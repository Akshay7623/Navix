/**
 * Thin wrapper over chrome.debugger. One attachment per tab, reference counted
 * so overlapping tool calls do not detach each other.
 */

interface Attachment {
  refs: number;
  consoleMessages: ConsoleEntry[];
  networkRequests: Map<string, NetworkEntry>;
  dialogs: DialogEntry[];
  dialogPolicy: DialogPolicy;
  listeners: Array<{ event: string; fn: (source: chrome.debugger.Debuggee, method: string, params?: object) => void }>;
}

export type DialogPolicy = "dismiss" | "accept";

export interface DialogEntry {
  dialogType: string;
  message: string;
  defaultValue?: string;
  action: "accepted" | "dismissed";
  at: number;
}

export interface ConsoleEntry {
  level: string;
  text: string;
  url?: string;
  line?: number;
  at: number;
}

export interface NetworkEntry {
  requestId: string;
  url: string;
  method: string;
  status?: number;
  type?: string;
  mimeType?: string;
  failed?: string;
  at: number;
}

const attachments = new Map<number, Attachment>();

function onDebuggerEvent(
  source: chrome.debugger.Debuggee,
  method: string,
  params?: object,
): void {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  const att = attachments.get(tabId);
  if (!att) return;

  if (method === "Runtime.consoleAPICalled") {
    const p = params as {
      type: string;
      args: Array<{ value?: unknown; description?: string; type: string }>;
      stackTrace?: { callFrames: Array<{ url: string; lineNumber: number }> };
    };
    const text = p.args
      .map((a) => {
        if (a.value !== undefined) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
        return a.description ?? `<${a.type}>`;
      })
      .join(" ");
    const frame = p.stackTrace?.callFrames?.[0];
    att.consoleMessages.push({
      level: p.type,
      text,
      url: frame?.url,
      line: frame ? frame.lineNumber + 1 : undefined,
      at: Date.now(),
    });
    if (att.consoleMessages.length > 500) att.consoleMessages.splice(0, att.consoleMessages.length - 500);
  }

  if (method === "Runtime.exceptionThrown") {
    const p = params as {
      exceptionDetails: { text: string; url?: string; lineNumber?: number; exception?: { description?: string } };
    };
    att.consoleMessages.push({
      level: "error",
      text: p.exceptionDetails.exception?.description ?? p.exceptionDetails.text,
      url: p.exceptionDetails.url,
      line: p.exceptionDetails.lineNumber !== undefined ? p.exceptionDetails.lineNumber + 1 : undefined,
      at: Date.now(),
    });
  }

  if (method === "Network.requestWillBeSent") {
    const p = params as { requestId: string; request: { url: string; method: string }; type?: string };
    att.networkRequests.set(p.requestId, {
      requestId: p.requestId,
      url: p.request.url,
      method: p.request.method,
      type: p.type,
      at: Date.now(),
    });
  }

  if (method === "Network.responseReceived") {
    const p = params as {
      requestId: string;
      response: { status: number; mimeType: string };
      type?: string;
    };
    const entry = att.networkRequests.get(p.requestId);
    if (entry) {
      entry.status = p.response.status;
      entry.mimeType = p.response.mimeType;
      entry.type = p.type ?? entry.type;
    }
  }

  if (method === "Network.loadingFailed") {
    const p = params as { requestId: string; errorText: string };
    const entry = att.networkRequests.get(p.requestId);
    if (entry) entry.failed = p.errorText;
  }

  if (method === "Page.javascriptDialogOpening") {
    const p = params as { type: string; message: string; defaultPrompt?: string };
    // A JS dialog blocks the renderer, so every subsequent CDP call would hang
    // until it is answered. Answer it here, synchronously with respect to the
    // event, or the whole agent run deadlocks.
    const accept = att.dialogPolicy === "accept" && p.type !== "beforeunload";
    att.dialogs.push({
      dialogType: p.type,
      message: p.message,
      defaultValue: p.defaultPrompt,
      action: accept ? "accepted" : "dismissed",
      at: Date.now(),
    });
    if (att.dialogs.length > 50) att.dialogs.splice(0, att.dialogs.length - 50);
    void chrome.debugger
      .sendCommand({ tabId }, "Page.handleJavaScriptDialog", {
        accept,
        promptText: accept ? (p.defaultPrompt ?? "") : undefined,
      })
      .catch(() => undefined);
  }
}

