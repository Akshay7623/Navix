/**
 * A small badge that tells the user an agent is currently driving this tab.
 *
 * The side panel is easy to lose behind the page, and an agent that keeps
 * clicking after the user walked away is exactly the situation a visible
 * indicator is meant to prevent. The badge is also the only in-page way to
 * stop a run without switching back to the panel.
 */
(() => {
  if (window.__navixAgentIndicator) return;
  window.__navixAgentIndicator = true;

  const HOST_ID = "__navix_agent_indicator_host";
  let host = null;
  let root = null;
  let label = null;
  let timer = 0;

  function ensure() {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "pointer-events:none",
    ].join(";");

    root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .badge {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 12px 7px 10px;
        border-radius: 999px;
        background: rgba(20, 20, 24, .92);
        color: #f4f4f6;
        font: 500 12px/1.2 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        box-shadow: 0 6px 20px rgba(0,0,0,.32);
        opacity: 0;
        transform: translateY(6px);
        transition: opacity 160ms ease, transform 160ms ease;
        pointer-events: auto;
      }
      .badge.visible { opacity: 1; transform: translateY(0); }
      .spinner {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        border: 2px solid rgba(255,255,255,.28);
        border-top-color: #6ea8ff;
        animation: navix-agent-spin 720ms linear infinite;
        flex: none;
      }
      .badge.idle .spinner { animation: none; border-top-color: #4ade80; }
      .stop {
        all: unset;
        cursor: pointer;
        padding: 2px 7px;
        border-radius: 999px;
        background: rgba(255,255,255,.14);
        font-size: 11px;
      }
      .stop:hover { background: rgba(255,255,255,.24); }
      @keyframes navix-agent-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) {
        .spinner { animation-duration: 2s; }
        .badge { transition: none; }
      }
    `;

    const badge = document.createElement("div");
    badge.className = "badge";

    const spinner = document.createElement("span");
    spinner.className = "spinner";

    label = document.createElement("span");
    label.textContent = "Agent working";

    const stop = document.createElement("button");
    stop.className = "stop";
    stop.textContent = "Stop";
    stop.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "agent/abort" }).catch(() => undefined);
      hide();
    });

    badge.append(spinner, label, stop);
    root.append(style, badge);
    (document.body || document.documentElement).append(host);
    host.__badge = badge;
  }

  function show(text) {
    ensure();
    if (text) label.textContent = text;
    host.__badge.classList.remove("idle");
    host.__badge.classList.add("visible");
    clearTimeout(timer);
  }

  function hide() {
    if (!host || !host.__badge) return;
    host.__badge.classList.remove("visible");
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "navix-agent/indicator") {
      if (msg.state === "hide") hide();
      else show(typeof msg.text === "string" ? msg.text : undefined);
    }
  });
})();
