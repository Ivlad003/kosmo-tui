// Throwaway probe for stage 3: Next.js client code in headless Chrome over CDP.
// Usage: node probe-browser.mjs <appDir> <webpack|turbopack> <httpPort> <chromePort> <outJson>
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { sleep, waitFor, getJson, connect, specMatches, specNormalize } from "./cdp.mjs";
import { AnyMap, eachMapping, originalPositionFor } from
  "/Users/kosmodev/Documents/pet_project/kosmo-callflow/node_modules/@jridgewell/trace-mapping/dist/trace-mapping.mjs";

const [, , appDirArg, bundler, httpPortArg, chromePortArg, outJson] = process.argv;
const appDir = path.resolve(appDirArg);
const httpPort = Number(httpPortArg);
const chromePort = Number(chromePortArg);
const major = Number(JSON.parse(readFileSync(path.join(appDir, "node_modules/next/package.json"), "utf8")).version.split(".")[0]);
const R = { bundler, major };
const log = (...a) => console.error("[browser-probe]", ...a);

const args = [path.join(appDir, "node_modules/next/dist/bin/next"), "dev", "-p", String(httpPort)];
if (bundler === "turbopack" && major < 16) args.push("--turbopack");
if (bundler === "webpack" && major >= 16) args.push("--webpack");
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", FORCE_COLOR: "0" };
delete env.NODE_OPTIONS;
const next = spawn(process.execPath, args, { cwd: appDir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
next.stdout.on("data", (d) => (out += d));
next.stderr.on("data", (d) => (out += d));
const prof = path.join(path.dirname(new URL(import.meta.url).pathname), "chrome-prof-" + chromePort);
rmSync(prof, { recursive: true, force: true });
mkdirSync(prof, { recursive: true });
let chrome;
const killAll = () => {
  try { process.kill(-next.pid, "SIGKILL"); } catch {}
  try { process.kill(-chrome.pid, "SIGKILL"); } catch {}
};
process.on("exit", killAll);
const finish = () => { R.devTail = out.split("\n").filter(Boolean).slice(-12); writeFileSync(outJson, JSON.stringify(R, null, 2)); killAll(); process.exit(0); };
process.on("uncaughtException", (e) => { R.fatal = String(e.stack); finish(); });

await waitFor(() => /Ready in/.test(out), 60000);
chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", `--remote-debugging-port=${chromePort}`, `--user-data-dir=${prof}`, "--no-first-run",
  "--no-default-browser-check", "--disable-extensions", "about:blank",
], { detached: true, stdio: "ignore" });
await waitFor(async () => !!(await getJson(`http://127.0.0.1:${chromePort}/json/version`, 300)).Browser, 15000, 200);
const version = await getJson(`http://127.0.0.1:${chromePort}/json/version`);
const list = await getJson(`http://127.0.0.1:${chromePort}/json/list`);
R.discovery = { Browser: version.Browser, protocol: version["Protocol-Version"], hasBrowserWs: !!version.webSocketDebuggerUrl, targets: list.map((t) => ({ type: t.type, url: t.url, title: t.title, fields: Object.keys(t).sort() })) };
const page = list.find((t) => t.type === "page");
const cdp = connect(page.webSocketDebuggerUrl);
await cdp.opened;
const scripts = new Map();
const events = [];
const contexts = [];
cdp.on((m) => {
  if (m.method === "Debugger.scriptParsed") scripts.set(m.params.scriptId, { ...m.params, at: Date.now() });
  else if (m.method === "Runtime.executionContextCreated") contexts.push(m.params.context);
  else events.push({ ...m, at: Date.now() });
});
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Debugger.enable");
await cdp.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
const base = `http://localhost:${httpPort}`;
await cdp.send("Page.navigate", { url: base + "/" });
await waitFor(() => events.some((e) => e.method === "Page.loadEventFired"), 30000);
await sleep(2500);
R.contexts = contexts.map((c) => ({ id: c.id, name: c.name, origin: c.origin, auxData: c.auxData }));

