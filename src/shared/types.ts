export type ProviderId = "deepseek" | "qwen" | "custom";

export type ReasoningEffort = "default" | "low" | "medium" | "xhigh";

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  baseUrl: string;
  models: string[];
  defaultModel: string;
  docsUrl: string;
  /** Some gateways want `Authorization: Bearer`, others want a raw key header. */
  authStyle: "bearer" | "x-api-key";
  notes: string;
}

export interface Settings {
  provider: ProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  /** Includes thinking tokens: vLLM counts reasoning toward `max_tokens`. */
  maxTokens: number;
  maxSteps: number;
  /**
   * Sent to custom endpoints as `chat_template_kwargs.reasoning_effort`, which
   * Qwen3.5-family chat templates read. `default` sends nothing and leaves the
   * template's own default (xhigh for Qwen3.8).
   */
  reasoningEffort: ReasoningEffort;
  approvalMode: "ask" | "auto";
  systemPromptExtra: string;
  /** Attach screenshots to the conversation. Requires a vision-capable model. */
  visionEnabled: boolean;
  /** How to answer JS dialogs (alert/confirm/prompt) that would otherwise block the renderer. */
  dialogPolicy: "dismiss" | "accept";
  /** `standard` blocks high-risk sites outright; `permissive` only warns. */
  safetyMode: "standard" | "permissive";
  /** Draw a cursor and a working badge on the page while the agent acts. */
  visualFeedback: boolean;
}

export type RiskTier = "safe" | "caution" | "restricted" | "blocked";

export interface SiteAssessment {
  tier: RiskTier;
  reason: string;
  /** True when the site could not be classified and we defaulted to the strict tier. */
  unknown: boolean;
}

export interface PlanStep {
  step: string;
  status: "pending" | "in_progress" | "done";
}

export type PermissionState = "allow" | "deny";

export interface DomainPermission {
  origin: string;
  state: PermissionState;
  updatedAt: number;
}

export interface PermissionStore {
  domains: Record<string, DomainPermission>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolResult {
  ok: boolean;
  /** Text handed back to the model. */
  content: string;
  /** Optional image data URL for screenshot-style tools. */
  image?: string;
  /** Set when the tool needs a human decision before it can run. */
  needsApproval?: {
    origin: string;
    toolName: string;
    summary: string;
  };
}

export interface ToolContext {
  tabId: number;
  origin: string;
  signal: AbortSignal;
  settings: Settings;
  /** Push an event to the side panel. */
  emit(event: RuntimeEvent): void;
  /** Replace the agent's visible plan. */
  setPlan(steps: PlanStep[]): void;
}

export interface ToolDefinition {
  schema: ToolSchema;
  /** Tools that mutate the page or read sensitive data require approval. */
  mutating: boolean;
  /** Tools that need a chrome.debugger attachment (input dispatch, capture). */
  needsCdp?: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/* ---------- chat history ---------- */

/**
 * A stored conversation is a flat replay log: user prompts interleaved with the
 * runtime events the agent emitted. Replaying it through the same event handler
 * the live run uses means restored chats render exactly like fresh ones.
 */
export type ConversationItem =
  | { kind: "user"; text: string }
  | { kind: "event"; event: RuntimeEvent };

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  items: ConversationItem[];
}

/** Lightweight row for the history list (no transcript payload). */
export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/* ---------- runtime messaging ---------- */

export type RuntimeRequest =
  | { type: "agent/run"; prompt: string; tabId?: number; history?: ChatMessage[] }
  | { type: "agent/abort" }
  | { type: "agent/state" }
  | { type: "permission/respond"; origin: string; decision: "allow" | "deny"; remember: boolean }
  | { type: "settings/get" }
  | { type: "settings/set"; settings: Partial<Settings> }
  | { type: "permissions/list" }
  | { type: "permissions/clear"; origin?: string }
  | { type: "tab/active" }
  | { type: "gif/export" }
  | { type: "history/list" }
  | { type: "history/get"; id: string }
  | { type: "history/save"; conversation: Conversation }
  | { type: "history/delete"; id: string }
  | { type: "history/clear" };

export type RuntimeEvent =
  | { type: "agent/delta"; text: string }
  | { type: "agent/reasoning"; text: string }
  | { type: "agent/step"; step: number }
  | { type: "agent/tool_start"; id: string; name: string; args: unknown }
  | {
      type: "agent/tool_end";
      id: string;
      name: string;
      ok: boolean;
      /** One-line summary for the collapsed card header. */
      preview: string;
      /** Full tool output, newlines preserved, for the expanded card body. */
      output: string;
    }
  | { type: "agent/approval"; origin: string; toolName: string; summary: string }
  | { type: "agent/plan"; steps: PlanStep[] }
  | { type: "agent/error"; message: string }
  /** The model call failed transiently and will be tried again after `delayMs`. */
  | {
      type: "agent/retry";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      /** HTTP status; absent when the connection itself failed. */
      status?: number;
      reason: string;
    }
  | { type: "agent/gif"; frames: number }
  | { type: "agent/done"; steps: number };

export interface AgentState {
  running: boolean;
  steps: number;
  pendingApproval: { origin: string; toolName: string; summary: string } | null;
  plan: PlanStep[];
}
