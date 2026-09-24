// T2: does setSkipAllPauses(true) suppress instrumentation pauses? T1: are filtered-out workers left paused? T3: console replay.
import { launch, startServer, sleep, helperSrc, cond } from "./cdp.mjs";
const log = (...a) => console.log(...a);
const srv = await startServer();
const results = {};
async function withBrowser(fn) {
  const br = launch({ pipe: true }); const cdp = br.cdp;
  try {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const page = targetInfos.find((t) => t.type === "page");
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    const S = cdp.session(sessionId);
    const val = async (e, sid = sessionId) => (await cdp.send("Runtime.evaluate", { expression: e, returnByValue: true }, sid)).result.value;
    await fn({ cdp, S, page, val });
    await cdp.send("Browser.close").catch(() => {});
  } catch (e) { log("ERROR", e.stack); } finally { await sleep(200); br.cleanup(); }
}
const URL0 = `http://127.0.0.1:${srv.port}/`;

// T2
await withBrowser(async ({ cdp, S, val }) => {
  const paused = [];
  cdp.on((m) => { if (m.method === "Debugger.paused") { paused.push(`${m.sessionId === S.id ? "page" : "other"}:${m.params.reason}:${(m.params.data?.url ?? m.params.callFrames[0]?.url ?? "").replace(/^http:\/\/127\.0\.0\.1:\d+/, "")}`); cdp.send("Debugger.resume", {}, m.sessionId).catch(() => {}); } });
  await S.send("Page.enable"); await S.send("Runtime.enable"); await S.send("Debugger.enable");
  await S.send("Debugger.setSkipAllPauses", { skip: true });
  await S.send("Debugger.setInstrumentationBreakpoint", { instrumentation: "beforeScriptWithSourceMapExecution" });
  await S.send("Page.navigate", { url: URL0 }); await sleep(1500);
  log("[T2 skip=true, instr set, navigate] pauses:", paused.splice(0));
  S.send("Runtime.evaluate", { expression: "debugger; 1" }).catch(() => {}); await sleep(300);
  log("[T2 skip=true] Runtime.evaluate('debugger') pauses:", paused.splice(0));
  await S.send("Page.reload", {}); await sleep(1500);
  log("[T2 skip=true, reload] pauses:", paused.splice(0));
  await S.send("Debugger.setSkipAllPauses", { skip: false });
  await S.send("Page.reload", {}); await sleep(1500);
  log("[T2 skip=false, reload] pauses:", paused.splice(0));
});

// T1: worker behaviour under filters
for (const [label, params] of [
  ["no setAutoAttach", null],
  ["filter exclude worker, waitForDebuggerOnStart:true", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "iframe" }, { type: "worker", exclude: true }] }],
  ["filter [{type:iframe}] only, waitForDebuggerOnStart:true", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "iframe" }] }],
  ["filter exclude worker, waitForDebuggerOnStart:false", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe" }, { type: "worker", exclude: true }] }],
  ["no filter, waitForDebuggerOnStart:true, resume all", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }],
]) {
  await withBrowser(async ({ cdp, S, val }) => {
    const att = [];
    cdp.on((m) => { if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type !== "page") { att.push(`${m.params.targetInfo.type} w=${m.params.waitingForDebugger}`); cdp.send("Runtime.runIfWaitingForDebugger", {}, m.params.sessionId).catch(() => {}); } });
    await S.send("Page.enable"); await S.send("Runtime.enable");
    if (params) await S.send("Target.setAutoAttach", params);
    await S.send("Page.navigate", { url: URL0 }); await sleep(2500);
    log(`[T1 ${label}] attached: ${JSON.stringify(att)} __wmsgs after 2.5s: ${await val("window.__wmsgs")}`);
  });
}

// T3: replay of kosmo-tui console messages to a newly enabled session (same document)
await withBrowser(async ({ cdp, S, val }) => {
  const nonce = "abc123";
  await S.send("Page.enable"); await S.send("Runtime.enable"); await S.send("Debugger.enable");
  await S.send("Page.navigate", { url: URL0 }); await sleep(1000);
  await S.send("Runtime.evaluate", { expression: helperSrc(nonce) });
  let scripts = [];
  cdp.on((m) => { if (m.method === "Debugger.scriptParsed" && m.sessionId === S.id) scripts.push(m.params); });
  // find app.js via a reload-free path: getPossible? use setBreakpointByUrl(url) for this probe
  const bp = await S.send("Debugger.setBreakpointByUrl", { url: URL0 + "app.js", lineNumber: 2, condition: cond(nonce, 1, ["n"]) });
  await sleep(500);
  await S.send("Debugger.removeBreakpoint", { breakpointId: bp.breakpointId });
  const { sessionId: s2 } = await cdp.send("Target.attachToTarget", { targetId: (await cdp.send("Target.getTargets")).targetInfos.find((t) => t.type === "page").targetId, flatten: true });
  let before = 0, after = 0, gotResp = false;
  cdp.on((m) => { if (m.sessionId === s2 && m.method === "Runtime.consoleAPICalled" && m.params.context?.startsWith("kosmo-tui")) (gotResp ? after++ : before++); });
  await cdp.send("Runtime.enable", {}, s2); gotResp = true; await sleep(300);
  log(`[T3] new session Runtime.enable: kosmo msgs before response ${before}, after ${after}`);
  await cdp.send("Runtime.discardConsoleEntries", {}, S.id);
  const { sessionId: s3 } = await cdp.send("Target.attachToTarget", { targetId: (await cdp.send("Target.getTargets")).targetInfos.find((t) => t.type === "page").targetId, flatten: true });
  let b3 = 0; cdp.on((m) => { if (m.sessionId === s3 && m.method === "Runtime.consoleAPICalled" && m.params.context?.startsWith("kosmo-tui")) b3++; });
  await cdp.send("Runtime.enable", {}, s3); await sleep(300);
  log(`[T3] after discardConsoleEntries, third session replay: ${b3}`);
});
srv.proc.kill();
process.exit(0);
