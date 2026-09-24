// Re-verification probe (pipe mode, headless Chrome 153).
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { launch, startServer, sleep, helperSrc, cond } from "./cdp.mjs";

const log = (...a) => console.log(...a);
const nonce = randomBytes(8).toString("hex");
const srv = await startServer();
const br = launch({ pipe: true });
const cdp = br.cdp;
const done = () => { try { br.cleanup(); } catch {} try { srv.proc.kill(); } catch {} };
process.on("exit", done);

const ev = { paused: [], hits: [], ctxCleared: 0, ctxDestroyed: 0, ctxCreated: 0, attached: [], scripts: [], contexts: new Set(), preEnable: 0 };
let S, autoResume = true;
cdp.on((m) => {
  const p = m.params ?? {};
  if (m.method === "Debugger.paused") {
    ev.paused.push({ sid: m.sessionId, reason: p.reason, url: p.data?.url, top: p.callFrames?.[0]?.url, hit: p.hitBreakpoints });
    if (autoResume) cdp.send("Debugger.resume", {}, m.sessionId).catch(() => {});
  }
  if (m.method === "Runtime.consoleAPICalled" && p.context?.startsWith("kosmo-tui")) {
    ev.contexts.add(p.context);
    if (p.args?.[1]?.value === nonce) ev.hits.push({ sid: m.sessionId, tp: p.args[2].value, st: p.stackTrace, t: Date.now() });
  }
  if (m.method === "Runtime.executionContextsCleared" && m.sessionId === S?.id) ev.ctxCleared++;
  if (m.method === "Runtime.executionContextDestroyed" && m.sessionId === S?.id) ev.ctxDestroyed++;
  if (m.method === "Runtime.executionContextCreated" && m.sessionId === S?.id) ev.ctxCreated++;
  if (m.method === "Debugger.scriptParsed") ev.scripts.push({ sid: m.sessionId, ...p });
  if (m.method === "Target.attachedToTarget") {
    const t = p.targetInfo; ev.attached.push({ type: t.type, url: t.url, waiting: p.waitingForDebugger, sid: p.sessionId });
    if (t.type === "iframe" && autoResume) cdp.send("Runtime.runIfWaitingForDebugger", {}, p.sessionId).catch(() => {});
  }
});

