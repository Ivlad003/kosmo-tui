// Probe 2: Vite 7 + @vitejs/plugin-react 5 + React 19.2 StrictMode in headless Chrome (pipe transport).
// Resolves ORIGINAL lines through inline maps, sets non-pausing tracepoints by scriptId,
// uses beforeScriptWithSourceMapExecution to arm breakpoints before module code runs.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { launch, sleep, SCRATCH } from "./cdp.mjs";
import { HELPER, condition } from "./helper.mjs";

const require = createRequire(import.meta.url);
const { SourceMapConsumer } = require("/Users/kosmodev/Documents/pet_project/kosmo-callflow/node_modules/source-map-js");
const ORIGIN = process.env.ORIGIN ?? "http://127.0.0.1:5199";
const APP_FILE = `${SCRATCH}/${process.env.APP_DIR ?? "vite-app"}/src/App.jsx`;
const log = (...a) => console.log(...a);

// logical tracepoints on ORIGINAL (1-based) lines
const logical = [
  { id: 1, file: "src/App.jsx", line: 7, names: ["label", "user", "onPick", "children", "count"], what: "Counter body" },
  { id: 2, file: "src/App.jsx", line: 9, names: ["label"], what: "useEffect callback" },
  { id: 3, file: "src/App.jsx", line: 13, names: ["event", "label"], what: "handleClick" },
  { id: 4, file: "src/App.jsx", line: 25, names: ["picked"], what: "App body" },
  { id: 5, file: "src/Lazy.jsx", line: 2, names: ["label"], what: "LazyPanel (Suspense/lazy)" },
];

const br = launch({ pipe: true });
const cdp = br.cdp;
const timer = setTimeout(() => { log("TIMEOUT"); br.cleanup(); process.exit(2); }, 90000);
const original = readFileSync(APP_FILE, "utf8");
const restore = () => writeFileSync(APP_FILE, original);
process.on("exit", () => { restore(); br.cleanup(); });

const scripts = new Map(); // scriptId -> info
const hits = []; let pauses = { instrumentation: 0, other: 0 };
const armed = []; // {tp, scriptId, breakpointId, line}
let S;

function decodeDataMap(url) {
  const m = /^data:application\/json;(?:charset=utf-8;)?base64,(.*)$/.exec(url);
  return m ? JSON.parse(Buffer.from(m[1], "base64").toString("utf8")) : null;
}
async function mapFor(info) {
  if (info.map !== undefined) return info.map;
  if (!info.sourceMapURL) return (info.map = null);
  if (info.sourceMapURL.startsWith("data:")) return (info.map = decodeDataMap(info.sourceMapURL));
  const u = new URL(info.sourceMapURL, info.url); // separate map: only same loopback origin
  if (u.origin !== new URL(info.url).origin || !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(u.origin)) return (info.map = null);
  const r = await fetch(u, { redirect: "error", signal: AbortSignal.timeout(2000) });
  return (info.map = r.ok ? await r.json() : null);
}
function matchSource(map, file, info) {
  // Source Map v3: sources resolve against the map URL; for data: maps, against the script URL.
  const base = info.sourceMapURL && !info.sourceMapURL.startsWith("data:") ? new URL(info.sourceMapURL, info.url) : new URL(info.url);
  const root = map.sourceRoot ?? "";
  return map.sources.find((s) => { const abs = new URL(root + s, base); return decodeURIComponent(abs.pathname).endsWith("/" + file); });
}

async function arm(info) {
  if (info.armed) return; info.armed = true;
  if (!info.url.startsWith(ORIGIN) || info.url.includes("/node_modules/")) return;
  const map = await mapFor(info);
  if (!map) return;
  for (const tp of logical) {
    const src = matchSource(map, tp.file, info);
    if (!src) continue;
    const c = new SourceMapConsumer(map);
    const gens = c.allGeneratedPositionsFor({ source: src, line: tp.line, column: 0 });
    if (!gens.length) { log(`tp${tp.id} no generated position in ${info.url}`); continue; }
    const g = gens[0];
    const r = await S.send("Debugger.setBreakpoint", { location: { scriptId: info.scriptId, lineNumber: g.line - 1, columnNumber: g.column }, condition: condition(tp.id, tp.names) }).catch((e) => ({ error: e.message }));
    if (r.error) { log(`tp${tp.id} setBreakpoint error`, r.error); continue; }
    const back = c.originalPositionFor({ line: r.actualLocation.lineNumber + 1, column: r.actualLocation.columnNumber });
    armed.push({ tp: tp.id, scriptId: info.scriptId, url: info.url, breakpointId: r.breakpointId });
    log(`armed tp${tp.id} (${tp.what}) ${info.url.replace(ORIGIN, "")} gen ${r.actualLocation.lineNumber + 1}:${r.actualLocation.columnNumber + 1} -> orig ${back.line}:${back.column + 1}`);
  }
}