// --- registry
const httpMapCache = new Map();
async function mapFor(s) {
  const smu = s.sourceMapURL;
  if (!smu) return { kind: "none" };
  if (smu.startsWith("data:")) {
    const comma = smu.indexOf(",");
    const b = smu.slice(comma + 1);
    return { kind: "data", map: JSON.parse(smu.slice(0, comma).includes("base64") ? Buffer.from(b, "base64").toString() : decodeURIComponent(b)) };
  }
  let abs;
  try { abs = new URL(smu, s.url).href; } catch { return { kind: "unresolvable", smu }; }
  if (httpMapCache.has(abs)) return httpMapCache.get(abs);
  let r;
  try {
    const res = await fetch(abs);
    r = res.ok ? { kind: "http", url: abs, map: await res.json() } : { kind: "http-" + res.status, url: abs };
  } catch (e) { r = { kind: "http-error", url: abs, error: String(e) }; }
  httpMapCache.set(abs, r);
  return r;
}
function classify(u) {
  if (!u) return "(empty)";
  if (u.startsWith(base + "/_next/static/chunks/")) return "http /_next/static/chunks/";
  if (u.startsWith(base + "/_next/static/")) return "http /_next/static/(other)";
  if (u.startsWith(base)) return "http (other)";
  const m = u.match(/^([a-z-]+):\/\/(\/?\([^)]*\))?/);
  return m ? m[1] + ":" + (m[2] ?? "") : "other";
}
async function registry(since = 0) {
  const byKind = {};
  const app = [];
  for (const s of scripts.values()) {
    if (s.at < since) continue;
    const k = classify(s.url) + " | " + (!s.sourceMapURL ? "no map" : s.sourceMapURL.startsWith("data:") ? "data: map" : "url map");
    byKind[k] = (byKind[k] ?? 0) + 1;
    if (/node_modules|next\/dist|react-dom|webpack\/runtime/.test(s.url) && !/src_app|src\/app/.test(s.url)) continue;
    const m = await mapFor(s);
    const secs = m.map?.sections ? m.map.sections.map((x) => x.map) : m.map ? [m.map] : [];
    const srcs = secs.flatMap((x) => (x.sources ?? []).map((src) => ({ src, root: x.sourceRoot })));
    const appSrc = srcs.filter((x) => /src\/(app|lib)/.test(x.src));
    if (!appSrc.length) continue;
    app.push({
      id: s.scriptId, url: s.url.replace(base, "<origin>"), hasSourceURL: !!s.hasSourceURL,
      smu: s.sourceMapURL?.startsWith("data:") ? "data:…" : s.sourceMapURL?.replace(base, "<origin>"),
      mapKind: m.kind, mapUrl: m.url?.replace(base, "<origin>"), indexMap: !!m.map?.sections, sections: m.map?.sections?.length ?? 0,
      appSources: appSrc.map((x) => ({ src: x.src.replace(appDir, "<app>"), sourceRoot: x.root ?? null, normalized: specNormalize(x.root, x.src).replace(appDir, "<app>"), specMatchesCounter: specMatches(x.root, x.src, "src/app/counter.tsx") })),
      hash: s.hash?.slice(0, 12), ctx: s.executionContextId, isModule: s.isModule,
    });
  }
  return { total: scripts.size, byKind, app };
}
R.registry = await registry();

// --- tracepoints in the browser
const HELPER = `Object.defineProperty(globalThis, Symbol.for("kosmo-tui"), { configurable: true, enumerable: false,
  value: function kosmoHit(tag, capture) { let v; try { v = capture(); } catch (e) { v = { captureError: String(e) }; }
    console.context("kosmo-tui").trace("KOSMO_TP", tag, JSON.stringify(v)); } }), "installed"`;
