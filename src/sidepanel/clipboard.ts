/**
 * Clipboard helper for the side panel.
 *
 * `navigator.clipboard` needs a focused document, which a side panel normally
 * has, but it can still reject (permissions, focus loss). The textarea +
 * `execCommand` path is the fallback that works everywhere.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Flash a button between "Copy" and "Copied" without leaking timers. */
export function flashLabel(btn: HTMLButtonElement, ok: boolean, idle = "Copy"): void {
  btn.textContent = ok ? "Copied" : "Failed";
  btn.classList.toggle("copied", ok);
  setTimeout(() => {
    btn.textContent = idle;
    btn.classList.remove("copied");
  }, 1400);
}
