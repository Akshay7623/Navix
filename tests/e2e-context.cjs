/**
 * Real-browser end-to-end test for what the agent sends as a task grows:
 *
 *   - one system message, with the extra system prompt appended to it
 *   - reasoning effort goes to custom endpoints as chat_template_kwargs, and
 *     defaults to medium; "default" and hosted presets send nothing
 *   - old read_page outputs are replaced by a stub once enough pile up, in a
 *     batch, keeping the newest two in full
 *   - a reply cut off by max_tokens fails once with a clear error instead of
 *     the whole request being sent again without streaming
 *   - a server that ignores `stream: true` still gets the non-streaming retry
 *
 * Run with: node tests/e2e-context.cjs
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const EXT = path.resolve(__dirname, "..", "dist");
const EXT_ID = require("./ext-id.cjs")(EXT);
const PROFILE = path.join(os.tmpdir(), "agent-e2e-context-" + Date.now());
const PORT = 9451;
const DEBUG_PORT = 9452;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Enough text that every read_page fills its 20,000-character default.
const ITEMS = Array.from({ length: 900 }, (_, i) => `<li>Catalogue entry ${i} with some filler words</li>`).join("");
const PAGE_HTML = `<!doctype html><html><head><title>Big Page</title></head><body><h1>Big Page</h1><ul>${ITEMS}</ul></body></html>`;

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
function openStream(res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Access-Control-Allow-Origin": "*" });
}
function say(res, text) {
  openStream(res);
  sse(res, { choices: [{ delta: { content: text } }] });
  sse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
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
  sse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  res.write("data: [DONE]\n\n");
  res.end();
}
/** Thinking that runs into max_tokens before any answer. */
function thinkUntilCut(res) {
  openStream(res);
  sse(res, { choices: [{ delta: { reasoning: "Let me consider every possibility..." } }] });
  sse(res, { choices: [{ delta: {}, finish_reason: "length" }] });
  res.write("data: [DONE]\n\n");
  res.end();
}
/** A server that ignores `stream: true` and answers with one JSON body. */
function jsonAnswer(res, text) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] }));
}

let replies = [];
let fallback = (res) => say(res, "(script exhausted)");
let requests = [];

