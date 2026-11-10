import type {
  ChatMessage,
  Conversation,
  ConversationItem,
  ConversationSummary,
  PlanStep,
  RuntimeEvent,
  Settings,
} from "../shared/types";
import { onEvent, sendRequest } from "../shared/messaging";
import { icon, logoMark, mountIcons, toolMeta } from "../shared/icons";
import { renderMarkdownInto } from "./markdown";
import { copyText, flashLabel } from "./clipboard";

mountIcons();

const transcript = document.getElementById("transcript") as HTMLElement;
const emptyState = document.getElementById("emptyState") as HTMLElement;
const promptInput = document.getElementById("prompt") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send") as HTMLButtonElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;
const statusDot = document.getElementById("statusDot") as HTMLElement;
const modelLabel = document.getElementById("modelLabel") as HTMLElement;
const openOptions = document.getElementById("openOptions") as HTMLButtonElement;
const newChatBtn = document.getElementById("newChat") as HTMLButtonElement;

const approvalBar = document.getElementById("approvalBar") as HTMLElement;
const approvalTool = document.getElementById("approvalTool") as HTMLElement;
const approvalOrigin = document.getElementById("approvalOrigin") as HTMLElement;
const approvalDetail = document.getElementById("approvalDetail") as HTMLElement;
const approvalRemember = document.getElementById("approvalRemember") as HTMLInputElement;
const approvalAllow = document.getElementById("approvalAllow") as HTMLButtonElement;
const approvalDeny = document.getElementById("approvalDeny") as HTMLButtonElement;

const planBar = document.getElementById("planBar") as HTMLElement;
const planToggle = document.getElementById("planToggle") as HTMLButtonElement;
const planCurrent = document.getElementById("planCurrent") as HTMLElement;
const planMeter = document.getElementById("planMeter") as HTMLElement;
const planList = document.getElementById("planList") as HTMLOListElement;
const planProgress = document.getElementById("planProgress") as HTMLElement;
const exportGifBtn = document.getElementById("exportGif") as HTMLButtonElement;

const historyBtn = document.getElementById("historyBtn") as HTMLButtonElement;
const historyPanel = document.getElementById("historyPanel") as HTMLElement;
const historyList = document.getElementById("historyList") as HTMLElement;
const historyClear = document.getElementById("historyClear") as HTMLButtonElement;
const historyClose = document.getElementById("historyClose") as HTMLButtonElement;
const historyScrim = document.getElementById("historyScrim") as HTMLElement;

const activityBar = document.getElementById("activity") as HTMLElement;
const activityText = document.getElementById("activityText") as HTMLElement;
const activityStep = document.getElementById("activityStep") as HTMLElement;
const activityTime = document.getElementById("activityTime") as HTMLElement;

const tabChip = document.getElementById("tabChip") as HTMLElement;
const tabFavicon = document.getElementById("tabFavicon") as HTMLImageElement;
const tabFallback = document.getElementById("tabFallback") as HTMLElement;
const tabTitle = document.getElementById("tabTitle") as HTMLElement;
const modelChip = document.getElementById("modelChip") as HTMLButtonElement;

let running = false;
let currentAssistant: HTMLElement | null = null;
let currentAssistantText = "";
/** The single Thinking group for the current run, holding one section per step. */
let reasoningGroup: HTMLDetailsElement | null = null;
let reasoningGroupBody: HTMLElement | null = null;
let reasoningGroupCount: HTMLElement | null = null;
let reasoningStepCount = 0;
let currentReasoning: HTMLElement | null = null;
let currentReasoningBlock: HTMLDetailsElement | null = null;
const toolCards = new Map<
  string,
  {
    root: HTMLElement;
    name: string;
    status: HTMLElement;
    body: HTMLElement;
    preview: HTMLElement;
    args: ToolSection;
    result: ToolSection;
  }
>();

/** One collapsible, resizable Arguments/Result pane inside a tool card. */
interface ToolSection {
  root: HTMLDetailsElement;
  pre: HTMLPreElement;
  size: HTMLElement;
  copy: HTMLButtonElement;
  stretch: HTMLButtonElement;
}
let pendingApproval: { origin: string } | null = null;

/* ---------- conversation state ---------- */

let conversation: Conversation | null = null;
/** True while replaying a stored transcript, so events are not re-recorded. */
let replaying = false;

