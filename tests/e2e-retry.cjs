/**
 * Real-browser end-to-end test for model-call retries:
 *
 *   - cold-start 503s are waited out, with a live note in the side panel
 *   - a failure mid-run keeps the run's progress and does not repeat its tools
 *   - dropped connections retry and `Retry-After` is honoured
 *   - Stop ends a wait, and errors that are not transient fail immediately
 *   - a turn that already streamed text is never retried
 *   - the configured API URL is requested exactly as entered
 *
 * Run with: node tests/e2e-retry.cjs
 * E2E_RETRY_FULL=1 also waits out the whole retry budget (about three minutes).
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const EXT = path.resolve(__dirname, "..", "dist");
const EXT_ID = require("./ext-id.cjs")(EXT);
const PROFILE = path.join(os.tmpdir(), "agent-e2e-retry-" + Date.now());
const PORT = 9441;
const DEBUG_PORT = 9442;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE_HTML = `<!doctype html><html><head><title>Retry Lab</title></head><body><h1>Retry Lab</h1></body></html>`;
const NO_UPSTREAMS = JSON.stringify({ error: "no upstreams available" });

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
function openStream(res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Access-Control-Allow-Origin": "*" });
}
function say(res, text) {
  openStream(res);
  sse(res, { choices: [{ delta: { content: text } }] });
  res.write("data: [DONE]\n\n");
  res.end();
}
function callTool(res, name, args) {
  openStream(res);
  sse(res, {
    choices: [
      { delta: { tool_calls: [{ index: 0, id: "call_" + requests.length, type: "function", function: { name, arguments: JSON.stringify(args) } }] } },
    ],
  });
  res.write("data: [DONE]\n\n");
  res.end();
}
function fail(res, status, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(NO_UPSTREAMS);
}

/** Replies for the current scenario, consumed one per model request. */
let replies = [];
/** Reply used once `replies` runs out. */
let fallback = (res) => say(res, "(script exhausted)");
let requests = [];
/** A custom endpoint path, to prove the configured URL is used as entered. */
const EXACT_PATH = "/my/model/generate/?key=1";
const paths = [];

const server = http.createServer((req, res) => {
  if (req.url === "/page") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(PAGE_HTML);
    return;
  }
  if (req.url !== "/v1/chat/completions" && req.url !== EXACT_PATH) {
    res.writeHead(404);
    res.end();
    return;
  }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    paths.push(req.url);
    requests.push(JSON.parse(body));
    (replies.shift() ?? fallback)(res, req);
  });
});

