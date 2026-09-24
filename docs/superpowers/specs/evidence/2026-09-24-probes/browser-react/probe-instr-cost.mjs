// Cost of Debugger.setInstrumentationBreakpoint(beforeScriptWithSourceMapExecution) on page load.
import { launch, sleep } from "./cdp.mjs";
const ORIGIN = process.env.ORIGIN;
const br = launch({ pipe: true }); const cdp = br.cdp;
process.on("exit", () => br.cleanup());
let pauses = 0, loadAt = 0, S;
cdp.on((m) => {
  if (m.method === "Debugger.paused") { pauses++; S.send("Debugger.resume"); }
  if (m.method === "Page.loadEventFired") loadAt = Date.now();
});
try {
  const { targetInfos } = await cdp.send("Target.getTargets");
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: targetInfos.find((t) => t.type === "page").targetId, flatten: true });
  S = cdp.session(sessionId);
  await S.send("Page.enable"); await S.send("Runtime.enable"); await S.send("Debugger.enable");
  await S.send("Page.navigate", { url: ORIGIN + "/" }); await sleep(3000); // warm dev-server compile cache
  const res = {};
  for (const mode of ["off", "on", "off", "on", "off", "on"]) {
    if (mode === "on") await S.send("Debugger.setInstrumentationBreakpoint", { instrumentation: "beforeScriptWithSourceMapExecution" }).then((r) => (S.bpId = r.breakpointId));
    else if (S.bpId) { await S.send("Debugger.removeBreakpoint", { breakpointId: S.bpId }); S.bpId = null; }
    pauses = 0; loadAt = 0; const t0 = Date.now();
    await S.send("Page.reload", { ignoreCache: false });
    while (!loadAt && Date.now() - t0 < 20000) await sleep(10);
    (res[mode] ??= []).push(`${loadAt - t0}ms/${pauses}p`);
    await sleep(500);
  }
  console.log(ORIGIN, "load time/pauses:", res);
  await cdp.send("Browser.close").catch(() => {});
} finally { await sleep(200); br.cleanup(); process.exit(0); }
