"use strict";
// Tiny DevTools-protocol helpers shared by the screenshot scripts.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(port, p) {
  return (await fetch(`http://127.0.0.1:${port}${p}`)).json();
}

async function connect(wsUrl) {
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
  await new Promise((r, j) => {
    ws.addEventListener("open", r);
    ws.addEventListener("error", j);
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      waiters.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send("Runtime.enable");
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.error) throw new Error(r.error.message);
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    }
    return r.result?.result?.value;
  };
  return { ws, send, evaluate, close: () => ws.close() };
}

async function waitForTarget(port, pred, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const list = await getJson(port, "/json/list");
      const t = list.find(pred);
      if (t) return t;
    } catch {}
    await sleep(250);
  }
  return null;
}

module.exports = { sleep, getJson, connect, waitForTarget };
