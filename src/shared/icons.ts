/**
 * Line icons drawn on a 24px grid, built with createElementNS so no markup
 * string ever reaches innerHTML. Static buttons get theirs through
 * `mountIcons`, which fills every element carrying `data-icon`.
 */

const NS = "http://www.w3.org/2000/svg";

type Shape = [tag: string, attrs: Record<string, string | number>];

const p = (d: string): Shape => ["path", { d }];
const c = (cx: number, cy: number, r: number): Shape => ["circle", { cx, cy, r }];
const r = (x: number, y: number, width: number, height: number, rx = 2): Shape => [
  "rect",
  { x, y, width, height, rx },
];

const ICONS = {
  history: [c(12, 12, 8.5), p("M12 7.5V12l3 2")],
  menu: [p("M4 7h16M4 12h16M4 17h10")],
  plus: [p("M12 5v14M5 12h14")],
  download: [p("M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14")],
  settings: [p("M4 7h9M17 7h3M4 17h3M11 17h9"), c(15, 7, 2), c(9, 17, 2)],
  sparkle: [
    p("M12 3.5l1.7 4.8 4.8 1.7-4.8 1.7L12 16.5l-1.7-4.8L5.5 10l4.8-1.7z"),
    p("M18.5 15.5l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z"),
  ],
  eye: [p("M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"), c(12, 12, 2.8)],
  text: [p("M5 6.5h14M5 10.5h14M5 14.5h10M5 18.5h6")],
  search: [c(11, 11, 6.5), p("M20 20l-4.3-4.3")],
  cursor: [p("M6 4l12.5 6.2-5.3 1.8-1.8 5.3z"), p("M13.5 13.5l4.5 4.5")],
  keyboard: [r(3, 6.5, 18, 11, 2.5), p("M7 10.5h.01M10.5 10.5h.01M14 10.5h.01M17 10.5h.01M8 14h8")],
  scroll: [p("M12 4v16M8.5 7.5 12 4l3.5 3.5M8.5 16.5 12 20l3.5-3.5")],
  target: [c(12, 12, 7), c(12, 12, 2), p("M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3")],
  move: [
    p("M12 3.5v17M3.5 12h17"),
    p("M9.5 6 12 3.5 14.5 6M9.5 18 12 20.5 14.5 18M6 9.5 3.5 12 6 14.5M18 9.5l2.5 2.5-2.5 2.5"),
  ],
  upload: [p("M12 15.5V4M7.5 8.5 12 4l4.5 4.5M5 19.5h14")],
  globe: [c(12, 12, 8.5), p("M3.5 12h17M12 3.5c2.8 2.9 2.8 14.1 0 17M12 3.5c-2.8 2.9-2.8 14.1 0 17")],
  camera: [p("M4 8.5h3l1.8-2.5h6.4L17 8.5h3V19H4z"), c(12, 13.3, 3.2)],
  code: [p("M9 7.5 4.5 12 9 16.5M15 7.5l4.5 4.5-4.5 4.5")],
  list: [p("M9.5 6.5h10M9.5 12h10M9.5 17.5h10"), c(5, 6.5, 1), c(5, 12, 1), c(5, 17.5, 1)],
  terminal: [r(3, 4.5, 18, 15, 2.5), p("M7 9.5l3 2.5-3 2.5M12.5 15H17")],
  activity: [p("M3 12h4l2.5-6.5 5 13L17 12h4")],
  window: [r(3, 5, 18, 14, 2.5), p("M3 9.5h18M6.5 7.2h.01M9 7.2h.01")],
  zoom: [p("M4 9V4.5h4.5M20 9V4.5h-4.5M4 15v4.5h4.5M20 15v4.5h-4.5")],
  message: [p("M4.5 5h15v11h-9l-6 4.5z")],
  clock: [c(12, 12, 8.5), p("M12 7.5V12l3 2")],
  alert: [c(12, 12, 8.5), p("M12 7.5v5.5M12 16.3h.01")],
  shield: [p("M12 3.5l7 2.8v5.5c0 4.4-2.9 7.4-7 8.9-4.1-1.5-7-4.5-7-8.9V6.3z"), p("M9 12l2 2 4-4")],
  check: [p("M5 12.5l4.5 4.5L19 7.5")],
  x: [p("M6.5 6.5l11 11M17.5 6.5l-11 11")],
  chevron: [p("M6.5 9.5 12 15l5.5-5.5")],
  send: [p("M12 19V5.5M6 11.5 12 5.5l6 6")],
  stop: [r(6.5, 6.5, 11, 11, 2.5)],
  copy: [r(8.5, 8.5, 11.5, 11.5, 2.5), p("M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5")],
  trash: [p("M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.9 12.5h9.2L17.5 7")],
  key: [c(8, 15, 4), p("M11 12l8.5-8.5M16.5 6.5l2.5 2.5M14 9l2 2")],
  plug: [p("M9 3.5V8M15 3.5V8M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0zM12 17v3.5")],
  cpu: [r(6.5, 6.5, 11, 11, 2), p("M10 3.5v3M14 3.5v3M10 17.5v3M14 17.5v3M3.5 10h3M3.5 14h3M17.5 10h3M17.5 14h3")],
  info: [c(12, 12, 8.5), p("M12 11v5.5M12 7.7h.01")],
  user: [c(12, 8.5, 3.8), p("M4.5 20c1.2-3.8 4.1-5.5 7.5-5.5s6.3 1.7 7.5 5.5")],
  hide: [
    p("M3.5 4.5l17 15M10 6.1A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.7 3.4M6.6 7.7A16.5 16.5 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.6-1.2"),
  ],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 16, className = ""): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `icon icon-${name}${className ? ` ${className}` : ""}`);
  for (const [tag, attrs] of ICONS[name] ?? ICONS.info) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.append(el);
  }
  // Solid shapes: the stop square reads better filled.
  if (name === "stop") svg.setAttribute("fill", "currentColor");
  return svg;
}

