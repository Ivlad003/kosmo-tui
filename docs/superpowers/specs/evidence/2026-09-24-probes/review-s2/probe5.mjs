import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const here = fileURLToPath(new URL(".", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function connect(url) {
  const ws = new WebSocket(url); let id = 0; const pending = new Map(); const log = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); log.push(m); if (m.id !== undefined) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
  const opened = new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  return { ws, log, opened, send: (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); }) };
}
const out = {};
for (const flag of ["--inspect-brk=127.0.0.1:0", "--inspect=127.0.0.1:0"]) {
  const child = spawn(process.execPath, [flag, here + "target2.mjs"], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", (d) => (stderr += d));
  const t0 = Date.now(); while (Date.now() - t0 < 5000 && !/ws:\/\/\S+/.test(stderr)) await sleep(20);
  await sleep(300);
  const c = connect(stderr.match(/ws:\/\/\S+/)[0]); await c.opened;
  const r = {};
  for (const expr of ["process.pid", "globalThis.process.pid", "typeof process", "1+1"]) {
    const x = await c.send("Runtime.evaluate", { expression: expr, throwOnSideEffect: true, returnByValue: true });
    r[expr] = { result: x.result, exc: x.exceptionDetails ? (x.exceptionDetails.exception?.description ?? x.exceptionDetails.text) : undefined };
  }
  const x2 = await c.send("Runtime.evaluate", { expression: "process.pid", returnByValue: true });
  r["process.pid (no throwOnSideEffect)"] = x2.result;
  out[flag.split("=")[0]] = { childPid: child.pid, ...r };
  child.kill(); c.ws.close();
}
console.log(JSON.stringify(out, null, 1));
process.exit(0);
