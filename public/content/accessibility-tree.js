/**
 * Accessibility-tree snapshot builder.
 *
 * Runs in every frame at document_start. It walks the DOM, assigns stable
 * `ref_N` identifiers to interactive/meaningful nodes, and exposes a lookup
 * table so the background worker can resolve a ref back to a live element.
 *
 * Nothing here talks to the network. The maps live on a namespaced global so
 * the background worker can reach them through Runtime.evaluate.
 */
(() => {
  const NS = "__navixAgent";
  if (window[NS]) return;

  const MAX_NODES = 2500;
  const MAX_TEXT = 160;

  // LABEL and OPTION are deliberately excluded: they are not directly
  // actionable and they duplicate the name of the control they describe,
  // which makes the tree ambiguous for the model.
  const INTERACTIVE = new Set([
    "A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY",
    "DETAILS", "AUDIO", "VIDEO",
  ]);

  const LANDMARK_ROLES = new Set([
    "banner", "navigation", "main", "complementary", "contentinfo",
    "search", "form", "region", "dialog", "alertdialog", "menu", "menubar",
    "tablist", "tabpanel", "listbox", "grid", "table", "tree", "toolbar",
  ]);

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK", "HEAD",
    "SVG", "PATH", "DEFS", "CLIPPATH", "G", "USE", "SYMBOL",
  ]);

  // Roles whose accessible name is derived from their descendant text.
  const NAME_FROM_CONTENT_ROLES = new Set([
    "button", "link", "heading", "listitem", "cell", "columnheader",
    "rowheader", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
    "option", "treeitem", "checkbox", "radio", "switch", "tooltip",
    "figure", "caption", "legend", "term", "definition",
  ]);

  const NAME_FROM_CONTENT_TAGS = new Set([
    "A", "BUTTON", "SUMMARY", "LABEL", "OPTION", "LEGEND", "CAPTION",
    "H1", "H2", "H3", "H4", "H5", "H6", "LI", "TD", "TH", "DT", "DD",
    "FIGCAPTION", "BLOCKQUOTE", "Q", "CITE",
  ]);

  const SENSITIVE_AUTOCOMPLETE = /(^|\s)(current-password|new-password|cc-number|cc-csc|cc-exp|one-time-code)(\s|$)/i;
  const SENSITIVE_NAME = /pass(word|wd)?|secret|token|otp|ssn|cvv|cvc|card.?number|routing/i;

  const elementMap = new Map();
  const reverseMap = new WeakMap();
  let counter = 0;

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) return false;
    return true;
  }

  function isSensitive(el) {
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return false;
    if (el.type === "password") return true;
    const ac = el.getAttribute("autocomplete") || "";
    if (SENSITIVE_AUTOCOMPLETE.test(ac)) return true;
    const hint = `${el.name || ""} ${el.id || ""} ${el.getAttribute("aria-label") || ""}`;
    return SENSITIVE_NAME.test(hint);
  }

  function clip(text) {
    const flat = String(text).replace(/\s+/g, " ").trim();
    return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT)}…` : flat;
  }

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === "A") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "BUTTON") return "button";
    if (tag === "INPUT") {
      const t = el.type || "text";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button" || t === "reset") return "button";
      if (t === "range") return "slider";
      if (t === "file") return "file-input";
      return "textbox";
    }
    if (tag === "SELECT") return el.multiple ? "listbox" : "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "IMG") return "image";
    if (tag === "H1" || tag === "H2" || tag === "H3" || tag === "H4" || tag === "H5" || tag === "H6") {
      return "heading";
    }
    if (tag === "UL" || tag === "OL") return "list";
    if (tag === "LI") return "listitem";
    if (tag === "TABLE") return "table";
    if (tag === "TR") return "row";
    if (tag === "TD" || tag === "TH") return "cell";
    if (tag === "FORM") return "form";
    if (tag === "NAV") return "navigation";
    if (tag === "MAIN") return "main";
    if (tag === "HEADER") return "banner";
    if (tag === "FOOTER") return "contentinfo";
    if (tag === "ASIDE") return "complementary";
    if (tag === "DIALOG") return "dialog";
    if (tag === "P") return "paragraph";
    return "generic";
  }

  function accessibleName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return clip(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => n.textContent || "");
      const joined = clip(parts.join(" "));
      if (joined) return joined;
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      if (el.labels && el.labels.length) {
        const fromLabel = clip(Array.from(el.labels).map((l) => l.textContent || "").join(" "));
        if (fromLabel) return fromLabel;
      }
      const ph = el.getAttribute("placeholder");
      if (ph) return clip(ph);
      const title = el.getAttribute("title");
      if (title) return clip(title);
      return clip(el.getAttribute("name") || el.id || "");
    }
    if (el instanceof HTMLImageElement) {
      return clip(el.alt || el.title || "");
    }
    const title = el.getAttribute("title");
    if (title) return clip(title);
    // Name-from-content: buttons, links, headings, cells, etc. take their name
    // from descendant text. Without this the model sees `button` with no label.
    if (NAME_FROM_CONTENT_TAGS.has(el.tagName) || NAME_FROM_CONTENT_ROLES.has(roleOf(el))) {
      const fromContent = clip(el.textContent || "");
      if (fromContent) return fromContent;
    }
    return "";
  }

  function valueOf(el) {
    if (isSensitive(el)) return "[value redacted]";
    if (el instanceof HTMLInputElement) {
      if (el.type === "checkbox" || el.type === "radio") return el.checked ? "checked" : "unchecked";
      if (el.type === "file") {
        const files = el.files ? Array.from(el.files).map((f) => f.name) : [];
        return files.length ? files.join(", ") : "";
      }
      return clip(el.value || "");
    }
    if (el instanceof HTMLTextAreaElement) return clip(el.value || "");
    if (el instanceof HTMLSelectElement) {
      const selected = Array.from(el.selectedOptions).map((o) => o.textContent || o.value);
      return clip(selected.join(", "));
    }
    return "";
  }

  function assignRef(el) {
    let ref = reverseMap.get(el);
    if (ref) return ref;
    counter += 1;
    ref = `ref_${counter}`;
    elementMap.set(ref, el);
    reverseMap.set(el, ref);
    // Mirror the ref onto the element so CDP can address it by selector
    // (DOM.setFileInputFiles needs a node, not a JS handle).
    try {
      el.setAttribute("data-navix-agent-ref", ref);
    } catch {
      /* some elements reject attribute writes */
    }
    return ref;
  }

  function shouldRef(el, role) {
    if (INTERACTIVE.has(el.tagName)) return true;
    if (LANDMARK_ROLES.has(role)) return true;
    if (el.hasAttribute("role")) return true;
    if (el.hasAttribute("contenteditable") && el.getAttribute("contenteditable") !== "false") return true;
    if (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") return true;
    if (el.hasAttribute("onclick")) return true;
    return false;
  }

  function buildNode(el, depth, budget) {
    if (budget.count >= MAX_NODES) return null;
    if (SKIP_TAGS.has(el.tagName)) return null;
    if (el.getAttribute("aria-hidden") === "true") return null;
    if (!isVisible(el)) return null;

    budget.count += 1;

    const role = roleOf(el);
    const name = accessibleName(el);
    const value = valueOf(el);
    const ref = shouldRef(el, role) ? assignRef(el) : null;

    const node = { role, name, ref, value, depth, children: [] };

    if (el instanceof HTMLInputElement && el.type === "password") {
      node.value = "[value redacted]";
    }

    const children = el.children;
    for (let i = 0; i < children.length; i += 1) {
      const child = buildNode(children[i], depth + 1, budget);
      if (child) node.children.push(child);
    }

    // Collapse wrappers that carry no semantics of their own.
    if (node.role === "generic" && !node.ref && !node.name && node.children.length === 1) {
      return node.children[0];
    }
    if (node.role === "generic" && !node.ref && !node.name && node.children.length === 0) {
      return null;
    }
    return node;
  }

  function render(node, lines) {
    const indent = "  ".repeat(node.depth);
    const bits = [`${indent}${node.role}`];
    if (node.name) bits.push(`"${node.name}"`);
    if (node.ref) bits.push(`[${node.ref}]`);
    if (node.value) bits.push(`= ${node.value}`);
    lines.push(bits.join(" "));
    for (const child of node.children) render(child, lines);
  }

  function snapshot() {
    // Refs are intentionally NOT reset here: the model often reads the page,
    // acts, then reads again, and stable refs across snapshots make that
    // reliable. Stale entries are pruned instead.
    for (const [ref, el] of elementMap) {
      if (!el.isConnected) elementMap.delete(ref);
    }
    const budget = { count: 0 };
    const root = document.body || document.documentElement;
    if (!root) return { text: "(empty document)", count: 0, url: location.href, title: document.title };
    const tree = buildNode(root, 0, budget);
    const lines = [];
    if (tree) {
      // The <body> wrapper is usually a nameless `generic` node; render its
      // children at depth 0 instead of emitting a meaningless root line.
      if (tree.role === "generic" && !tree.name && !tree.ref) {
        for (const child of tree.children) render(child, lines);
      } else {
        render(tree, lines);
      }
    }
    return {
      text: lines.join("\n") || "(no visible content)",
      count: budget.count,
      url: location.href,
      title: document.title,
    };
  }

  function resolve(ref) {
    const el = elementMap.get(ref);
    if (!el || !el.isConnected) return null;
    return el;
  }

  function describe(ref) {
    const el = resolve(ref);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: accessibleName(el),
      value: valueOf(el),
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
      // Viewport-relative: this is what Input.dispatchMouseEvent expects.
      center: {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      },
      inViewport: rect.top < window.innerHeight && rect.bottom > 0,
    };
  }

  function scrollIntoView(ref) {
    const el = resolve(ref);
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return true;
  }

  function focusRef(ref) {
    const el = resolve(ref);
    if (!el) return false;
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    return true;
  }

  function setValue(ref, text, mode) {
    const el = resolve(ref);
    if (!el) return { ok: false, error: "ref not found" };
    if (isSensitive(el)) return { ok: false, error: "refused: sensitive field" };

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const proto = el instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      const next = mode === "append" ? `${el.value}${text}` : text;
      if (setter) setter.call(el, next);
      else el.value = next;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }

    if (el instanceof HTMLSelectElement) {
      const target = text.trim().toLowerCase();
      const option = Array.from(el.options).find(
        (o) => (o.value || "").toLowerCase() === target || (o.textContent || "").trim().toLowerCase() === target,
      );
      if (!option) return { ok: false, error: `no option matching "${text}"` };
      el.value = option.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }

    if (el.isContentEditable) {
      el.focus();
      if (mode === "append") el.textContent = `${el.textContent || ""}${text}`;
      else el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return { ok: true };
    }

    return { ok: false, error: `cannot type into <${el.tagName.toLowerCase()}>` };
  }

  function clickRef(ref) {
    const el = resolve(ref);
    if (!el) return { ok: false, error: "ref not found" };
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    if (typeof el.click === "function") {
      el.click();
      return { ok: true };
    }
    return { ok: false, error: "element is not clickable" };
  }

  function findByText(query, limit) {
    const needle = query.toLowerCase();
    const hits = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node && hits.length < limit) {
      if (node instanceof Element && isVisible(node)) {
        const text = (node.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (text && text.includes(needle)) {
          const role = roleOf(node);
          const ref = shouldRef(node, role) ? assignRef(node) : null;
          hits.push({ role, name: accessibleName(node), ref, text: clip(node.textContent || "") });
        }
      }
      node = walker.nextNode();
    }
    return hits;
  }

  window[NS] = {
    snapshot,
    resolve,
    describe,
    scrollIntoView,
    focusRef,
    setValue,
    clickRef,
    findByText,
    version: 1,
  };
})();
