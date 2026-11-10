import type {
  AgentState,
  ChatMessage,
  ContentPart,
  PlanStep,
  RuntimeEvent,
  Settings,
  ToolCall,
} from "../shared/types";
import { emitEvent } from "../shared/messaging";
import { getSettings, originOf } from "../shared/storage";
import { TOOL_MAP, TOOL_SCHEMAS, sleep } from "./tools";
import { streamChat, completeChat, isTransient, ProviderError, type StreamResult } from "./provider";
import { authorize, cancelAll } from "./permissions";
import * as cdp from "./cdp";
import * as gif from "./gif";
import * as safety from "./safety";
import * as visual from "./visual";

const SYSTEM_PROMPT = `You are Navix Agent, a browser automation agent operating a real Chrome tab on the user's behalf.

You act only through the tools you are given. Never claim you did something you did not do.

Working method:
1. Call read_page before interacting with a page you have not seen. It returns an accessibility tree where interactive elements carry ref_N ids.
2. Pass those ref_N ids to click, type, scroll_to, hover, drag, and upload_file. Refs are invalidated whenever the page navigates or re-renders — call read_page again after any navigation.
3. After an action that changes the page, verify the result with read_page or get_page_text before reporting success.
4. Use find to locate elements by visible text when you do not want to read the whole tree.
5. Use javascript_tool only when the accessibility tree cannot express what you need. It runs in the page's main world.
6. Use screenshot when layout or visual state matters and text alone is ambiguous.

Multi-step tasks:
- If the task needs more than about three actions, call update_plan first with the ordered steps, then call it again as each step completes. The user sees this plan live, so keep the wording short and keep exactly one step in_progress.
- Skip update_plan for single-action requests.

Specialised tools:
- drag: sliders, kanban boards, sortable lists, HTML5 drag-and-drop. Pass from_ref/to_ref, or coordinates.
- upload_file: attach local files to an <input type=file>. Paths must be absolute.
- set_viewport / set_zoom: test responsive layouts or zoom. Pass reset=true to restore.
- read_dialogs: see alert/confirm/prompt dialogs that appeared. They are answered automatically so they never block the page.

Rules:
- Never enter credentials, payment details, or one-time codes. If a task requires them, stop and ask the user to do that step.
- Do not take destructive or irreversible actions (deleting data, sending money, publishing content) without explicit confirmation in the conversation.
- Keep going until the task is done or you are genuinely blocked. When blocked, explain precisely what stopped you.
- Be concise in your final answer: state what you did and what the outcome was.`;

interface RunOptions {
  prompt: string;
  tabId: number;
  /** Earlier turns of the same chat, oldest first. */
  history?: ChatMessage[];
}

/**
 * Replayable history for the model. Only plain user/assistant text survives:
 * tool calls from a previous run have no matching tool results any more, and
 * strict OpenAI-compatible servers reject an orphaned `tool` message.
 */
function historyMessages(history: ChatMessage[] | undefined): ChatMessage[] {
  if (!history?.length) return [];
  const out: ChatMessage[] = [];
  for (const msg of history) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    if (typeof msg.content !== "string") continue;
    const text = msg.content.trim();
    if (!text) continue;
    out.push({ role: msg.role, content: text });
  }
  return out;
}

/** Tools whose output describes the page at one moment and goes stale after it. */
const SNAPSHOT_TOOLS = new Set(["read_page", "get_page_text"]);
/** Newest snapshots (page reads and screenshots) kept in full. */
const KEEP_RECENT_SNAPSHOTS = 2;
/** Smaller outputs are not worth rewriting the conversation for. */
const MIN_SNAPSHOT_CHARS = 1500;
/**
 * Compact once the stale snapshots add up to this many characters. Rewriting
 * an earlier message makes the server's prefix cache miss from that message
 * on, so stale snapshots are removed in batches rather than one per step.
 */
const COMPACT_THRESHOLD_CHARS = 40000;
/** A screenshot's weight toward the threshold: roughly its token cost in characters. */
const IMAGE_WEIGHT_CHARS = 4000;
const REMOVED_PREFIX = "[Removed to save context:";

