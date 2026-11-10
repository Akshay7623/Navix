/**
 * Draws a synthetic cursor so the user can see where the agent is acting.
 *
 * CDP input dispatch is invisible: `Input.dispatchMouseEvent` moves the real
 * input pipeline but never paints anything. Without this overlay a run looks
 * like the page is being edited by a ghost, which makes it impossible to tell
 * a wrong click from a slow one.
 *
 * The overlay lives in a closed shadow root so page CSS cannot restyle it and
 * page scripts cannot read it.
 */
(() => {
  if (window.__navixAgentCursor) return;
  window.__navixAgentCursor = true;

  const HOST_ID = "__navix_agent_cursor_host";
  let host = null;
  let root = null;
  let cursor = null;
  let ripple = null;
  let hideTimer = 0;

  function ensure() {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = [
      "position:fixed",
      "left:0",
      "top:0",
      "width:0",
      "height:0",
      "z-index:2147483647",
      "pointer-events:none",
      "contain:layout style",
    ].join(";");

    root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .cursor {
        position: fixed;
        left: 0;
        top: 0;
        width: 20px;
        height: 20px;
        margin: -2px 0 0 -2px;
        opacity: 0;
        transition: transform 140ms cubic-bezier(.22,.61,.36,1), opacity 120ms linear;
        will-change: transform;
      }
      .cursor.visible { opacity: 1; }
      .cursor svg { display: block; filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); }
      .ripple {
        position: fixed;
        left: 0;
        top: 0;
        width: 34px;
        height: 34px;
        margin: -17px 0 0 -17px;
        border-radius: 50%;
        border: 2px solid #4f8cff;
        opacity: 0;
        transform: scale(.3);
        pointer-events: none;
      }
      .ripple.pulse {
        animation: navix-agent-ripple 420ms ease-out;
      }
      @keyframes navix-agent-ripple {
        0%   { opacity: .9; transform: scale(.3); }
        100% { opacity: 0;  transform: scale(1.15); }
      }
      @media (prefers-reduced-motion: reduce) {
        .cursor { transition: none; }
        .ripple.pulse { animation-duration: 1ms; }
      }
    `;

    cursor = document.createElement("div");
    cursor.className = "cursor";
    cursor.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">' +
      '<path d="M2 1.5 L2 15.2 L5.9 11.6 L8.4 17.4 L11 16.2 L8.5 10.6 L13.6 10.4 Z" ' +
      'fill="#ffffff" stroke="#1b1b1f" stroke-width="1.2" stroke-linejoin="round"/></svg>';

    ripple = document.createElement("div");
    ripple.className = "ripple";

    root.append(style, ripple, cursor);
    (document.body || document.documentElement).append(host);
  }

  function move(x, y) {
    ensure();
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    cursor.classList.add("visible");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => cursor && cursor.classList.remove("visible"), 4000);
  }

  function pulse(x, y) {
    ensure();
    ripple.style.transform = `translate(${x}px, ${y}px)`;
    ripple.classList.remove("pulse");
    // Force a reflow so the animation restarts on rapid consecutive clicks.
    void ripple.offsetWidth;
    ripple.classList.add("pulse");
  }

  function hide() {
    if (cursor) cursor.classList.remove("visible");
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "navix-agent/cursor") {
      if (typeof msg.x === "number" && typeof msg.y === "number") move(msg.x, msg.y);
      if (msg.click && typeof msg.x === "number" && typeof msg.y === "number") pulse(msg.x, msg.y);
    } else if (msg.type === "navix-agent/cursor-hide") {
      hide();
    }
  });
})();