function newConversation(): Conversation {
  const now = Date.now();
  return {
    id: `c_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    items: [],
  };
}

function record(item: ConversationItem): void {
  if (replaying) return;
  if (!conversation) conversation = newConversation();

  // Streaming deltas arrive one token at a time; merge them into the previous
  // item so a long answer is one entry instead of hundreds.
  const last = conversation.items[conversation.items.length - 1];
  if (
    item.kind === "event" &&
    last?.kind === "event" &&
    last.event.type === item.event.type &&
    (item.event.type === "agent/delta" || item.event.type === "agent/reasoning")
  ) {
    const prev = last.event as { type: string; text: string };
    const next = item.event as { type: string; text: string };
    last.event = { ...next, text: prev.text + next.text } as RuntimeEvent;
    conversation.updatedAt = Date.now();
    return;
  }

  conversation.items.push(item);
  conversation.updatedAt = Date.now();
  if (conversation.title === "New chat" && item.kind === "user") {
    conversation.title = item.text.replace(/\s+/g, " ").trim().slice(0, 60) || "New chat";
  }
}

let saveTimer: number | undefined;

/** Debounced persist so a streaming run does not hammer `chrome.storage`. */
function scheduleSave(): void {
  if (replaying || !conversation) return;
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    void persist();
  }, 600) as unknown as number;
}

async function persist(): Promise<void> {
  if (!conversation || !conversation.items.length) return;
  const snapshot = conversation;
  try {
    await sendRequest({ type: "history/save", conversation: snapshot });
    await refreshHistory();
  } catch {
    /* history is best-effort; never break the chat over it */
  }
}

/** Rough character budget for replayed history, so a long chat cannot blow the context window. */
const HISTORY_CHAR_BUDGET = 8000;

/**
 * Rebuild the model-facing transcript from the replay log. Tool cards and
 * reasoning are dropped on purpose: their `tool` messages would be orphaned
 * without the matching assistant `tool_calls`, which strict OpenAI-compatible
 * servers reject. Only the visible user/assistant text is replayed.
 */
function buildHistory(): ChatMessage[] {
  if (!conversation) return [];
  const turns: ChatMessage[] = [];
  let assistant = "";
  /** True once a tool card or step boundary split the current answer. */
  let broken = false;

  const flush = (): void => {
    const text = assistant.trim();
    if (text) turns.push({ role: "assistant", content: text });
    assistant = "";
    broken = false;
  };

  for (const item of conversation.items) {
    if (item.kind === "user") {
      flush();
      const text = item.text.trim();
      if (text) turns.push({ role: "user", content: text });
      continue;
    }
    if (item.event.type === "agent/delta") {
      // A run's answer can be split by tool calls; keep the segments readable
      // instead of gluing "Looking." and "Done." into one word.
      if (broken && assistant) assistant += "\n\n";
      assistant += item.event.text;
      broken = false;
      continue;
    }
    if (item.event.type === "agent/tool_start" || item.event.type === "agent/step") broken = true;
  }
  flush();

  // Keep the newest turns that fit the budget; a partial turn is worse than none.
  const kept: ChatMessage[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const msg = turns[i];
    const size = typeof msg.content === "string" ? msg.content.length : 0;
    if (used + size > HISTORY_CHAR_BUDGET && kept.length) break;
    used += size;
    kept.unshift(msg);
  }
  // A leading assistant turn has no question to answer, so drop it.
  while (kept.length && kept[0].role === "assistant") kept.shift();
  return kept;
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

function scrollToBottom(): void {
  transcript.scrollTop = transcript.scrollHeight;
}

function hideEmpty(): void {
  emptyState.classList.add("hidden");
}

function addMessage(role: "user" | "assistant", text: string): HTMLElement {
  hideEmpty();
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;

  const head = document.createElement("div");
  head.className = "msg-head";

  const label = document.createElement("div");
  label.className = "msg-role";
  label.textContent = role === "user" ? "You" : "Agent";
  if (role === "assistant") head.append(logoMark(18));
  head.append(label);

  const body = document.createElement("div");
  body.className = "msg-body";
  if (role === "assistant") {
    renderMarkdownInto(body, text);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "md-copy msg-copy";
    copy.textContent = "Copy";
    copy.title = "Copy this answer";
    copy.addEventListener("click", () => {
      void copyText(wrap.dataset.raw ?? "").then((ok) => flashLabel(copy, ok));
    });
    head.append(copy);
  } else {
    body.textContent = text;
  }

  wrap.dataset.raw = text;
  wrap.append(head, body);
  transcript.append(wrap);
  scrollToBottom();
  return body;
}

let assistantRenderQueued = false;

/** Keep the copy-answer payload in sync with the streaming text. */
function syncAssistantRaw(): void {
  const wrap = currentAssistant?.closest<HTMLElement>(".msg");
  if (wrap) wrap.dataset.raw = currentAssistantText;
}

/** Re-render the streaming assistant bubble at most once per frame. */
function scheduleAssistantRender(): void {
  if (assistantRenderQueued) return;
  assistantRenderQueued = true;
  requestAnimationFrame(() => {
    assistantRenderQueued = false;
    if (!currentAssistant) return;
    renderMarkdownInto(currentAssistant, currentAssistantText);
    syncAssistantRaw();
    scrollToBottom();
  });
}

/** Render any pending assistant text immediately (used before resetting state). */
function flushAssistant(): void {
  if (currentAssistant) {
    // A step that only emitted reasoning or a tool call leaves an empty bubble;
    // drop it instead of leaving a blank row in the transcript.
    if (!currentAssistantText.trim()) {
      currentAssistant.closest(".msg")?.remove();
      currentAssistant = null;
      currentAssistantText = "";
    } else {
      renderMarkdownInto(currentAssistant, currentAssistantText);
      syncAssistantRaw();
    }
  }
  assistantRenderQueued = false;
}

/* ------------------------------------------------------------------ */
/* reasoning                                                           */
/* ------------------------------------------------------------------ */

/**
 * One Thinking group per run. Every model turn's reasoning becomes a nested
 * step inside it, so a ten-step run reads as a single row instead of ten.
 */
function ensureReasoningGroup(): HTMLElement {
  if (reasoningGroupBody) return reasoningGroupBody;

  hideEmpty();
  const group = document.createElement("details");
  group.className = "msg assistant reasoning-group act";
  group.open = true;

  const badge = document.createElement("span");
  badge.className = "act-icon";
  badge.append(icon("sparkle", 14));

  const head = document.createElement("summary");
  head.className = "reasoning-group-head";

  const label = document.createElement("span");
  label.className = "reasoning-group-label";
  label.textContent = "Thinking";

  const count = document.createElement("span");
  count.className = "reasoning-group-count";
  count.textContent = "1 step";

  // The badge sits inside <summary>: a closed <details> hides everything else.
  head.append(badge, label, count, icon("chevron", 14, "act-chevron"));

  const body = document.createElement("div");
  body.className = "reasoning-steps";

  group.append(head, body);
  transcript.append(group);

  reasoningGroup = group;
  reasoningGroupBody = body;
  reasoningGroupCount = count;
  reasoningStepCount = 0;
  return body;
}

/** Close the current step's block but keep the run's group open. */
function endReasoningStep(): void {
  if (currentReasoningBlock) currentReasoningBlock.open = false;
  reasoningGroup?.classList.remove("live");
  currentReasoning = null;
  currentReasoningBlock = null;
}

/** Close the current step and collapse the whole run's group. */
function endReasoningRun(): void {
  // Leave the last step expanded so re-opening the group shows its thinking.
  currentReasoning = null;
  currentReasoningBlock = null;
  reasoningGroup?.classList.remove("live");
  if (reasoningGroup) reasoningGroup.open = false;
  reasoningGroup = null;
  reasoningGroupBody = null;
  reasoningGroupCount = null;
  reasoningStepCount = 0;
}

function addError(message: string): void {
  hideEmpty();
  const box = document.createElement("div");
  box.className = "error-box";
  box.setAttribute("role", "alert");
  const text = document.createElement("div");
  text.className = "error-text";
  text.textContent = message;
  box.append(icon("alert", 16), text);
  transcript.append(box);
  scrollToBottom();
}

/** The one live "waiting for the model server" row, updated in place between retries. */
let retryNote: HTMLElement | null = null;
let retryText: HTMLElement | null = null;

function showRetryNote(event: Extract<RuntimeEvent, { type: "agent/retry" }>): void {
  hideEmpty();
  if (!retryNote || !retryText) {
    retryNote = document.createElement("div");
    retryNote.className = "retry-note";
    retryNote.setAttribute("role", "status");
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    retryText = document.createElement("span");
    retryNote.append(spinner, retryText);
    transcript.append(retryNote);
  }
  const cause = event.status ? `returned ${event.status}` : "could not be reached";
  retryText.textContent =
    `Model server ${cause}, it may still be starting. ` +
    `Retrying in ${Math.round(event.delayMs / 1000)}s (attempt ${event.attempt} of ${event.maxAttempts}).`;
  retryNote.title = event.reason;
  scrollToBottom();
}

function clearRetryNote(): void {
  retryNote?.remove();
  retryNote = null;
  retryText = null;
}

/** Human-readable payload size for a section badge. */
function formatSize(text: string): string {
  const n = text.length;
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

/**
 * One collapsible Arguments/Result pane. The body is capped in height so a huge
 * tool result cannot swallow the transcript; "Expand" lifts the cap and the
 * `<pre>` also carries a native resize handle.
 */
function toolSection(label: string, text: string, opts: { open: boolean; hidden?: boolean }): ToolSection {
  const root = document.createElement("details");
  root.className = "tool-section";
  if (opts.hidden) root.classList.add("hidden");
  root.open = opts.open;

  const summary = document.createElement("summary");
  summary.className = "tool-section-head";

  const labelEl = document.createElement("span");
  labelEl.className = "tool-label";
  labelEl.textContent = label;

  const size = document.createElement("span");
  size.className = "tool-size";
  size.textContent = formatSize(text);

  const pre = document.createElement("pre");
  pre.className = "tool-pre";
  pre.textContent = text;

  const stretch = document.createElement("button");
  stretch.type = "button";
  stretch.className = "md-copy tool-stretch";
  stretch.textContent = "Expand";
  stretch.title = "Show the full output";
  stretch.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const on = root.classList.toggle("stretched");
    stretch.textContent = on ? "Collapse" : "Expand";
  });

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "md-copy tool-copy";
  copy.textContent = "Copy";
  copy.title = `Copy ${label.toLowerCase()}`;
  copy.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void copyText(pre.textContent ?? "").then((ok) => flashLabel(copy, ok));
  });

  summary.append(labelEl, size, stretch, copy);
  root.append(summary, pre);
  return { root, pre, size, copy, stretch };
}

/** Status marker for a tool row: a spinner while running, then a check or a cross. The text stays for screen readers. */
function setToolStatus(status: HTMLElement, state: "pending" | "ok" | "err"): void {
  status.className = `tool-status ${state}`;
  const label = document.createElement("span");
  label.className = "sr-only";
  label.textContent = state === "pending" ? "running" : state === "ok" ? "done" : "failed";
  let mark: Element;
  if (state === "pending") {
    mark = document.createElement("span");
    mark.className = "spinner";
  } else {
    mark = icon(state === "ok" ? "check" : "x", 15);
  }
  status.replaceChildren(mark, label);
}

/** A short line describing what a tool is about to do, shown until its result arrives. */
function describeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const pick = a.url ?? a.text ?? a.query ?? a.ref ?? a.key ?? a.from_ref ?? a.direction;
  if (typeof pick === "string" || typeof pick === "number") return String(pick);
  if (Array.isArray(a.steps)) return `${a.steps.length} steps`;
  return "";
}

function addToolCard(id: string, name: string, args: unknown): void {
  hideEmpty();
  const meta = toolMeta(name);
  const root = document.createElement("div");
  root.className = "tool act";

  const badge = document.createElement("span");
  badge.className = "act-icon";
  badge.append(icon(meta.icon, 14));

  const head = document.createElement("div");
  head.className = "tool-head";
  head.setAttribute("role", "button");
  head.tabIndex = 0;
  head.setAttribute("aria-expanded", "false");

  const title = document.createElement("span");
  title.className = "tool-title";
  title.textContent = meta.label;

  const nameEl = document.createElement("span");
  nameEl.className = "tool-name";
  nameEl.textContent = name;

  const status = document.createElement("span");
  setToolStatus(status, "pending");

  head.append(title, nameEl, status, icon("chevron", 14, "act-chevron"));

  const previewEl = document.createElement("div");
  previewEl.className = "tool-preview";
  previewEl.textContent = describeArgs(args) || "…";

  const body = document.createElement("div");
  body.className = "tool-body hidden";

  const argsSection = toolSection("Arguments", JSON.stringify(args ?? {}, null, 2), { open: true });
  const resultSection = toolSection("Result", "", { open: true, hidden: true });

  body.append(argsSection.root, resultSection.root);

  const toggle = () => {
    const open = body.classList.toggle("hidden") === false;
    root.classList.toggle("open", open);
    head.setAttribute("aria-expanded", String(open));
  };
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });
  previewEl.addEventListener("click", toggle);

  root.append(badge, head, previewEl, body);
  transcript.append(root);
  toolCards.set(id, { root, name, status, body, preview: previewEl, args: argsSection, result: resultSection });
  scrollToBottom();
}

function finishToolCard(id: string, ok: boolean, preview: string, output: string): void {
  const card = toolCards.get(id);
  if (!card) return;
  setToolStatus(card.status, ok ? "ok" : "err");
  card.preview.textContent = preview || "(no output)";
  card.preview.title = preview;

  const text = output || preview || "(no output)";
  card.result.root.classList.remove("hidden");
  card.result.pre.textContent = text;
  card.result.size.textContent = formatSize(text);
  scrollToBottom();
}

function renderPlan(steps: PlanStep[]): void {
  planList.replaceChildren();
  if (!steps.length) {
    planBar.classList.add("hidden");
    return;
  }

  let done = 0;
  for (const step of steps) {
    if (step.status === "done") done += 1;
    const li = document.createElement("li");
    li.className = `plan-step ${step.status}`;
    li.textContent = step.step;
    planList.append(li);
  }

  const current = steps.find((s) => s.status === "in_progress") ?? steps.find((s) => s.status === "pending");
  planCurrent.textContent = current ? current.step : "All steps done";
  planProgress.textContent = `${done}/${steps.length}`;
  planMeter.style.width = `${Math.round((done / steps.length) * 100)}%`;
  planBar.classList.remove("hidden");
}

planToggle.addEventListener("click", () => {
  const collapsed = planBar.classList.toggle("collapsed");
  planToggle.setAttribute("aria-expanded", String(!collapsed));
});

/* ---------- live activity strip ---------- */

let runStartedAt = 0;
let activityTimer: number | undefined;
let activityStepNo = 0;

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function tickActivity(): void {
  activityTime.textContent = formatElapsed(Date.now() - runStartedAt);
}

/** What the agent is doing right now, with the run's elapsed time. Live runs only. */
function setActivity(text: string, waiting = false): void {
  if (replaying || !running) return;
  activityText.textContent = text;
  activityStep.textContent = activityStepNo ? `· step ${activityStepNo}` : "";
  activityBar.classList.toggle("waiting", waiting);
}

function startActivity(): void {
  runStartedAt = Date.now();
  activityStepNo = 0;
  activityBar.classList.remove("hidden");
  tickActivity();
  if (activityTimer !== undefined) clearInterval(activityTimer);
  activityTimer = setInterval(tickActivity, 1000) as unknown as number;
  setActivity("Waiting for the model");
}

function stopActivity(): void {
  if (activityTimer !== undefined) clearInterval(activityTimer);
  activityTimer = undefined;
  activityBar.classList.add("hidden");
  activityBar.classList.remove("waiting");
}

function updateSendState(): void {
  sendBtn.disabled = !promptInput.value.trim();
}

function setRunning(next: boolean): void {
  const wasRunning = running;
  running = next;
  statusDot.classList.toggle("running", next);
  // A finished run's plan stops animating its unfinished step.
  planBar.classList.toggle("idle", !next);
  sendBtn.classList.toggle("hidden", next);
  stopBtn.classList.toggle("hidden", !next);
  promptInput.disabled = next;
  if (next && !wasRunning && !replaying) startActivity();
  if (!next) {
    stopActivity();
    flushAssistant();
    currentAssistant = null;
    currentAssistantText = "";
    endReasoningRun();
    updateSendState();
    promptInput.focus();
  }
}

/* ------------------------------------------------------------------ */
/* events                                                              */
/* ------------------------------------------------------------------ */

function handleEvent(event: RuntimeEvent): void {
  if (event.type !== "agent/retry") clearRetryNote();

  switch (event.type) {
    case "agent/retry":
      showRetryNote(event);
      setActivity("Waiting for the model server", true);
      break;

    case "agent/delta": {
      if (!event.text) break;
      setActivity("Writing the answer");
      if (!currentAssistant) {
        currentAssistant = addMessage("assistant", "");
        currentAssistantText = "";
      }
      currentAssistantText += event.text;
      scheduleAssistantRender();
      break;
    }

    case "agent/step": {
      // A new model turn starts: close the previous step's block so each
      // step's thinking stays separate, but keep the run's group intact.
      endReasoningStep();
      flushAssistant();
      currentAssistant = null;
      currentAssistantText = "";
      activityStepNo = event.step;
      setActivity("Waiting for the model");
      break;
    }

    case "agent/reasoning": {
      if (!event.text) break;
      setActivity("Thinking");
      if (!currentReasoning) {
        const steps = ensureReasoningGroup();
        reasoningStepCount += 1;
        if (reasoningGroupCount) {
          reasoningGroupCount.textContent =
            reasoningStepCount === 1 ? "1 step" : `${reasoningStepCount} steps`;
        }

        const wrap = document.createElement("details");
        wrap.className = "msg assistant reasoning-block";
        wrap.open = true;
        const label = document.createElement("summary");
        label.className = "msg-role";
        label.textContent = `Step ${reasoningStepCount}`;
        const body = document.createElement("div");
        body.className = "reasoning";
        wrap.append(label, body);
        steps.append(wrap);
        currentReasoning = body;
        currentReasoningBlock = wrap;
      }
      if (!replaying) reasoningGroup?.classList.add("live");
      currentReasoning.textContent = (currentReasoning.textContent ?? "") + event.text;
      scrollToBottom();
      break;
    }

    case "agent/tool_start":
      // Collapse the thinking that led to this call so the card is the focus.
      endReasoningStep();
      addToolCard(event.id, event.name, event.args);
      setActivity(`${toolMeta(event.name).label}…`);
      break;

    case "agent/tool_end":
      // Older stored transcripts predate the `output` field.
      finishToolCard(event.id, event.ok, event.preview, event.output ?? event.preview);
      setActivity("Waiting for the model");
      break;

    case "agent/approval": {
      pendingApproval = { origin: event.origin };
      approvalTool.textContent = toolMeta(event.toolName).label.toLowerCase();
      approvalOrigin.textContent = event.origin;
      // The summary reads "<tool> on <origin> — <why this site needs approval>".
      const why = event.summary.split(" — ").slice(1).join(" — ");
      approvalDetail.textContent = why ? why.charAt(0).toUpperCase() + why.slice(1) : "";
      approvalBar.classList.remove("hidden");
      setActivity("Waiting for your approval", true);
      break;
    }

    case "agent/plan":
      renderPlan(event.steps);
      break;

    case "agent/gif":
      exportGifBtn.classList.toggle("hidden", event.frames < 2);
      break;

    case "agent/error":
      addError(event.message);
      statusDot.classList.add("error");
      setRunning(false);
      break;

    case "agent/done":
      setRunning(false);
      break;
  }
}

onEvent((event: RuntimeEvent) => {
  // A retry note is live status, not part of the conversation, so it is not stored.
  if (event.type !== "agent/retry") record({ kind: "event", event });
  handleEvent(event);
  if (event.type === "agent/done" || event.type === "agent/error") {
    void persist();
  } else {
    scheduleSave();
  }
});

/* ------------------------------------------------------------------ */
/* actions                                                             */
/* ------------------------------------------------------------------ */

async function submit(): Promise<void> {
  const prompt = promptInput.value.trim();
  if (!prompt || running) return;

  // Snapshot the earlier turns before this prompt is recorded, otherwise the
  // new prompt would appear twice in the model's message list.
  const history = buildHistory();

  promptInput.value = "";
  promptInput.style.height = "auto";
  updateSendState();
  addMessage("user", prompt);
  record({ kind: "user", text: prompt });
  statusDot.classList.remove("error");
  renderPlan([]);
  exportGifBtn.classList.add("hidden");
  setRunning(true);

  try {
    await sendRequest({ type: "agent/run", prompt, history });
  } catch (err) {
    addError(err instanceof Error ? err.message : String(err));
    setRunning(false);
  }
}

sendBtn.addEventListener("click", () => void submit());

stopBtn.addEventListener("click", () => {
  void sendRequest({ type: "agent/abort" }).catch(() => undefined);
  setRunning(false);
});

promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void submit();
  }
});

promptInput.addEventListener("input", () => {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 160)}px`;
  updateSendState();
});

