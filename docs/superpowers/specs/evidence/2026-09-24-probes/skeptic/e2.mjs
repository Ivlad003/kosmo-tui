import { startTarget, connect, sleep, waitFor } from "./lib.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const file = new URL("./t2.mjs", import.meta.url).pathname; const url = pathToFileURL(file).href;
const src = readFileSync(file, "utf8").split("\n"); const L = (tag) => src.findIndex((l) => l.includes(tag));
const t = await startTarget(["--inspect=127.0.0.1:0"], file);
await waitFor(() => t.stdout.includes("READY"));
const out = { node: process.version };
const A = connect(t.wsUrl); await A.opened; const B = connect(t.wsUrl); await B.opened;
const ev = { A: [], B: [] };
A.on((m) => { if (m.method === "Debugger.paused") ev.A.push({ reason: m.params.reason, hit: m.params.hitBreakpoints, line: m.params.callFrames[0].location.lineNumber }); if (m.method === "Debugger.resumed") ev.A.push("resumed"); if (m.method === "Runtime.consoleAPICalled" && m.params.args[0]?.value === "KOSMO_TP") ev.A.push("hit"); });
B.on((m) => { if (m.method === "Debugger.paused") ev.B.push({ reason: m.params.reason, hit: m.params.hitBreakpoints }); if (m.method === "Debugger.resumed") ev.B.push("resumed"); });
await A.send("Runtime.enable"); await A.send("Debugger.enable");
// a) debugger; statement, A not skipping
t.send("dbg"); await sleep(300); out.a_debuggerStmt = ev.A.splice(0); await A.send("Debugger.resume"); await sleep(100); ev.A.length = 0;
// b) A skipAllPauses + conditional tracepoint + debugger;
await A.send("Debugger.setSkipAllPauses", { skip: true });
await A.send("Runtime.evaluate", { expression: `globalThis.__kt = () => console.context("kosmo-tui").trace("KOSMO_TP")` });
const tp = await A.send("Debugger.setBreakpointByUrl", { url, lineNumber: L("LINE_CALC"), condition: "(__kt(), false)" });
const ubp = await A.send("Debugger.setBreakpointByUrl", { url, lineNumber: L("LINE_NEXT") });
t.send("run"); t.send("dbg"); t.send("run"); await sleep(400);
out.b_skip = ev.A.splice(0);
await A.send("Debugger.removeBreakpoint", { breakpointId: ubp.breakpointId });
// c) B sets bp; A (skip) sees nothing, B pauses
await B.send("Debugger.enable");
const bbp = await B.send("Debugger.setBreakpointByUrl", { url, lineNumber: L("LINE_NEXT") });
t.send("run"); await sleep(300);
out.c_withSkip = { A: ev.A.splice(0), B: ev.B.splice(0) };
await B.send("Debugger.resume"); await sleep(200); ev.A.length = 0; ev.B.length = 0;
// c2) A no skip, B's bp -> A sees paused
await A.send("Debugger.setSkipAllPauses", { skip: false });
t.send("run"); await sleep(300);
out.c2_noSkip = { A: ev.A.splice(0), B: ev.B.splice(0) };
await A.send("Debugger.resume"); await sleep(200);
out.c2_afterAResume = { A: ev.A.splice(0), B: ev.B.splice(0) };
await B.send("Debugger.removeBreakpoint", { breakpointId: bbp.breakpointId });
// d) A's own bp then stepOver -> hitBreakpoints of step pause
await A.send("Debugger.removeBreakpoint", { breakpointId: tp.breakpointId });
const abp = await A.send("Debugger.setBreakpointByUrl", { url, lineNumber: L("LINE_CALC") });
t.send("run"); await sleep(300);
await A.send("Debugger.stepOver"); await sleep(300);
out.d_step = { ours: abp.breakpointId, A: ev.A.splice(0) };
await A.send("Debugger.resume");
console.log(JSON.stringify(out));
t.send("exit"); A.close(); B.close(); setTimeout(() => process.exit(0), 300);
