// diag-browser.mjs — drive the built demo in headless Chromium over CDP and
// dump the console + board/log so we can see why Counter Exchange fails.
//
// Requires: built host + remotes (pnpm build && pnpm build:remotes), chromium.
//
// Usage: node scripts/diag-browser.mjs [--no-attest]

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const ATTEST = !process.argv.includes("--no-attest");
const procs = [];

function serve(dist, port, role) {
  const p = spawn(
    "node",
    ["scripts/origin-server.mjs", "--dist", dist, "--port", String(port), "--role", role,
     "--origin", `http://localhost:${port}`],
    { stdio: "ignore" },
  );
  procs.push(p);
  return p;
}

async function cdp(ws, method, params = {}) {
  const id = cdp._id = (cdp._id || 0) + 1;
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) {
        ws.removeEventListener("message", onMsg);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  // 1. origin servers + host static server
  serve("apps/catalog/dist", 4001, "catalog");
  serve("apps/cart/dist", 4002, "cart");
  serve("apps/host/dist", 3000, "host");
  await sleep(800);

  // 2. chromium headless with remote debugging
  const chrome = spawn("chromium-browser", [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    "--remote-debugging-port=9222", "about:blank",
  ], { stdio: "ignore" });
  procs.push(chrome);
  await sleep(1500);

  // 3. find the page target
  let target;
  for (let i = 0; i < 20; i++) {
    try {
      const list = await (await fetch("http://localhost:9222/json")).json();
      target = list.find((t) => t.type === "page");
      if (target) break;
    } catch {}
    await sleep(300);
  }
  if (!target) throw new Error("no chromium page target");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));

  const consoleLines = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.consoleAPICalled") {
      const text = (m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
      consoleLines.push(`[${m.params.type}] ${text}`);
    }
    if (m.method === "Runtime.exceptionThrown") {
      consoleLines.push(`[exception] ${m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails)}`);
    }
  });

  await cdp(ws, "Runtime.enable");
  await cdp(ws, "Page.enable");
  await cdp(ws, "Page.navigate", { url: "http://localhost:3000" });
  await sleep(2500);

  // 4. set the checkbox and click Run Counter Exchange
  const clickRes = await cdp(ws, "Runtime.evaluate", {
    expression: `(() => {
      const chk = document.getElementById('chk-attest');
      const btn = document.getElementById('btn-attest');
      if (!chk || !btn) return 'MISSING CONTROLS';
      chk.checked = ${ATTEST};
      btn.click();
      return 'clicked, attest=' + chk.checked;
    })()`,
    returnByValue: true,
  });
  console.log("CLICK:", clickRes.result.value);

  await sleep(3500); // let fetches + handshake + render happen

  // 5. drive the exchange: catalog Set x = 42, malicious Inject x = 666
  const actRes = await cdp(ws, "Runtime.evaluate", {
    expression: `(() => {
      const set = (id, val) => {
        const card = document.querySelector('[data-card-id="' + id + '"]');
        if (!card) return id + ' MISSING';
        card.querySelector('.value-input').value = String(val);
        card.querySelector('.value-controls button').click();
        return id + ' set ' + val;
      };
      return [set('r-catalog', 42), set('r-mal', 666)].join(' | ');
    })()`,
    returnByValue: true,
  });
  console.log("ACTIONS:", actRes.result.value);

  await sleep(1500);

  const dump = await cdp(ws, "Runtime.evaluate", {
    expression: `JSON.stringify({
      board: document.getElementById('value-board')?.innerText || '(empty)',
      log: document.getElementById('log-panel')?.innerText || '(empty)',
    })`,
    returnByValue: true,
  });
  const { board, log } = JSON.parse(dump.result.value);

  console.log("\n===== CONSOLE =====\n" + (consoleLines.join("\n") || "(none)"));
  console.log("\n===== BOARD =====\n" + board);
  console.log("\n===== LOG PANEL =====\n" + log);

  ws.close();
}

main()
  .catch((e) => console.log("DIAG ERROR:", e.message))
  .finally(async () => {
    for (const p of procs) p.kill("SIGKILL");
    await sleep(200);
    process.exit(0);
  });