for (const chip of Array.from(document.querySelectorAll<HTMLButtonElement>(".chip"))) {
  chip.addEventListener("click", () => {
    promptInput.value = chip.dataset.prompt ?? "";
    void submit();
  });
}

approvalAllow.addEventListener("click", () => {
  if (!pendingApproval) return;
  void sendRequest({
    type: "permission/respond",
    origin: pendingApproval.origin,
    decision: "allow",
    remember: approvalRemember.checked,
  });
  pendingApproval = null;
  approvalBar.classList.add("hidden");
  setActivity("Working");
});

approvalDeny.addEventListener("click", () => {
  if (!pendingApproval) return;
  void sendRequest({
    type: "permission/respond",
    origin: pendingApproval.origin,
    decision: "deny",
    remember: approvalRemember.checked,
  });
  pendingApproval = null;
  approvalBar.classList.add("hidden");
});

openOptions.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

modelChip.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

/* ---------- the tab the agent will act on ---------- */

async function refreshTab(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const title = tab?.title || tab?.url || "No tab";
    tabTitle.textContent = title;
    tabChip.title = tab?.url ? `Acting on: ${tab.url}` : "The tab the agent acts on";
    const fav = tab?.favIconUrl;
    if (fav && /^(https?:|data:)/.test(fav)) {
      if (tabFavicon.src !== fav) tabFavicon.src = fav;
      tabFavicon.classList.remove("hidden");
      tabFallback.classList.add("hidden");
    } else {
      tabFavicon.classList.add("hidden");
      tabFallback.classList.remove("hidden");
    }
  } catch {
    tabTitle.textContent = "Current tab";
  }
}

