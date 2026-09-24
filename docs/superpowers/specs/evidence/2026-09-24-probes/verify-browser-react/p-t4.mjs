// T4: is setSkipAllPauses lost on cross-process navigation? T5: excluded worker really waiting-for-debugger?
import { launch, startServer, sleep } from "./cdp.mjs";
const log = (...a) => console.log(...a);
const srv = await startServer();
const A = `http://127.0.0.1:${srv.port}/`, B = `http://localhost:${srv.port}/`;
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
await withBrowser(async ({ cdp, S }) => {
  const paused = [];
  cdp.on((m) => { if (m.method === "Debugger.paused") { paused.push(m.params.reason + ":" + (m.params.data?.url ?? "").replace(/^http:\/\/[^/]+/, "")); cdp.send("Debugger.resume", {}, m.sessionId).catch(() => {}); } });
  await S.send("Page.enable"); await S.send("Runtime.enable"); await S.send("Debugger.enable");
  await S.send("Page.navigate", { url: A }); await sleep(1200);
  await S.send("Debugger.setSkipAllPauses", { skip: true });
  const dbg = async (tag) => { S.send("Runtime.evaluate", { expression: "debugger; 1" }).catch(() => {}); await sleep(300); log(`[T4 ${tag}] debugger-statement pauses:`, paused.splice(0)); };
  await dbg("skip set after navigate, same doc");
  await S.send("Debugger.setInstrumentationBreakpoint", { instrumentation: "beforeScriptWithSourceMapExecution" });
  await S.send("Page.reload", {}); await sleep(1500);
  log("[T4 same-site reload] instrumentation pauses:", paused.splice(0));
  await dbg("after same-site reload");
  await S.send("Page.navigate", { url: B }); await sleep(1500);
  log("[T4 cross-site navigate 127.0.0.1 -> localhost] instrumentation pauses:", paused.splice(0));
  await dbg("after cross-site navigate");
  await S.send("Debugger.setSkipAllPauses", { skip: true });
  await dbg("after re-sending setSkipAllPauses(true)");
  await S.send("Page.reload", {}); await sleep(1500);
  log("[T4 reload after re-send] instrumentation pauses:", paused.splice(0));
});
await withBrowser(async ({ cdp, S, val }) => {
  await S.send("Page.enable"); await S.send("Runtime.enable");
  await S.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "iframe" }, { type: "worker", exclude: true }] });
  await S.send("Page.navigate", { url: A }); await sleep(2000);
  const { targetInfos } = await cdp.send("Target.getTargets");
  const w = targetInfos.find((t) => t.type === "worker");
  log("[T5] __wmsgs:", await val("window.__wmsgs"), "| worker target listed:", !!w, w && { attached: w.attached, url: w.url.replace(/:\d+\//, ":P/") });
  if (w) {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: w.targetId, flatten: true });
    await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
    await sleep(600);
    log("[T5] after manual attach + runIfWaitingForDebugger __wmsgs:", await val("window.__wmsgs"));
  }
});
srv.proc.kill(); process.exit(0);
