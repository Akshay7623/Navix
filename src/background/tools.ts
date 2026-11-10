import type { PlanStep, ToolDefinition, ToolResult, ToolSchema } from "../shared/types";
import * as cdp from "./cdp";
import * as dom from "./dom";
import * as visual from "./visual";

function schema(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): ToolSchema {
  return { type: "function", function: { name, description, parameters } };
}

function str(description: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "string", description, ...extra };
}

function num(description: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "number", description, ...extra };
}

function bool(description: string): Record<string, unknown> {
  return { type: "boolean", description };
}

function ok(content: string, image?: string): ToolResult {
  return image ? { ok: true, content, image } : { ok: true, content };
}

function fail(content: string): ToolResult {
  return { ok: false, content };
}

function truncate(text: string, max = 20000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

/* ------------------------------------------------------------------ */
/* navigation                                                          */
/* ------------------------------------------------------------------ */

const navigate: ToolDefinition = {
  mutating: true,
  schema: schema("navigate", "Load a URL in the active tab and wait for the page to settle.", {
    type: "object",
    properties: {
      url: str("Absolute URL to open. Must start with http:// or https://."),
      wait_ms: num("Extra settle time after load, in milliseconds (default 800)."),
    },
    required: ["url"],
  }),
  async run(args, ctx) {
    const url = String(args.url ?? "");
    if (!/^https?:\/\//i.test(url)) return fail("url must start with http:// or https://");

    const before = await chrome.tabs.get(ctx.tabId).catch(() => null);
    const sameUrl = before?.url === url && before?.status === "complete";

    // Register the load watcher before navigating: a fast page can finish
    // loading before an awaited tabs.update resolves.
    const loaded = sameUrl ? Promise.resolve() : waitForLoad(ctx.tabId, ctx.signal);
    await chrome.tabs.update(ctx.tabId, { url });
    await loaded;

    const extra = Number(args.wait_ms ?? 800);
    if (extra > 0) await sleep(extra, ctx.signal);

    const tab = await chrome.tabs.get(ctx.tabId);
    return ok(`Navigated to ${tab.url ?? url}\nTitle: ${tab.title ?? "(none)"}`);
  },
};

function waitForLoad(tabId: number, signal: AbortSignal, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.webNavigation.onCompleted.removeListener(navListener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === "complete") finish();
    };
    const navListener = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
      if (details.tabId === tabId && details.frameId === 0) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.webNavigation.onCompleted.addListener(navListener);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/* ------------------------------------------------------------------ */
/* reading                                                             */
/* ------------------------------------------------------------------ */

const readPage: ToolDefinition = {
  mutating: false,
  schema: schema(
    "read_page",
    "Return the accessibility tree of the current page. Interactive elements carry a ref_N id you can pass to click/type/scroll_to.",
    {
      type: "object",
      properties: {
        max_chars: num("Truncate the tree to this many characters (default 20000)."),
      },
    },
  ),
  async run(args, ctx) {
    const snap = await dom.snapshot(ctx.tabId);
    const max = Number(args.max_chars ?? 20000);
    return ok(
      `URL: ${snap.url}\nTitle: ${snap.title}\nNodes: ${snap.count}\n\n${truncate(snap.text, max)}`,
    );
  },
};

const getPageText: ToolDefinition = {
  mutating: false,
  schema: schema("get_page_text", "Return the visible text of the page with markup stripped.", {
    type: "object",
    properties: {
      max_chars: num("Truncate to this many characters (default 20000)."),
    },
  }),
  async run(args, ctx) {
    const text = await dom.pageText(ctx.tabId);
    return ok(truncate(text || "(no text)", Number(args.max_chars ?? 20000)));
  },
};

const find: ToolDefinition = {
  mutating: false,
  schema: schema("find", "Search the page for elements whose text contains a query string.", {
    type: "object",
    properties: {
      query: str("Case-insensitive substring to look for."),
      limit: num("Maximum matches to return (default 20)."),
    },
    required: ["query"],
  }),
  async run(args, ctx) {
    const hits = await dom.findByText(ctx.tabId, String(args.query ?? ""), Number(args.limit ?? 20));
    if (!hits.length) return ok(`No elements matched "${args.query}".`);
    const lines = hits.map(
      (h, i) => `${i + 1}. ${h.role}${h.ref ? ` [${h.ref}]` : ""}${h.name ? ` "${h.name}"` : ""} — ${h.text}`,
    );
    return ok(lines.join("\n"));
  },
};

/* ------------------------------------------------------------------ */
/* interaction                                                         */
/* ------------------------------------------------------------------ */

const click: ToolDefinition = {
  mutating: true,
  needsCdp: true,
  schema: schema(
    "click",
    "Click an element. Prefer passing a ref_N from read_page; x/y coordinates are a fallback.",
    {
      type: "object",
      properties: {
        ref: str("Element ref from read_page, e.g. ref_12."),
        x: num("Viewport x coordinate when no ref is given."),
        y: num("Viewport y coordinate when no ref is given."),
        button: str("left, right, or middle (default left).", { enum: ["left", "right", "middle"] }),
        click_count: num("1 for single, 2 for double, 3 for triple (default 1)."),
      },
    },
  ),
  async run(args, ctx) {
    const button = (args.button as "left" | "right" | "middle") ?? "left";
    const clickCount = Number(args.click_count ?? 1);
    const showCursor = ctx.settings.visualFeedback;

    if (typeof args.ref === "string" && args.ref) {
      const info = await dom.describe(ctx.tabId, args.ref);
      if (!info) return fail(`ref ${args.ref} is no longer on the page; call read_page again.`);
      await dom.scrollIntoView(ctx.tabId, args.ref);
      const fresh = await dom.describe(ctx.tabId, args.ref);
      if (!fresh) return fail(`ref ${args.ref} disappeared after scrolling.`);
      if (showCursor) await visual.showCursor(ctx.tabId, fresh.center.x, fresh.center.y, true);
      await cdp.clickAt(ctx.tabId, fresh.center.x, fresh.center.y, { button, clickCount });
      return ok(`Clicked ${fresh.role} "${fresh.name}" [${args.ref}] at (${Math.round(fresh.center.x)}, ${Math.round(fresh.center.y)}).`);
    }

    if (typeof args.x === "number" && typeof args.y === "number") {
      if (showCursor) await visual.showCursor(ctx.tabId, args.x, args.y, true);
      await cdp.clickAt(ctx.tabId, args.x, args.y, { button, clickCount });
      return ok(`Clicked at (${args.x}, ${args.y}).`);
    }

    return fail("Provide either ref or both x and y.");
  },
};

const typeTool: ToolDefinition = {
  mutating: true,
  needsCdp: true,
  schema: schema(
    "type",
    "Type text into an element. Focuses the ref first, then inserts the text.",
    {
      type: "object",
      properties: {
        ref: str("Element ref from read_page."),
        text: str("Text to enter."),
        mode: str("replace (default) or append.", { enum: ["replace", "append"] }),
        submit: bool("Press Enter after typing (default false)."),
      },
      required: ["text"],
    },
  ),
  async run(args, ctx) {
    const text = String(args.text ?? "");
    const mode = (args.mode as "replace" | "append") ?? "replace";

    if (typeof args.ref === "string" && args.ref) {
      const info = await dom.describe(ctx.tabId, args.ref);
      if (!info) return fail(`ref ${args.ref} is no longer on the page; call read_page again.`);
      await dom.scrollIntoView(ctx.tabId, args.ref);
      if (ctx.settings.visualFeedback) {
        const fresh = await dom.describe(ctx.tabId, args.ref);
        if (fresh) await visual.showCursor(ctx.tabId, fresh.center.x, fresh.center.y, false);
      }
      await dom.focusRef(ctx.tabId, args.ref);
      const res = await dom.setValue(ctx.tabId, args.ref, text, mode);
      if (!res.ok) return fail(res.error ?? "could not set value");
      if (args.submit) await cdp.pressKey(ctx.tabId, "Enter");
      return ok(`Typed ${text.length} chars into ${info.role} "${info.name}" [${args.ref}]${args.submit ? " and pressed Enter" : ""}.`);
    }

    await cdp.typeText(ctx.tabId, text);
    if (args.submit) await cdp.pressKey(ctx.tabId, "Enter");
    return ok(`Typed ${text.length} chars into the focused element.`);
  },
};

const pressKeyTool: ToolDefinition = {
  mutating: true,
  needsCdp: true,
  schema: schema("press_key", "Send a single key press to the focused element.", {
    type: "object",
    properties: {
      key: str("Key name: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space, or a single character."),
      modifiers: num("Bitmask: 1=Alt, 2=Ctrl, 4=Meta, 8=Shift."),
    },
    required: ["key"],
  }),
  async run(args, ctx) {
    const key = String(args.key ?? "");
    await cdp.pressKey(ctx.tabId, key, Number(args.modifiers ?? 0));
    return ok(`Pressed ${key}.`);
  },
};

const scroll: ToolDefinition = {
  mutating: true,
  needsCdp: true,
  schema: schema("scroll", "Scroll the page or a specific element.", {
    type: "object",
    properties: {
      direction: str("up, down, left, or right.", { enum: ["up", "down", "left", "right"] }),
      amount: num("Pixels to scroll (default 600)."),
      ref: str("Optional element ref to scroll instead of the page."),
    },
    required: ["direction"],
  }),
  async run(args, ctx) {
    const direction = String(args.direction ?? "down");
    const amount = Number(args.amount ?? 600);
    const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
    const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;

    if (typeof args.ref === "string" && args.ref) {
      await dom.scrollIntoView(ctx.tabId, args.ref);
      return ok(`Scrolled ${args.ref} into view.`);
    }

    const size = await dom.viewportSize(ctx.tabId);
    await cdp.scrollAt(ctx.tabId, size.width / 2, size.height / 2, dx, dy);
    return ok(`Scrolled ${direction} by ${amount}px.`);
  },
};

const scrollTo: ToolDefinition = {
  mutating: true,
  schema: schema("scroll_to", "Scroll an element into the viewport.", {
    type: "object",
    properties: { ref: str("Element ref from read_page.") },
    required: ["ref"],
  }),
  async run(args, ctx) {
    const found = await dom.scrollIntoView(ctx.tabId, String(args.ref ?? ""));
    return found ? ok(`Scrolled ${args.ref} into view.`) : fail(`ref ${args.ref} not found.`);
  },
};

const hover: ToolDefinition = {
  mutating: true,
  needsCdp: true,
  schema: schema("hover", "Move the mouse over an element to trigger hover states.", {
    type: "object",
    properties: { ref: str("Element ref from read_page.") },
    required: ["ref"],
  }),
  async run(args, ctx) {
    const info = await dom.describe(ctx.tabId, String(args.ref ?? ""));
    if (!info) return fail(`ref ${args.ref} not found.`);
    await dom.scrollIntoView(ctx.tabId, String(args.ref));
    const fresh = await dom.describe(ctx.tabId, String(args.ref));
    if (!fresh) return fail(`ref ${args.ref} disappeared.`);
    if (ctx.settings.visualFeedback) {
      await visual.showCursor(ctx.tabId, fresh.center.x, fresh.center.y, false);
    }
    await cdp.dispatchMouse(ctx.tabId, "mouseMoved", fresh.center.x, fresh.center.y);
    return ok(`Hovered ${fresh.role} "${fresh.name}".`);
  },
};

/* ------------------------------------------------------------------ */
/* drag, upload, viewport, dialogs, plan                               */
/* ------------------------------------------------------------------ */

const drag: ToolDefinition = {
  mutating: true,
  needsCdp: true,
  schema: schema(
    "drag",
    "Drag one element onto another, or from a point to a point. Use for sliders, kanban boards, sortable lists, and HTML5 drag-and-drop.",
    {
      type: "object",
      properties: {
        from_ref: str("Element ref to drag from."),
        to_ref: str("Element ref to drop onto."),
        from_x: num("Start x when not using from_ref."),
        from_y: num("Start y when not using from_ref."),
        to_x: num("End x when not using to_ref."),
        to_y: num("End y when not using to_ref."),
        steps: num("Intermediate mouse moves (default 12). More steps help HTML5 drag targets register."),
      },
    },
  ),
  async run(args, ctx) {
    const from = await resolvePoint(ctx.tabId, args, "from");
    if ("error" in from) return fail(from.error);
    const to = await resolvePoint(ctx.tabId, args, "to");
    if ("error" in to) return fail(to.error);

    if (ctx.settings.visualFeedback) {
      await visual.showCursor(ctx.tabId, from.x, from.y, false);
    }
    await cdp.dragBetween(ctx.tabId, from, to, { steps: Number(args.steps ?? 12) });
    if (ctx.settings.visualFeedback) {
      await visual.showCursor(ctx.tabId, to.x, to.y, true);
    }
    return ok(
      `Dragged from (${Math.round(from.x)}, ${Math.round(from.y)}) to (${Math.round(to.x)}, ${Math.round(to.y)}).`,
    );
  },
};

/** Resolve a `{prefix}_ref` or `{prefix}_x`/`{prefix}_y` pair into a point. */
async function resolvePoint(
  tabId: number,
  args: Record<string, unknown>,
  prefix: "from" | "to",
): Promise<{ x: number; y: number } | { error: string }> {
  const ref = args[`${prefix}_ref`];
  if (typeof ref === "string" && ref) {
    await dom.scrollIntoView(tabId, ref);
    const info = await dom.describe(tabId, ref);
    if (!info) return { error: `ref ${ref} is not on the page; call read_page again.` };
    return { x: info.center.x, y: info.center.y };
  }
  const x = args[`${prefix}_x`];
  const y = args[`${prefix}_y`];
  if (typeof x === "number" && typeof y === "number") return { x, y };
  return { error: `Provide ${prefix}_ref or both ${prefix}_x and ${prefix}_y.` };
}

const uploadFile: ToolDefinition = {
  mutating: true,
  needsCdp: true,
  schema: schema(
    "upload_file",
    "Attach local files to a file input. The paths must be absolute and readable by the browser process.",
    {
      type: "object",
      properties: {
        ref: str("Element ref of the <input type=file> from read_page."),
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Absolute file paths to attach.",
        },
      },
      required: ["ref", "paths"],
    },
  ),
  async run(args, ctx) {
    const ref = String(args.ref ?? "");
    const paths = Array.isArray(args.paths) ? args.paths.map(String).filter(Boolean) : [];
    if (!ref) return fail("ref is required");
    if (!paths.length) return fail("paths must contain at least one absolute file path");

    const info = await dom.describe(ctx.tabId, ref);
    if (!info) return fail(`ref ${ref} is not on the page; call read_page again.`);
    if (info.tag !== "input") {
      return fail(`ref ${ref} is a <${info.tag}>, not a file input. Look for an <input type=file>.`);
    }

    await cdp.setFileInputFiles(ctx.tabId, ref, paths);
    return ok(`Attached ${paths.length} file(s) to [${ref}]: ${paths.join(", ")}`);
  },
};

const setViewportTool: ToolDefinition = {
  mutating: true,
  needsCdp: true,
  schema: schema(
    "set_viewport",
    "Emulate a viewport size, device scale, and mobile mode. Use to test responsive layouts. Pass reset=true to restore the real window size.",
    {
      type: "object",
      properties: {
        width: num("Viewport width in CSS pixels."),
        height: num("Viewport height in CSS pixels."),
        device_scale_factor: num("Device pixel ratio (default 1). Use 2 or 3 for retina."),
        mobile: bool("Emulate a mobile device (default false)."),
        reset: bool("Clear the override and return to the real window size."),
      },
    },
  ),
  async run(args, ctx) {
    if (args.reset) {
      await cdp.clearViewport(ctx.tabId);
      return ok("Viewport override cleared.");
    }

    const width = Number(args.width ?? 0);
    const height = Number(args.height ?? 0);
    if (!(width > 0) || !(height > 0)) {
      return fail("Provide width and height, or reset=true.");
    }

    await cdp.setViewport(ctx.tabId, Math.round(width), Math.round(height), {
      deviceScaleFactor: Number(args.device_scale_factor ?? 1),
      mobile: Boolean(args.mobile),
    });
    return ok(
      `Viewport set to ${Math.round(width)}x${Math.round(height)} @${Number(args.device_scale_factor ?? 1)}x${args.mobile ? " (mobile)" : ""}.`,
    );
  },
};

const setZoomTool: ToolDefinition = {
  mutating: true,
  needsCdp: true,
  schema: schema("set_zoom", "Set the page zoom factor. 1 is 100%, 0.5 is 50%, 2 is 200%.", {
    type: "object",
    properties: {
      factor: num("Zoom factor between 0.25 and 5."),
    },
    required: ["factor"],
  }),
  async run(args, ctx) {
    const factor = Number(args.factor ?? 1);
    if (!(factor >= 0.25 && factor <= 5)) return fail("factor must be between 0.25 and 5");
    await cdp.setZoom(ctx.tabId, factor);
    return ok(`Zoom set to ${Math.round(factor * 100)}%.`);
  },
};

const readDialogs: ToolDefinition = {
  mutating: false,
  needsCdp: true,
  schema: schema(
    "read_dialogs",
    "List alert/confirm/prompt dialogs that appeared since the debugger attached. Dialogs are answered automatically so they never block the page.",
    {
      type: "object",
      properties: {
        clear: bool("Clear the buffer after reading (default false)."),
      },
    },
  ),
  async run(args, ctx) {
    const entries = cdp.getDialogs(ctx.tabId);
    if (args.clear) cdp.clearCapture(ctx.tabId);
    if (!entries.length) return ok("No dialogs appeared.");
    return ok(
      entries
        .map((d) => `[${d.dialogType}] "${d.message}" → ${d.action}`)
        .join("\n"),
    );
  },
};

const updatePlan: ToolDefinition = {
  mutating: false,
  schema: schema(
    "update_plan",
    "Publish or update your task plan so the user can see what you are doing. Call this once at the start of a multi-step task, then again as steps complete.",
    {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "Ordered list of steps.",
          items: {
            type: "object",
            properties: {
              step: str("Short description of the step."),
              status: str("pending, in_progress, or done.", {
                enum: ["pending", "in_progress", "done"],
              }),
            },
            required: ["step", "status"],
          },
        },
      },
      required: ["steps"],
    },
  ),
  async run(args, ctx) {
    const raw = Array.isArray(args.steps) ? args.steps : [];
    const steps: PlanStep[] = raw
      .map((entry) => {
        const item = entry as { step?: unknown; status?: unknown };
        const status: PlanStep["status"] =
          item.status === "done" || item.status === "in_progress" ? item.status : "pending";
        return { step: String(item.step ?? "").trim(), status };
      })
      .filter((s) => s.step);

    if (!steps.length) return fail("steps must contain at least one entry with a step description.");

    ctx.setPlan(steps);
    const done = steps.filter((s) => s.status === "done").length;
    return ok(`Plan updated: ${done}/${steps.length} steps done.`);
  },
};