tabFavicon.addEventListener("error", () => {
  tabFavicon.classList.add("hidden");
  tabFallback.classList.remove("hidden");
});

chrome.tabs?.onActivated?.addListener(() => void refreshTab());
chrome.tabs?.onUpdated?.addListener((_id, info, tab) => {
  if (tab.active && (info.title || info.url || info.favIconUrl || info.status === "complete")) void refreshTab();
});
chrome.windows?.onFocusChanged?.addListener(() => void refreshTab());

function resetChat(): void {
  clearRetryNote();
  transcript.replaceChildren(emptyState);
  emptyState.classList.remove("hidden");
  toolCards.clear();
  currentAssistant = null;
  currentAssistantText = "";
  assistantRenderQueued = false;
  currentReasoning = null;
  currentReasoningBlock = null;
  reasoningGroup = null;
  reasoningGroupBody = null;
  reasoningGroupCount = null;
  reasoningStepCount = 0;
  pendingApproval = null;
  approvalBar.classList.add("hidden");
  renderPlan([]);
  exportGifBtn.classList.add("hidden");
  statusDot.classList.remove("error");
  promptInput.value = "";
  promptInput.style.height = "auto";
  updateSendState();
  promptInput.focus();
}

/* ------------------------------------------------------------------ */
/* history panel                                                       */
/* ------------------------------------------------------------------ */

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

