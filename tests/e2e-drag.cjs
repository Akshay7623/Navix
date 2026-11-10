/**
 * Real-browser end-to-end test for the `drag` tool.
 *
 * Two independent drag mechanisms are exercised, because they fail in
 * different ways:
 *   1. Pointer-based dragging (mousedown → mousemove → mouseup) on a slider.
 *   2. HTML5 drag-and-drop (dragstart → dragover → drop), which only starts a
 *      drag session if the intermediate mouse moves are dispatched.
 *
 * Run with: node tests/e2e-drag.cjs
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const EXT = path.resolve(__dirname, "..", "dist");
const EXT_ID = require("./ext-id.cjs")(EXT);
const PROFILE = path.join(os.tmpdir(), "agent-e2e-drag-" + Date.now());
const PORT = 9411;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE_HTML = `<!doctype html><html><head><title>Drag Lab</title>
<style>
  body { font-family: sans-serif; margin: 24px; }
  #track { position: relative; width: 400px; height: 24px; background: #ddd; margin: 16px 0 40px; }
  #thumb { position: absolute; left: 0; top: 0; width: 24px; height: 24px; background: #36c; cursor: grab; }
  #card { width: 120px; height: 60px; background: #fc6; margin-bottom: 40px; }
  #zone { width: 240px; height: 120px; border: 2px dashed #999; }
  #zone.hot { border-color: #36c; background: #eef; }
</style></head><body>
<h1>Drag Lab</h1>

<div id="track"><div id="thumb" role="slider" aria-label="Volume"></div></div>
<div id="sliderOut">slider:0</div>

<div id="card" draggable="true" role="button" aria-label="Card">Card</div>
<div id="zone" role="region" aria-label="Drop zone">Drop here</div>
<div id="dndOut">dnd:none</div>

<script>
  // Pointer-based slider: only a real mousedown/mousemove/mouseup sequence moves it.
  const track = document.getElementById("track");
  const thumb = document.getElementById("thumb");
  let dragging = false;
  thumb.addEventListener("mousedown", () => { dragging = true; });
  window.addEventListener("mouseup", () => { dragging = false; });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const r = track.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width - 24, e.clientX - r.left - 12));
    thumb.style.left = x + "px";
    document.getElementById("sliderOut").textContent = "slider:" + Math.round(x);
  });

  // HTML5 drag-and-drop.
  const card = document.getElementById("card");
  const zone = document.getElementById("zone");
  card.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", "card"); });
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("hot"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("hot"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("hot");
    document.getElementById("dndOut").textContent = "dnd:" + e.dataTransfer.getData("text/plain");
  });
</script>
</body></html>`;

let step = 0;
const seen = [];

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
function toolCall(res, name, args) {
  sse(res, {
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: "call_" + step, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  });
  sse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  res.write("data: [DONE]\n\n");
  res.end();
}
function say(res, text) {
  sse(res, { choices: [{ delta: { content: text } }] });
  sse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer((req, res) => {
  if (req.url === "/page") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(PAGE_HTML);
    return;
  }
  if (req.url === "/v1/chat/completions") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const msgs = parsed.messages;
      const toolMsgs = msgs.filter((m) => m.role === "tool");
      const last = toolMsgs[toolMsgs.length - 1];
      seen.push({ step, lastTool: last?.name, lastContent: last?.content?.slice(0, 400) });

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      });

      if (step === 0) {
        step++;
        toolCall(res, "read_page", {});
        return;
      }
      if (step === 1) {
        const tree = last?.content ?? "";
        const thumbRef = (tree.match(/slider[^\n]*\[(ref_\d+)\]/) || [])[1];
        const cardRef = (tree.match(/button[^\n]*Card[^\n]*\[(ref_\d+)\]/) || [])[1];
        const zoneRef = (tree.match(/region[^\n]*Drop zone[^\n]*\[(ref_\d+)\]/) || [])[1];
        seen.push({ extracted: { thumbRef, cardRef, zoneRef } });
        step++;
        if (!thumbRef || !cardRef || !zoneRef) {
          say(res, "FAILED: missing refs " + JSON.stringify({ thumbRef, cardRef, zoneRef }));
          return;
        }
        toolCall(res, "drag", { from_ref: thumbRef, to_x: 380, to_y: 0, steps: 20 });
        return;
      }
      if (step === 2) {
        step++;
        const ex = seen.find((s) => s.extracted)?.extracted ?? {};
        toolCall(res, "drag", { from_ref: ex.cardRef, to_ref: ex.zoneRef, steps: 20 });
        return;
      }
      if (step === 3) {
        step++;
        toolCall(res, "get_page_text", {});
        return;
      }
      if (step === 4) {
        step++;
        const text = last?.content ?? "";
        const sliderOk = /slider:(\d+)/.test(text) && Number((text.match(/slider:(\d+)/) || [])[1]) > 100;
        const dndOk = text.includes("dnd:card");
        say(res, `slider=${sliderOk} dnd=${dndOk} :: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
        return;
      }
      say(res, "unexpected step");
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  fs.mkdirSync(PROFILE, { recursive: true });

  const child = spawn(
    EDGE,
    [
      "--remote-debugging-port=9412",
      "--user-data-dir=" + PROFILE,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--window-size=1280,900",
      "--load-extension=" + EXT,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  const getJson = async (p) => (await fetch(`http://127.0.0.1:9412${p}`)).json();

  let targets = [];
  for (let i = 0; i < 80; i++) {
    try {
      targets = await getJson("/json/list");
    } catch {
      await sleep(250);
      continue;
    }
    if (targets.some((t) => t.type === "service_worker" && t.url === `chrome-extension://${EXT_ID}/background.js`)) break;
    await sleep(250);
  }
  const sw = targets.find((t) => t.type === "service_worker" && t.url === `chrome-extension://${EXT_ID}/background.js`);
  if (!sw) {
    console.log("FAIL: no service worker");
    console.log(log.slice(-2000));
    child.kill();
    server.close();
    process.exitCode = 1;
    return;
  }
  const extId = new URL(sw.url).host;
  console.log("extension:", extId);

  const connect = async (wsUrl) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const waiters = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && waiters.has(m.id)) {
        waiters.get(m.id)(m);
        waiters.delete(m.id);
      }
    });
    await new Promise((r) => ws.addEventListener("open", r));
    const send = (method, params) =>
      new Promise((res) => {
        const i = ++id;
        waiters.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    await send("Runtime.enable", {});
    const evaluate = async (expression) => {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails)
        return { error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text };
      return { value: r.result?.result?.value };
    };
    return { ws, send, evaluate };
  };

  const browserWs = (await getJson("/json/version")).webSocketDebuggerUrl;
  const bc = await connect(browserWs);
  await bc.send("Target.createTarget", { url: `chrome-extension://${extId}/src/sidepanel/index.html` });
  await sleep(1500);
  const list = await getJson("/json/list");
  const panelTarget = list.find((t) => t.url.includes("sidepanel/index.html"));
  if (!panelTarget) {
    console.log("FAIL: sidepanel target missing");
    child.kill();
    server.close();
    process.exitCode = 1;
    return;
  }
  const pc = await connect(panelTarget.webSocketDebuggerUrl);

  const tabId = await pc.evaluate(
    `chrome.tabs.create({ url: "http://127.0.0.1:${PORT}/page", active: true }).then(t => t.id)`,
  );
  if (typeof tabId.value !== "number") {
    console.log("FAIL: could not create test tab ->", JSON.stringify(tabId));
    child.kill();
    server.close();
    process.exitCode = 1;
    return;
  }
  console.log("test tab:", tabId.value);

  let pageReady = false;
  for (let i = 0; i < 40; i++) {
    const t = await pc.evaluate(`chrome.tabs.get(${tabId.value}).then(t => t.status + "|" + t.url)`);
    if (t.value === `complete|http://127.0.0.1:${PORT}/page`) {
      pageReady = true;
      break;
    }
    await sleep(250);
  }
  if (!pageReady) {
    console.log("FAIL: test tab never reached the page");
    child.kill();
    server.close();
    process.exitCode = 1;
    return;
  }

  const cfg = await pc.evaluate(`chrome.storage.local.set({ settings: {
    provider: "custom",
    baseUrl: "http://127.0.0.1:${PORT}/v1/chat/completions",
    apiKey: "test-key",
    model: "mock-model",
    temperature: 0,
    maxTokens: 1024,
    maxSteps: 10,
    approvalMode: "auto",
    safetyMode: "permissive",
    dialogPolicy: "dismiss",
    visualFeedback: false,
    systemPromptExtra: "",
    visionEnabled: false
  }}).then(() => "ok").catch(e => "ERR:" + e.message)`);
  console.log("settings:", cfg.value ?? cfg.error);

  await pc.evaluate(
    `window.__events = []; chrome.runtime.onMessage.addListener(m => { if (m && m.__event) window.__events.push(m.event); }); "ok"`,
  );

  const started = await pc.evaluate(
    `chrome.runtime.sendMessage({ type: "agent/run", prompt: "Drag the slider to the right, then drag the card into the drop zone.", tabId: ${tabId.value} }).then(r => JSON.stringify(r))`,
  );
  console.log("run:", started.value ?? started.error);

  let finalState = null;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const st = await pc.evaluate(`chrome.runtime.sendMessage({ type: "agent/state" }).then(r => JSON.stringify(r))`);
    try {
      finalState = JSON.parse(st.value)?.data ?? null;
    } catch {
      finalState = null;
    }
    if (finalState && finalState.running === false) break;
  }

  const events = await pc.evaluate(`JSON.stringify(window.__events)`);
  const evs = JSON.parse(events.value ?? "[]");

  console.log("\n--- provider saw ---");
  for (const s of seen) console.log("  " + JSON.stringify(s).slice(0, 300));

  console.log("\n--- agent events ---");
  for (const e of evs) console.log("  " + JSON.stringify(e).slice(0, 240));

  const done = evs.find((e) => e.type === "agent/done");
  const err = evs.find((e) => e.type === "agent/error");
  const dragResults = seen.filter((s) => s.lastTool === "drag").map((s) => s.lastContent ?? "");
  const finalText = seen.filter((s) => s.lastTool === "get_page_text").map((s) => s.lastContent ?? "").join(" ");

  const checks = [];
  const check = (n, ok, d) => checks.push({ n, ok: !!ok, d });
  check("agent finished without error", !err, err?.message);
  check("agent emitted done", !!done, JSON.stringify(finalState));
  check("read_page found the slider ref", !!seen.find((s) => s.extracted?.thumbRef), JSON.stringify(seen.find((s) => s.extracted)));
  check("read_page found the card ref", !!seen.find((s) => s.extracted?.cardRef), JSON.stringify(seen.find((s) => s.extracted)));
  check("read_page found the drop zone ref", !!seen.find((s) => s.extracted?.zoneRef), JSON.stringify(seen.find((s) => s.extracted)));
  check("drag tool ran twice", dragResults.length === 2, JSON.stringify(dragResults));
  check("drag reported success", dragResults.every((c) => c.startsWith("Dragged from")), JSON.stringify(dragResults));
  check(
    "pointer drag moved the slider",
    /slider:(\d+)/.test(finalText) && Number((finalText.match(/slider:(\d+)/) || [])[1]) > 100,
    finalText.slice(0, 200),
  );
  check("html5 drag fired drop", finalText.includes("dnd:card"), finalText.slice(0, 200));

  console.log("\n--- results ---");
  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.n}${c.ok ? "" : "  -> " + (c.d ?? "")}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);

  pc.ws.close();
  bc.ws.close();
  child.kill();
  server.close();
  await sleep(600);
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true });
  } catch {}
  process.exitCode = failed ? 1 : 0;
})().catch((e) => {
  console.error("HARNESS ERROR", e);
  server.close();
  process.exitCode = 2;
});