let logoCount = 0;

/** The brand mark: a violet tile with a pointer and a spark. */
export function logoMark(size = 22): SVGSVGElement {
  const id = `logo-grad-${(logoCount += 1)}`;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "logo");

  const defs = document.createElementNS(NS, "defs");
  const grad = document.createElementNS(NS, "linearGradient");
  grad.setAttribute("id", id);
  grad.setAttribute("x1", "0");
  grad.setAttribute("y1", "0");
  grad.setAttribute("x2", "1");
  grad.setAttribute("y2", "1");
  for (const [offset, color] of [
    ["0", "#a08fff"],
    ["1", "#5140e6"],
  ]) {
    const stop = document.createElementNS(NS, "stop");
    stop.setAttribute("offset", offset);
    stop.setAttribute("stop-color", color);
    grad.append(stop);
  }
  defs.append(grad);

  const tile = document.createElementNS(NS, "rect");
  tile.setAttribute("width", "24");
  tile.setAttribute("height", "24");
  tile.setAttribute("rx", "7");
  tile.setAttribute("fill", `url(#${id})`);

  const pointer = document.createElementNS(NS, "path");
  pointer.setAttribute("d", "M7.5 6.5l9.5 4.6-4 1.3-1.3 4z");
  pointer.setAttribute("fill", "#fff");
  pointer.setAttribute("stroke", "#fff");
  pointer.setAttribute("stroke-width", "1.2");
  pointer.setAttribute("stroke-linejoin", "round");

  const spark = document.createElementNS(NS, "path");
  spark.setAttribute("d", "M17.6 4.4l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z");
  spark.setAttribute("fill", "#fff");
  spark.setAttribute("opacity", "0.9");

  svg.append(defs, tile, pointer, spark);
  return svg;
}

/** Fill every `[data-icon]` / `[data-logo]` placeholder under `root`. */
export function mountIcons(root: ParentNode = document): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-icon]"))) {
    if (el.querySelector(":scope > svg")) continue;
    el.prepend(icon(el.dataset.icon as IconName, Number(el.dataset.iconSize ?? 16)));
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-logo]"))) {
    if (el.querySelector(":scope > svg")) continue;
    el.prepend(logoMark(Number(el.dataset.logo || 22)));
  }
}

/** A readable label and icon for each agent tool; unknown tools fall back to their raw name. */
const TOOL_META: Record<string, { label: string; icon: IconName }> = {
  navigate: { label: "Open page", icon: "globe" },
  read_page: { label: "Read page", icon: "eye" },
  get_page_text: { label: "Read text", icon: "text" },
  find: { label: "Find", icon: "search" },
  click: { label: "Click", icon: "cursor" },
  type: { label: "Type", icon: "keyboard" },
  press_key: { label: "Press key", icon: "keyboard" },
  scroll: { label: "Scroll", icon: "scroll" },
  scroll_to: { label: "Scroll to", icon: "scroll" },
  hover: { label: "Hover", icon: "target" },
  drag: { label: "Drag", icon: "move" },
  upload_file: { label: "Upload file", icon: "upload" },
  set_viewport: { label: "Set viewport", icon: "zoom" },
  set_zoom: { label: "Zoom", icon: "zoom" },
  update_plan: { label: "Update plan", icon: "list" },
  screenshot: { label: "Screenshot", icon: "camera" },
  read_console_messages: { label: "Console", icon: "terminal" },
  read_network_requests: { label: "Network", icon: "activity" },
  read_dialogs: { label: "Dialogs", icon: "message" },
  javascript_tool: { label: "Run JavaScript", icon: "code" },
  tabs_list: { label: "List tabs", icon: "window" },
  tabs_create: { label: "New tab", icon: "window" },
  tabs_switch: { label: "Switch tab", icon: "window" },
  wait: { label: "Wait", icon: "clock" },
};

export function toolMeta(name: string): { label: string; icon: IconName } {
  return TOOL_META[name] ?? { label: name.replace(/_/g, " "), icon: "sparkle" };
}