/** Date bucket for grouping the history list. */
function dayGroup(ts: number): string {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const day = 86400000;
  if (ts >= startOfToday.getTime()) return "Today";
  if (ts >= startOfToday.getTime() - day) return "Yesterday";
  if (ts >= startOfToday.getTime() - 6 * day) return "Previous 7 days";
  return "Older";
}

function renderHistoryList(rows: ConversationSummary[]): void {
  historyList.replaceChildren();

  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    const text = document.createElement("span");
    text.textContent = "No conversations yet.";
    empty.append(icon("history", 22), text);
    historyList.append(empty);
    return;
  }

  let lastGroup = "";
  for (const row of rows) {
    const group = dayGroup(row.updatedAt);
    if (group !== lastGroup) {
      const heading = document.createElement("div");
      heading.className = "history-group";
      heading.textContent = group;
      historyList.append(heading);
      lastGroup = group;
    }

    const item = document.createElement("div");
    item.className = "history-item";
    if (conversation?.id === row.id) item.classList.add("active");

    const open = document.createElement("button");
    open.type = "button";
    open.className = "history-open";

    const title = document.createElement("span");
    title.className = "history-item-title";
    title.textContent = row.title;

    const meta = document.createElement("span");
    meta.className = "history-item-meta";
    meta.textContent = `${relativeTime(row.updatedAt)} · ${row.messageCount} msg`;

    open.append(title, meta);
    open.addEventListener("click", () => void openConversation(row.id));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "history-del";
    del.title = "Delete conversation";
    del.setAttribute("aria-label", `Delete "${row.title}"`);
    del.append(icon("trash", 15));
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      void deleteConversation(row.id);
    });

    item.append(open, del);
    historyList.append(item);
  }
}