const server = http.createServer((req, res) => {
  if (req.url === "/page") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(PAGE_HTML);
    return;
  }
  if (req.url !== "/v1/chat/completions") {
    res.writeHead(404);
    res.end();
    return;
  }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
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

  // No reasoningEffort here on purpose: settings saved by an older version
  // lack it, and the stored defaults must fill it in as medium.
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
    systemPromptExtra: "EXTRA RULE: answer in English.",
    visionEnabled: false
  }}).then(() => "ok")`);
  await pc.evaluate(`window.__events = []; chrome.runtime.onMessage.addListener(m => { if (m && m.__event) window.__events.push(m.event); }); "ok"`);

  const patchSettings = (patch) =>
    pc.evaluate(`chrome.storage.local.get("settings").then(s => chrome.storage.local.set({ settings: { ...s.settings, ...${JSON.stringify(patch)} } })).then(() => "ok")`);
  const events = async () => JSON.parse(await pc.evaluate(`JSON.stringify(window.__events)`));
  const startRun = () =>
    pc.evaluate(`window.__events.length = 0; chrome.runtime.sendMessage({ type: "agent/run", prompt: "go", tabId: ${tabId} }).then(() => "ok")`);
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
  const toolContents = (req) => req.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
  const isStub = (text) => text.startsWith("[Removed to save context:");

  const checks = [];
  const check = (n, ok, d) => checks.push({ n, ok: !!ok, d });

  /* ---------- system message and reasoning effort ---------- */
  scenario([(r) => say(r, "HELLO")]);
  await startRun();
  let evs = await waitFor(ended, 8000);
  await settle();
  const first = requests[0] ?? { messages: [] };
  const systems = first.messages.filter((m) => m.role === "system");
  check("system: exactly one system message", systems.length === 1, JSON.stringify(first.messages.map((m) => m.role)));
  check("system: extra prompt appended to it", systems[0] && String(systems[0].content).endsWith("EXTRA RULE: answer in English."), String(systems[0]?.content).slice(-80));
  check("system: it comes first", first.messages[0]?.role === "system", first.messages[0]?.role);
  check("effort: medium by default on custom endpoints", first.chat_template_kwargs?.reasoning_effort === "medium", JSON.stringify(first.chat_template_kwargs));
  check("effort: run answers", answer(evs) === "HELLO", JSON.stringify(evs));

  await patchSettings({ reasoningEffort: "low" });
  scenario([(r) => say(r, "LOW")]);
  await startRun();
  await waitFor(ended, 8000);
  await settle();
  check("effort: the chosen level is sent", requests[0]?.chat_template_kwargs?.reasoning_effort === "low", JSON.stringify(requests[0]?.chat_template_kwargs));

  await patchSettings({ reasoningEffort: "default" });
  scenario([(r) => say(r, "DEFAULT")]);
  await startRun();
  await waitFor(ended, 8000);
  await settle();
  check("effort: 'default' sends nothing", requests[0] && !("chat_template_kwargs" in requests[0]), JSON.stringify(requests[0]?.chat_template_kwargs));

  await patchSettings({ reasoningEffort: "medium", provider: "deepseek" });
  scenario([(r) => say(r, "HOSTED")]);
  await startRun();
  await waitFor(ended, 8000);
  await settle();
  check("effort: hosted presets send nothing", requests[0] && !("chat_template_kwargs" in requests[0]), JSON.stringify(requests[0]?.chat_template_kwargs));
  await patchSettings({ provider: "custom" });

  /* ---------- old page snapshots are compacted in a batch ---------- */
  scenario([
    (r) => callTool(r, "read_page", {}),
    (r) => callTool(r, "read_page", {}),
    (r) => callTool(r, "read_page", {}),
    (r) => callTool(r, "read_page", {}),
    (r) => say(r, "READ FOUR TIMES"),
  ]);
  await startRun();
  evs = await waitFor(ended, 20000);
  await settle();
  check("compact: run finishes", answer(evs) === "READ FOUR TIMES" && !ofType(evs, "agent/error").length, JSON.stringify(ofType(evs, "agent/error")));
  check("compact: five model requests", requests.length === 5, String(requests.length));
  const sizes = (requests[3] ? toolContents(requests[3]) : []).map((t) => t.length);
  check("compact: each read_page is large", sizes.length === 3 && sizes.every((n) => n >= 20000), JSON.stringify(sizes));
  check(
    "compact: below the threshold nothing is removed",
    requests[3] && toolContents(requests[3]).every((t) => !isStub(t)),
    JSON.stringify(requests[3] && toolContents(requests[3]).map((t) => t.slice(0, 40))),
  );
  const last = requests[4] ? toolContents(requests[4]) : [];
  check("compact: older snapshots replaced by a stub", last.length === 4 && isStub(last[0]) && isStub(last[1]), JSON.stringify(last.map((t) => t.slice(0, 60))));
  check("compact: newest two kept in full", last.length === 4 && !isStub(last[2]) && !isStub(last[3]) && last[3].length >= 20000, JSON.stringify(last.map((t) => t.length)));
  check("compact: stub names the page and says what to do", /URL: http:\/\/127\.0\.0\.1:\d+\/page/.test(last[0] ?? "") && /Call read_page again/.test(last[0] ?? ""), last[0]);
  check(
    "compact: tool messages keep their call ids",
    requests[4] && requests[4].messages.filter((m) => m.role === "tool").every((m) => m.tool_call_id && m.name === "read_page"),
    JSON.stringify(requests[4]?.messages.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, m.name])),
  );

  /* ---------- a reply cut off by max_tokens ---------- */
  scenario([thinkUntilCut], (r) => say(r, "SHOULD NOT BE ASKED"));
  await startRun();
  evs = await waitFor(ended, 8000);
  await settle();
  const cutError = ofType(evs, "agent/error")[0]?.message ?? "";
  check("max_tokens: request is not sent again", requests.length === 1, `${requests.length} requests`);
  check("max_tokens: error says to raise Max tokens", /Max tokens/.test(cutError) && /never answered/.test(cutError), cutError);
  check("max_tokens: no retry note", !ofType(evs, "agent/retry").length, JSON.stringify(ofType(evs, "agent/retry")));

  /* ---------- a stream that ended without an answer is not repeated ---------- */
  scenario([(r) => say(r, "")], (r) => say(r, "SHOULD NOT BE ASKED"));
  await startRun();
  evs = await waitFor(ended, 8000);
  await settle();
  check("empty stream: request is not sent again", requests.length === 1, `${requests.length} requests`);

  /* ---------- a server that ignores stream: true ---------- */
  scenario([(r) => jsonAnswer(r, "PLAIN JSON"), (r) => jsonAnswer(r, "PLAIN JSON")]);
  await startRun();
  evs = await waitFor(ended, 8000);
  await settle();
  check("no-stream server: falls back once", requests.length === 2 && requests[1].stream === false, `${requests.length} requests, stream=${requests[1]?.stream}`);
  check("no-stream server: answer arrives", answer(evs) === "PLAIN JSON", answer(evs));

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
