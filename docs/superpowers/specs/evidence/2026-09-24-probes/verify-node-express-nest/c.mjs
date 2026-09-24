// independent minimal CDP client for verification
import { spawn } from "node:child_process";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function launch(node, args, opts = {}) {
  const ch = spawn(node, args, { cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) }, stdio: ["ignore", "pipe", "pipe"] });
  const out = { stdout: "", stderr: "" }; let r; const ws = new Promise((x) => (r = x));
  ch.stdout.on("data", (d) => (out.stdout += d));
  ch.stderr.on("data", (d) => { out.stderr += d; const m = /Debugger listening on (ws:\/\/\S+)/.exec(out.stderr); if (m) r(m[1]); });
  ch.on("exit", (c, s) => (out.exit = { c, s }));
  return { ch, out, ws };
}
export async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((a, b) => { ws.onopen = a; ws.onerror = b; });
  let id = 0; const pend = new Map(), hs = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.b(new Error(JSON.stringify(m.error))) : p.a(m.result); return; } for (const h of hs.get(m.method) || []) h(m.params); for (const h of hs.get("*") || []) h(m.method, m.params); };
  const closed = new Promise((a) => ws.addEventListener("close", a));
  return { send: (method, params = {}) => new Promise((a, b) => { const i = ++id; pend.set(i, { a, b }); ws.send(JSON.stringify({ id: i, method, params })); }), on: (m, f) => { if (!hs.has(m)) hs.set(m, []); hs.get(m).push(f); }, close: () => ws.close(), closed };
}
export function decodeMap(s) { const u = s.sourceMapURL; if (!u?.startsWith("data:")) return null; const b = u.slice(u.indexOf(",") + 1); return JSON.parse(u.includes(";base64,") ? Buffer.from(b, "base64").toString() : decodeURIComponent(b)); }