/** Character weight of a message if it is a compactable snapshot, else 0. */
function snapshotWeight(msg: ChatMessage): number {
  if (msg.role === "tool" && msg.name && SNAPSHOT_TOOLS.has(msg.name) && typeof msg.content === "string") {
    if (msg.content.startsWith(REMOVED_PREFIX) || msg.content.length < MIN_SNAPSHOT_CHARS) return 0;
    return msg.content.length;
  }
  if (msg.role === "user" && Array.isArray(msg.content) && msg.content.some((p) => p.type === "image_url")) {
    return IMAGE_WEIGHT_CHARS;
  }
  return 0;
}

function removedStub(msg: ChatMessage): string {
  if (msg.role === "user") return `${REMOVED_PREFIX} an earlier screenshot. Take a new one if you need to see the page.]`;
  const text = typeof msg.content === "string" ? msg.content : "";
  // read_page output starts with "URL: …\nTitle: …"; keep that so the model knows which page it was.
  const where = text.startsWith("URL: ") ? ` (${text.split("\n", 2).join(", ")})` : "";
  return (
    `${REMOVED_PREFIX} earlier ${msg.name} output${where}. It showed an older state of the page and ` +
    `its ref ids are no longer valid. Call ${msg.name} again if you need the page.]`
  );
}

/**
 * Replace all but the newest page snapshots with a one-line stub once enough
 * stale ones pile up. Every step sends the whole conversation, so without this
 * each read_page (up to 20,000 characters) stays in every later request.
 * Returns how many messages were rewritten.
 */
function compactSnapshots(messages: ChatMessage[]): number {
  const snapshots: number[] = [];
  messages.forEach((msg, i) => {
    if (snapshotWeight(msg) > 0) snapshots.push(i);
  });
  const stale = snapshots.slice(0, Math.max(0, snapshots.length - KEEP_RECENT_SNAPSHOTS));
  const staleChars = stale.reduce((sum, i) => sum + snapshotWeight(messages[i]), 0);
  if (staleChars < COMPACT_THRESHOLD_CHARS) return 0;
  for (const i of stale) messages[i] = { ...messages[i], content: removedStub(messages[i]) };
  return stale.length;
}

let controller: AbortController | null = null;
let state: AgentState = { running: false, steps: 0, pendingApproval: null, plan: [] };

export function getState(): AgentState {
  return { ...state, plan: [...state.plan] };
}

export function abort(): void {
  controller?.abort();
  cancelAll();
  state = { running: false, steps: state.steps, pendingApproval: null, plan: state.plan };
}

function emit(event: RuntimeEvent): void {
  emitEvent(event);
}

function preview(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Full tool output for the expanded card. Unlike `preview` this keeps newlines
 * and indentation, because the accessibility tree and page text are only
 * readable when their line structure survives.
 */
function fullOutput(text: string, max = 20000): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}\n… (${trimmed.length - max} more characters)` : trimmed;
}

/**
 * Approval key for pages that have no http(s) origin. `file://` and `data:`
 * pages are still real pages the agent can act on, so they must be gated too.
 */
function labelForUrl(url: string | undefined): string {
  if (!url) return "unknown page";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return "file://";
    return `${parsed.protocol}//`;
  } catch {
    return "unknown page";
  }
}

