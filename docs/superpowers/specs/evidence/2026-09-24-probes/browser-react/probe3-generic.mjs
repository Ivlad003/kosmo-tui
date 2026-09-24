// Probe 3: generic dev-server page probe. Inventory of scripts/maps + tracepoints on ORIGINAL lines.
// usage: ORIGIN=http://127.0.0.1:5197 TPS='[{"id":1,"file":"app/routes/home.tsx","line":15,"names":["loaderData","n"]}]' node probe3-generic.mjs
import { createRequire } from "node:module";
import { launch, sleep } from "./cdp.mjs";
import { HELPER, condition } from "./helper.mjs";

const require = createRequire(import.meta.url);
const { SourceMapConsumer } = require("/Users/kosmodev/Documents/pet_project/kosmo-callflow/node_modules/source-map-js");
const ORIGIN = process.env.ORIGIN;
const PATHNAME = process.env.PAGE ?? "/";
const logical = JSON.parse(process.env.TPS ?? "[]");
const CLICK = process.env.CLICK ?? "#inc";
const log = (...a) => console.log(...a);
const short = (u) => u.replace(ORIGIN, "").replace(/\/@fs\/.*\/node_modules\//, "/@fs/…/node_modules/").slice(0, 140);

const br = launch({ pipe: true });
const cdp = br.cdp;
const timer = setTimeout(() => { log("TIMEOUT"); br.cleanup(); process.exit(2); }, Number(process.env.TIMEOUT ?? 120000));
process.on("exit", () => br.cleanup());
const scripts = new Map(); const hits = []; const pauses = { instrumentation: 0, other: 0 }; let S; const sessions = [];

function decodeDataMap(url) { const m = /^data:application\/json;(?:charset=utf-8;)?base64,(.*)$/.exec(url); return m ? JSON.parse(Buffer.from(m[1], "base64").toString("utf8")) : null; }
async function mapFor(info) {
  if (info.map !== undefined) return info.map;
  if (!info.sourceMapURL) return (info.map = null);
  if (info.sourceMapURL.startsWith("data:")) return (info.map = decodeDataMap(info.sourceMapURL));
  const u = new URL(info.sourceMapURL, info.url);
  if (!/^http:$/.test(u.protocol) || u.origin !== new URL(info.url).origin) return (info.map = { error: "cross-origin " + u.origin });
  const t0 = Date.now();
  const r = await fetch(u, { redirect: "error", signal: AbortSignal.timeout(5000) }).catch((e) => ({ ok: false, status: e.message }));
  if (!r.ok) return (info.map = { error: "fetch " + r.status });
  const text = await r.text();
  info.mapBytes = text.length; info.mapMs = Date.now() - t0;
  return (info.map = JSON.parse(text));
}
function flatSources(map) { return map.sections ? map.sections.flatMap((s) => s.map.sources ?? []) : map.sources ?? []; }
function matchSource(map, file, info) {
  const base = info.sourceMapURL && !info.sourceMapURL.startsWith("data:") ? new URL(info.sourceMapURL, info.url) : new URL(info.url);
  const root = map.sourceRoot ?? "";
  return (map.sources ?? []).find((s) => {
    let p;
    try { p = decodeURIComponent(new URL(root + s, base).pathname); } catch { p = s; }
    // webpack:// / turbopack:// / file:// style sources
    const norm = s.replace(/^webpack:\/\/[^/]*\//, "/").replace(/^turbopack:\/\/\/?(\[project\]\/)?/, "/").replace(/^file:\/\//, "").replace(/\?.*$/, "");
    return p.endsWith("/" + file) || norm.endsWith("/" + file);
  });
}
async function arm(info) {
  if (info.armed) return; info.armed = true;
  if (!/^https?:/.test(info.url) && !/^webpack-internal:/.test(info.url)) return;
  if (/\/node_modules\/|\/_next\/static\/chunks\/(framework|main|webpack|polyfills)/.test(info.url)) return;
  const map = await mapFor(info);
  if (!map || map.error) return;
  const maps = map.sections ? map.sections.map((s) => ({ map: s.map, off: s.offset })) : [{ map, off: { line: 0, column: 0 } }];
  for (const tp of logical) {
    for (const { map: m, off } of maps) {
      const src = matchSource(m, tp.file, info);
      if (!src) continue;
      const c = new SourceMapConsumer(m);
      const gens = c.allGeneratedPositionsFor({ source: src, line: tp.line, column: 0 });
      if (!gens.length) { log(`tp${tp.id} no generated position (${src})`); continue; }
      const g = gens[0];
      const line0 = g.line - 1 + off.line, col0 = g.line === 1 ? g.column + off.column : g.column;
      const r = await info.session.send("Debugger.setBreakpoint", { location: { scriptId: info.scriptId, lineNumber: line0, columnNumber: col0 }, condition: condition(tp.id, tp.names) }).catch((e) => ({ error: e.message }));
      if (r.error) { log(`tp${tp.id} setBreakpoint error`, r.error); continue; }
      const back = c.originalPositionFor({ line: r.actualLocation.lineNumber - off.line + 1, column: r.actualLocation.columnNumber });
      log(`armed tp${tp.id} in ${short(info.url)} src=${src.slice(0, 90)} gen ${r.actualLocation.lineNumber + 1}:${r.actualLocation.columnNumber + 1} -> orig ${back.line}:${back.column + 1}${map.sections ? " [index map]" : ""}`);
    }
  }
}

cdp.on(async (m) => {
  const sess = sessions.find((s) => s.id === m.sessionId);
  if (m.method === "Debugger.scriptParsed") {
    const p = m.params;
    scripts.set(m.sessionId + ":" + p.scriptId, { scriptId: p.scriptId, url: p.url, sourceMapURL: p.sourceMapURL, hasSourceURL: p.hasSourceURL, isModule: p.isModule, length: p.length, session: sess });
  } else if (m.method === "Debugger.paused") {
    if (m.params.reason === "instrumentation") { pauses.instrumentation++; for (const info of scripts.values()) if (info.session === sess) await arm(info); }
    else pauses.other++;
    sess.send("Debugger.resume");
  } else if (m.method === "Runtime.consoleAPICalled" && m.params.context?.startsWith("kosmo-tui#")) {
    hits.push({ tp: m.params.args[1].value, data: JSON.parse(m.params.args[2].value), stack: m.params.stackTrace });
  } else if (m.method === "Runtime.exceptionThrown") log("exceptionThrown", m.params.exceptionDetails.text, m.params.exceptionDetails.exception?.description?.split("\n")[0]);
});

try {
  const { targetInfos } = await cdp.send("Target.getTargets");
  const page = targetInfos.find((t) => t.type === "page");
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  S = cdp.session(sessionId); sessions.push(S);
  await S.send("Page.enable");
  await S.send("Page.addScriptToEvaluateOnNewDocument", { source: HELPER, runImmediately: true });
  await S.send("Runtime.enable");
  await S.send("Debugger.enable");
  await S.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
  await S.send("Debugger.setInstrumentationBreakpoint", { instrumentation: "beforeScriptWithSourceMapExecution" });
  const t0 = Date.now();
  await S.send("Page.navigate", { url: ORIGIN + PATHNAME });
  await sleep(Number(process.env.WAIT ?? 4000));
  // arm scripts parsed without an instrumentation pause (e.g. eval'd modules, no-map scripts)
  for (const info of scripts.values()) await arm(info);
  log(`loaded; instrumentation pauses ${pauses.instrumentation}, other pauses ${pauses.other}`);
  const rows = [];
  for (const info of scripts.values()) {
    if (!/^(https?|webpack-internal):/.test(info.url)) continue;
    const map = await mapFor(info).catch((e) => ({ error: e.message }));
    const kind = !info.sourceMapURL ? "none" : info.sourceMapURL.startsWith("data:") ? `inline ${Math.round(info.sourceMapURL.length / 1024)}KiB` : `separate ${info.sourceMapURL.slice(0, 60)}${info.mapBytes ? ` (${Math.round(info.mapBytes / 1024)}KiB, ${info.mapMs}ms)` : ""}`;
    rows.push(`${short(info.url)} | module=${info.isModule} sourceURL=${info.hasSourceURL} | map=${kind}${map?.error ? " ERR " + map.error : ""}${map?.sections ? ` | index map ${map.sections.length} sections` : ""} | sources[0..1]=${JSON.stringify(map && !map.error ? flatSources(map).slice(0, 2) : [])}`);
  }
  const limit = Number(process.env.ROWS ?? 40);
  log(`scripts (${rows.length}):\n  ` + rows.slice(0, limit).join("\n  "));
  const count = (from) => { const c = {}; for (const h of hits.slice(from)) c["tp" + h.tp] = (c["tp" + h.tp] ?? 0) + 1; return c; };
  log("LOAD hits:", count(0));
  for (const tp of logical) { const h = hits.find((x) => x.tp === tp.id); if (h) log(`  tp${tp.id} sample`, JSON.stringify(h.data).slice(0, 300), "| top frame", h.stack.callFrames[2]?.functionName, short(h.stack.callFrames[2]?.url ?? ""), "| async", h.stack.parent?.description ?? "-"); }
  const b = hits.length;
  const clicked = await S.send("Runtime.evaluate", { expression: `(() => { const el = document.querySelector(${JSON.stringify(CLICK)}); if (!el) return "no element"; el.click(); return "clicked"; })()`, returnByValue: true });
  await sleep(600);
  log("CLICK", clicked.result.value, "hits:", count(b));
  if (process.env.HMR_FILE) {
    const fs = await import("node:fs");
    const orig = fs.readFileSync(process.env.HMR_FILE, "utf8");
    const n0 = scripts.size, p0 = pauses.instrumentation, h0 = hits.length;
    fs.writeFileSync(process.env.HMR_FILE, orig.replace("{text}", "{text}!"));
    await sleep(Number(process.env.HMR_WAIT ?? 4000));
    for (const info of scripts.values()) await arm(info);
    const fresh = [...scripts.values()].slice(n0).filter((s) => /^(https?|webpack-internal):/.test(s.url));
    log(`HMR: ${fresh.length} new scripts, +${pauses.instrumentation - p0} instrumentation pauses`);
    for (const f of fresh.slice(0, 8)) log("  new", short(f.url), "sourceURL=" + f.hasSourceURL, "map=" + (f.sourceMapURL ? (f.sourceMapURL.startsWith("data:") ? "inline" : f.sourceMapURL.slice(0, 50)) : "none"));
    const same = fresh.filter((f) => [...scripts.values()].slice(0, n0).some((o) => o.url === f.url));
    log("  new scripts reusing an existing URL:", same.map((f) => short(f.url)));
    log("  hits during HMR:", count(h0));
    const h1 = hits.length;
    await S.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(CLICK)})?.click()` });
    await sleep(600);
    const after = hits.slice(h1);
    log("  click after HMR:", count(h1), "hit script urls:", [...new Set(after.map((h) => short(h.stack.callFrames[2]?.url ?? "?")))], "text now:", (await S.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(CLICK)})?.textContent`, returnByValue: true })).result.value);
    fs.writeFileSync(process.env.HMR_FILE, orig);
    await sleep(1500);
  }
  log("pauses: instrumentation", pauses.instrumentation, "other", pauses.other);
  await cdp.send("Browser.close").catch(() => {});
} catch (e) { log("ERROR", e.stack); }
finally { clearTimeout(timer); await sleep(300); br.cleanup(); log("chrome exit", br.child.exitCode, br.child.signalCode); process.exit(0); }
