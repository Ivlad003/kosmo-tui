import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = fileURLToPath(new URL(".", import.meta.url));
const targetPath = here + "target2.mjs";
const targetUrl = pathToFileURL(targetPath).href;
const src = readFileSync(targetPath, "utf8").split("\n");
const lineOf = (tag) => src.findIndex((l) => l.includes(tag));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = { node: process.version };
function connect(url) {
  const ws = new WebSocket(url); let id = 0; const pending = new Map(); const listeners = new Set(); const log = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); log.push(m); if (m.id !== undefined) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } else for (const l of listeners) l(m); };
  const opened = new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  return { ws, log, opened, send: (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); }), on: (fn) => (listeners.add(fn), () => listeners.delete(fn)) };
}
async function start(flag) {
  const child = spawn(process.execPath, [flag, targetPath], { stdio: ["pipe", "pipe", "pipe"] });
  const st = { child, stdout: "", stderr: "" };
  child.stdout.on("data", (d) => (st.stdout += d));
  child.stderr.on("data", (d) => (st.stderr += d));
  const t0 = Date.now(); while (Date.now() - t0 < 5000 && !/ws:\/\/\S+/.test(st.stderr)) await sleep(20);
  st.wsUrl = st.stderr.match(/ws:\/\/\S+/)[0];
  return st;
}
// ---- A: --inspect-brk: pid check before runIfWaitingForDebugger, then what pause arrives?
for (const flag of ["--inspect-brk=127.0.0.1:0", "--inspect-wait=127.0.0.1:0"]) {
  const st = await start(flag);
  const c = connect(st.wsUrl); await c.opened;
  const r = {};
  const ev = await Promise.race([c.send("Runtime.evaluate", { expression: "process.pid", throwOnSideEffect: true, returnByValue: true }), sleep(2000).then(() => "timeout")]);
  r.pid = ev === "timeout" ? "timeout" : { value: ev.result?.value, ok: ev.result?.value === st.child.pid, exc: ev.exceptionDetails?.text ?? null };
  await c.send("Runtime.enable"); await c.send("Debugger.enable");
  await c.send("Runtime.runIfWaitingForDebugger");
  await sleep(500);
  const p = c.log.find((m) => m.method === "Debugger.paused");
  r.pausedAfterRun = p ? { reason: p.params.reason, hitBreakpoints: p.params.hitBreakpoints, top: p.params.callFrames[0]?.url.split("/").pop() } : null;
  r.appRunning = st.stdout.includes("READY");
  R["A_" + flag.split("=")[0]] = r;
  st.child.kill(); c.ws.close();
}
// ---- B: skipAllPauses(true): do conditional tracepoints still fire, does `debugger;` still pause?
{
  const st = await start("--inspect=127.0.0.1:0");
  const t0 = Date.now(); while (Date.now() - t0 < 5000 && !st.stdout.includes("READY")) await sleep(20);
  const c = connect(st.wsUrl); await c.opened;
  await c.send("Runtime.enable"); await c.send("Debugger.enable");
  await c.send("Runtime.evaluate", { expression: `Object.defineProperty(globalThis, Symbol.for("kosmo-tui"), { configurable: true, value: (id) => console.context("kosmo-tui").trace("KOSMO_TP", id) }); 1` });
  await c.send("Debugger.setSkipAllPauses", { skip: true });
  const from = c.log.length;
  const bp = await c.send("Debugger.setBreakpointByUrl", { url: targetUrl, lineNumber: lineOf("LINE_TP"), condition: `(globalThis[Symbol.for("kosmo-tui")](1), false)` });
  st.child.stdin.write("dbg\n");
  await sleep(500);
  const mine = c.log.slice(from);
  R.B_skipAllPauses = { tracepointHits: mine.filter((m) => m.method === "Runtime.consoleAPICalled").length, pausedEvents: mine.filter((m) => m.method === "Debugger.paused").length, tickAdvancing: /tick/.test(st.stdout) };
  // and unconditional B-style breakpoint under skipAllPauses
  await c.send("Debugger.removeBreakpoint", { breakpointId: bp.breakpointId });
  const from2 = c.log.length;
  const bp2 = await c.send("Debugger.setBreakpointByUrl", { url: targetUrl, lineNumber: lineOf("LINE_TP") });
  await sleep(300);
  R.B_skipAllPauses.unconditionalBpPaused = c.log.slice(from2).filter((m) => m.method === "Debugger.paused").length;
  await c.send("Debugger.removeBreakpoint", { breakpointId: bp2.breakpointId });
  st.child.kill(); c.ws.close();
}
console.log(JSON.stringify(R, null, 2));
process.exit(0);
