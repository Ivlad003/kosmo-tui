import { spawn } from "node:child_process";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(pred, ms = 5000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(10); } return false; }
export async function startTarget(args, file, env) {
  const child = spawn(process.execPath, [...args, file], { stdio: ["pipe", "pipe", "pipe"], env: env ?? process.env });
  const o = { child, stdout: "", stderr: "" };
  child.stdout.on("data", (d) => (o.stdout += d));
  child.stderr.on("data", (d) => (o.stderr += d));
  await waitFor(() => /ws:\/\/\S+/.test(o.stderr));
  o.wsUrl = o.stderr.match(/ws:\/\/\S+/)[0];
  o.send = (c) => child.stdin.write(c + "\n");
  return o;
}
export function connect(url) {
  const ws = new WebSocket(url); let id = 0; const pending = new Map(); const listeners = new Set();
  const log = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); log.push(m); if (m.id !== undefined) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } else for (const l of listeners) l(m); };
  const opened = new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  return { ws, opened, log, send: (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); }), on: (fn) => (listeners.add(fn), () => listeners.delete(fn)), close: () => ws.close() };
}
