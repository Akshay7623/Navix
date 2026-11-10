const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const EXT = path.resolve(__dirname, "..", "dist");
const EXT_ID = require("./ext-id.cjs")(EXT);
const PROFILE = path.join(os.tmpdir(), "agent-e2e-" + Date.now());
const PORT = 9401;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- mock OpenAI-compatible provider ---------------- */

const PAGE_HTML = `<!doctype html><html><head><title>E2E Form</title></head><body>
<h1>Signup</h1>
<label for="email">Email</label>
<input id="email" type="email" placeholder="you@example.com">
<button id="go" onclick="document.getElementById('out').textContent='SUBMITTED:'+document.getElementById('email').value">Submit</button>
<div id="out">idle</div>
</body></html>`;

let step = 0;
const seen = [];

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
function toolCall(res, name, args) {
  sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_" + step, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
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
      seen.push({ step, tools: parsed.tools?.length ?? 0, lastTool: last?.name, lastContent: last?.content?.slice(0, 300) });

      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" });

      if (step === 0) {
        step++;
        toolCall(res, "read_page", {});
        return;
      }
      if (step === 1) {
        const tree = last?.content ?? "";
        const emailRef = (tree.match(/textbox[^\n]*\[(ref_\d+)\]/) || [])[1];
        const btnRef = (tree.match(/button[^\n]*\[(ref_\d+)\]/) || [])[1];
        seen.push({ extracted: { emailRef, btnRef } });
        step++;
        if (!emailRef) { say(res, "FAILED: no textbox ref in tree"); return; }
        toolCall(res, "type", { ref: emailRef, text: "hello@example.com" });
        return;
      }
      if (step === 2) {
        const tree = seen.find((s) => s.extracted)?.extracted ?? {};
        step++;
        toolCall(res, "click", { ref: tree.btnRef });
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
        say(res, text.includes("SUBMITTED:hello@example.com")
          ? "DONE: form submitted with the right value."
          : "FAILED: page text was " + text.slice(0, 200));
        return;
      }
      say(res, "unexpected step");
    });
    return;
  }
  res.writeHead(404); res.end();
});

