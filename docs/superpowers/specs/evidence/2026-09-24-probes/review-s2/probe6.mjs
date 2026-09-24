import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = fileURLToPath(new URL(".", import.meta.url));
const tp = here + "target3.mjs", turl = pathToFileURL(tp).href;
const LF = readFileSync(tp, "utf8").split("\n").findIndex((l) => l.includes("LINE_F"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(process.execPath, ["--inspect=127.0.0.1:0", tp], { stdio: ["pipe", "pipe", "pipe"] });
let stdout = "", stderr = ""; child.stdout.on("data", (d) => (stdout += d)); child.stderr.on("data", (d) => (stderr += d));
const waitFor = async (p, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (p()) return true; await sleep(5); } return false; };
await waitFor(() => /ws:\/\/\S+/.test(stderr) && stdout.includes("READY"));
const ws = new WebSocket(stderr.match(/ws:\/\/\S+/)[0]); let id = 0; const pend = new Map(); const lis = new Set();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.j(new Error(m.error.message)) : p.r(m.result); } else for (const l of lis) l(m); };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r, j) => { const mid = ++id; pend.set(mid, { r, j }); ws.send(JSON.stringify({ id: mid, method, params })); });
await send("Runtime.enable"); await send("Debugger.enable"); await send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
const run = async (n) => { const b = stdout.length; child.stdin.write("run" + n + "\n"); await waitFor(() => /RUN (\S+)/.test(stdout.slice(b))); return Number(stdout.slice(b).match(/RUN (\S+)/)[1]); };
const R = { node: process.version };
R.baseline_200_ms = await run(200);
// (1) predicate in the V8 condition (in-process), never matches
let bp = await send("Debugger.setBreakpointByUrl", { url: turl, lineNumber: LF, condition: "item.id === -1" });
R.conditionPredicate_200_ms = await run(200);
await send("Debugger.removeBreakpoint", { breakpointId: bp.breakpointId });
// (2) spec 9.7: unconditional pause, client evaluateOnCallFrame(throwOnSideEffect, timeout 200), resume
let pauses = 0;
const onPause = async (m) => {
  if (m.method !== "Debugger.paused") return;
  pauses++;
  await send("Debugger.evaluateOnCallFrame", { callFrameId: m.params.callFrames[0].callFrameId, expression: "item.id === -1", throwOnSideEffect: true, timeout: 200, returnByValue: true });
  await send("Debugger.resume");
};
lis.add(onPause);
bp = await send("Debugger.setBreakpointByUrl", { url: turl, lineNumber: LF });
R.clientPredicate_200_ms = await run(200);
R.clientPredicate_pauses = pauses;
await send("Debugger.removeBreakpoint", { breakpointId: bp.breakpointId });
lis.delete(onPause);
// (3) optimized-away module-level name that shadows a global: what does a capture see?
bp = await send("Debugger.setBreakpointByUrl", { url: turl, lineNumber: LF, condition: `(globalThis.__shadow = (() => { try { return typeof performance === "string" ? performance : "GLOBAL " + Object.prototype.toString.call(performance) } catch (e) { return String(e) } })(), false)` });
await run(1);
await send("Debugger.removeBreakpoint", { breakpointId: bp.breakpointId });
R.shadowedGlobalCapture = (await send("Runtime.evaluate", { expression: "globalThis.__shadow", returnByValue: true })).result.value;
console.log(JSON.stringify(R, null, 1));
child.kill(); process.exit(0);
