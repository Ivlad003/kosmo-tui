// T6: within one document, does re-asserted setSkipAllPauses(true) suppress instrumentation pauses for lazily imported modules?
import { launch, startServer, sleep } from "./cdp.mjs";
const srv = await startServer(); const URL0 = `http://127.0.0.1:${srv.port}/`;
const br = launch({ pipe: true }); const cdp = br.cdp; const paused = []; let S;
cdp.on((m) => { if (m.method === "Debugger.paused") { paused.push(m.params.reason + ":" + (m.params.data?.url ?? "").replace(URL0, "/")); cdp.send("Debugger.resume", {}, m.sessionId).catch(() => {}); } });
try {
  const { targetInfos } = await cdp.send("Target.getTargets");
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: targetInfos.find((t) => t.type === "page").targetId, flatten: true });
  S = cdp.session(sessionId);
  await S.send("Page.enable"); await S.send("Runtime.enable"); await S.send("Debugger.enable");
  await S.send("Debugger.setInstrumentationBreakpoint", { instrumentation: "beforeScriptWithSourceMapExecution" });
  await S.send("Page.navigate", { url: URL0 }); await sleep(1500); paused.length = 0;
  for (const skip of [false, true]) {
    await S.send("Debugger.setSkipAllPauses", { skip });
    await S.send("Runtime.evaluate", { expression: `import("/m/a.js?v=${skip}").then(m => m.a())`, awaitPromise: true });
    await sleep(300);
    console.log(`[T6 same doc, skipAllPauses=${skip}] lazy import instrumentation pauses:`, paused.splice(0));
  }
  await cdp.send("Browser.close").catch(() => {});
} catch (e) { console.log("ERROR", e.stack); } finally { await sleep(200); br.cleanup(); srv.proc.kill(); process.exit(0); }