/* ---------------- browser ---------------- */

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  fs.mkdirSync(PROFILE, { recursive: true });

  const child = spawn(EDGE, [
    "--remote-debugging-port=9402",
    "--user-data-dir=" + PROFILE,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--window-size=1280,900",
    "--load-extension=" + EXT,
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  const getJson = async (p) => (await fetch(`http://127.0.0.1:9402${p}`)).json();

  let targets = [];
  for (let i = 0; i < 80; i++) {
    try { targets = await getJson("/json/list"); } catch { await sleep(250); continue; }
    if (targets.some((t) => t.type === "service_worker" && t.url === `chrome-extension://${EXT_ID}/background.js`)) break;
    await sleep(250);
  }
  const sw = targets.find((t) => t.type === "service_worker" && t.url === `chrome-extension://${EXT_ID}/background.js`);
  if (!sw) { console.log("FAIL: no service worker"); console.log(log.slice(-2000)); child.kill(); server.close(); process.exitCode = 1; return; }
  const extId = new URL(sw.url).host;
  console.log("extension:", extId);

  const connect = async (wsUrl) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const waiters = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
    });
    await new Promise((r) => ws.addEventListener("open", r));
    const send = (method, params) => new Promise((res) => { const i = ++id; waiters.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send("Runtime.enable", {});
    const evaluate = async (expression) => {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text };
      return { value: r.result?.result?.value };
    };
    return { ws, send, evaluate };
  };

  const swc = await connect(sw.webSocketDebuggerUrl);

  // Open the side panel via CDP so we never depend on the service worker's chrome
  // binding, which is unreliable while the worker is starting up.
  const browserWs = (await getJson("/json/version")).webSocketDebuggerUrl;
  const bc = await connect(browserWs);
  await bc.send("Target.createTarget", { url: `chrome-extension://${extId}/src/sidepanel/index.html` });
  await sleep(1500);
  const list = await getJson("/json/list");
  const panelTarget = list.find((t) => t.url.includes("sidepanel/index.html"));
  if (!panelTarget) { console.log("FAIL: sidepanel target missing"); child.kill(); server.close(); process.exitCode = 1; return; }
  const pc = await connect(panelTarget.webSocketDebuggerUrl);

  // Create the test page from the panel page context and confirm the tab really
  // navigated. A silent `undefined` here would make the agent fall back to the
  // active about:blank tab and fail for the wrong reason.
  const tabId = await pc.evaluate(`chrome.tabs.create({ url: "http://127.0.0.1:${PORT}/page", active: true }).then(t => t.id)`);
  if (typeof tabId.value !== "number") {
    console.log("FAIL: could not create test tab ->", JSON.stringify(tabId));
    child.kill(); server.close(); process.exitCode = 1; return;
  }
  console.log("test tab:", tabId.value);
  let pageReady = false;
  for (let i = 0; i < 40; i++) {
    const t = await pc.evaluate(`chrome.tabs.get(${tabId.value}).then(t => t.status + "|" + t.url)`);
    if (t.value === `complete|http://127.0.0.1:${PORT}/page`) { pageReady = true; break; }
    await sleep(250);
  }
  if (!pageReady) {
    console.log("FAIL: test tab never reached the page");
    child.kill(); server.close(); process.exitCode = 1; return;
  }

  // Point the extension at the mock provider. Written from the panel page because
  // an idle MV3 service worker target has no `chrome` binding.
  const cfg = await pc.evaluate(`chrome.storage.local.set({ settings: {
    provider: "custom",
    baseUrl: "http://127.0.0.1:${PORT}/v1/chat/completions",
    apiKey: "test-key",
    model: "mock-model",
    temperature: 0,
    maxTokens: 1024,
    maxSteps: 10,
    approvalMode: "auto",
    systemPromptExtra: "",
    visionEnabled: false
  }}).then(() => "ok").catch(e => "ERR:" + e.message)`);
  console.log("settings:", cfg.value ?? cfg.error);

  await pc.evaluate(`window.__events = []; chrome.runtime.onMessage.addListener(m => { if (m && m.__event) window.__events.push(m.event); }); "ok"`);

  const started = await pc.evaluate(`chrome.runtime.sendMessage({ type: "agent/run", prompt: "Fill the email field and submit the form.", tabId: ${tabId.value} }).then(r => JSON.stringify(r))`);
  console.log("run:", started.value ?? started.error);

  let finalState = null;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const st = await pc.evaluate(`chrome.runtime.sendMessage({ type: "agent/state" }).then(r => JSON.stringify(r))`);
    try { finalState = JSON.parse(st.value)?.data ?? null; } catch { finalState = null; }
    if (finalState && finalState.running === false) break;
  }

  const events = await pc.evaluate(`JSON.stringify(window.__events)`);
  const evs = JSON.parse(events.value ?? "[]");

  console.log("\n--- provider saw ---");
  for (const s of seen) console.log("  " + JSON.stringify(s).slice(0, 220));

  console.log("\n--- agent events ---");
  for (const e of evs) console.log("  " + JSON.stringify(e).slice(0, 240));

  const done = evs.find((e) => e.type === "agent/done");
  const err = evs.find((e) => e.type === "agent/error");
  const toolResults = evs.filter((e) => e.type === "agent/tool_result" || e.type === "tool/result");

  const checks = [];
  const check = (n, ok, d) => checks.push({ n, ok: !!ok, d });
  check("agent finished without error", !err, err?.message);
  check("agent emitted done", !!done, JSON.stringify(finalState));
  check("provider received tools", seen[0]?.tools > 0, String(seen[0]?.tools));
  check("read_page returned a textbox ref", !!seen.find((s) => s.extracted?.emailRef), JSON.stringify(seen.find((s) => s.extracted)));
  check("read_page returned a button ref", !!seen.find((s) => s.extracted?.btnRef), JSON.stringify(seen.find((s) => s.extracted)));
  check("type tool ran", seen.some((s) => s.lastTool === "type"), JSON.stringify(seen.map((s) => s.lastTool)));
  check("click tool ran", seen.some((s) => s.lastTool === "click"), JSON.stringify(seen.map((s) => s.lastTool)));
  check("get_page_text ran", seen.some((s) => s.lastTool === "get_page_text"), JSON.stringify(seen.map((s) => s.lastTool)));
  check("form actually submitted with typed value", seen.some((s) => (s.lastContent ?? "").includes("SUBMITTED:hello@example.com")), JSON.stringify(seen.map((s) => s.lastContent)));

  console.log("\n--- results ---");
  let failed = 0;
  for (const c of checks) { if (!c.ok) failed++; console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.n}${c.ok ? "" : "  -> " + (c.d ?? "")}`); }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);

  pc.ws.close(); swc.ws.close();
  child.kill(); server.close();
  await sleep(600);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error("HARNESS ERROR", e); server.close(); process.exitCode = 2; });
