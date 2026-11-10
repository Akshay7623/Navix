"use strict";
/**
 * Regenerate the README screenshots in docs/screenshots/.
 *
 *   npm run build && npm run screenshots
 *
 * Loads the built extension into headless Edge and stages two runs against a
 * scripted OpenAI-compatible mock model on a fictional site (lumennotes.example,
 * served locally). The side panel, service worker, tools and page overlays are
 * the real extension; only the model's replies are scripted, so every shot
 * comes out the same.
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { sleep, getJson, connect, waitForTarget } = require("./cdp.cjs");

const ROOT = path.resolve(__dirname, "..", "..");
const EXT = path.join(ROOT, "dist");
const EXT_ID = require(path.join(ROOT, "tests", "ext-id.cjs"))(EXT);
const OUT = path.join(ROOT, "docs", "screenshots");
const RAW = fs.mkdtempSync(path.join(os.tmpdir(), "navix-shots-raw-"));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "navix-shots-profile-"));
const EDGE = process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DBG = 9571;
const PORT = 9570;
const HOST = "lumennotes.example";
const SITE = `http://${HOST}/`;
const DEMO_HTML = fs.readFileSync(path.join(__dirname, "demo-page.html"), "utf8");
const EMAIL = "alex@example.com";

const HEIGHT = 820;
const PANEL = { width: 440, height: HEIGHT };
const PAGE = { width: 1120, height: HEIGHT };
const OPTIONS = { width: 1180, height: 820 };

if (!fs.existsSync(path.join(EXT, "manifest.json"))) {
  console.error("dist/ is missing. Run `npm run build` first.");
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ */
/* scripted model                                                      */
/* ------------------------------------------------------------------ */

const plan = (a, b, c) => ({
  steps: [
    { step: "Read the pricing page", status: a },
    { step: "Choose Team and enter the email", status: b },
    { step: "Start the trial and confirm", status: c },
  ],
});

/** One entry per model turn: reasoning, then a tool call or a final answer. */
const SCRIPTS = {
  team: [
    { reasoning: "The user wants the Team plan and its price. I'll set out a short plan, then read the page.", tool: "update_plan", args: () => plan("in_progress", "pending", "pending") },
    { reasoning: "Reading the page to find the plan cards and the sign-up form.", tool: "read_page", args: () => ({}) },
    { reasoning: "Team is $12 per seat per month. Its card has a \"Choose Team\" button.", tool: "update_plan", args: () => plan("done", "in_progress", "pending") },
    { reasoning: "Selecting the Team plan first so the form picks it up.", tool: "click", args: (b) => ({ ref: ref(b, "button", "Choose Team") }) },
    { reasoning: "Team is selected. Now the work email field.", tool: "type", args: (b) => ({ ref: ref(b, "textbox", "Work email"), text: EMAIL }) },
    { reasoning: "Email entered and the plan shows Team. Next, start the trial.", tool: "update_plan", args: () => plan("done", "done", "in_progress") },
    { reasoning: "Submitting the form with \"Start free trial\".", tool: "click", args: (b) => ({ ref: ref(b, "button", "Start free trial") }) },
    { reasoning: "Checking the page text to confirm the trial really started.", tool: "get_page_text", args: () => ({}) },
    { reasoning: "The confirmation banner is there. Marking the plan complete.", tool: "update_plan", args: () => plan("done", "done", "done") },
    {
      reasoning: "Everything is confirmed, so I can report back with the price.",
      text:
        "Done. Your **Team** trial has started for `" + EMAIL + "`.\n\n" +
        "- **Price:** $12 per seat per month after the trial\n" +
        "- **Trial:** 14 days free, no card needed\n" +
        "- **Includes:** unlimited notes and shared spaces, 90-day version history\n\n" +
        "> You're in! Check " + EMAIL + " to finish setup.",
    },
  ],
  business: [
    { reasoning: "The user wants to switch plans. Reading the page for the Business card.", tool: "read_page", args: () => ({}) },
    { reasoning: "The Business card has a \"Choose Business\" button.", tool: "click", args: (b) => ({ ref: ref(b, "button", "Choose Business") }) },
    {
      reasoning: "Business is now selected in the form.",
      text:
        "Switched to **Business** ($24 per seat per month). It adds **SSO and audit logs** and unlimited version history.\n\n" +
        "The trial hasn't started yet. Say the word and I'll press **Start free trial**.",
    },
  ],
};

