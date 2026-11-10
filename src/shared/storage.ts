import type {
  Conversation,
  ConversationSummary,
  DomainPermission,
  PermissionStore,
  Settings,
} from "./types";
import { PROVIDERS } from "./providers";

const SETTINGS_KEY = "settings";
const PERMISSIONS_KEY = "permissions";
const HISTORY_KEY = "conversations";

/** Keep the newest N conversations so `chrome.storage.local` stays bounded. */
export const HISTORY_LIMIT = 50;

export const DEFAULT_SETTINGS: Settings = {
  provider: "deepseek",
  baseUrl: PROVIDERS.deepseek.baseUrl,
  apiKey: "",
  model: PROVIDERS.deepseek.defaultModel,
  temperature: 0.2,
  // Thinking counts toward this, so 4096 often left reasoning models no room
  // to answer. Kept moderate because hosted APIs cap output per model.
  maxTokens: 8192,
  maxSteps: 25,
  reasoningEffort: "medium",
  approvalMode: "ask",
  systemPromptExtra: "",
  visionEnabled: false,
  dialogPolicy: "dismiss",
  safetyMode: "standard",
  visualFeedback: true,
};

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = stored[SETTINGS_KEY] as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function getPermissions(): Promise<PermissionStore> {
  const stored = await chrome.storage.local.get(PERMISSIONS_KEY);
  const raw = stored[PERMISSIONS_KEY] as PermissionStore | undefined;
  return raw && raw.domains ? raw : { domains: {} };
}

export async function setDomainPermission(
  origin: string,
  state: DomainPermission["state"],
): Promise<void> {
  const store = await getPermissions();
  store.domains[origin] = { origin, state, updatedAt: Date.now() };
  await chrome.storage.local.set({ [PERMISSIONS_KEY]: store });
}

export async function clearPermissions(origin?: string): Promise<void> {
  if (!origin) {
    await chrome.storage.local.set({ [PERMISSIONS_KEY]: { domains: {} } });
    return;
  }
  const store = await getPermissions();
  delete store.domains[origin];
  await chrome.storage.local.set({ [PERMISSIONS_KEY]: store });
}

export function originOf(url: string | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* chat history                                                        */
/* ------------------------------------------------------------------ */

async function readHistory(): Promise<Conversation[]> {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const raw = stored[HISTORY_KEY] as Conversation[] | undefined;
  return Array.isArray(raw) ? raw : [];
}

async function writeHistory(list: Conversation[]): Promise<void> {
  await chrome.storage.local.set({ [HISTORY_KEY]: list });
}

/** Newest first, without the transcript payload. */
export async function listConversations(): Promise<ConversationSummary[]> {
  const list = await readHistory();
  return list
    .map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messageCount: c.items.filter((i) => i.kind === "user").length,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const list = await readHistory();
  return list.find((c) => c.id === id) ?? null;
}

/** Insert or replace by id, then trim to `HISTORY_LIMIT` newest entries. */
export async function saveConversation(conversation: Conversation): Promise<void> {
  const list = await readHistory();
  const index = list.findIndex((c) => c.id === conversation.id);
  if (index >= 0) list[index] = conversation;
  else list.push(conversation);

  list.sort((a, b) => b.updatedAt - a.updatedAt);
  await writeHistory(list.slice(0, HISTORY_LIMIT));
}

export async function deleteConversation(id: string): Promise<void> {
  const list = await readHistory();
  await writeHistory(list.filter((c) => c.id !== id));
}

export async function clearConversations(): Promise<void> {
  await writeHistory([]);
}
