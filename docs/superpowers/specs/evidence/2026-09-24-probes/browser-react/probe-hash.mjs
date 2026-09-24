// Does setBreakpointByUrl({scriptHash}) arm a re-parsed identical script before it runs (reload), with no pause?
import { launch, sleep } from "./cdp.mjs";
import { HELPER, condition } from "./helper.mjs";
const ORIGIN = process.env.ORIGIN, MATCH = process.env.MATCH, LINE0 = Number(process.env.LINE0), COL0 = Number(process.env.COL0 ?? 0);
const br = launch({ pipe: true }); const cdp = br.cdp; process.on("exit", () => br.cleanup());
const scripts = []; const hits = []; let pauses = 0; let S;
cdp.on((m) => {
  if (m.method === "Debugger.scriptParsed" && m.params.url.includes(MATCH)) scripts.push(m.params);
  if (m.method === "Debugger.paused") { pauses++; S.send("Debugger.resume"); }
  if (m.method === "Runtime.consoleAPICalled" && m.params.context?.startsWith("kosmo-tui#")) hits.push(m.params.args[1].value);
});
try {
  const { targetInfos } = await cdp.send("Target.getTargets");
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: targetInfos.find((t) => t.type === "page").targetId, flatten: true });
  S = cdp.session(sessionId);
  await S.send("Page.enable"); await S.send("Page.addScriptToEvaluateOnNewDocument", { source: HELPER, runImmediately: true });
  await S.send("Runtime.enable"); await S.send("Debugger.enable");
  await S.send("Page.navigate", { url: ORIGIN + "/" }); await sleep(4000);
  const first = scripts.at(-1);
  console.log("first:", first.url.slice(0, 90), "hash", first.hash.slice(0, 12), "hasSourceURL", first.hasSourceURL);
  const r = await S.send("Debugger.setBreakpointByUrl", { scriptHash: first.hash, lineNumber: LINE0, columnNumber: COL0, condition: condition(7, ["label"]) });
  console.log("byHash locations now:", r.locations.length);
  const n = scripts.length; hits.length = 0;
  await S.send("Page.reload", {}); await sleep(4000);
  const again = scripts.slice(n);
  console.log("after reload: reparsed", again.length, "same hash:", again.map((s) => s.hash === first.hash), "mount hits via hash bp:", hits.filter((h) => h === 7).length, "pauses:", pauses);
  await cdp.send("Browser.close").catch(() => {});
} catch (e) { console.log("ERROR", e.message); } finally { await sleep(200); br.cleanup(); process.exit(0); }