R.helper = (await cdp.send("Runtime.evaluate", { expression: HELPER, returnByValue: true })).result.value;
R.addScriptOnNewDocument = (await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HELPER })).identifier;
const FILES = { CLIENT_BUMP: "src/lib/bump.ts", CLIENT_RENDER: "src/app/counter.tsx" };
const FILE = "src/app/counter.tsx";
const lineOf = (tag) => readFileSync(path.join(appDir, FILES[tag]), "utf8").split("\n").findIndex((l) => l.includes("LINE_" + tag)) + 1;
const cap = { CLIENT_BUMP: ["n"], CLIENT_RENDER: ["count", "start"] };
const cond = (tag) => `(globalThis[Symbol.for("kosmo-tui")](${JSON.stringify(tag)}, () => ({ ${cap[tag].map((n) => `${n}: (() => { try { return ${n}; } catch (e) { return { $type: "unavailable" }; } })()`).join(", ")} })), false)`;
async function arm(tag, since = 0) {
  const line = lineOf(tag);
  const res = [];
  for (const s of scripts.values()) {
    if (s.at < since || !s.sourceMapURL) continue;
    const m = await mapFor(s);
    if (!m.map) continue;
    let tm;
    try { tm = new AnyMap(m.map, m.url ?? s.url); } catch { continue; }
    let best = null;
    eachMapping(tm, (mp) => {
      if (mp.originalLine !== line || !mp.source || !specMatches(null, mp.source, FILES[tag])) return;
      if (!best || mp.generatedLine < best.l || (mp.generatedLine === best.l && mp.generatedColumn < best.c)) best = { l: mp.generatedLine, c: mp.generatedColumn, src: mp.source };
    });
    if (!best) continue;
    const e = { id: s.scriptId, url: s.url.replace(base, "<origin>"), gen: `${best.l - 1}:${best.c}`, src: best.src.replace(appDir, "<app>") };
    try {
      const r = await cdp.send("Debugger.setBreakpoint", { location: { scriptId: s.scriptId, lineNumber: best.l - 1 + (s.startLine ?? 0), columnNumber: best.c }, condition: cond(tag) });
      e.actual = `${r.actualLocation.lineNumber}:${r.actualLocation.columnNumber}`;
      const back = originalPositionFor(tm, { line: r.actualLocation.lineNumber - (s.startLine ?? 0) + 1, column: r.actualLocation.columnNumber });
      e.back = back.source ? `${back.source.split("/").slice(-2).join("/")}:${back.line}` : null;
    } catch (err) { e.error = err.message; }
    res.push(e);
  }
  return res;
}
function hits(since) {
  return events.filter((e) => e.at >= since).flatMap((e) => {
    if (e.method === "Runtime.consoleAPICalled" && e.params.args?.[0]?.value === "KOSMO_TP") {
      const st = e.params.stackTrace;
      const chain = [];
      for (let p = st?.parent; p && chain.length < 3; p = p.parent) chain.push(p.description + ":" + (p.callFrames[0]?.functionName || "(anon)"));
      return [{ tag: e.params.args[1].value, v: e.params.args[2].value, ctx: e.params.context, frame: (st?.callFrames?.[2] ? `${st.callFrames[2].functionName}@${st.callFrames[2].url.replace(base, "<origin>")}:${st.callFrames[2].lineNumber}#${st.callFrames[2].scriptId}` : null), chain }];
    }
    if (e.method === "Runtime.exceptionThrown") return [{ exception: e.params.exceptionDetails.exception?.description?.split("\n")[0] }];
    if (e.method === "Debugger.paused") return [{ paused: true }];
    return [];
  });
}
const count = (hs) => hs.reduce((a, h) => ((a[h.tag ?? (h.exception ? "exception" : "paused")] = (a[h.tag ?? (h.exception ? "exception" : "paused")] ?? 0) + 1), a), {});
const click = async (sel) => (await cdp.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(sel)}).click(), document.querySelector(${JSON.stringify(sel)}).textContent`, returnByValue: true })).result.value;

R.arm = { CLIENT_BUMP: await arm("CLIENT_BUMP"), CLIENT_RENDER: await arm("CLIENT_RENDER") };
let t = Date.now();
R.click1 = { before: await click("#inc") };
await sleep(800);
R.click1.after = (await cdp.send("Runtime.evaluate", { expression: `document.querySelector("#inc").textContent`, returnByValue: true })).result.value;
const h1 = hits(t);
R.click1.counts = count(h1);
R.click1.samples = h1.slice(0, 4);

// --- Fast Refresh: edit counter.tsx without moving tagged lines
const fp = path.join(appDir, FILE);
const orig = readFileSync(fp, "utf8");
const before = Date.now();
try {
  writeFileSync(fp, orig.replace("export function Counter", "export const refreshMarker = 1;\nexport function Counter"));
  await sleep(4000);
  R.refresh = { newRegistry: await registry(before) };
  R.refresh.newScripts = [...scripts.values()].filter((s) => s.at >= before).map((s) => s.url.replace(base, "<origin>")).slice(0, 20);
  R.refresh.fullReload = events.some((e) => e.at >= before && (e.method === "Page.frameNavigated" || e.method === "Page.loadEventFired"));
  t = Date.now();
  await click("#inc");
  await sleep(800);
  R.refresh.hitsOldBreakpoints = count(hits(t));
  R.refresh.rearm = { CLIENT_BUMP: await arm("CLIENT_BUMP", before), CLIENT_RENDER: await arm("CLIENT_RENDER", before) };
  t = Date.now();
  await click("#inc");
  await sleep(800);
  const h3 = hits(t);
  R.refresh.hitsAfterRearm = count(h3);
  R.refresh.sample = h3.slice(0, 2);
} finally {
  writeFileSync(fp, orig);
}
R.fakeReact = [...scripts.values()].filter((s) => /^(rsc|about):\/\/React\//.test(s.url)).slice(0, 4).map((s) => ({ url: s.url.replace(base, "<origin>").replace(appDir, "<app>"), smu: s.sourceMapURL?.slice(0, 120).replace(base, "<origin>") }));
R.fakeReactCount = [...scripts.values()].filter((s) => /^(rsc|about):\/\/React\//.test(s.url)).length;
// variant 2: a Fast-Refresh-able edit (component-only module) of counter.tsx
await sleep(5000); // let the restore of variant 1 settle (it may full-reload)
{
  const before2 = Date.now();
  const nav0 = events.filter((e) => e.method === "Page.frameNavigated").length;
  const txt = readFileSync(fp, "utf8");
  try {
    writeFileSync(fp, txt.replace("<div>", "<div data-v=\"2\">"));
    await sleep(4000);
    R.fastRefresh = {
      fullReload: events.filter((e) => e.method === "Page.frameNavigated").length > nav0,
      newAppScripts: (await registry(before2)).app.map((x) => ({ url: x.url, hasSourceURL: x.hasSourceURL, mapKind: x.mapKind, mapUrl: x.mapUrl, sources: x.appSources.map((y) => y.src) })),
      newScriptUrls: [...scripts.values()].filter((s) => s.at >= before2).map((s) => s.url.replace(base, "<origin>")).slice(0, 12),
      domAttr: (await cdp.send("Runtime.evaluate", { expression: `document.querySelector("#inc").parentElement.getAttribute("data-v")`, returnByValue: true })).result.value,
    };
    let t4 = Date.now();
    await click("#inc");
    await sleep(800);
    R.fastRefresh.hitsBeforeRearm = count(hits(t4));
    R.fastRefresh.rearm = { CLIENT_RENDER: await arm("CLIENT_RENDER", before2), CLIENT_BUMP: await arm("CLIENT_BUMP", before2) };
    t4 = Date.now();
    await click("#inc");
    await sleep(800);
    R.fastRefresh.hitsAfterRearm = count(hits(t4));
  } finally { writeFileSync(fp, txt); }
}
cdp.close();
finish();
