import { launch, sleep } from "./cdp.mjs";
const ORIGIN = process.argv[2];
const br = launch({ pipe: true }); const cdp = br.cdp; process.on("exit", () => br.cleanup());
const scripts = []; let S;
cdp.on((m) => { if (m.method === "Debugger.scriptParsed" && m.sessionId === S?.id) scripts.push(m.params); });
try {
  const { targetInfos } = await cdp.send("Target.getTargets");
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: targetInfos.find((t) => t.type === "page").targetId, flatten: true });
  S = cdp.session(sessionId);
  await S.send("Page.enable"); await S.send("Runtime.enable"); await S.send("Debugger.enable");
  await S.send("Page.navigate", { url: ORIGIN + "/" }); await sleep(3000);
  for (const s of scripts.filter((x) => x.url.startsWith("about://React"))) {
    const src = (await S.send("Debugger.getScriptSource", { scriptId: s.scriptId })).scriptSource;
    let info = "no map";
    if (s.sourceMapURL) {
      try {
        const u = new URL(s.sourceMapURL, ORIGIN);
        const map = s.sourceMapURL.startsWith("data:") ? JSON.parse(Buffer.from(s.sourceMapURL.split(",")[1], "base64").toString()) : await (await fetch(u)).json();
        const srcs = map.sections ? map.sections.flatMap((x) => x.map.sources ?? []) : map.sources;
        info = `map ${s.sourceMapURL.startsWith("data:") ? "inline" : u.pathname + u.search.slice(0, 60)} sources: ${JSON.stringify(srcs.slice(0, 3)).replace(/\/private\/tmp\/claude-501\/[^/]+\/[^/]+\/scratchpad/g, "<SP>")}`;
      } catch (e) { info = "map fetch failed " + e.message + " url " + s.sourceMapURL.slice(0, 120); }
    }
    console.log(s.url.replace(/\/private\/tmp\/claude-501\/[^/]+\/[^/]+\/scratchpad/g, "<SP>"), "|", info, "| src head:", JSON.stringify(src.slice(0, 160)));
  }
  await cdp.send("Browser.close").catch(() => {});
} catch (e) { console.log("ERROR", e.stack); } finally { await sleep(200); br.cleanup(); process.exit(0); }