cdp.on(async (m) => {
  if (m.method === "Debugger.scriptParsed") {
    const p = m.params;
    const info = { scriptId: p.scriptId, url: p.url, sourceMapURL: p.sourceMapURL, hasSourceURL: p.hasSourceURL, isModule: p.isModule, hash: p.hash, length: p.length };
    scripts.set(p.scriptId, info);
    if (process.env.NO_INSTR) arm(info).catch((e) => log("arm error", e.message));
  } else if (m.method === "Debugger.paused") {
    if (m.params.reason === "instrumentation") {
      pauses.instrumentation++;
      // A module graph evaluates under ONE pause: arm every script parsed so far, not just data.scriptId.
      const paused = scripts.get(m.params.data?.scriptId);
      if (pauses.instrumentation <= 8) log(`instrumentation pause for ${paused?.url.replace(ORIGIN, "")}; unarmed parsed scripts: ${[...scripts.values()].filter((s) => !s.armed && s.sourceMapURL).length}`);
      for (const info of scripts.values()) await arm(info);
    } else pauses.other++;
    S.send("Debugger.resume");
  } else if (m.method === "Runtime.consoleAPICalled" && m.params.context?.startsWith("kosmo-tui#")) {
    hits.push({ t: Date.now(), tp: m.params.args[1].value, data: JSON.parse(m.params.args[2].value), stack: m.params.stackTrace });
  } else if (m.method === "Runtime.exceptionThrown") log("exceptionThrown", m.params.exceptionDetails.text, m.params.exceptionDetails.exception?.description?.split("\n")[0]);
});