async function refreshHistory(): Promise<void> {
  try {
    const rows = await sendRequest<ConversationSummary[]>({ type: "history/list" });
    renderHistoryList(rows ?? []);
  } catch {
    renderHistoryList([]);
  }
}

function setHistoryOpen(open: boolean): void {
  historyPanel.classList.toggle("hidden", !open);
  historyScrim.classList.toggle("hidden", !open);
  historyBtn.setAttribute("aria-expanded", String(open));
  if (open) void refreshHistory();
}

async function openConversation(id: string): Promise<void> {
  if (running) {
    void sendRequest({ type: "agent/abort" }).catch(() => undefined);
    setRunning(false);
  }

  const stored = await sendRequest<Conversation | null>({ type: "history/get", id }).catch(
    () => null,
  );
  if (!stored) return;

  resetChat();
  conversation = stored;
  setHistoryOpen(false);

  replaying = true;
  try {
    for (const item of stored.items) {
      if (item.kind === "user") addMessage("user", item.text);
      else handleEvent(item.event);
    }
    flushAssistant();
  } finally {
    replaying = false;
  }

  // A replayed transcript is a finished run, so drop any live-run affordances.
  setRunning(false);
  approvalBar.classList.add("hidden");
  pendingApproval = null;
  scrollToBottom();
}