chrome.debugger.onEvent.addListener(onDebuggerEvent);

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) attachments.delete(source.tabId);
});

export async function attach(tabId: number): Promise<void> {
  const existing = attachments.get(tabId);
  if (existing) {
    existing.refs += 1;
    return;
  }

  await chrome.debugger.attach({ tabId }, "1.3");
  const att: Attachment = {
    refs: 1,
    consoleMessages: [],
    networkRequests: new Map(),
    dialogs: [],
    dialogPolicy: "dismiss",
    listeners: [],
  };
  attachments.set(tabId, att);

  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  await chrome.debugger.sendCommand({ tabId }, "Page.enable");
  await chrome.debugger.sendCommand({ tabId }, "Network.enable");
  await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", {
    enabled: true,
  });
}

export async function detach(tabId: number): Promise<void> {
  const att = attachments.get(tabId);
  if (!att) return;
  att.refs -= 1;
  if (att.refs > 0) return;
  attachments.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* tab may already be gone */
  }
}

export async function withTab<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  await attach(tabId);
  try {
    return await fn();
  } finally {
    await detach(tabId);
  }
}

/**
 * Attach once and keep the session open for the rest of the agent run.
 *
 * Console and network buffers live on the attachment, so detaching between tool
 * calls would silently discard everything `read_console_messages` and
 * `read_network_requests` are supposed to report.
 */
export async function ensure(tabId: number): Promise<void> {
  if (attachments.has(tabId)) return;
  await attach(tabId);
}

export async function release(tabId: number): Promise<void> {
  const att = attachments.get(tabId);
  if (!att) return;
  att.refs = 1;
  await detach(tabId);
}

export async function sendCommand<T = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
}

export async function evaluate<T = unknown>(
  tabId: number,
  expression: string,
  opts: { awaitPromise?: boolean; userGesture?: boolean } = {},
): Promise<T> {
  const res = await sendCommand<{
    result: { value?: T; description?: string };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? true,
    userGesture: opts.userGesture ?? true,
    replMode: true,
  });

  if (res.exceptionDetails) {
    throw new Error(
      res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "evaluation failed",
    );
  }
  return res.result.value as T;
}

export async function screenshot(
  tabId: number,
  opts: { fullPage?: boolean; format?: "png" | "jpeg"; quality?: number } = {},
): Promise<string> {
  const params: Record<string, unknown> = {
    format: opts.format ?? "jpeg",
    quality: opts.quality ?? 70,
  };

  if (opts.fullPage) {
    const metrics = await sendCommand<{ contentSize: { width: number; height: number } }>(
      tabId,
      "Page.getLayoutMetrics",
    );
    params.clip = {
      x: 0,
      y: 0,
      width: Math.ceil(metrics.contentSize.width),
      height: Math.ceil(metrics.contentSize.height),
      scale: 1,
    };
    params.captureBeyondViewport = true;
  }

  const res = await sendCommand<{ data: string }>(tabId, "Page.captureScreenshot", params);
  return `data:image/${params.format === "png" ? "png" : "jpeg"};base64,${res.data}`;
}

export async function dispatchMouse(
  tabId: number,
  type: "mousePressed" | "mouseReleased" | "mouseMoved",
  x: number,
  y: number,
  opts: { button?: "left" | "right" | "middle" | "none"; clickCount?: number; modifiers?: number } = {},
): Promise<void> {
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: opts.button ?? "left",
    clickCount: opts.clickCount ?? 1,
    modifiers: opts.modifiers ?? 0,
  });
}

export async function clickAt(
  tabId: number,
  x: number,
  y: number,
  opts: { button?: "left" | "right" | "middle"; clickCount?: number } = {},
): Promise<void> {
  const button = opts.button ?? "left";
  const clickCount = opts.clickCount ?? 1;
  await dispatchMouse(tabId, "mouseMoved", x, y, { button: "none" });
  await dispatchMouse(tabId, "mousePressed", x, y, { button, clickCount });
  await dispatchMouse(tabId, "mouseReleased", x, y, { button, clickCount });
}