export async function run({ prompt, tabId, history }: RunOptions): Promise<void> {
  if (state.running) throw new Error("An agent run is already in progress.");

  const settings = await getSettings();
  if (!settings.apiKey && settings.provider !== "custom") {
    throw new Error("No API key configured. Open the extension options and add one.");
  }
  if (!settings.model) {
    throw new Error("No model selected. Open the extension options and pick one.");
  }

  // Refuse a blocked site before spending a model call on it. The per-tool gate
  // in executeTool() is the real enforcement point, but failing here gives the
  // user an immediate, unambiguous reason instead of a run that silently does
  // nothing.
  const target = await chrome.tabs.get(tabId).catch(() => null);
  const preflight = safety.assess(target?.url);
  if (preflight.tier === "blocked") {
    throw new Error(
      `${originOf(target?.url) || labelForUrl(target?.url)} is classified as blocked ` +
        `(${preflight.reason}). The agent does not act on this site.`,
    );
  }

  controller = new AbortController();
  const signal = controller.signal;
  state = { running: true, steps: 0, pendingApproval: null, plan: [] };

  // Attach up front so console and network capture covers the whole run, not
  // just the window between the first and last CDP-backed tool call.
  await cdp.ensure(tabId).catch(() => undefined);
  cdp.setDialogPolicy(tabId, settings.dialogPolicy);

  if (settings.visualFeedback) await visual.showIndicator(tabId, "Agent working");
  gif.start(tabId);

  // One system message: Qwen3.5-family chat templates reject a second one
  // ("System message must be at the beginning").
  const extra = settings.systemPromptExtra.trim();
  const messages: ChatMessage[] = [
    { role: "system", content: extra ? `${SYSTEM_PROMPT}\n\n${extra}` : SYSTEM_PROMPT },
    ...historyMessages(history),
    { role: "user", content: prompt },
  ];

  try {
    for (let step = 0; step < settings.maxSteps; step += 1) {
      if (signal.aborted) break;
      state.steps = step + 1;
      // Each model turn gets its own reasoning step; without this the panel
      // concatenates every step's thinking into one unreadable wall.
      emit({ type: "agent/step", step: step + 1 });

      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) throw new Error("The target tab was closed.");

      const compacted = compactSnapshots(messages);
      if (compacted) console.info(`[agent] step ${step + 1}: removed ${compacted} old page snapshots`);

      const result = await callModel(settings, messages, signal);
      if (signal.aborted) break;

      if (result.content) {
        messages.push({
          role: "assistant",
          content: result.content,
          tool_calls: result.toolCalls.length ? result.toolCalls : undefined,
        });
      } else if (result.toolCalls.length) {
        // Some strict OpenAI-compatible servers reject `content: null` on an
        // assistant turn that carries tool calls, so send an empty string.
        messages.push({ role: "assistant", content: "", tool_calls: result.toolCalls });
      }

      if (!result.toolCalls.length) {
        emit({ type: "agent/done", steps: step + 1 });
        return;
      }

      for (const call of result.toolCalls) {
        if (signal.aborted) break;
        const output = await executeTool(call, tabId, settings, signal);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: output.content,
        });
        if (output.image) {
          if (settings.visionEnabled) {
            const parts: ContentPart[] = [
              { type: "text", text: `Screenshot returned by ${call.function.name}:` },
              { type: "image_url", image_url: { url: output.image } },
            ];
            messages.push({ role: "user", content: parts });
          } else {
            messages.push({
              role: "user",
              content:
                "A screenshot was captured but image input is disabled in settings, so you cannot see it. " +
                "Rely on read_page or get_page_text instead, or ask the user to enable vision.",
            });
          }
        }
        await recordFrame(tabId);
      }
    }

    if (signal.aborted) {
      emit({ type: "agent/done", steps: state.steps });
    } else {
      emit({
        type: "agent/error",
        message: `Stopped after ${settings.maxSteps} steps without finishing. Raise the step limit in options or narrow the task.`,
      });
    }
  } catch (err) {
    if (signal.aborted) {
      emit({ type: "agent/done", steps: state.steps });
    } else {
      const message =
        err instanceof ProviderError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      emit({ type: "agent/error", message });
    }
  } finally {
    controller = null;
    state = { running: false, steps: state.steps, pendingApproval: null, plan: state.plan };
    if (settings.visualFeedback) await visual.hideIndicator(tabId);
    await visual.hideCursor(tabId);
    const frames = await gif.finish(tabId);
    if (frames > 0) emit({ type: "agent/gif", frames });
    await cdp.release(tabId).catch(() => undefined);
  }
}

/**
 * Snapshot the tab after a mutating tool so the run can be exported as a GIF.
 * Failures are ignored: a recording is a nicety, never a reason to fail a run.
 */
async function recordFrame(tabId: number): Promise<void> {
  if (!gif.isRecording(tabId)) return;
  try {
    const dataUrl = await cdp.screenshot(tabId, { format: "jpeg", quality: 55 });
    const comma = dataUrl.indexOf(",");
    if (comma > 0) await gif.captureFrame(tabId, dataUrl.slice(comma + 1));
  } catch {
    /* tab may have navigated or closed */
  }
}