async function deleteConversation(id: string): Promise<void> {
  await sendRequest({ type: "history/delete", id }).catch(() => undefined);
  if (conversation?.id === id) {
    conversation = null;
    resetChat();
  }
  await refreshHistory();
}

historyBtn.addEventListener("click", () => {
  setHistoryOpen(historyPanel.classList.contains("hidden"));
});

historyScrim.addEventListener("click", () => setHistoryOpen(false));
historyClose.addEventListener("click", () => setHistoryOpen(false));

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !historyPanel.classList.contains("hidden")) setHistoryOpen(false);
});

historyClear.addEventListener("click", () => {
  void (async () => {
    await sendRequest({ type: "history/clear" }).catch(() => undefined);
    conversation = null;
    resetChat();
    await refreshHistory();
  })();
});

newChatBtn.addEventListener("click", () => {
  if (running) {
    void sendRequest({ type: "agent/abort" }).catch(() => undefined);
    setRunning(false);
  }
  void persist();
  conversation = newConversation();
  resetChat();
  setHistoryOpen(false);
});

exportGifBtn.addEventListener("click", () => {
  void (async () => {
    try {
      const result = await sendRequest<{ dataUrl: string; frames: number } | null>({
        type: "gif/export",
      });
      if (!result?.dataUrl) {
        addError("No recording available for this tab.");
        return;
      }
      const a = document.createElement("a");
      a.href = result.dataUrl;
      a.download = `navix-agent-${Date.now()}.gif`;
      a.click();
    } catch (err) {
      addError(err instanceof Error ? err.message : String(err));
    }
  })();
});

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

// Keep the model chip current when settings are saved in the options page.
chrome.storage.onChanged.addListener((changes, area) => {
  const next = changes.settings?.newValue as Partial<Settings> | undefined;
  if (area !== "local" || !next) return;
  modelLabel.textContent = next.model || "no model";
  modelChip.title = `${next.model || "No model"} · open settings`;
});

async function boot(): Promise<void> {
  conversation = newConversation();

  updateSendState();
  void refreshTab();

  try {
    const settings = await sendRequest<Settings>({ type: "settings/get" });
    modelLabel.textContent = settings.model || "no model";
    modelChip.title = `${settings.model || "No model"} · open settings`;
    if (!settings.apiKey && settings.provider !== "custom") {
      addError("No API key yet. Open settings and add one to get started.");
    }
  } catch {
    modelLabel.textContent = "offline";
  }

  const state = await sendRequest<{ running: boolean; plan?: PlanStep[] }>({
    type: "agent/state",
  }).catch(() => null);
  if (state?.running) setRunning(true);
  if (state?.plan?.length) renderPlan(state.plan);

  await refreshHistory();
  promptInput.focus();
}

void boot();