function toolText(body) {
  return body.messages
    .filter((m) => m.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

/** Find an element ref in the latest read_page output, e.g. `button "Choose Team" [ref_8]`. */
function ref(body, role, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const all = [...toolText(body).matchAll(new RegExp(`${role} "${esc}"[^\\n\\[]*\\[(ref_\\d+)\\]`, "g"))];
  if (!all.length) throw new Error(`no ref for ${role} "${name}"`);
  return all[all.length - 1][1];
}

function scenarioOf(body) {
  const last = body.messages.map((m) => m.role).lastIndexOf("user");
  const prompt = String(body.messages[last]?.content ?? "");
  const turn = body.messages.slice(last + 1).filter((m) => m.role === "tool").length;
  const name = /business/i.test(prompt) ? "business" : /team plan/i.test(prompt) ? "team" : null;
  return { name, turn };
}

/* Holds pause the model at a chosen turn so the driver can take screenshots. */
const deferred = () => {
  let r;
  const p = new Promise((res) => (r = res));
  return { p, r };
};
const holds = {};
const hold = (key) => (holds[key] = { arrived: deferred(), release: deferred() });
const arrivedAt = (key) => holds[key].arrived.p;
const release = (key) => holds[key].release.r();

let callN = 0;
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

async function reply(body, res) {
  const { name, turn } = scenarioOf(body);
  const key = `${name}:${turn}`;
  if (holds[key]) {
    holds[key].arrived.r();
    await holds[key].release.p;
  }
  const step = SCRIPTS[name]?.[turn];
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" });
  if (!step) {
    sse(res, { choices: [{ delta: { content: "(script ended)" } }] });
    sse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
  } else {
    for (const part of step.reasoning.match(/.{1,24}(\s|$)/g) ?? [step.reasoning]) {
      sse(res, { choices: [{ delta: { reasoning_content: part } }] });
      await sleep(25);
    }
    if (step.tool) {
      const call = { index: 0, id: "call_" + ++callN, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args(body)) } };
      sse(res, { choices: [{ delta: { tool_calls: [call] } }] });
      sse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    } else {
      for (const part of step.text.match(/[\s\S]{1,40}/g)) {
        sse(res, { choices: [{ delta: { content: part } }] });
        await sleep(20);
      }
      sse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
    }
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST" });
    return res.end();
  }
  if (req.url.startsWith("/v1/chat/completions")) {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () =>
      reply(JSON.parse(raw), res).catch((e) => {
        console.log("mock error:", e.message);
        res.end();
      }),
    );
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(DEMO_HTML);
});

/* ------------------------------------------------------------------ */
/* extension state                                                     */
/* ------------------------------------------------------------------ */

const SETTINGS = {
  provider: "custom",
  baseUrl: `http://127.0.0.1:${PORT}/v1/chat/completions`,
  apiKey: "demo-key",
  model: "qwen3.8-27b",
  temperature: 0.2,
  maxTokens: 16384,
  maxSteps: 25,
  reasoningEffort: "medium",
  approvalMode: "auto",
  // lumennotes.example is unknown to the classifier, so "standard" would ask.
  safetyMode: "permissive",
  dialogPolicy: "dismiss",
  visualFeedback: true,
  systemPromptExtra: "",
  visionEnabled: false,
};

/** What the settings page shows: a typical self-hosted setup. */
const DISPLAY_SETTINGS = {
  ...SETTINGS,
  baseUrl: "http://127.0.0.1:8000/v1/chat/completions",
  apiKey: "sk-demo-0000000000000000",
  approvalMode: "ask",
  safetyMode: "standard",
};

const DAY = 86400000;
function seedHistory(now) {
  const conv = (id, ago, prompts, text) => {
    const items = [];
    for (const p of prompts) {
      items.push({ kind: "user", text: p });
      items.push({ kind: "event", event: { type: "agent/delta", text } });
      items.push({ kind: "event", event: { type: "agent/done", steps: 3 } });
    }
    return { id, title: prompts[0], createdAt: now - ago - 600000, updatedAt: now - ago, items };
  };
  return [
    conv("seed-1", DAY + 3 * 3600000, ["Summarise the top five stories on this page", "Which one is about climate?"], "Here are the five stories."),
    conv("seed-2", 2 * DAY + 5 * 3600000, ["Compare the two laptops in my open tabs"], "The second one has the better battery."),
    conv("seed-3", 4 * DAY, ["Find the return policy and tell me the deadline"], "Returns are accepted within 30 days."),
    conv("seed-4", 9 * DAY, ["Fill in the contact form with my details", "Now send it"], "Sent."),
    conv("seed-5", 16 * DAY, ["List every heading on this docs page as a checklist"], "- Install\n- Configure\n- Deploy"),
  ];
}