try {
  const { targetInfos } = await cdp.send("Target.getTargets");
  const page = targetInfos.find((t) => t.type === "page");
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  S = cdp.session(sessionId);
  await S.send("Page.enable");
  await S.send("Page.addScriptToEvaluateOnNewDocument", { source: HELPER, runImmediately: true });
  await S.send("Runtime.enable");
  await S.send("Debugger.enable");
  await S.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
  await S.send("Debugger.setBlackboxPatterns", { patterns: ["/node_modules/", "/@vite/client", "/@react-refresh"] });
  if (!process.env.NO_INSTR) await S.send("Debugger.setInstrumentationBreakpoint", { instrumentation: "beforeScriptWithSourceMapExecution" });
  const t0 = Date.now();
  await S.send("Page.navigate", { url: ORIGIN + "/" });
  await sleep(2500);
  log(`load: ${Date.now() - t0} ms incl. wait; instrumentation pauses ${pauses.instrumentation}, other pauses ${pauses.other}`);

  // Script inventory
  for (const info of scripts.values()) {
    if (!/^https?:/.test(info.url)) continue;
    const map = await mapFor(info).catch(() => null);
    const kind = !info.sourceMapURL ? "none" : info.sourceMapURL.startsWith("data:") ? `inline(${info.sourceMapURL.length} B)` : `separate(${info.sourceMapURL})`;
    log("script", info.url.replace(ORIGIN, ""), { isModule: info.isModule, hasSourceURL: info.hasSourceURL, map: kind, file: map?.file, sourceRoot: map?.sourceRoot, sources: map?.sources?.slice(0, 2), sections: Boolean(map?.sections), sourcesContent: map?.sourcesContent ? map.sourcesContent.length : 0 });
  }
  const appInfo = [...scripts.values()].find((s) => s.url.startsWith(ORIGIN + "/src/App.jsx"));
  const appMap = await mapFor(appInfo);
  log("App.jsx sourcesContent equals disk:", appMap.sourcesContent?.[0] === original);

  const count = (from) => { const c = {}; for (const h of hits.slice(from)) c["tp" + h.tp] = (c["tp" + h.tp] ?? 0) + 1; return c; };
  log("MOUNT hits (StrictMode):", count(0));
  for (const h of hits.filter((h) => h.tp === 1 || h.tp === 2)) log(`  mount tp${h.tp} frames:`, h.stack.callFrames.slice(2, 9).map((f) => f.functionName || "(anon)").join(" < "), "| async:", h.stack.parent?.description);
  const mountRender = hits.find((h) => h.tp === 1);
  if (mountRender) log("Counter props capture:", JSON.stringify(mountRender.data));

  // Click -> handler + re-render
  const beforeClick = hits.length;
  await S.send("Runtime.evaluate", { expression: "document.getElementById('inc').click()" });
  await sleep(400);
  log("CLICK hits:", count(beforeClick));
  const handler = hits.slice(beforeClick).find((h) => h.tp === 3);
  if (handler) log("handleClick capture:", JSON.stringify(handler.data).slice(0, 400));
  const rerender = hits.slice(beforeClick).find((h) => h.tp === 1);
  const fr = (st) => st.callFrames.slice(0, 6).map((f) => `${f.functionName || "(anon)"} ${f.url.replace(ORIGIN, "").replace(/\?.*/, "")}:${f.lineNumber + 1}`);
  if (rerender) {
    let st = rerender.stack, d = 0;
    log("re-render sync frames (top 6):", fr(st), "total", st.callFrames.length);
    while (st.parent && d++ < 5) { st = st.parent; log(`  async parent [${st.description}]`, fr(st)); }
  }
  if (handler) {
    log("handler sync frames (top 6):", fr(handler.stack), "total", handler.stack.callFrames.length, "async parent:", handler.stack.parent?.description ?? "(none)");
  }

  // Burst: 20 clicks -> hit rate
  const beforeBurst = hits.length; const tb = Date.now();
  await S.send("Runtime.evaluate", { expression: "for (let i = 0; i < 20; i++) document.getElementById('inc').click()" });
  await sleep(300);
  log(`BURST 20 clicks in ${Date.now() - tb} ms:`, count(beforeBurst));

  // HMR: edit App.jsx -> new module ?t=, React Fast Refresh re-render
  const beforeHmr = hits.length; const nScripts = scripts.size;
  writeFileSync(APP_FILE, original.replace('<p id="picked">', '<p id="picked" data-x="1">'));
  await sleep(1500);
  const newScripts = [...scripts.values()].slice(nScripts).filter((s) => /^https?:/.test(s.url));
  log("HMR new scripts:", newScripts.map((s) => `${s.url.replace(ORIGIN, "")} map=${s.sourceMapURL ? "inline" : "none"}`));
  log("HMR instrumentation pauses total:", pauses.instrumentation, "armed total:", armed.length);
  const hmrHits = hits.slice(beforeHmr);
  log("HMR hits:", count(beforeHmr), "from scripts:", [...new Set(hmrHits.map((h) => h.stack.callFrames.find((f) => f.url.includes("/src/App.jsx"))?.url.replace(ORIGIN, "") ?? "?"))]);
  // old-script breakpoints still hit?
  const beforeClick2 = hits.length;
  await S.send("Runtime.evaluate", { expression: "document.getElementById('inc').click()" });
  await sleep(400);
  const after = hits.slice(beforeClick2);
  log("click after HMR:", count(beforeClick2), "script urls:", [...new Set(after.map((h) => h.stack.callFrames.find((f) => f.url.includes("/src/App.jsx"))?.url.replace(ORIGIN, "") ?? "?"))]);
  restore();
  await sleep(800);

  // Page console exposure: nothing from our helper in page-visible console hooks
  log("helper counts (page side):", (await S.send("Runtime.evaluate", { expression: "JSON.stringify([...globalThis[Symbol.for('kosmo-tui')].counts])", returnByValue: true })).result.value);
  log("total pauses: instrumentation", pauses.instrumentation, "other", pauses.other);
  await cdp.send("Browser.close").catch(() => {});
} catch (e) { log("ERROR", e.stack); }
finally { clearTimeout(timer); restore(); await sleep(300); br.cleanup(); log("chrome exit", br.child.exitCode, br.child.signalCode); process.exit(0); }
