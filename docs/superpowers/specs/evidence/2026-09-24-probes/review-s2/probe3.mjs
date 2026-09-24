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
const child = spawn(process.execPath, ["--expose-gc", "--inspect=127.0.0.1:0", targetPath], { stdio: ["pipe", "pipe", "pipe"] });
let stdout = "", stderr = "";
child.stdout.on("data", (d) => (stdout += d));
child.stderr.on("data", (d) => (stderr += d));
const waitFor = async (pred, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(20); } return false; };
const send = (c) => child.stdin.write(c + "\n");
await waitFor(() => /ws:\/\/\S+/.test(stderr) && stdout.includes("READY"));
const wsUrl = stderr.match(/ws:\/\/\S+/)[0];
function connect(url) {
  const ws = new WebSocket(url); let id = 0; const pending = new Map(); const listeners = new Set(); const log = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); log.push(m); if (m.id !== undefined) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } else for (const l of listeners) l(m); };
  const opened = new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  return { ws, log, opened, send: (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject, method }); ws.send(JSON.stringify({ id: mid, method, params })); }), on: (fn) => (listeners.add(fn), () => listeners.delete(fn)) };
}
const LTP = lineOf("LINE_TP");
const helperSrc = `Object.defineProperty(globalThis, Symbol.for("kosmo-tui"), { enumerable: false, configurable: true, value: function (tpId, tag) { console.context("kosmo-tui").trace("KOSMO_TP", tpId, tag); } }); 1`;
// ---------- Session 1: produce kosmo-tui hits, then close without Runtime.discardConsoleEntries
{
  const s1 = connect(wsUrl); await s1.opened;
  await s1.send("Runtime.enable"); await s1.send("Debugger.enable");
  await s1.send("Runtime.evaluate", { expression: helperSrc });
  const bp = await s1.send("Debugger.setBreakpointByUrl", { url: targetUrl, lineNumber: LTP, condition: `(globalThis[Symbol.for("kosmo-tui")](1, "session1"), false)` });
  await sleep(300);
  await s1.send("Debugger.removeBreakpoint", { breakpointId: bp.breakpointId });
  R.T11_session1_hits = s1.log.filter((m) => m.method === "Runtime.consoleAPICalled").length;
  s1.ws.close(); await sleep(300);
}
// ---------- Session 2 (fresh kosmo-tui): what does Runtime.enable replay?
const cdp = connect(wsUrl); await cdp.opened;
const events = []; cdp.on((m) => events.push(m));
const scripts = new Map();
cdp.on((m) => m.method === "Debugger.scriptParsed" && scripts.set(m.params.url, m.params));
{
  const enableP = cdp.send("Runtime.enable");
  await enableP;
  const idx = cdp.log.findIndex((m) => m.id !== undefined);
  const before = cdp.log.slice(0, idx).filter((m) => m.method === "Runtime.consoleAPICalled");
  await sleep(100);
  R.T11_replayOnEnable = {
    consoleMsgsBeforeEnableResponse: before.length,
    ofWhichKosmoContext: before.filter((m) => String(m.params.context).startsWith("kosmo-tui")).length,
    sampleArgs: before[0]?.params.args.map((a) => a.value),
    sampleContext: before[0]?.params.context,
    sampleTimestampAgeMs: before[0] ? Date.now() - before[0].params.timestamp : null,
  };
}
await cdp.send("Debugger.enable");
await cdp.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
await cdp.send("Debugger.setPauseOnExceptions", { state: "none" });
await waitFor(() => scripts.has(targetUrl));
const tScript = scripts.get(targetUrl);
// ---------- T7: `debugger;` statement in app code once our Debugger domain is enabled
{
  const from = events.length;
  send("dbg");
  const ok = await waitFor(() => events.slice(from).some((m) => m.method === "Debugger.paused"), 2000);
  const p = events.slice(from).find((m) => m.method === "Debugger.paused");
  R.T7_debuggerStatement = { paused: ok, reason: p?.params.reason, hitBreakpoints: p?.params.hitBreakpoints, top: p?.params.callFrames?.[0]?.functionName };
  if (ok) await cdp.send("Debugger.resume");
}
// ---------- T8: scriptId breakpoint + scriptHash breakpoint on the same live script/line
{
  const from = events.length;
  const b1 = await cdp.send("Debugger.setBreakpoint", { location: { scriptId: tScript.scriptId, lineNumber: LTP }, condition: `(globalThis[Symbol.for("kosmo-tui")](8, "byScriptId"), false)` });
  let b2, b2err = null;
  try { b2 = await cdp.send("Debugger.setBreakpointByUrl", { scriptHash: tScript.hash, lineNumber: LTP, condition: `(globalThis[Symbol.for("kosmo-tui")](8, "byScriptHash"), false)` }); } catch (e) { b2err = e.message; }
  await sleep(400);
  await cdp.send("Debugger.removeBreakpoint", { breakpointId: b1.breakpointId });
  if (b2) await cdp.send("Debugger.removeBreakpoint", { breakpointId: b2.breakpointId });
  const msgs = events.slice(from).filter((m) => m.method === "Runtime.consoleAPICalled" && m.params.args[0]?.value === "KOSMO_TP");
  R.T8_doubleBreakpoint = { b1: b1.actualLocation, b2: b2?.locations, b2err, byScriptId: msgs.filter((m) => m.params.args[2].value === "byScriptId").length, byScriptHash: msgs.filter((m) => m.params.args[2].value === "byScriptHash").length };
}
// ---------- T9: resolvedBreakpoints on scriptParsed for a pre-set url breakpoint
{
  const from = events.length;
  const b = await cdp.send("Debugger.setBreakpointByUrl", { url: "/virtual/late.ts", lineNumber: 2 });
  send("newscript");
  await waitFor(() => events.slice(from).some((m) => m.method === "Debugger.scriptParsed" && m.params.url === "/virtual/late.ts"), 2000);
  await sleep(100);
  const sp = events.slice(from).find((m) => m.method === "Debugger.scriptParsed" && m.params.url === "/virtual/late.ts");
  R.T9_resolvedBreakpoints = { scriptParsedHasField: sp ? "resolvedBreakpoints" in sp.params : "no-script", value: sp?.params.resolvedBreakpoints, breakpointResolvedEvents: events.slice(from).filter((m) => m.method === "Debugger.breakpointResolved").length, startLine: sp?.params.startLine };
  await cdp.send("Debugger.removeBreakpoint", { breakpointId: b.breakpointId });
  // any paused from that? resume just in case
  if (events.slice(from).some((m) => m.method === "Debugger.paused")) await cdp.send("Debugger.resume").catch(() => {});
}
// ---------- T10: vm context created and GC'd: executionContextDestroyed for a NON-main context?
{
  const from = events.length;
  send("vm");
  await waitFor(() => stdout.includes("VMDONE"), 3000);
  await sleep(300);
  const ev = events.slice(from).filter((m) => m.method.startsWith("Runtime.executionContext"));
  R.T10_vmContext = ev.map((m) => ({ method: m.method, id: m.params.context?.id ?? m.params.executionContextId, name: m.params.context?.name, isDefault: m.params.context?.auxData?.isDefault }));
  R.T10_processStillAlive = child.exitCode === null;
}
// ---------- T13: another client (e.g. VS Code) pauses on ITS breakpoint: what do we see?
{
  const other = connect(wsUrl); await other.opened;
  await other.send("Debugger.enable");
  const from = events.length;
  const ob = await other.send("Debugger.setBreakpointByUrl", { url: targetUrl, lineNumber: LTP });
  const ok = await waitFor(() => events.slice(from).some((m) => m.method === "Debugger.paused"), 2000);
  const p = events.slice(from).find((m) => m.method === "Debugger.paused");
  R.T13_otherClientPause = { weSawPaused: ok, reason: p?.params.reason, hitBreakpoints: p?.params.hitBreakpoints, otherBpId: ob.breakpointId };
  await other.send("Debugger.removeBreakpoint", { breakpointId: ob.breakpointId });
  // we resume (as spec 9.8 'closing' / 9.7 'non-matching' would)
  const from2 = other.log.length;
  await cdp.send("Debugger.resume");
  await sleep(200);
  R.T13_otherClientPause.otherSawResumed = other.log.slice(from2).some((m) => m.method === "Debugger.resumed");
  other.ws.close();
}
console.log(JSON.stringify(R, null, 2));
child.kill(); process.exit(0);
