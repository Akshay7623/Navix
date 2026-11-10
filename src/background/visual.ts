/**
 * Best-effort in-page feedback. Every call is fire-and-forget: a page that has
 * no content script (chrome://, the web store, a PDF viewer) must never break a
 * tool call, so failures are swallowed.
 */

async function send(tabId: number, message: Record<string, unknown>): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    /* no content script in this tab */
  }
}

export async function showCursor(tabId: number, x: number, y: number, click = false): Promise<void> {
  await send(tabId, { type: "navix-agent/cursor", x, y, click });
}

export async function hideCursor(tabId: number): Promise<void> {
  await send(tabId, { type: "navix-agent/cursor-hide" });
}

export async function showIndicator(tabId: number, text?: string): Promise<void> {
  await send(tabId, { type: "navix-agent/indicator", state: "show", text });
}

export async function hideIndicator(tabId: number): Promise<void> {
  await send(tabId, { type: "navix-agent/indicator", state: "hide" });
}
