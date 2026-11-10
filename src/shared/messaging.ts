import type { RuntimeEvent, RuntimeRequest } from "./types";

export async function sendRequest<T = unknown>(req: RuntimeRequest): Promise<T> {
  const res = (await chrome.runtime.sendMessage(req)) as
    | { ok: true; data: T }
    | { ok: false; error: string }
    | undefined;
  if (!res) throw new Error("No response from background service worker");
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

export function onEvent(handler: (event: RuntimeEvent) => void): () => void {
  const listener = (msg: unknown) => {
    if (msg && typeof msg === "object" && (msg as { __event?: boolean }).__event) {
      handler((msg as { event: RuntimeEvent }).event);
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

export function emitEvent(event: RuntimeEvent): void {
  void chrome.runtime.sendMessage({ __event: true, event }).catch(() => {
    /* side panel may be closed */
  });
}