/* ------------------------------------------------------------------ */
/* observation                                                         */
/* ------------------------------------------------------------------ */

const screenshot: ToolDefinition = {
  mutating: false,
  needsCdp: true,
  schema: schema("screenshot", "Capture the visible viewport (or the full page) as an image.", {
    type: "object",
    properties: {
      full_page: bool("Capture the entire scrollable page instead of the viewport."),
      format: str("jpeg (default) or png.", { enum: ["jpeg", "png"] }),
    },
  }),
  async run(args, ctx) {
    const format = (args.format as "jpeg" | "png") ?? "jpeg";
    const dataUrl = await cdp.screenshot(ctx.tabId, {
      fullPage: Boolean(args.full_page),
      format,
      quality: format === "jpeg" ? 70 : undefined,
    });
    return ok(`Captured ${args.full_page ? "full-page" : "viewport"} screenshot (${format}).`, dataUrl);
  },
};

const readConsole: ToolDefinition = {
  mutating: false,
  needsCdp: true,
  schema: schema("read_console_messages", "Read console output captured since the debugger attached.", {
    type: "object",
    properties: {
      level: str("Filter by level: log, info, warning, error, debug."),
      limit: num("Maximum entries to return (default 50)."),
      clear: bool("Clear the buffer after reading (default false)."),
    },
  }),
  async run(args, ctx) {
    let entries = cdp.getConsoleMessages(ctx.tabId);
    if (typeof args.level === "string" && args.level) {
      entries = entries.filter((e) => e.level === args.level);
    }
    const limit = Number(args.limit ?? 50);
    entries = entries.slice(-limit);
    if (args.clear) cdp.clearCapture(ctx.tabId);
    if (!entries.length) return ok("No console messages captured.");
    return ok(
      entries
        .map((e) => `[${e.level}] ${e.text}${e.url ? ` (${e.url}:${e.line ?? 0})` : ""}`)
        .join("\n"),
    );
  },
};