/**
 * With doubling delays capped at MAX_RETRY_DELAY_MS, 12 retries wait about three
 * minutes in total: long enough for a typical serverless cold start.
 */
const MAX_MODEL_RETRIES = 12;
/** Stays under the 30s idle limit that would suspend the MV3 service worker. */
const MAX_RETRY_DELAY_MS = 20000;

function retryDelay(err: ProviderError, attempt: number): number {
  const backoff = 2000 * 2 ** (attempt - 1);
  return Math.min(Math.max(backoff, err.retryAfterMs ?? 0), MAX_RETRY_DELAY_MS);
}

/**
 * Call the model, waiting out transient failures such as a serverless backend
 * that is still cold-starting. Once a turn has streamed output it is never
 * retried, because the panel would show that output twice.
 */
async function callModel(
  settings: Settings,
  messages: ChatMessage[],
  signal: AbortSignal,
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  for (let attempt = 1; ; attempt += 1) {
    let streamed = false;
    try {
      return await attemptModel(settings, messages, signal, () => {
        streamed = true;
      });
    } catch (err) {
      if (signal.aborted || streamed || !isTransient(err)) throw err;
      if (attempt > MAX_MODEL_RETRIES) {
        throw new Error(
          `${err.message}\n\nThe model server was still unavailable after ${MAX_MODEL_RETRIES} retries. ` +
            `Send your message again to retry.`,
        );
      }
      const delayMs = retryDelay(err, attempt);
      emit({
        type: "agent/retry",
        attempt,
        maxAttempts: MAX_MODEL_RETRIES,
        delayMs,
        status: err.status,
        reason: err.message,
      });
      await sleep(delayMs, signal);
      if (signal.aborted) throw err;
    }
  }
}

async function attemptModel(
  settings: Settings,
  messages: ChatMessage[],
  signal: AbortSignal,
  onOutput: () => void,
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  let content = "";
  let toolCalls: ToolCall[] = [];
  let stream: StreamResult;

  try {
    stream = await streamChat(
      settings,
      messages,
      TOOL_SCHEMAS,
      {
        onDelta(text) {
          onOutput();
          content += text;
          emit({ type: "agent/delta", text });
        },
        onReasoning(text) {
          onOutput();
          emit({ type: "agent/reasoning", text });
        },
        onToolCalls(calls) {
          toolCalls = calls;
        },
      },
      signal,
    );
  } catch (err) {
    // Some self-hosted gateways ignore `stream: true` or reject it outright.
    // Retry once without streaming before surfacing the failure.
    const retryable =
      err instanceof ProviderError &&
      (err.status === 400 || err.status === 422 || err.status === 501);
    if (!retryable || signal.aborted) throw err;

    const fallback = await completeChat(settings, messages, TOOL_SCHEMAS, signal);
    if (fallback.content) emit({ type: "agent/delta", text: fallback.content });
    return { content: fallback.content, toolCalls: fallback.toolCalls };
  }

  // A reply cut off by max_tokens. Reasoning models count their thinking
  // toward it, so this is usually thinking that never reached an answer.
  // Sending the request again would only repeat the same cut.
  if (stream.finishReason === "length" && !toolCalls.length) {
    throw new Error(
      `The model used all ${settings.maxTokens} tokens of its Max tokens limit ` +
        `${content ? "before finishing its answer" : "on thinking and never answered"}. ` +
        `Raise Max tokens in the extension options, or lower the reasoning effort.`,
    );
  }

  // A server that ignored `stream: true` returns one JSON body, which the SSE
  // parser skips entirely. Detect that and retry non-streaming. A stream that
  // did arrive but held no answer is not retried: that would repeat the whole
  // request for the same result.
  if (!content && !toolCalls.length && !stream.sawChunk) {
    const fallback = await completeChat(settings, messages, TOOL_SCHEMAS, signal);
    if (fallback.content) emit({ type: "agent/delta", text: fallback.content });
    return { content: fallback.content, toolCalls: fallback.toolCalls };
  }

  return { content, toolCalls };
}