/* ------------------------------------------------------------------ */
/* capture helpers                                                     */
/* ------------------------------------------------------------------ */

async function shot(client, file) {
  const r = await client.send("Page.captureScreenshot", { format: "png" });
  if (!r.result) throw new Error("screenshot failed: " + JSON.stringify(r.error));
  fs.writeFileSync(file, Buffer.from(r.result.data, "base64"));
  return file;
}

const out = (name) => path.join(OUT, name);
const raw = (name) => path.join(RAW, name);

/** Save `<name>.png` (dark, the default theme) and `<name>-light.png`. */
async function themed(client, name) {
  await shot(client, out(name + ".png"));
  await client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await sleep(350);
  await shot(client, out(name + "-light.png"));
  await client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await sleep(350);
  console.log("  " + name + ".png, " + name + "-light.png");
}

async function waitFor(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(150);
  }
  throw new Error("timed out waiting for " + what);
}

/** A browser window around the page with the side panel docked on the right. */
function compositeHtml(pagePng, panelPng, title) {
  const favicon = (DEMO_HTML.match(/<link rel="icon" href="([^"]+)"/) || [])[1] || "";
  const icon = pathToFileURL(path.join(EXT, "icons", "icon32.png")).href;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; }
  body {
    width: ${PAGE.width + PANEL.width + 1 + 112}px; height: ${HEIGHT + 78 + 96}px;
    display: grid; place-items: center; font-family: "Segoe UI", system-ui, sans-serif;
    background:
      radial-gradient(900px 520px at 12% 0%, rgba(124, 58, 237, .55), transparent 65%),
      radial-gradient(800px 520px at 100% 100%, rgba(37, 99, 235, .45), transparent 60%),
      #0b0b12;
  }
  .win { border-radius: 14px; overflow: hidden; background: #1c1c23;
    box-shadow: 0 30px 80px rgba(0, 0, 0, .55), 0 0 0 1px rgba(255, 255, 255, .09); }
  .tabs { height: 38px; display: flex; align-items: flex-end; padding: 0 12px; background: #131318; }
  .tab { height: 30px; width: 230px; display: flex; align-items: center; gap: 8px; padding: 0 14px;
    background: #1f1f27; border-radius: 9px 9px 0 0; color: #e7e7ee; font-size: 12.5px; }
  .tab img { width: 14px; height: 14px; }
  .bar { height: 40px; display: flex; align-items: center; gap: 14px; padding: 0 14px;
    background: #1f1f27; border-bottom: 1px solid #2c2c36; color: #8d8d99; }
  .bar svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2;
    stroke-linecap: round; stroke-linejoin: round; }
  .url { flex: 1; height: 28px; border-radius: 14px; background: #131318; color: #cfcfd8;
    display: flex; align-items: center; padding: 0 14px; font-size: 13px; }
  .ext { width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center;
    background: rgba(139, 92, 246, .22); box-shadow: inset 0 0 0 1px rgba(139, 92, 246, .45); }
  .ext img { width: 16px; height: 16px; }
  .content { display: flex; }
  .content img { display: block; }
  .divider { width: 1px; background: #2c2c36; }
</style></head><body>
<div class="win">
  <div class="tabs"><div class="tab"><img src="${favicon}">${title}</div></div>
  <div class="bar">
    <svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>
    <svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg>
    <svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/></svg>
    <div class="url">${HOST}</div>
    <div class="ext"><img src="${icon}"></div>
  </div>
  <div class="content">
    <img src="${pathToFileURL(pagePng).href}" width="${PAGE.width}" height="${HEIGHT}">
    <div class="divider"></div>
    <img src="${pathToFileURL(panelPng).href}" width="${PANEL.width}" height="${HEIGHT}">
  </div>
</div>
</body></html>`;
}

/* ------------------------------------------------------------------ */
/* driver                                                              */
/* ------------------------------------------------------------------ */

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const child = spawn(
    EDGE,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--force-device-scale-factor=2",
      `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${PORT}`,
      "--remote-debugging-port=" + DBG,
      "--user-data-dir=" + PROFILE,
      `--window-size=${PAGE.width},${PAGE.height}`,
      "--load-extension=" + EXT,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const killer = setTimeout(() => {
    console.log("timed out after 4 minutes");
    child.kill();
    process.exit(1);
  }, 240000);

  try {
    const swT = await waitForTarget(DBG, (t) => t.type === "service_worker" && t.url === `chrome-extension://${EXT_ID}/background.js`, 80);
    if (!swT) throw new Error("extension service worker not found");
    const sw = await connect(swT.webSocketDebuggerUrl);
    const browser = await connect((await getJson(DBG, "/json/version")).webSocketDebuggerUrl);

    /** Resize a window until the page inside it has exactly the wanted viewport. */
    const fitWindow = async (targetId, client, want) => {
      const { windowId } = (await browser.send("Browser.getWindowForTarget", { targetId })).result;
      let bounds = { width: want.width, height: want.height };
      for (let i = 0; i < 4; i++) {
        await browser.send("Browser.setWindowBounds", { windowId, bounds });
        await sleep(300);
        const [w, h] = await client.evaluate("[innerWidth, innerHeight]");
        if (w === want.width && h === want.height) return;
        bounds = { width: bounds.width + want.width - w, height: bounds.height + want.height - h };
      }
    };
    const emulate = (client, size) =>
      client.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 2, mobile: false });

    // The demo site in the first window.
    const pageT = await waitForTarget(DBG, (t) => t.type === "page");
    const page = await connect(pageT.webSocketDebuggerUrl);
    await page.send("Page.enable");
    const loadSite = async () => {
      await page.send("Page.navigate", { url: SITE });
      await waitFor(async () => (await page.evaluate("location.host + document.readyState")) === HOST + "complete", "demo page");
      await sleep(400);
    };
    await loadSite();
    await fitWindow(pageT.id, page, PAGE);

    // The side panel page in a window of its own.
    const panelId = (await browser.send("Target.createTarget", { url: `chrome-extension://${EXT_ID}/src/sidepanel/index.html`, newWindow: true })).result.targetId;
    const panel = await connect((await waitForTarget(DBG, (t) => t.id === panelId)).webSocketDebuggerUrl);
    await panel.send("Page.enable");
    await emulate(panel, PANEL);
    await sleep(600);

    const demoWindow = await panel.evaluate(`chrome.tabs.query({ url: "${SITE}*" }).then(([t]) => t.windowId)`);
    await panel.evaluate(`chrome.storage.local.set(${JSON.stringify({ settings: SETTINGS, conversations: seedHistory(Date.now()) })}).then(() => true)`);

    // A docked side panel belongs to the browsing window, so "the active tab of
    // the last-focused window" is the page beside it. Headless windows never
    // take focus, so point that one lookup at the demo window.
    const pin = `(() => {
      if (chrome.tabs.__pinned) return true;
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (q, ...rest) =>
        q && q.active && q.lastFocusedWindow ? query({ active: true, windowId: ${demoWindow} }, ...rest) : query(q, ...rest);
      return (chrome.tabs.__pinned = true);
    })()`;
    await sw.evaluate(pin);
    await panel.send("Page.reload");
    await sleep(900);
    await panel.evaluate(pin);
    await loadSite(); // fires tabs.onUpdated so the panel's tab chip picks up the demo page
    await panel.evaluate(`window.__ev = []; chrome.runtime.onMessage.addListener((m) => { if (m && m.__event) window.__ev.push(m.event); }); true`);
    console.log("panel", await panel.evaluate(`innerWidth + "x" + innerHeight + ", acting on: " + document.getElementById("tabTitle").textContent`));
    console.log("page ", await page.evaluate(`innerWidth + "x" + innerHeight`));

    const runEnded = () => panel.evaluate(`window.__ev.some((e) => e.type === "agent/done" || e.type === "agent/error")`);
    const submit = async (text) => {
      await sw.evaluate(pin); // the worker may have restarted since
      await panel.evaluate(`(() => {
        window.__ev = [];
        const p = document.getElementById("prompt");
        p.value = ${JSON.stringify(text)};
        p.dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("send").click();
        return true;
      })()`);
    };
    const checkErrors = async () => {
      const errs = await panel.evaluate(`JSON.stringify(window.__ev.filter((e) => e.type === "agent/error"))`);
      if (errs !== "[]") throw new Error("run failed: " + errs);
    };

    /* empty state */
    console.log("empty state");
    await themed(panel, "panel-empty");

    /* the main run: sign up for a plan, paused twice for the hero shots */
    console.log("sign-up run");
    hold("team:6");
    hold("team:9");
    await submit(`Sign me up for the Team plan with ${EMAIL} and tell me what it costs.`);
    await arrivedAt("team:6");
    await sleep(1200);
    // Show the prompt at the top: collapse the live thinking list and scroll up.
    await panel.evaluate(`(() => {
      const g = document.querySelector(".reasoning-group");
      if (g) g.open = false;
      document.getElementById("transcript").scrollTop = 0;
      return true;
    })()`);
    await sleep(300);
    await shot(panel, raw("mid-panel.png"));
    await shot(page, raw("mid-page.png"));
    release("team:6");
    await arrivedAt("team:9");
    release("team:9");
    await waitFor(runEnded, "sign-up run to finish");
    await checkErrors();
    await sleep(1200);
    await themed(panel, "panel-answer");
    await shot(panel, raw("done-panel.png"));
    await shot(page, raw("done-page.png"));

    /* expanded tool row */
    console.log("tool details");
    const opened = await panel.evaluate(`(() => {
      const row = [...document.querySelectorAll(".tool")].find((r) => r.querySelector(".tool-name")?.textContent.trim() === "read_page");
      if (!row) return "read_page row not found";
      row.querySelector(".tool-head").click();
      row.querySelectorAll("details.tool-section").forEach((s) => (s.open = true));
      row.scrollIntoView({ block: "start" });
      return "ok";
    })()`);
    if (opened !== "ok") throw new Error(opened);
    await sleep(500);
    await themed(panel, "panel-tool-details");

    /* approval run */
    console.log("approval run");
    await panel.evaluate(`chrome.storage.local.get("settings").then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, approvalMode: "ask" } })).then(() => true)`);
    await loadSite();
    await panel.evaluate(`document.getElementById("newChat").click(); true`);
    await sleep(500);
    await submit("Switch me to the Business plan instead.");
    await waitFor(() => panel.evaluate(`!document.getElementById("approvalBar").classList.contains("hidden")`), "approval card");
    await sleep(700);
    await themed(panel, "panel-approval");
    await panel.evaluate(`document.getElementById("approvalAllow").click(); true`);
    await waitFor(runEnded, "approval run to finish");
    await checkErrors();
    await sleep(800);

    /* history drawer */
    console.log("history");
    await panel.evaluate(`document.getElementById("historyBtn").click(); true`);
    await sleep(700);
    await themed(panel, "panel-history");
    await panel.evaluate(`document.getElementById("historyClose").click(); true`);

    /* settings page */
    console.log("settings");
    await panel.evaluate(`chrome.storage.local.set({ settings: ${JSON.stringify(DISPLAY_SETTINGS)} }).then(() => true)`);
    const optId = (await browser.send("Target.createTarget", { url: `chrome-extension://${EXT_ID}/src/options/index.html`, newWindow: true })).result.targetId;
    const options = await connect((await waitForTarget(DBG, (t) => t.id === optId)).webSocketDebuggerUrl);
    await options.send("Page.enable");
    await emulate(options, OPTIONS);
    await options.send("Page.reload");
    await sleep(1200);
    await options.evaluate(`document.documentElement.style.scrollbarWidth = "none"; true`);
    await themed(options, "settings");

    /* composites: the page with the panel docked beside it */
    console.log("composites");
    const compId = (await browser.send("Target.createTarget", { url: "about:blank", newWindow: true })).result.targetId;
    const comp = await connect((await waitForTarget(DBG, (t) => t.id === compId)).webSocketDebuggerUrl);
    await comp.send("Page.enable");
    const W = PAGE.width + PANEL.width + 1 + 112;
    const H = HEIGHT + 78 + 96;
    await comp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1.25, mobile: false });
    for (const [name, pagePng, panelPng] of [
      ["hero.png", raw("mid-page.png"), raw("mid-panel.png")],
      ["hero-result.png", raw("done-page.png"), raw("done-panel.png")],
    ]) {
      const html = raw(name + ".html");
      fs.writeFileSync(html, compositeHtml(pagePng, panelPng, "Pricing · Lumen Notes"));
      await comp.send("Page.navigate", { url: pathToFileURL(html).href });
      await sleep(400);
      await comp.evaluate(`Promise.all([...document.images].map((i) => i.decode())).then(() => true)`);
      await shot(comp, out(name));
      console.log("  " + name);
    }
  } catch (e) {
    console.log("ERROR", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    clearTimeout(killer);
    child.kill();
    server.close();
    await sleep(800);
    for (const dir of [PROFILE, RAW]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    process.exit(process.exitCode ?? 0);
  }
})();
