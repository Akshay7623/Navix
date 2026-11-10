/**
 * DOM access helpers.
 *
 * The accessibility-tree content script installs `window.__navixAgent` in the
 * extension's isolated world. `chrome.scripting.executeScript` defaults to that
 * same isolated world, so these helpers can reach it without touching the
 * page's own globals.
 */

export interface Snapshot {
  text: string;
  count: number;
  url: string;
  title: string;
}

export interface ElementInfo {
  tag: string;
  role: string;
  name: string;
  value: string;
  rect: { x: number; y: number; width: number; height: number };
  center: { x: number; y: number };
  inViewport: boolean;
}

export interface TextHit {
  role: string;
  name: string;
  ref: string | null;
  text: string;
}

interface AgentBridge {
  snapshot(): Snapshot;
  describe(ref: string): ElementInfo | null;
  scrollIntoView(ref: string): boolean;
  focusRef(ref: string): boolean;
  setValue(ref: string, text: string, mode: "replace" | "append"): { ok: boolean; error?: string };
  clickRef(ref: string): { ok: boolean; error?: string };
  findByText(query: string, limit: number): TextHit[];
}

declare global {
  interface Window {
    __navixAgent?: AgentBridge;
  }
}

async function runInPage<A extends unknown[], R>(
  tabId: number,
  func: (...args: A) => R,
  args: A,
): Promise<R> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    world: "ISOLATED",
    func,
    args,
  });
  const first = results[0];
  if (!first) throw new Error("script injection returned no result");
  return first.result as R;
}

export async function ensureBridge(tabId: number): Promise<void> {
  const present = await runInPage(tabId, () => Boolean(window.__navixAgent), []);
  if (present) return;
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ["content/accessibility-tree.js"],
  });
}

export async function snapshot(tabId: number): Promise<Snapshot> {
  await ensureBridge(tabId);
  return runInPage(
    tabId,
    () => {
      const bridge = window.__navixAgent;
      if (!bridge) return { text: "(bridge unavailable)", count: 0, url: location.href, title: document.title };
      return bridge.snapshot();
    },
    [],
  );
}

export async function describe(tabId: number, ref: string): Promise<ElementInfo | null> {
  await ensureBridge(tabId);
  return runInPage(
    tabId,
    (r: string) => window.__navixAgent?.describe(r) ?? null,
    [ref],
  );
}

export async function scrollIntoView(tabId: number, ref: string): Promise<boolean> {
  await ensureBridge(tabId);
  return runInPage(tabId, (r: string) => window.__navixAgent?.scrollIntoView(r) ?? false, [ref]);
}

export async function focusRef(tabId: number, ref: string): Promise<boolean> {
  await ensureBridge(tabId);
  return runInPage(tabId, (r: string) => window.__navixAgent?.focusRef(r) ?? false, [ref]);
}

export async function setValue(
  tabId: number,
  ref: string,
  text: string,
  mode: "replace" | "append" = "replace",
): Promise<{ ok: boolean; error?: string }> {
  await ensureBridge(tabId);
  return runInPage(
    tabId,
    (r: string, t: string, m: "replace" | "append") =>
      window.__navixAgent?.setValue(r, t, m) ?? { ok: false, error: "bridge unavailable" },
    [ref, text, mode],
  );
}

export async function clickRef(tabId: number, ref: string): Promise<{ ok: boolean; error?: string }> {
  await ensureBridge(tabId);
  return runInPage(
    tabId,
    (r: string) => window.__navixAgent?.clickRef(r) ?? { ok: false, error: "bridge unavailable" },
    [ref],
  );
}

export async function findByText(tabId: number, query: string, limit = 20): Promise<TextHit[]> {
  await ensureBridge(tabId);
  return runInPage(
    tabId,
    (q: string, l: number) => window.__navixAgent?.findByText(q, l) ?? [],
    [query, limit],
  );
}

export async function pageText(tabId: number): Promise<string> {
  return runInPage(
    tabId,
    () => {
      const body = document.body;
      if (!body) return "";
      const clone = body.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("script,style,noscript,template,svg").forEach((n) => n.remove());
      return (clone.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    },
    [],
  );
}

export async function viewportSize(tabId: number): Promise<{ width: number; height: number }> {
  return runInPage(
    tabId,
    () => ({ width: window.innerWidth, height: window.innerHeight }),
    [],
  );
}
