// Next.js dev: script/map inventory for Counter.jsx and instrumentation-pause cost with/without blackboxing.
import { launch, sleep } from "./cdp.mjs";
const ORIGIN = process.argv[2];
const BB = ["/node_modules/", "^webpack-internal:///.*/node_modules/", "/_next/static/chunks/.*next_dist", "/@vite/client", "/@react-refresh"];
const br = launch({ pipe: true }); const cdp = br.cdp;
process.on("exit", () => br.cleanup());
const scripts = []; let pauses = [], loadAt = 0, S;
cdp.on((m) => {
  if (m.method === "Debugger.scriptParsed" && m.sessionId === S?.id) scripts.push(m.params);
  if (m.method === "Debugger.paused") { pauses.push(m.params.data?.url ?? ""); cdp.send("Debugger.resume", {}, m.sessionId).catch(() => {}); }
  if (m.method === "Page.loadEventFired") loadAt = Date.now();
});
try {
  const { targetInfos } = await cdp.send("Target.getTargets");
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: targetInfos.find((t) => t.type === "page").targetId, flatten: true });
  S = cdp.session(sessionId);
  await S.send("Page.enable"); await S.send("Runtime.enable"); await S.send("Debugger.enable");
  await S.send("Page.navigate", { url: ORIGIN + "/" }); await sleep(4000);
  const counter = scripts.filter((s) => /Counter\.jsx/.test(s.url) || (s.sourceMapURL && !s.sourceMapURL.startsWith("data:") && /chunks\/[^/]*\._\.js/.test(s.url)));
  console.log(ORIGIN, "scripts:", scripts.length, "with map:", scripts.filter((s) => s.sourceMapURL).length, "| max sourceMapURL length in scriptParsed:", Math.max(...scripts.map((s) => s.sourceMapURL?.length ?? 0)));
  for (const s of scripts) {
    const inline = s.sourceMapURL?.startsWith("data:");
    let map;
    if (inline) { try { map = JSON.parse(Buffer.from(s.sourceMapURL.split(",")[1], "base64").toString()); } catch { continue; } }
    else if (s.sourceMapURL) { const u = new URL(s.sourceMapURL, s.url); if (!/_\.js\.map$/.test(u.pathname) && !u.pathname.includes("app")) continue; try { map = await (await fetch(u)).json(); } catch { continue; } }
    else continue;
    const srcs = map.sections ? map.sections.flatMap((x) => x.map.sources ?? []) : map.sources;
    const hit = srcs.find((x) => /Counter\.jsx/.test(x));
    if (!hit) continue;
    console.log(`  Counter in ${s.url.replace(ORIGIN, "")} | hasSourceURL=${s.hasSourceURL} | map=${inline ? "inline" : "separate"} | sections=${map.sections ? map.sections.length : 0} | source=${hit.replace(/\/private\/tmp\/claude-501\/[^/]+\/[^/]+\/scratchpad/, "<SP>")}`);
  }
  const res = {};
  for (const mode of ["off", "on", "on+blackbox", "off", "on", "on+blackbox"]) {
    await S.send("Debugger.setBlackboxPatterns", { patterns: mode === "on+blackbox" ? BB : [] });
    if (mode !== "off") S.bp ??= (await S.send("Debugger.setInstrumentationBreakpoint", { instrumentation: "beforeScriptWithSourceMapExecution" })).breakpointId;
    else if (S.bp) { await S.send("Debugger.removeBreakpoint", { breakpointId: S.bp }); S.bp = null; }
    pauses = []; loadAt = 0; const t0 = Date.now();
    await S.send("Page.reload", {});
    while (!loadAt && Date.now() - t0 < 20000) await sleep(10);
    await sleep(800);
    (res[mode] ??= []).push(`${loadAt - t0}ms/${pauses.length}p`);
    if (mode === "on+blackbox") res.bbUrls = [...new Set(pauses.map((u) => u.replace(ORIGIN, "")))].slice(0, 8);
  }
  console.log(ORIGIN, res);
  await cdp.send("Browser.close").catch(() => {});
} catch (e) { console.log("ERROR", e.stack); } finally { await sleep(200); br.cleanup(); process.exit(0); }