try {
  await sleep(300);
  let listen = "(none)";
  try { listen = execFileSync("lsof", ["-a", "-p", String(br.child.pid), "-iTCP", "-sTCP:LISTEN", "-P", "-n"], { encoding: "utf8" }).trim() || "(none)"; } catch {}
  log("[pipe] LISTEN on browser pid:", listen, "| DevToolsActivePort:", existsSync(path.join(br.profile, "DevToolsActivePort")), "| profile mode:", (statSync(br.profile).mode & 0o777).toString(8));
  log("[pipe] version:", (await cdp.send("Browser.getVersion")).product);

  const { targetInfos } = await cdp.send("Target.getTargets");
  log("[targets at start]", targetInfos.map((t) => `${t.type} ${t.url}`));
  const page = targetInfos.find((t) => t.type === "page");
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  S = cdp.session(sessionId);
  // Proposed §9.3 order
  await S.send("Page.enable");
  const { identifier } = await S.send("Page.addScriptToEvaluateOnNewDocument", { source: helperSrc(nonce), runImmediately: true });
  await S.send("Runtime.enable");
  await S.send("Debugger.enable");
  await S.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
  await S.send("Debugger.setBlackboxPatterns", { patterns: ["/node_modules/"] });
  await S.send("Debugger.setSkipAllPauses", { skip: true });
  const aa = await S.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "iframe" }, { type: "worker", exclude: true }, { type: "service_worker", exclude: true }, { type: "shared_worker", exclude: true }] }).then(() => "ok", (e) => e.message);
  log("[setAutoAttach with filter]", aa);
  await S.send("Page.navigate", { url: `http://127.0.0.1:${srv.port}/` });
  await sleep(1500);
  log("[auto-attached after navigate]", ev.attached.map((a) => `${a.type} ${a.url} waiting=${a.waiting}`));
  const val = async (expr, sid = S.id) => (await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true }, sid)).result.value;
  log("[worker not attached -> running] __wmsgs:", await val("window.__wmsgs"), "| helper present:", await val(`typeof globalThis[Symbol.for("kosmo-tui:${nonce}")]`));

  const app = ev.scripts.filter((s) => s.sid === S.id && s.url.endsWith("/app.js")).at(-1);
  log("[app.js] scriptId", app.scriptId, "hash", app.hash.slice(0, 12));

  // Phase A: tracepoint with skipAllPauses(true)
  const bpTick = await S.send("Debugger.setBreakpointByUrl", { scriptHash: app.hash, lineNumber: 2, condition: cond(nonce, 1, ["n", "user", "doubled"]) });
  ev.hits.length = 0; ev.paused.length = 0;
  await sleep(1000);
  const h1 = ev.hits.filter((h) => h.tp === 1);
  const st = h1[0]?.st;
  const chain = []; for (let p = st?.parent; p; p = p.parent) chain.push(p.description);
  log("[A skipAllPauses=true] tick hits/1s:", h1.length, "pauses:", ev.paused.length, "| sync top:", st?.callFrames.slice(0, 3).map((f) => `${f.functionName || "(anon)"}@${f.url.split("/").pop() || "''"}:${f.lineNumber}`), "| async chain:", chain, "| parentId:", !!st?.parentId);
  log("[A] gap ms:", await val("window.__gap"));
  await S.send("Debugger.removeBreakpoint", { breakpointId: bpTick.breakpointId });

  // Phase B: instrumentation BP while skipAllPauses(true); hash BP for first-run mountOnce; reload behaviour
  const bpMount = await S.send("Debugger.setBreakpointByUrl", { scriptHash: app.hash, lineNumber: 6, condition: cond(nonce, 2, ["label"]) });
  const bpById = await S.send("Debugger.setBreakpoint", { location: { scriptId: app.scriptId, lineNumber: 2 }, condition: cond(nonce, 3, ["n"]) });
  const instr = await S.send("Debugger.setInstrumentationBreakpoint", { instrumentation: "beforeScriptWithSourceMapExecution" });
  ev.hits.length = 0; ev.paused.length = 0; ev.ctxCleared = ev.ctxDestroyed = ev.ctxCreated = 0; ev.attached.length = 0;
  const nScripts = ev.scripts.length;
  await S.send("Page.reload", {});
  await sleep(1500);
  const app2 = ev.scripts.slice(nScripts).filter((s) => s.sid === S.id && s.url.endsWith("/app.js")).at(-1);
  log("[B reload] ctxCleared", ev.ctxCleared, "ctxDestroyed", ev.ctxDestroyed, "ctxCreated", ev.ctxCreated, "| new app.js id", app2?.scriptId, "same hash", app2?.hash === app.hash);
  log("[B reload] hash-BP first-run mountOnce hits:", ev.hits.filter((h) => h.tp === 2).length, "| scriptId-BP hits after reload:", ev.hits.filter((h) => h.tp === 3).length, "| pauses (skipAllPauses=true + instrumentation):", ev.paused.length);
  log("[B reload] helper re-installed:", await val(`typeof globalThis[Symbol.for("kosmo-tui:${nonce}")]`), "| session still usable:", await val("1+1"));
  await S.send("Debugger.removeBreakpoint", { breakpointId: bpMount.breakpointId });
  await S.send("Debugger.removeBreakpoint", { breakpointId: bpById.breakpointId });

  // Phase C: instrumentation with skipAllPauses(false), without and with blackboxing
  await S.send("Debugger.setSkipAllPauses", { skip: false });
  for (const patterns of [[], ["/node_modules/"]]) {
    await S.send("Debugger.setBlackboxPatterns", { patterns });
    ev.paused.length = 0;
    await S.send("Page.reload", {});
    await sleep(1500);
    const pp = ev.paused.filter((p) => p.sid === S.id);
    log(`[C skipAllPauses=false blackbox=${JSON.stringify(patterns)}] pauses:`, pp.length, pp.map((p) => `${p.reason}:${(p.url || "").replace(/^http:\/\/127\.0\.0\.1:\d+/, "")}`));
  }
  await S.send("Debugger.removeBreakpoint", { breakpointId: instr.breakpointId });
  await S.send("Debugger.setSkipAllPauses", { skip: true });

  // Phase D: hot line, client-side guard
  const app3 = ev.scripts.filter((s) => s.sid === S.id && s.url.endsWith("/app.js")).at(-1);
  const N = 20000;
  const base = await val(`runHot(${N})`);
  let bpHot = await S.send("Debugger.setBreakpointByUrl", { scriptHash: app3.hash, lineNumber: 9, condition: cond(nonce, 4, ["i"]) });
  ev.hits.length = 0;
  const noGuard = await val(`runHot(${N})`);
  const hitsNoGuard = ev.hits.filter((h) => h.tp === 4).length;
  // guard: remove after 100 hits
  ev.hits.length = 0; let removedAt = null, removeAck = null;
  const off = cdp.on((m) => {
    if (m.method === "Runtime.consoleAPICalled" && m.params.args?.[2]?.value === 4 && removedAt === null && ev.hits.filter((h) => h.tp === 4).length >= 100) {
      removedAt = Date.now();
      S.send("Debugger.removeBreakpoint", { breakpointId: bpHot.breakpointId }).then(() => (removeAck = Date.now()));
    }
  });
  const t0 = Date.now();
  const guarded = await val(`runHot(${N})`);
  const tEval = Date.now();
  off();
  log(`[D hot] runHot(${N}) no bp: ${base.toFixed(1)} ms | tracepoint no guard: ${noGuard.toFixed(0)} ms (${(noGuard * 1000 / N).toFixed(1)} us/pass, hits ${hitsNoGuard}) | guard remove@100: ${guarded.toFixed(0)} ms, hits ${ev.hits.filter((h) => h.tp === 4).length}, removeBreakpoint acked ${removeAck ? removeAck - removedAt : "n/a"} ms after send, evaluate returned ${tEval - t0} ms after start, ack before eval return: ${removeAck !== null && removeAck <= tEval}`);

  // Phase E: auto-attach without filter; unresumed worker stays paused
  autoResume = false;
  await S.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  ev.attached.length = 0;
  await S.send("Page.reload", {});
  await sleep(1500);
  log("[E no filter] attached:", ev.attached.map((a) => `${a.type} waiting=${a.waiting}`));
  const iframes = ev.attached.filter((a) => a.type === "iframe");
  for (const f of iframes) await cdp.send("Runtime.runIfWaitingForDebugger", {}, f.sid).catch(() => {});
  const w1 = await val("window.__wmsgs");
  const wk = ev.attached.find((a) => a.type === "worker");
  if (wk) await cdp.send("Runtime.runIfWaitingForDebugger", {}, wk.sid);
  await sleep(500);
  log("[E no filter] __wmsgs while worker unresumed:", w1, "-> after runIfWaitingForDebugger:", await val("window.__wmsgs"));
  autoResume = true;

  // Phase F: replay to a second session + cleanup check
  const { sessionId: s2 } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  let replay = 0, replayOurs = 0;
  const off2 = cdp.on((m) => { if (m.sessionId === s2 && m.method === "Runtime.consoleAPICalled" && m.params.context?.startsWith("kosmo-tui")) { replay++; if (m.params.args?.[1]?.value === nonce) replayOurs++; } });
  await cdp.send("Runtime.enable", {}, s2);
  const replayAtResp = replay;
  await sleep(300);
  off2();
  log("[F second session] kosmo msgs before Runtime.enable response:", replayAtResp, "(with our nonce:", replayOurs, ") after +300ms:", replay);
  log("[contexts seen]", [...ev.contexts].slice(0, 6));
  // cleanup
  await S.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  await S.send("Runtime.evaluate", { expression: `delete globalThis[Symbol.for("kosmo-tui:${nonce}")]` });
  await cdp.send("Page.enable", {}, s2);
  await cdp.send("Page.reload", {}, s2); await sleep(1000);
  log("[F cleanup] helper after removeScript+delete+reload (fresh session):", (await cdp.send("Runtime.evaluate", { expression: `typeof globalThis[Symbol.for("kosmo-tui:${nonce}")]`, returnByValue: true }, s2)).result.value);
  log("[stderr mentions KOSMO]", /KOSMO/.test(br.log));
  await cdp.send("Browser.close").catch(() => {});
} catch (e) { log("ERROR", e.stack); }
finally { await sleep(300); log("chrome exit", br.child.exitCode, br.child.signalCode); done(); process.exit(0); }
