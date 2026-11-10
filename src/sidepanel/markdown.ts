/**
 * Minimal, allocation-cheap Markdown renderer for model output.
 *
 * Everything is built with `createElement` / `createTextNode` — model output is
 * never assigned to `innerHTML`, so a hostile page cannot inject markup into
 * the side panel through a tool result.
 */

import { copyText, flashLabel } from "./clipboard";

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\([^()\s]+\))/;

const SAFE_SCHEME = /^(https?:|mailto:)/i;

/** Build a copy button that reads its payload lazily from `source`. */
function copyButton(source: () => string, label = "Copy"): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "md-copy";
  btn.textContent = label;
  btn.title = "Copy to clipboard";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void copyText(source()).then((ok) => flashLabel(btn, ok, label));
  });
  return btn;
}

/** Fenced code: a header row (language + copy) above the scrollable block. */
function codeBlock(lang: string, body: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "md-code";

  const head = document.createElement("div");
  head.className = "md-code-head";

  const label = document.createElement("span");
  label.className = "md-code-lang";
  label.textContent = lang || "code";

  const pre = document.createElement("pre");
  pre.className = "md-pre";
  const code = document.createElement("code");
  if (lang) code.className = `language-${lang}`;
  code.textContent = body;
  pre.appendChild(code);

  head.append(label, copyButton(() => code.textContent ?? ""));
  wrap.append(head, pre);
  return wrap;
}

function inline(text: string, into: Node): void {
  let rest = text;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m || m.index === undefined) {
      into.appendChild(document.createTextNode(rest));
      return;
    }
    if (m.index > 0) into.appendChild(document.createTextNode(rest.slice(0, m.index)));
    const token = m[0];
    rest = rest.slice(m.index + token.length);

    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      into.appendChild(code);
      continue;
    }

    if (token.startsWith("[")) {
      const split = token.indexOf("](");
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      if (SAFE_SCHEME.test(href)) {
        const a = document.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noreferrer noopener";
        inline(label, a);
        into.appendChild(a);
      } else {
        into.appendChild(document.createTextNode(label));
      }
      continue;
    }

    // Emphasis delimiters only count when they hug their content, so prose like
    // "a * b * c" stays literal instead of turning into italics.
    const width = token.startsWith("**") || token.startsWith("__") || token.startsWith("~~") ? 2 : 1;
    const inner = token.slice(width, -width);
    if (!inner.trim() || inner !== inner.trim()) {
      into.appendChild(document.createTextNode(token));
      continue;
    }

    const tag = width === 2 ? (token.startsWith("~~") ? "del" : "strong") : "em";
    const node = document.createElement(tag);
    inline(inner, node);
    into.appendChild(node);
  }
}

function paragraph(lines: string[]): HTMLElement {
  const p = document.createElement("p");
  p.className = "md-p";
  inline(lines.join("\n"), p);
  return p;
}

function listItem(text: string): HTMLLIElement {
  const li = document.createElement("li");
  inline(text, li);
  return li;
}

/**
 * A model that degenerates into repeating `---` would otherwise paint a wall of
 * dividers. Collapse runs of dividers into one, and drop the ones that land at
 * the very start or end of a message, where they carry no meaning.
 */
function tidyDividers(frag: DocumentFragment): void {
  let prevWasHr = false;
  for (const el of Array.from(frag.children)) {
    const isHr = el.classList.contains("md-hr");
    if (isHr && prevWasHr) el.remove();
    prevWasHr = isHr;
  }
  // A message that is nothing but a divider keeps it; otherwise the edges are
  // just stray lines above or below the answer.
  if (frag.childElementCount < 2) return;
  while (frag.firstElementChild?.classList.contains("md-hr")) {
    frag.firstElementChild.remove();
  }
  while (frag.lastElementChild?.classList.contains("md-hr")) {
    frag.lastElementChild.remove();
  }
}

/** Render `text` into a DocumentFragment of block-level elements. */
export function renderMarkdown(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence (or EOF)
      while (body.length && !body[body.length - 1].trim()) body.pop();
      frag.appendChild(codeBlock(fence[1], body.join("\n")));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const h = document.createElement(`h${heading[1].length}`) as HTMLElement;
      h.className = "md-h";
      inline(heading[2], h);
      frag.appendChild(h);
      i += 1;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
      const hr = document.createElement("hr");
      hr.className = "md-hr";
      frag.appendChild(hr);
      i += 1;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const ul = document.createElement("ul");
      ul.className = "md-list";
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        ul.appendChild(listItem(lines[i].replace(/^\s*[-*+]\s+/, "")));
        i += 1;
      }
      frag.appendChild(ul);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const ol = document.createElement("ol");
      ol.className = "md-list";
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        ol.appendChild(listItem(lines[i].replace(/^\s*\d+[.)]\s+/, "")));
        i += 1;
      }
      frag.appendChild(ol);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = document.createElement("blockquote");
      quote.className = "md-quote";
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      quote.appendChild(paragraph(body));
      frag.appendChild(quote);
      continue;
    }

    const body: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i])
    ) {
      body.push(lines[i]);
      i += 1;
    }
    frag.appendChild(paragraph(body));
  }

  tidyDividers(frag);
  return frag;
}

/** Replace `el`'s children with the rendered form of `text`. */
export function renderMarkdownInto(el: HTMLElement, text: string): void {
  el.replaceChildren(renderMarkdown(text));
}
