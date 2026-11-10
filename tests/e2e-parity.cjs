/**
 * Real-browser end-to-end test for the parity features added on top of the
 * core agent loop:
 *
 *   - `update_plan` → `agent/plan` event → side panel plan list
 *   - GIF recording → `agent/gif` event → `gif/export` handler
 *   - the safety gate refusing a `blocked` site even in `auto` approval mode
 *
 * Run with: node tests/e2e-parity.cjs
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const EXT = path.resolve(__dirname, "..", "dist");
const EXT_ID = require("./ext-id.cjs")(EXT);
const PROFILE = path.join(os.tmpdir(), "agent-e2e-parity-" + Date.now());
const PORT = 9421;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE_HTML = `<!doctype html><html><head><title>Parity Lab</title></head><body>
<h1>Parity Lab</h1>
<button id="a" onclick="document.getElementById('out').textContent='CLICKED'">Press me</button>
<div id="out">idle</div>
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
      const toolMsgs = parsed.messages.filter((m) => m.role === "tool");
      const last = toolMsgs[toolMsgs.length - 1];
      seen.push({ step, lastTool: last?.name, lastContent: last?.content?.slice(0, 300) });

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      });

      if (step === 0) {
        step++;
        toolCall(res, "update_plan", {
          steps: [
            { step: "Read the page", status: "in_progress" },
            { step: "Press the button", status: "pending" },
          ],
        });
        return;
      }
      if (step === 1) {
        step++;
        toolCall(res, "read_page", {});
        return;
      }
      if (step === 2) {
        const tree = last?.content ?? "";
        const btnRef = (tree.match(/button[^\n]*\[(ref_\d+)\]/) || [])[1];
        seen.push({ extracted: { btnRef } });
        step++;
        if (!btnRef) {
          say(res, "FAILED: no button ref");
          return;
        }
        toolCall(res, "update_plan", {
          steps: [
            { step: "Read the page", status: "done" },
            { step: "Press the button", status: "in_progress" },
          ],
        });
        return;
      }
      if (step === 3) {
        step++;
        const btnRef = seen.find((s) => s.extracted)?.extracted?.btnRef;
        toolCall(res, "click", { ref: btnRef });
        return;
      }
      if (step === 4) {
        step++;
        toolCall(res, "update_plan", {
          steps: [
            { step: "Read the page", status: "done" },
            { step: "Press the button", status: "done" },
          ],
        });
        return;
      }
      if (step === 5) {
        step++;
        toolCall(res, "get_page_text", {});
        return;
      }
      if (step === 6) {
        step++;
        const text = last?.content ?? "";
        say(res, text.includes("CLICKED") ? "DONE: button pressed." : "FAILED: " + text.slice(0, 120));
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
      "--remote-debugging-port=9422",
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

  const getJson = async (p) => (await fetch(`http://127.0.0.1:9422${p}`)).json();

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
    maxSteps: 12,
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
    `chrome.runtime.sendMessage({ type: "agent/run", prompt: "Press the button.", tabId: ${tabId.value} }).then(r => JSON.stringify(r))`,
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

  // The side panel must have rendered the plan from the last agent/plan event.
  const planDom = await pc.evaluate(
    `JSON.stringify({
       hidden: document.getElementById("planBar").classList.contains("hidden"),
       progress: document.getElementById("planProgress").textContent,
       steps: Array.from(document.querySelectorAll("#planList .plan-step")).map(li => li.className + "|" + li.textContent)
     })`,
  );
  const plan = JSON.parse(planDom.value ?? "{}");

  // GIF export must hand back a real GIF89a data URL.
  const gifExport = await pc.evaluate(
    `chrome.runtime.sendMessage({ type: "gif/export" }).then(r => JSON.stringify({ ok: r?.ok, frames: r?.data?.frames, head: r?.data?.dataUrl?.slice(0, 30), len: r?.data?.dataUrl?.length }))`,
  );
  const gifInfo = JSON.parse(gifExport.value ?? "{}");

  // Safety gate: a blocked host must be refused even with approvalMode=auto.
  const seenBeforeBlocked = seen.length;
  const blocked = await pc.evaluate(`(async () => {
    window.__blockedEvents = [];
    const listener = (m) => { if (m && m.__event) window.__blockedEvents.push(m.event); };
    chrome.runtime.onMessage.addListener(listener);
    const tab = await chrome.tabs.create({ url: "https://www.paypal.com/", active: true });
    await new Promise(r => setTimeout(r, 2500));
    const res = await chrome.runtime.sendMessage({ type: "agent/run", prompt: "click something", tabId: tab.id });
    await new Promise(r => setTimeout(r, 4000));
    const st = await chrome.runtime.sendMessage({ type: "agent/state" });
    chrome.runtime.onMessage.removeListener(listener);
    await chrome.tabs.remove(tab.id);
    return JSON.stringify({ run: res, state: st?.data ?? st, events: window.__blockedEvents });
  })()`);
  const blockedInfo = JSON.parse(blocked.value ?? "{}");

  console.log("\n--- provider saw ---");
  for (const s of seen) console.log("  " + JSON.stringify(s).slice(0, 240));

  console.log("\n--- agent events ---");
  for (const e of evs) console.log("  " + JSON.stringify(e).slice(0, 200));

  console.log("\n--- plan dom ---");
  console.log("  " + JSON.stringify(plan));

  console.log("\n--- gif export ---");
  console.log("  " + JSON.stringify(gifInfo));

  console.log("\n--- blocked site ---");
  console.log("  " + JSON.stringify(blockedInfo).slice(0, 400));

  const done = evs.find((e) => e.type === "agent/done");
  const err = evs.find((e) => e.type === "agent/error");
  const planEvents = evs.filter((e) => e.type === "agent/plan");
  const gifEvent = evs.find((e) => e.type === "agent/gif");

  const checks = [];
  const check = (n, ok, d) => checks.push({ n, ok: !!ok, d });
  check("agent finished without error", !err, err?.message);
  check("agent emitted done", !!done, JSON.stringify(finalState));
  check("update_plan ran", seen.some((s) => s.lastTool === "update_plan"), JSON.stringify(seen.map((s) => s.lastTool)));
  check("agent/plan emitted 3 times", planEvents.length === 3, String(planEvents.length));
  check("agent/plan carries 2 steps", planEvents[0]?.steps?.length === 2, JSON.stringify(planEvents[0]));
  check("agent/plan final step done", planEvents[2]?.steps?.[1]?.status === "done", JSON.stringify(planEvents[2]));
  check("state exposes the plan", finalState?.plan?.length === 2, JSON.stringify(finalState?.plan));
  check("plan bar visible in the panel", plan.hidden === false, JSON.stringify(plan));
  check("plan progress shows 2/2", plan.progress === "2/2", plan.progress);
  check("plan list rendered 2 steps", plan.steps?.length === 2, JSON.stringify(plan.steps));
  check("plan step styled done", (plan.steps ?? []).every((s) => s.startsWith("plan-step done")), JSON.stringify(plan.steps));
  check("agent/gif emitted", !!gifEvent && gifEvent.frames >= 2, JSON.stringify(gifEvent));
  check("gif/export returned frames", gifInfo.frames >= 2, JSON.stringify(gifInfo));
  check("gif/export returned a GIF89a data url", (gifInfo.head ?? "").startsWith("data:image/gif;base64,R0lGOD"), gifInfo.head);
  check("gif/export payload is non-trivial", (gifInfo.len ?? 0) > 2000, String(gifInfo.len));
  check(
    "blocked site: error event explains why",
    (blockedInfo.events ?? []).some((e) => e.type === "agent/error" && /blocked/i.test(e.message)),
    JSON.stringify(blockedInfo.events),
  );
  check(
    "blocked site: run did not start",
    !(blockedInfo.events ?? []).some((e) => e.type === "agent/step" || e.type === "agent/tool_start"),
    JSON.stringify((blockedInfo.events ?? []).map((e) => e.type)),
  );
  check("blocked site: no tool ran", seen.length === seenBeforeBlocked, JSON.stringify(seen.slice(seenBeforeBlocked).map((s) => s.lastTool)));

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
