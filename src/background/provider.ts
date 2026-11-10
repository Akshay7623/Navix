import type { ChatMessage, Settings, ToolCall, ToolSchema } from "../shared/types";

export interface StreamHandlers {
  onDelta(text: string): void;
  onReasoning(text: string): void;
  onToolCalls(calls: ToolCall[]): void;
}

export interface StreamResult {
  /** `length` means the reply hit `max_tokens`; null if the server sent none. */
  finishReason: string | null;
  /** False when no SSE chunk arrived, e.g. a server that ignored `stream: true`. */
  sawChunk: boolean;
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  error?: { message?: string; type?: string };
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Server-requested wait from a `Retry-After` header. */
    readonly retryAfterMs?: number,
    /** The request never got an HTTP response, or the connection dropped mid-stream. */
    readonly connectionFailed = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Statuses that mean "try again shortly" rather than "this request is wrong".
 * Serverless backends return these while a container cold-starts or scales up,
 * e.g. Modal's `503 {"error":"no upstreams available"}`.
 */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

export function isTransient(err: unknown): err is ProviderError {
  return (
    err instanceof ProviderError &&
    (err.connectionFailed || (err.status !== undefined && TRANSIENT_STATUS.has(err.status)))
  );
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** Wrap a network failure so it can be retried, leaving a user abort untouched. */
function connectionFailure(err: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return err;
  const detail = err instanceof Error ? err.message : String(err);
  return new ProviderError(`Could not reach the provider: ${detail}`, undefined, undefined, true);
}

function buildBody(
  settings: Settings,
  messages: ChatMessage[],
  tools: ToolSchema[],
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
    stream,
  };
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  // Only custom endpoints: these are vLLM/SGLang-style servers that pass the
  // field to the chat template. Hosted presets could reject an unknown field.
  if (settings.provider === "custom" && settings.reasoningEffort !== "default") {
    body.chat_template_kwargs = { reasoning_effort: settings.reasoningEffort };
  }
  return body;
}

function headers(settings: Settings): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (settings.apiKey) h.Authorization = `Bearer ${settings.apiKey}`;
  return h;
}

async function post(
  settings: Settings,
  messages: ChatMessage[],
  tools: ToolSchema[],
  stream: boolean,
  signal: AbortSignal,
): Promise<Response> {
  // The URL is the full endpoint, used as entered: nothing is appended to it.
  const endpoint = settings.baseUrl.trim();
  if (!endpoint) throw new ProviderError("API URL is not configured. Open the options page.");
  // fetch() rejects a malformed URL the same way it rejects a dead server, and
  // only the dead server is worth retrying.
  try {
    new URL(endpoint);
  } catch {
    throw new ProviderError(`API URL is not a valid URL: ${settings.baseUrl}`);
  }

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: stream ? headers(settings) : { ...headers(settings), Accept: "application/json" },
      body: JSON.stringify(buildBody(settings, messages, tools, stream)),
      signal,
    });
  } catch (err) {
    throw connectionFailure(err, signal);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(
      `Provider returned ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 800)}` : ""}`,
      res.status,
      parseRetryAfter(res.headers.get("Retry-After")),
    );
  }
  return res;
}

/**
 * Stream a chat completion and accumulate tool calls.
 *
 * OpenAI-compatible servers differ in how they emit tool calls: some send the
 * whole call in one delta, others dribble `arguments` fragments across many
 * chunks keyed by `index`. We accumulate by index and only emit once the stream
 * finishes, which is what every provider we target supports.
 */
export async function streamChat(
  settings: Settings,
  messages: ChatMessage[],
  tools: ToolSchema[],
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<StreamResult> {
  const res = await post(settings, messages, tools, true, signal);

  if (!res.body) throw new ProviderError("Provider returned an empty body.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finishReason: string | null = null;
  let sawChunk = false;

  const calls = new Map<number, { id: string; name: string; args: string }>();

  while (true) {
    let read: ReadableStreamReadResult<Uint8Array>;
    try {
      read = await reader.read();
    } catch (err) {
      throw connectionFailure(err, signal);
    }
    const { done, value } = read;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const rawLine = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");

      if (!rawLine || rawLine.startsWith(":")) continue;
      if (!rawLine.startsWith("data:")) continue;

      const payload = rawLine.slice(5).trim();
      if (payload === "[DONE]") continue;

      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(payload) as StreamChunk;
      } catch {
        continue;
      }

      if (chunk.error) {
        throw new ProviderError(chunk.error.message ?? "Provider stream error");
      }
      sawChunk = true;

      const choice = chunk.choices?.[0];
      // The final chunk can carry finish_reason with an empty delta.
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta;
      if (!delta) continue;

      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning) handlers.onReasoning(reasoning);
      if (delta.content) handlers.onDelta(delta.content);

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const slot = calls.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          calls.set(tc.index, slot);
        }
      }
    }
  }

  if (calls.size) {
    const ordered = Array.from(calls.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([index, slot]) => ({
        id: slot.id || `call_${index}_${Date.now()}`,
        type: "function" as const,
        function: { name: slot.name, arguments: slot.args || "{}" },
      }));
    handlers.onToolCalls(ordered);
  }
  return { finishReason, sawChunk };
}

/** Non-streaming fallback used when a server rejects `stream: true`. */
export async function completeChat(
  settings: Settings,
  messages: ChatMessage[],
  tools: ToolSchema[],
  signal: AbortSignal,
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const res = await post(settings, messages, tools, false, signal);

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
    error?: { message?: string };
  };

  if (json.error) throw new ProviderError(json.error.message ?? "Provider error");
  const message = json.choices?.[0]?.message;
  return { content: message?.content ?? "", toolCalls: message?.tool_calls ?? [] };
}