const readNetwork: ToolDefinition = {
  mutating: false,
  needsCdp: true,
  schema: schema("read_network_requests", "Read network requests captured since the debugger attached.", {
    type: "object",
    properties: {
      filter: str("Only include URLs containing this substring."),
      limit: num("Maximum entries to return (default 50)."),
      clear: bool("Clear the buffer after reading (default false)."),
    },
  }),
  async run(args, ctx) {
    let entries = cdp.getNetworkRequests(ctx.tabId);
    if (typeof args.filter === "string" && args.filter) {
      const needle = args.filter.toLowerCase();
      entries = entries.filter((e) => e.url.toLowerCase().includes(needle));
    }
    const limit = Number(args.limit ?? 50);
    entries = entries.slice(-limit);
    if (args.clear) cdp.clearCapture(ctx.tabId);
    if (!entries.length) return ok("No network requests captured.");
    return ok(
      entries
        .map((e) => {
          const status = e.failed ? `FAILED (${e.failed})` : (e.status ?? "pending");
          return `${e.method} ${status} ${e.url}`;
        })
        .join("\n"),
    );
  },
};

/* ------------------------------------------------------------------ */
/* tabs                                                                */
/* ------------------------------------------------------------------ */

const tabsList: ToolDefinition = {
  mutating: false,
  schema: schema("tabs_list", "List open tabs with their ids, titles, and URLs.", {
    type: "object",
    properties: {},
  }),
  async run() {
    const tabs = await chrome.tabs.query({});
    const lines = tabs.map(
      (t) => `${t.active ? "*" : " "} [${t.id}] ${t.title ?? "(untitled)"} — ${t.url ?? ""}`,
    );
    return ok(lines.join("\n") || "No tabs.");
  },
};