function scenario(list, otherwise) {
  replies = list;
  requests = [];
  fallback = otherwise ?? ((res) => say(res, "(script exhausted)"));
}

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  fs.mkdirSync(PROFILE, { recursive: true });

  const child = spawn(
    EDGE,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
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

  const getJson = async (p) => (await fetch(`http://127.0.0.1:${DEBUG_PORT}${p}`)).json();

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
  if (!sw) throw new Error("no service worker");
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
      if (r.result?.exceptionDetails) {
        throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
      }
      return r.result?.result?.value;
    };
    return { ws, send, evaluate };
  };

  const bc = await connect((await getJson("/json/version")).webSocketDebuggerUrl);
  await bc.send("Target.createTarget", { url: `chrome-extension://${extId}/src/sidepanel/index.html` });
  await sleep(1500);
  const panelTarget = (await getJson("/json/list")).find((t) => t.url.includes("sidepanel/index.html"));
  if (!panelTarget) throw new Error("sidepanel target missing");
  const pc = await connect(panelTarget.webSocketDebuggerUrl);

  const tabId = await pc.evaluate(`chrome.tabs.create({ url: "http://127.0.0.1:${PORT}/page", active: true }).then(t => t.id)`);
  for (let i = 0; i < 40; i++) {
    if ((await pc.evaluate(`chrome.tabs.get(${tabId}).then(t => t.status)`)) === "complete") break;
    await sleep(250);
  }

  await pc.evaluate(`chrome.storage.local.set({ settings: {
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
  }}).then(() => "ok")`);
  await pc.evaluate(`window.__events = []; chrome.runtime.onMessage.addListener(m => { if (m && m.__event) window.__events.push(m.event); }); "ok"`);

  const events = async () => JSON.parse(await pc.evaluate(`JSON.stringify(window.__events)`));
  const startRun = () =>
    pc.evaluate(`window.__events.length = 0; chrome.runtime.sendMessage({ type: "agent/run", prompt: "go", tabId: ${tabId} }).then(() => "ok")`);
  const stopRun = () => pc.evaluate(`chrome.runtime.sendMessage({ type: "agent/abort" }).then(() => "ok")`);
  const noteText = () => pc.evaluate(`document.querySelector(".retry-note")?.textContent ?? ""`);
  const waitFor = async (predicate, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const evs = await events();
      if (predicate(evs)) return evs;
      await sleep(100);
    }
    return events();
  };
  const ended = (evs) => evs.some((e) => e.type === "agent/done" || e.type === "agent/error");
  const ofType = (evs, type) => evs.filter((e) => e.type === type);
  const answer = (evs) => ofType(evs, "agent/delta").map((e) => e.text).join("");
  const settle = () => sleep(500);

  const checks = [];
  const check = (n, ok, d) => checks.push({ n, ok: !!ok, d });

  /* ---------- the configured URL is used exactly as entered ---------- */
  const setUrl = (url) =>
    pc.evaluate(`chrome.storage.local.get("settings").then(s => chrome.storage.local.set({ settings: { ...s.settings, baseUrl: ${JSON.stringify(url)} } })).then(() => "ok")`);
  await setUrl(`http://127.0.0.1:${PORT}${EXACT_PATH}`);
  scenario([(r) => say(r, "EXACT")]);
  paths.length = 0;
  await startRun();
  let evs = await waitFor(ended, 5000);
  await settle();
  check("exact URL: nothing appended or stripped", paths.join() === EXACT_PATH, paths.join());
  check("exact URL: run succeeds", answer(evs) === "EXACT", JSON.stringify(evs));
  await setUrl(`http://127.0.0.1:${PORT}/v1/chat/completions`);

  /* ---------- cold start, with the note visible during the wait ---------- */
  scenario([(r) => fail(r, 503), (r) => fail(r, 503), (r) => say(r, "WARM")]);
  await startRun();
  await waitFor((evs) => ofType(evs, "agent/retry").length >= 1, 5000);
  const liveNote = await noteText();
  evs = await waitFor(ended, 15000);
  await settle();
  check("cold start: run finishes without error", !ofType(evs, "agent/error").length, JSON.stringify(evs));
  check("cold start: answer arrives", answer(evs) === "WARM", answer(evs));
  check("cold start: retried twice", ofType(evs, "agent/retry").length === 2, String(ofType(evs, "agent/retry").length));
  check("cold start: three requests sent", requests.length === 3, String(requests.length));
  check("cold start: delays double", ofType(evs, "agent/retry").map((e) => e.delayMs).join() === "2000,4000", JSON.stringify(ofType(evs, "agent/retry")));
  check("cold start: panel explains the wait", /returned 503/.test(liveNote) && /attempt 1 of 12/.test(liveNote), liveNote);
  check("cold start: note is removed afterwards", (await noteText()) === "", await noteText());
  const stored = await pc.evaluate(`chrome.storage.local.get("conversations").then(s => JSON.stringify(s.conversations ?? []))`);
  check("cold start: retry notes stay out of history", !stored.includes("agent/retry"), stored.slice(0, 200));

  /* ---------- failure mid-run keeps progress ---------- */
  scenario([(r) => callTool(r, "get_page_text", {}), (r) => fail(r, 502), (r) => say(r, "RESUMED")]);
  await startRun();
  evs = await waitFor(ended, 12000);
  await settle();
  check("mid-run: run finishes", answer(evs) === "RESUMED" && !ofType(evs, "agent/error").length, JSON.stringify(evs));
  check("mid-run: the tool ran only once", ofType(evs, "agent/tool_end").length === 1, String(ofType(evs, "agent/tool_end").length));
  check(
    "mid-run: retry still carries the tool result",
    requests[2]?.messages.some((m) => m.role === "tool" && String(m.content).includes("Retry Lab")),
    JSON.stringify(requests[2]?.messages.map((m) => m.role)),
  );

  /* ---------- dropped connection ---------- */
  scenario([(_r, req) => req.socket.destroy(), (r) => say(r, "RECONNECTED")]);
  await startRun();
  evs = await waitFor(ended, 12000);
  await settle();
  check("connection: recovers", answer(evs) === "RECONNECTED", JSON.stringify(evs));
  check("connection: retry has no status", ofType(evs, "agent/retry")[0]?.status === undefined && ofType(evs, "agent/retry").length === 1, JSON.stringify(ofType(evs, "agent/retry")));

  /* ---------- Retry-After ---------- */
  scenario([(r) => fail(r, 429, { "Retry-After": "5" }), (r) => say(r, "OK")]);
  await startRun();
  evs = await waitFor(ended, 12000);
  await settle();
  check("Retry-After: honoured over the shorter backoff", ofType(evs, "agent/retry")[0]?.delayMs === 5000, JSON.stringify(ofType(evs, "agent/retry")));

  /* ---------- errors that must not retry ---------- */
  scenario([(r) => fail(r, 401)]);
  await startRun();
  evs = await waitFor(ended, 5000);
  await settle();
  check("401: fails immediately", ofType(evs, "agent/error").length === 1 && requests.length === 1, `${requests.length} requests`);
  check("401: no retry note", !ofType(evs, "agent/retry").length, JSON.stringify(evs));

  /* ---------- a turn that already streamed ---------- */
  scenario([
    (res) => {
      openStream(res);
      sse(res, { choices: [{ delta: { content: "PARTIAL" } }] });
      setTimeout(() => res.socket.destroy(), 100);
    },
  ]);
  await startRun();
  evs = await waitFor(ended, 5000);
  await settle();
  check("partial stream: not retried", requests.length === 1 && !ofType(evs, "agent/retry").length, `${requests.length} requests`);
  check("partial stream: error reported", ofType(evs, "agent/error").length === 1, JSON.stringify(evs));
  check("partial stream: text not duplicated", answer(evs) === "PARTIAL", answer(evs));

  /* ---------- Stop during a wait ---------- */
  scenario([], (r) => fail(r, 503));
  await startRun();
  await waitFor((e) => ofType(e, "agent/retry").length >= 2, 8000); // now in the 4 s wait
  const requestsAtStop = requests.length;
  const stoppedAt = Date.now();
  await stopRun();
  evs = await waitFor(ended, 3000);
  const stopTook = Date.now() - stoppedAt;
  await sleep(4500); // past when the next retry would have fired
  const stateAfterStop = JSON.parse(await pc.evaluate(`chrome.runtime.sendMessage({ type: "agent/state" }).then(r => JSON.stringify(r.data))`));
  check("Stop: ends the wait promptly", ofType(evs, "agent/done").length === 1 && stopTook < 1500, `${stopTook} ms`);
  check("Stop: reports no error", !ofType(evs, "agent/error").length, JSON.stringify(evs));
  check("Stop: no further requests", requests.length === requestsAtStop, `${requestsAtStop} -> ${requests.length}`);
  check("Stop: run is over", stateAfterStop.running === false, JSON.stringify(stateAfterStop));
  check("Stop: note is removed", (await noteText()) === "", await noteText());

  /* ---------- whole retry budget ---------- */
  if (process.env.E2E_RETRY_FULL) {
    scenario([], (r) => fail(r, 503));
    await startRun();
    const t0 = Date.now();
    evs = await waitFor(ended, 240000);
    const seconds = Math.round((Date.now() - t0) / 1000);
    console.log(`budget exhausted after ${seconds}s`);
    check("budget: 12 retries then 13 requests in total", ofType(evs, "agent/retry").length === 12 && requests.length === 13, `${ofType(evs, "agent/retry").length} retries, ${requests.length} requests`);
    check("budget: lasts about three minutes", seconds >= 180 && seconds <= 210, `${seconds}s`);
    const error = ofType(evs, "agent/error")[0]?.message ?? "";
    check("budget: error keeps the cause and says what to do", /no upstreams available/.test(error) && /Send your message again/.test(error), error);
    check("budget: delays never exceed the cap", ofType(evs, "agent/retry").every((e) => e.delayMs <= 20000), JSON.stringify(ofType(evs, "agent/retry").map((e) => e.delayMs)));
  }

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
    fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {}
  process.exitCode = failed ? 1 : 0;
  process.exit();
})().catch((e) => {
  console.error("HARNESS ERROR", e);
  process.exit(2);
});