export async function typeText(tabId: number, text: string): Promise<void> {
  await sendCommand(tabId, "Input.insertText", { text });
}

export async function pressKey(
  tabId: number,
  key: string,
  modifiers: number = 0,
): Promise<void> {
  const map: Record<string, { key: string; code: string; keyCode: number }> = {
    Enter: { key: "Enter", code: "Enter", keyCode: 13 },
    Tab: { key: "Tab", code: "Tab", keyCode: 9 },
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
    Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
    Delete: { key: "Delete", code: "Delete", keyCode: 46 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    Home: { key: "Home", code: "Home", keyCode: 36 },
    End: { key: "End", code: "End", keyCode: 35 },
    PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
    PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
    Space: { key: " ", code: "Space", keyCode: 32 },
  };

  const spec = map[key];
  if (!spec) {
    if (key.length === 1) {
      await sendCommand(tabId, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key,
        text: key,
        modifiers,
      });
      await sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key, modifiers });
      return;
    }
    throw new Error(`unsupported key: ${key}`);
  }

  await sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
    modifiers,
  });
  await sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
    modifiers,
  });
}

export async function scrollAt(
  tabId: number,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX,
    deltaY,
  });
}

/**
 * Press, move in steps, release. HTML5 drag-and-drop needs intermediate
 * `mouseMoved` events or the browser never starts a drag session, and
 * `dragstart`/`dragover` handlers never fire.
 */
export async function dragBetween(
  tabId: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: { steps?: number; button?: "left" | "right" | "middle" } = {},
): Promise<void> {
  const steps = Math.max(2, opts.steps ?? 12);
  const button = opts.button ?? "left";

  await dispatchMouse(tabId, "mouseMoved", from.x, from.y, { button: "none" });
  await dispatchMouse(tabId, "mousePressed", from.x, from.y, { button, clickCount: 1 });

  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    await dispatchMouse(tabId, "mouseMoved", from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, {
      button,
    });
  }

  await dispatchMouse(tabId, "mouseReleased", to.x, to.y, { button, clickCount: 1 });
}

export async function setViewport(
  tabId: number,
  width: number,
  height: number,
  opts: { deviceScaleFactor?: number; mobile?: boolean } = {},
): Promise<void> {
  await sendCommand(tabId, "Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: opts.deviceScaleFactor ?? 1,
    mobile: opts.mobile ?? false,
  });
}

export async function clearViewport(tabId: number): Promise<void> {
  await sendCommand(tabId, "Emulation.clearDeviceMetricsOverride");
}

export async function setZoom(tabId: number, factor: number): Promise<void> {
  await sendCommand(tabId, "Emulation.setPageScaleFactor", { pageScaleFactor: factor });
}

export async function setFileInputFiles(
  tabId: number,
  ref: string,
  files: string[],
): Promise<void> {
  const { root } = await sendCommand<{ root: { nodeId: number } }>(tabId, "DOM.getDocument", {
    depth: -1,
    pierce: true,
  });
  const { nodeId } = await sendCommand<{ nodeId: number }>(tabId, "DOM.querySelector", {
    nodeId: root.nodeId,
    selector: `[data-navix-agent-ref="${ref}"]`,
  });
  if (!nodeId) throw new Error(`ref ${ref} is not a file input on the page`);
  await sendCommand(tabId, "DOM.setFileInputFiles", { nodeId, files });
}

export function getConsoleMessages(tabId: number): ConsoleEntry[] {
  return attachments.get(tabId)?.consoleMessages ?? [];
}

export function getNetworkRequests(tabId: number): NetworkEntry[] {
  const att = attachments.get(tabId);
  if (!att) return [];
  return Array.from(att.networkRequests.values());
}

export function clearCapture(tabId: number): void {
  const att = attachments.get(tabId);
  if (!att) return;
  att.consoleMessages.length = 0;
  att.networkRequests.clear();
  att.dialogs.length = 0;
}

export function getDialogs(tabId: number): DialogEntry[] {
  return attachments.get(tabId)?.dialogs ?? [];
}

export function setDialogPolicy(tabId: number, policy: DialogPolicy): void {
  const att = attachments.get(tabId);
  if (att) att.dialogPolicy = policy;
}

export function isAttached(tabId: number): boolean {
  return attachments.has(tabId);
}