async function executeTool(
  call: ToolCall,
  tabId: number,
  settings: Settings,
  signal: AbortSignal,
): Promise<{ content: string; image?: string }> {
  const name = call.function.name;
  const tool = TOOL_MAP.get(name);

  if (!tool) {
    emit({
      type: "agent/tool_end",
      id: call.id,
      name,
      ok: false,
      preview: "unknown tool",
      output: `No tool named "${name}".`,
    });
    return {
      content: `Error: unknown tool "${name}". Available tools: ${Array.from(TOOL_MAP.keys()).join(", ")}.`,
    };
  }

  let args: Record<string, unknown> = {};
  if (call.function.arguments) {
    try {
      args = JSON.parse(call.function.arguments) as Record<string, unknown>;
    } catch {
      emit({
        type: "agent/tool_end",
        id: call.id,
        name,
        ok: false,
        preview: "bad JSON arguments",
        output: `Arguments were not valid JSON:\n${call.function.arguments}`,
      });
      return {
        content: `Error: arguments were not valid JSON: ${call.function.arguments.slice(0, 300)}`,
      };
    }
  }

  emit({ type: "agent/tool_start", id: call.id, name, args });

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  // Non-http(s) pages (file://, chrome://, data:) have no origin, but they still
  // need approval — fall back to a readable label instead of skipping the gate.
  const origin = originOf(tab?.url) || labelForUrl(tab?.url);

  if (tool.mutating) {
    const assessment = safety.assess(tab?.url);

    // A blocked site never runs, in any approval mode. This is the one hard
    // stop: banking, government, health, and password managers.
    if (assessment.tier === "blocked") {
      emit({
        type: "agent/tool_end",
        id: call.id,
        name,
        ok: false,
        preview: "blocked site",
        output: `Blocked: ${origin} is classified as blocked (${assessment.reason}).`,
      });
      return {
        content:
          `Error: ${origin} is classified as blocked (${assessment.reason}). ` +
          `The agent does not act on this site. Ask the user to perform this step themselves.`,
      };
    }

    // `auto` mode is only honoured on sites we can positively classify as
    // low-risk. Unrecognised and restricted sites always prompt.
    const skipPrompt =
      settings.approvalMode === "auto" && safety.autoAllowed(assessment, settings.safetyMode);

    if (!skipPrompt) {
      const summary = `${name} on ${origin} — ${safety.describe(assessment)}`;
      const allowed = await authorize(origin, name, summary, settings, (req) => {
        state.pendingApproval = req;
        emit({ type: "agent/approval", ...req });
      });
      state.pendingApproval = null;
      if (!allowed) {
        emit({
          type: "agent/tool_end",
          id: call.id,
          name,
          ok: false,
          preview: "denied by user",
          output: `The user denied permission to run ${name} on ${origin}.`,
        });
        return {
          content: `Error: the user denied permission to run ${name} on ${origin}. Do not retry; ask the user how to proceed.`,
        };
      }
    }
  }

  const ctx = {
    tabId,
    origin,
    signal,
    settings,
    emit,
    setPlan(steps: PlanStep[]) {
      state.plan = steps;
      emit({ type: "agent/plan", steps });
    },
  };

  try {
    const result = tool.needsCdp
      ? await (async () => {
          await cdp.ensure(tabId);
          return tool.run(args, ctx);
        })()
      : await tool.run(args, ctx);

    emit({
      type: "agent/tool_end",
      id: call.id,
      name,
      ok: result.ok,
      preview: result.image ? `${preview(result.content)} [image attached]` : preview(result.content),
      output: result.image
        ? `${fullOutput(result.content)}\n\n[image attached]`
        : fullOutput(result.content),
    });

    return result.image
      ? { content: result.ok ? result.content : `Error: ${result.content}`, image: result.image }
      : { content: result.ok ? result.content : `Error: ${result.content}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({
      type: "agent/tool_end",
      id: call.id,
      name,
      ok: false,
      preview: preview(message),
      output: fullOutput(message),
    });
    return { content: `Error: ${message}` };
  }
}
