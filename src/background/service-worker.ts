import type { RuntimeRequest } from "../shared/types";
import { emitEvent } from "../shared/messaging";
import {
  clearConversations,
  clearPermissions,
  deleteConversation,
  getConversation,
  getPermissions,
  getSettings,
  listConversations,
  saveConversation,
  setSettings,
} from "../shared/storage";
import * as agent from "./agent";
import * as cdp from "./cdp";
import * as gif from "./gif";
import { resolveApproval } from "./permissions";

/* ------------------------------------------------------------------ */
/* side panel wiring                                                   */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

/* ------------------------------------------------------------------ */
/* keepalive                                                           */
/* ------------------------------------------------------------------ */

/**
 * MV3 service workers are killed after ~30s of inactivity. A long agent run
 * holds an open message port, which usually keeps the worker alive, but a slow
 * provider response can still trip the timer. Poking an extension API on an
 * alarm keeps the worker warm while a run is active.
 */
const KEEPALIVE_ALARM = "agent-keepalive";

function startKeepalive(): void {
  // 0.5 min is the shortest period Chrome accepts for unpacked extensions.
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
}

function stopKeepalive(): void {
  void chrome.alarms.clear(KEEPALIVE_ALARM);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (!agent.getState().running) {
    stopKeepalive();
    return;
  }
  void chrome.runtime.getPlatformInfo();
});

/* ------------------------------------------------------------------ */
/* message router                                                      */
/* ------------------------------------------------------------------ */

type Handler = (req: RuntimeRequest) => Promise<unknown>;

const handlers: Record<RuntimeRequest["type"], Handler> = {
  "agent/run": async (req) => {
    if (req.type !== "agent/run") return null;
    const tabId = req.tabId ?? (await activeTabId());
    if (tabId === undefined) throw new Error("No active tab to drive.");
    startKeepalive();
    // Fire and forget: progress is reported through events so the side panel
    // stays responsive while the loop runs.
    void agent
      .run({ prompt: req.prompt, tabId, history: req.history })
      .catch((err: unknown) => {
        emitEvent({
          type: "agent/error",
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => stopKeepalive());
    return { started: true, tabId };
  },

  "agent/abort": async () => {
    agent.abort();
    stopKeepalive();
    return { aborted: true };
  },

  "agent/state": async () => agent.getState(),

  "permission/respond": async (req) => {
    if (req.type !== "permission/respond") return null;
    await resolveApproval(req.origin, req.decision, req.remember);
    return { ok: true };
  },

  "settings/get": async () => getSettings(),

  "settings/set": async (req) => {
    if (req.type !== "settings/set") return null;
    return setSettings(req.settings);
  },

  "permissions/list": async () => getPermissions(),

  "permissions/clear": async (req) => {
    if (req.type !== "permissions/clear") return null;
    await clearPermissions(req.origin);
    return { ok: true };
  },

  "tab/active": async () => {
    const tabId = await activeTabId();
    if (tabId === undefined) return null;
    const tab = await chrome.tabs.get(tabId);
    return { id: tab.id, url: tab.url, title: tab.title };
  },

  "gif/export": async () => {
    const tabId = await activeTabId();
    if (tabId === undefined) return null;
    const last = gif.getLast(tabId);
    if (!last) return null;
    return { dataUrl: last.dataUrl, frames: last.frames, at: last.at };
  },

  "history/list": async () => listConversations(),

  "history/get": async (req) => {
    if (req.type !== "history/get") return null;
    return getConversation(req.id);
  },

  "history/save": async (req) => {
    if (req.type !== "history/save") return null;
    await saveConversation(req.conversation);
    return { ok: true };
  },

  "history/delete": async (req) => {
    if (req.type !== "history/delete") return null;
    await deleteConversation(req.id);
    return { ok: true };
  },

  "history/clear": async () => {
    await clearConversations();
    return { ok: true };
  },
};

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id;
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  const req = message as RuntimeRequest & { __event?: boolean };
  if (req.__event) return false;

  const handler = handlers[req.type];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown request type: ${String(req.type)}` });
    return false;
  }

  handler(req)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err: unknown) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );

  return true;
});

/* ------------------------------------------------------------------ */
/* lifecycle hygiene                                                   */
/* ------------------------------------------------------------------ */

chrome.tabs.onRemoved.addListener((tabId) => {
  gif.clearLast(tabId);
  void cdp.release(tabId).catch(() => undefined);
});

chrome.runtime.onSuspend.addListener(() => {
  agent.abort();
});