const tabsCreate: ToolDefinition = {
  mutating: true,
  schema: schema("tabs_create", "Open a new tab and return its id.", {
    type: "object",
    properties: {
      url: str("URL to open (default about:blank)."),
      active: bool("Focus the new tab (default true)."),
    },
  }),
  async run(args) {
    const tab = await chrome.tabs.create({
      url: String(args.url ?? "about:blank"),
      active: args.active !== false,
    });
    return ok(`Opened tab ${tab.id}: ${tab.url ?? ""}`);
  },
};

const tabsSwitch: ToolDefinition = {
  mutating: true,
  schema: schema("tabs_switch", "Focus an existing tab by id.", {
    type: "object",
    properties: { tab_id: num("Tab id from tabs_list.") },
    required: ["tab_id"],
  }),
  async run(args) {
    const tabId = Number(args.tab_id);
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    return ok(`Switched to tab ${tabId}: ${tab.url ?? ""}`);
  },
};

/* ------------------------------------------------------------------ */
/* escape hatch                                                        */
/* ------------------------------------------------------------------ */

const javascriptTool: ToolDefinition = {
  mutating: true,
  needsCdp: true,
  schema: schema(
    "javascript_tool",
    "Evaluate JavaScript in the page's main world and return the result. Use for reading state the accessibility tree does not expose.",
    {
      type: "object",
      properties: {
        code: str("Expression or statement block. The completion value is returned."),
      },
      required: ["code"],
    },
  ),
  async run(args, ctx) {
    const code = String(args.code ?? "");
    if (!code.trim()) return fail("code is empty");
    const value = await cdp.evaluate<unknown>(ctx.tabId, code, { awaitPromise: true });
    const rendered =
      typeof value === "string" ? value : value === undefined ? "(undefined)" : JSON.stringify(value, null, 2);
    return ok(truncate(rendered ?? "(undefined)"));
  },
};

export const TOOLS: ToolDefinition[] = [
  navigate,
  readPage,
  getPageText,
  find,
  click,
  typeTool,
  pressKeyTool,
  scroll,
  scrollTo,
  hover,
  drag,
  uploadFile,
  setViewportTool,
  setZoomTool,
  readDialogs,
  updatePlan,
  screenshot,
  readConsole,
  readNetwork,
  tabsList,
  tabsCreate,
  tabsSwitch,
  javascriptTool,
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.schema.function.name, t]));

export const TOOL_SCHEMAS: ToolSchema[] = TOOLS.map((t) => t.schema);
