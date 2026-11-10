/**
 * Real-browser end-to-end test for side-panel transcript behaviour:
 *
 *   - reasoning is split into one collapsible block per model turn, and all of a
 *     run's steps are nested inside a single "Thinking" group, instead of every
 *     step's thinking concatenating into a single wall of text
 *   - the "New chat" button clears the transcript and restores the empty state
 *
 * Run with: node tests/e2e-ui.cjs
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const EXT = path.resolve(__dirname, "..", "dist");
const EXT_ID = require("./ext-id.cjs")(EXT);
const PROFILE = path.join(os.tmpdir(), "agent-e2e-ui-" + Date.now());
const PORT = 9431;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE_HTML = `<!doctype html><html><head><title>UI Lab</title></head><body>
<h1>UI Lab</h1>
<p id="body">A page with some text so read_page returns something.</p>
</body></html>`;

let step = 0;
/** Every chat-completions request body, so tests can inspect what the model saw. */
const requestBodies = [];

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/** Emit a reasoning delta, then a tool call, in one streamed turn. */
function reasoningThenTool(res, reasoning, name, args) {
  sse(res, { choices: [{ delta: { reasoning_content: reasoning } }] });
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

/** Emit a reasoning delta, then a plain answer. */
function reasoningThenSay(res, reasoning, text) {
  sse(res, { choices: [{ delta: { reasoning_content: reasoning } }] });
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
      try {
        requestBodies.push(JSON.parse(body));
      } catch {
        requestBodies.push({ raw: body });
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      });

      if (step === 0) {
        step++;
        reasoningThenTool(res, "STEP-ONE-THOUGHT: I should read the page first.", "read_page", {});
        return;
      }
      if (step === 1) {
        step++;
        reasoningThenTool(res, "STEP-TWO-THOUGHT: Now grab the visible text.", "get_page_text", {});
        return;
      }
      if (step === 2) {
        step++;
        reasoningThenSay(
          res,
          "STEP-THREE-THOUGHT: I have what I need, so I can answer.",
          "**Page identity:** UI Lab\n\n- first bullet\n- second bullet\n\n---\n\n---\n\n---\n\nUse `read_page` for structure.\n\n```js\nconst a = 1;\nconsole.log(a);\n```\n\n---\n\n---",
        );
        return;
      }
      reasoningThenSay(res, "RECALL-THOUGHT: answering from the transcript.", "RECALL-ANSWER");
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
      "--remote-debugging-port=9432",
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

  const getJson = async (p) => (await fetch(`http://127.0.0.1:9432${p}`)).json();

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
  await bc.send("Browser.grantPermissions", {
    origin: `chrome-extension://${extId}`,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  }).catch(() => undefined);
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
    `(() => {
       const input = document.getElementById("prompt");
       input.value = "Read the page.";
       input.dispatchEvent(new Event("input", { bubbles: true }));
       document.getElementById("send").click();
       return "clicked";
     })()`,
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

  // Reasoning must be split per model turn, not concatenated into one block,
  // and all of a run's steps must live inside a single Thinking group.
  const reasoningDom = await pc.evaluate(
    `JSON.stringify(Array.from(document.querySelectorAll(".reasoning-block")).map(el => ({
       open: el.open,
       tag: el.tagName,
       label: el.querySelector(".msg-role")?.textContent ?? "",
       grouped: !!el.closest(".reasoning-group"),
       text: el.querySelector(".reasoning")?.textContent ?? ""
     })))`,
  );
  const blocks = JSON.parse(reasoningDom.value ?? "[]");

  const groupDom = await pc.evaluate(
    `JSON.stringify(Array.from(document.querySelectorAll(".reasoning-group")).map(el => ({
       open: el.open,
       tag: el.tagName,
       label: el.querySelector(".reasoning-group-label")?.textContent ?? "",
       count: el.querySelector(".reasoning-group-count")?.textContent ?? "",
       steps: el.querySelectorAll(".reasoning-block").length
     })))`,
  );
  const groups = JSON.parse(groupDom.value ?? "[]");

  // Assistant markdown must be rendered as elements, not literal asterisks.
  const mdDom = await pc.evaluate(
    `JSON.stringify((() => {
       const bodies = Array.from(document.querySelectorAll(".msg.assistant .msg-body"));
       const last = bodies[bodies.length - 1];
       return {
         bodies: bodies.length,
         text: last ? last.textContent : "",
         strong: last ? last.querySelectorAll("strong").length : 0,
         li: last ? last.querySelectorAll("li").length : 0,
         code: last ? last.querySelectorAll("code").length : 0,
         hr: last ? last.querySelectorAll("hr").length : 0,
         rawAsterisks: last ? (last.textContent.match(/\\*\\*/g) || []).length : 0
       };
     })())`,
  );
  const md = JSON.parse(mdDom.value ?? "{}");

  // A model that degenerates into repeated "---" must not paint a wall of
  // dividers, and a step that streams no text must not leave a blank row.
  const noiseDom = await pc.evaluate(
    `JSON.stringify((() => {
       const msgs = Array.from(document.querySelectorAll("#transcript .msg"));
       const blank = msgs.filter(m => {
         if (m.matches(".reasoning-group, .reasoning-block")) return false;
         if (m.querySelector(".reasoning-group, .reasoning-block")) return false;
         const b = m.querySelector(".msg-body");
         return !b || b.textContent.trim() === "";
       });
       return {
         msgs: msgs.length,
         blank: blank.length,
         blankRoles: blank.map(m => m.className),
         totalHr: document.querySelectorAll("#transcript .md-hr").length,
         totalHrEls: document.querySelectorAll("#transcript hr").length
       };
     })())`,
  );
  const noise = JSON.parse(noiseDom.value ?? "{}");

  // Tool cards must expose the full, newline-preserving result when expanded.
  const toolDom = await pc.evaluate(
    `JSON.stringify(Array.from(document.querySelectorAll(".tool")).map(el => {
       const sections = Array.from(el.querySelectorAll(".tool-section"));
       const resultSection = sections[sections.length - 1];
       const result = resultSection ? resultSection.querySelector(".tool-pre") : null;
       return {
         name: el.querySelector(".tool-name")?.textContent ?? "",
         status: el.querySelector(".tool-status")?.textContent ?? "",
         preview: el.querySelector(".tool-preview")?.textContent ?? "",
         sections: sections.length,
         sectionTags: sections.map(s => s.tagName),
         labels: sections.map(s => s.querySelector(".tool-label")?.textContent ?? ""),
         sizes: sections.map(s => s.querySelector(".tool-size")?.textContent ?? ""),
         hasStretch: sections.every(s => !!s.querySelector(".tool-stretch")),
         hasCopy: sections.every(s => !!s.querySelector(".tool-copy")),
         resultHidden: resultSection ? resultSection.classList.contains("hidden") : true,
         result: result ? result.textContent : "",
         newlines: result ? (result.textContent.match(/\\n/g) || []).length : 0
       };
     }))`,
  );
  const tools = JSON.parse(toolDom.value ?? "[]");

  // "Expand" must lift the height cap on a long result.
  const stretchDom = await pc.evaluate(
    `(async () => {
       const card = document.querySelector(".tool");
       if (!card) return JSON.stringify({ ok: false });
       const body = card.querySelector(".tool-body");
       if (body && body.classList.contains("hidden")) card.querySelector(".tool-head").click();
       await new Promise(r => setTimeout(r, 60));
       const section = card.querySelectorAll(".tool-section")[1];
       if (!section) return JSON.stringify({ ok: false });
       const btn = section.querySelector(".tool-stretch");
       const pre = section.querySelector(".tool-pre");
       const before = getComputedStyle(pre).maxHeight;
       btn.click();
       await new Promise(r => setTimeout(r, 60));
       const after = getComputedStyle(pre).maxHeight;
       const label = btn.textContent;
       btn.click();
       await new Promise(r => setTimeout(r, 60));
       return JSON.stringify({
         ok: true,
         before, after, label,
         restored: getComputedStyle(pre).maxHeight,
         restoredLabel: btn.textContent
       });
     })()`,
  );
  const stretch = JSON.parse(stretchDom.value ?? "{}");

  // User turns must be right-aligned, agent turns full width.
  const alignDom = await pc.evaluate(
    `JSON.stringify((() => {
       const user = document.querySelector("#transcript .msg.user");
       const agent = document.querySelector("#transcript .msg.assistant");
       const ub = user ? user.querySelector(".msg-body") : null;
       const ab = agent ? agent.querySelector(".msg-body") : null;
       const box = el => el ? el.getBoundingClientRect() : null;
       const panel = document.getElementById("transcript").getBoundingClientRect();
       return {
         hasUser: !!user,
         userAlign: user ? getComputedStyle(user).alignItems : "",
         userRightGap: ub ? Math.round(panel.right - box(ub).right) : -1,
         userLeftGap: ub ? Math.round(box(ub).left - panel.left) : -1,
         agentLeftGap: ab ? Math.round(box(ab).left - panel.left) : -1,
         agentRightGap: ab ? Math.round(panel.right - box(ab).right) : -1
       };
     })())`,
  );
  const align = JSON.parse(alignDom.value ?? "{}");

  // Fenced code must be copyable, and each answer must offer a copy button.
  const copyDom = await pc.evaluate(
    `JSON.stringify((() => {
       const bodies = Array.from(document.querySelectorAll(".msg.assistant .msg-body"));
       const last = bodies[bodies.length - 1];
       const block = last ? last.querySelector(".md-code") : null;
       const btn = block ? block.querySelector(".md-copy") : null;
       const answerBtn = last ? last.closest(".msg").querySelector(".msg-copy") : null;
       return {
         blocks: last ? last.querySelectorAll(".md-code").length : 0,
         heads: last ? last.querySelectorAll(".md-code-head").length : 0,
         lang: block ? block.querySelector(".md-code-lang").textContent : "",
         hasBtn: !!btn,
         btnTag: btn ? btn.tagName : "",
         btnLabel: btn ? btn.textContent : "",
         codeText: block ? block.querySelector("pre code").textContent : "",
         hasAnswerBtn: !!answerBtn,
         answerLabel: answerBtn ? answerBtn.textContent : "",
         raw: last ? (last.closest(".msg").dataset.raw || "") : ""
       };
     })())`,
  );
  const copy = JSON.parse(copyDom.value ?? "{}");

  // Clicking a copy button must not throw and must report success.
  const copyClick = await pc.evaluate(
    `(async () => {
       const btn = document.querySelector(".msg.assistant .md-code .md-copy");
       if (!btn) return "no-button";
       btn.click();
       await new Promise(r => setTimeout(r, 120));
       return btn.textContent;
     })()`,
  );

  // A second prompt in the same chat must replay the earlier turns to the model.
  const bodiesBefore = requestBodies.length;
  await pc.evaluate(
    `(() => {
       const input = document.getElementById("prompt");
       input.value = "What did I ask you before?";
       input.dispatchEvent(new Event("input", { bubbles: true }));
       document.getElementById("send").click();
       return "clicked";
     })()`,
  );
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    const st = await pc.evaluate(`chrome.runtime.sendMessage({ type: "agent/state" }).then(r => JSON.stringify(r))`);
    let s = null;
    try {
      s = JSON.parse(st.value)?.data ?? null;
    } catch {
      s = null;
    }
    if (s && s.running === false) break;
  }
  const recallBody = requestBodies[bodiesBefore] ?? null;
  const recallMsgs = Array.isArray(recallBody?.messages) ? recallBody.messages : [];
  const recall = {
    requests: requestBodies.length - bodiesBefore,
    roles: recallMsgs.map((m) => m.role),
    hasFirstPrompt: recallMsgs.some((m) => m.role === "user" && m.content === "Read the page."),
    hasFirstAnswer: recallMsgs.some(
      (m) => m.role === "assistant" && typeof m.content === "string" && m.content.includes("Page identity"),
    ),
    lastIsNewPrompt: recallMsgs.length
      ? recallMsgs[recallMsgs.length - 1].content === "What did I ask you before?"
      : false,
    toolTurns: recallMsgs.filter((m) => m.role === "tool").length,
  };

  // The history drawer must list the finished run and restore it on click.
  await pc.evaluate(`document.getElementById("historyBtn").click(); "ok"`);
  await sleep(500);
  const histOpen = await pc.evaluate(
    `JSON.stringify({
       panelHidden: document.getElementById("historyPanel").classList.contains("hidden"),
       scrimHidden: document.getElementById("historyScrim").classList.contains("hidden"),
       expanded: document.getElementById("historyBtn").getAttribute("aria-expanded"),
       rows: document.querySelectorAll("#historyList .history-item").length,
       title: document.querySelector("#historyList .history-item-title")?.textContent ?? "",
       meta: document.querySelector("#historyList .history-item-meta")?.textContent ?? "",
       hasDelete: !!document.querySelector("#historyList .history-del")
     })`,
  );
  const hist = JSON.parse(histOpen.value ?? "{}");

  await pc.evaluate(`document.querySelector("#historyList .history-open").click(); "ok"`);
  await sleep(700);
  const histRestore = await pc.evaluate(
    `JSON.stringify({
       panelHidden: document.getElementById("historyPanel").classList.contains("hidden"),
       messages: document.querySelectorAll("#transcript .msg").length,
       tools: document.querySelectorAll("#transcript .tool").length,
       hasAnswer: Array.from(document.querySelectorAll("#transcript .msg.assistant .msg-body"))
         .some(b => b.textContent.includes("Page identity")),
       hasCode: !!document.querySelector("#transcript .md-code"),
       emptyHidden: document.getElementById("emptyState").classList.contains("hidden")
     })`,
  );
  const restored = JSON.parse(histRestore.value ?? "{}");

  // "New chat" must wipe the transcript and bring the empty state back.
  const beforeReset = await pc.evaluate(
    `JSON.stringify({
       children: document.getElementById("transcript").children.length,
       emptyHidden: document.getElementById("emptyState").classList.contains("hidden")
     })`,
  );
  const before = JSON.parse(beforeReset.value ?? "{}");

  await pc.evaluate(`document.getElementById("newChat").click(); "ok"`);
  await sleep(400);

  const afterReset = await pc.evaluate(
    `JSON.stringify({
       children: document.getElementById("transcript").children.length,
       onlyEmpty: document.getElementById("transcript").children.length === 1 &&
                  document.getElementById("transcript").children[0].id === "emptyState",
       emptyHidden: document.getElementById("emptyState").classList.contains("hidden"),
       planHidden: document.getElementById("planBar").classList.contains("hidden"),
       gifHidden: document.getElementById("exportGif").classList.contains("hidden"),
       prompt: document.getElementById("prompt").value
     })`,
  );
  const after = JSON.parse(afterReset.value ?? "{}");

  console.log("\n--- reasoning blocks ---");
  for (const b of blocks) console.log("  " + JSON.stringify(b).slice(0, 160));

  console.log("\n--- reasoning groups ---");
  for (const g of groups) console.log("  " + JSON.stringify(g).slice(0, 160));

  console.log("\n--- assistant markdown ---");
  console.log("  " + JSON.stringify(md).slice(0, 300));

  console.log("\n--- transcript noise ---");
  console.log("  " + JSON.stringify(noise));

  console.log("\n--- tool cards ---");
  for (const t of tools) console.log("  " + JSON.stringify(t).slice(0, 260));

  console.log("\n--- tool stretch ---");
  console.log("  " + JSON.stringify(stretch));

  console.log("\n--- message alignment ---");
  console.log("  " + JSON.stringify(align));

  console.log("\n--- transcript before reset ---");
  console.log("  " + JSON.stringify(before));

  console.log("\n--- copy buttons ---");
  console.log("  " + JSON.stringify(copy));

  console.log("\n--- conversation memory ---");
  console.log("  " + JSON.stringify(recall));

  console.log("\n--- history drawer ---");
  console.log("  " + JSON.stringify(hist));

  console.log("\n--- history restore ---");
  console.log("  " + JSON.stringify(restored));

  console.log("\n--- transcript after reset ---");
  console.log("  " + JSON.stringify(after));

  const stepEvents = evs.filter((e) => e.type === "agent/step");
  const reasoningEvents = evs.filter((e) => e.type === "agent/reasoning");

  const checks = [];
  const check = (n, ok, d) => checks.push({ n, ok: !!ok, d });

  check("agent finished without error", !evs.some((e) => e.type === "agent/error"), JSON.stringify(evs.filter((e) => e.type === "agent/error")));
  check("agent emitted done", evs.some((e) => e.type === "agent/done"));
  check("agent/step emitted once per model turn", stepEvents.length === 3, String(stepEvents.length));
  check("agent/step numbers are 1..3", JSON.stringify(stepEvents.map((e) => e.step)) === "[1,2,3]", JSON.stringify(stepEvents.map((e) => e.step)));
  check("reasoning streamed", reasoningEvents.length >= 3, String(reasoningEvents.length));

  check("one reasoning block per step", blocks.length === 3, String(blocks.length));
  check("reasoning blocks are <details>", blocks.every((b) => b.tag === "DETAILS"), JSON.stringify(blocks.map((b) => b.tag)));
  check(
    "each block holds only its own step",
    blocks.length === 3 &&
      blocks[0].text.includes("STEP-ONE-THOUGHT") &&
      !blocks[0].text.includes("STEP-TWO-THOUGHT") &&
      blocks[1].text.includes("STEP-TWO-THOUGHT") &&
      !blocks[1].text.includes("STEP-THREE-THOUGHT") &&
      blocks[2].text.includes("STEP-THREE-THOUGHT"),
    JSON.stringify(blocks.map((b) => b.text.slice(0, 60))),
  );
  check("finished steps are collapsed", blocks.length === 3 && blocks[0].open === false && blocks[1].open === false, JSON.stringify(blocks.map((b) => b.open)));
  check("latest step stays expanded", blocks.length === 3 && blocks[2].open === true, JSON.stringify(blocks.map((b) => b.open)));

  check("all steps share one Thinking group", groups.length === 1, String(groups.length));
  check("Thinking group is a <details>", groups.length === 1 && groups[0].tag === "DETAILS", JSON.stringify(groups.map((g) => g.tag)));
  check("Thinking group holds every step", groups.length === 1 && groups[0].steps === 3, JSON.stringify(groups.map((g) => g.steps)));
  check("Thinking group reports the step count", groups.length === 1 && groups[0].count === "3 steps", JSON.stringify(groups.map((g) => g.count)));
  check("Thinking group is labelled", groups.length === 1 && groups[0].label === "Thinking", JSON.stringify(groups.map((g) => g.label)));
  check("every step is nested in the group", blocks.length === 3 && blocks.every((b) => b.grouped), JSON.stringify(blocks.map((b) => b.grouped)));
  check("steps are numbered", JSON.stringify(blocks.map((b) => b.label)) === '["Step 1","Step 2","Step 3"]', JSON.stringify(blocks.map((b) => b.label)));
  check("finished run collapses the group", groups.length === 1 && groups[0].open === false, JSON.stringify(groups.map((g) => g.open)));
  check("latest step stays expanded", blocks.length === 3 && blocks[2].open === true, JSON.stringify(blocks.map((b) => b.open)));

  check("assistant reply rendered as markdown", md.strong >= 1 && md.li >= 2 && md.code >= 1, JSON.stringify(md));
  check("no literal markdown markers left", md.rawAsterisks === 0, JSON.stringify(md.text));
  check("repeated dividers collapse to one", md.hr === 1, JSON.stringify(md.hr));
  check("no blank transcript rows", noise.blank === 0, JSON.stringify(noise.blankRoles));
  check("transcript holds only the collapsed divider", noise.totalHrEls === 1, JSON.stringify(noise));
  check("tool cards rendered", tools.length === 2, String(tools.length));
  check(
    "tool cards expose a result",
    tools.length === 2 && tools.every((t) => t.status === "done" && !t.resultHidden && t.result.length > 0),
    JSON.stringify(tools.map((t) => ({ s: t.status, h: t.resultHidden, n: t.result.length }))),
  );
  check(
    "tool result keeps line structure",
    tools.length === 2 && tools.every((t) => t.newlines >= 1),
    JSON.stringify(tools.map((t) => t.newlines)),
  );
  check(
    "read_page result is not flattened",
    tools.some((t) => t.name === "read_page" && t.result.includes("Nodes:")),
    JSON.stringify(tools.map((t) => t.result.slice(0, 80))),
  );
  check(
    "collapsed card shows a one-line preview",
    tools.length === 2 && tools.every((t) => t.preview.length > 0 && !t.preview.includes("\n")),
    JSON.stringify(tools.map((t) => t.preview.slice(0, 60))),
  );
  check(
    "each tool card has Arguments and Result panes",
    tools.length === 2 && tools.every((t) => t.sections === 2 && JSON.stringify(t.labels) === '["Arguments","Result"]'),
    JSON.stringify(tools.map((t) => ({ n: t.sections, l: t.labels }))),
  );
  check(
    "tool panes are collapsible <details>",
    tools.length === 2 && tools.every((t) => t.sectionTags.every((tag) => tag === "DETAILS")),
    JSON.stringify(tools.map((t) => t.sectionTags)),
  );
  check(
    "tool panes show a size badge",
    tools.length === 2 && tools.every((t) => t.sizes.every((s) => /^\d+(\.\d)? (B|KB)$/.test(s))),
    JSON.stringify(tools.map((t) => t.sizes)),
  );
  check(
    "tool panes offer Copy and Expand",
    tools.length === 2 && tools.every((t) => t.hasCopy && t.hasStretch),
    JSON.stringify(tools.map((t) => ({ c: t.hasCopy, s: t.hasStretch }))),
  );
  check(
    "Expand lifts the result height cap",
    stretch.ok === true && stretch.before !== "none" && stretch.after === "none" && stretch.label === "Collapse",
    JSON.stringify(stretch),
  );
  check(
    "Collapse restores the height cap",
    stretch.ok === true && stretch.restored === stretch.before && stretch.restoredLabel === "Expand",
    JSON.stringify(stretch),
  );

  check("user turn is right-aligned", align.hasUser === true && align.userAlign === "flex-end", JSON.stringify(align));
  check(
    "user bubble hugs the right edge",
    align.userRightGap >= 0 && align.userRightGap <= 24 && align.userLeftGap > align.userRightGap,
    JSON.stringify(align),
  );
  check(
    "agent turn stays full width",
    align.agentLeftGap <= 24 && align.agentRightGap <= 24,
    JSON.stringify(align),
  );

  check("transcript had content before reset", before.children > 1, JSON.stringify(before));

  check("second prompt triggers one model call", recall.requests === 1, JSON.stringify(recall.requests));
  check(
    "second prompt replays the earlier user turn",
    recall.hasFirstPrompt === true,
    JSON.stringify(recall.roles),
  );
  check(
    "second prompt replays the earlier answer",
    recall.hasFirstAnswer === true,
    JSON.stringify(recall.roles),
  );
  check(
    "replayed history sits before the new prompt",
    recall.lastIsNewPrompt === true,
    JSON.stringify(recall.roles),
  );
  check(
    "replayed history carries no orphaned tool turns",
    recall.toolTurns === 0,
    JSON.stringify(recall.roles),
  );

  check("fenced code renders a copy wrapper", copy.blocks === 1 && copy.heads === 1, JSON.stringify(copy));
  check("code block shows its language", copy.lang === "js", JSON.stringify(copy.lang));
  check("code block has a copy button", copy.hasBtn === true && copy.btnTag === "BUTTON", JSON.stringify(copy));
  check("copy button starts as 'Copy'", copy.btnLabel === "Copy", JSON.stringify(copy.btnLabel));
  check("copy payload is the code text", copy.codeText === "const a = 1;\nconsole.log(a);", JSON.stringify(copy.codeText));
  check("answer has its own copy button", copy.hasAnswerBtn === true, JSON.stringify(copy));
  check("answer copy payload holds the raw markdown", copy.raw.includes("**Page identity:**"), JSON.stringify(copy.raw.slice(0, 60)));
  check("clicking copy reports success", copyClick.value === "Copied", JSON.stringify(copyClick));

  check("history button opens the drawer", hist.panelHidden === false && hist.scrimHidden === false, JSON.stringify(hist));
  check("history button reports expanded", hist.expanded === "true", JSON.stringify(hist.expanded));
  check("finished run is listed in history", hist.rows >= 1, JSON.stringify(hist.rows));
  check("history row is titled from the prompt", hist.title === "Read the page.", JSON.stringify(hist.title));
  check("history row shows a relative time and count", /ago|just now/.test(hist.meta) && /msg/.test(hist.meta), JSON.stringify(hist.meta));
  check("history row has a delete button", hist.hasDelete === true, JSON.stringify(hist));

  check("selecting a history row closes the drawer", restored.panelHidden === true, JSON.stringify(restored));
  check("selecting a history row restores messages", restored.messages >= 2, JSON.stringify(restored));
  check("selecting a history row restores tool cards", restored.tools === 2, JSON.stringify(restored));
  check("selecting a history row restores the answer", restored.hasAnswer === true, JSON.stringify(restored));
  check("selecting a history row restores code blocks", restored.hasCode === true, JSON.stringify(restored));
  check("restored transcript hides the empty state", restored.emptyHidden === true, JSON.stringify(restored));
  check("new chat leaves only the empty state", after.onlyEmpty === true, JSON.stringify(after));
  check("new chat un-hides the empty state", after.emptyHidden === false, JSON.stringify(after));
  check("new chat hides the plan bar", after.planHidden === true, JSON.stringify(after));
  check("new chat hides the gif button", after.gifHidden === true, JSON.stringify(after));
  check("new chat clears the prompt", after.prompt === "", JSON.stringify(after.prompt));

  console.log("\n--- results ---");
  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.n}${c.ok ? "" : "  -> " + (c.d ?? "")}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);

  child.kill();
  server.close();
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.error("harness error:", err);
  server.close();
  process.exitCode = 1;
});
