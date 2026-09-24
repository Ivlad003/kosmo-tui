// Throwaway probe: Next.js dev server topology, script registry, source maps, non-pausing
// tracepoints, HMR effects, edge middleware. Usage:
//   node probe-server.mjs <appDir> <webpack|turbopack> <inspect: env[=addr] | flag[=addr]> <httpPort> <outJson>
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  sleep, waitFor, getJson, connect, processTree, listeningPorts, loadMapFor, specNormalize, specMatches,
} from "./cdp.mjs";
import { AnyMap, eachMapping, originalPositionFor } from
  "/Users/kosmodev/Documents/pet_project/kosmo-callflow/node_modules/@jridgewell/trace-mapping/dist/trace-mapping.mjs";

const [, , appDirArg, bundler, inspectArg, httpPortArg, outJson, phasesArg = "all"] = process.argv;
const appDir = path.resolve(appDirArg);
const httpPort = Number(httpPortArg);
const phases = new Set(phasesArg.split(","));
const all = phases.has("all");
const nextPkg = JSON.parse(readFileSync(path.join(appDir, "node_modules/next/package.json"), "utf8"));
const major = Number(nextPkg.version.split(".")[0]);
const R = { next: nextPkg.version, node: process.version, bundler, inspect: inspectArg };
const log = (...a) => console.error("[probe]", ...a);

// ---------------------------------------------------------------------------------------------
// 0. start next dev
const args = [path.join(appDir, "node_modules/next/dist/bin/next"), "dev", "-p", String(httpPort)];
if (bundler === "turbopack") args.push("--turbopack");
if (bundler === "webpack" && major >= 16) args.push("--webpack");
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", FORCE_COLOR: "0" };
delete env.NODE_OPTIONS;
const [imode, iaddr] = inspectArg.split("=");
if (imode === "env") env.NODE_OPTIONS = iaddr ? `--inspect=${iaddr}` : "--inspect";
if (imode === "flag") args.push(iaddr ? `--inspect=${iaddr}` : "--inspect");
R.command = ["node", ...args.map((a) => a.replace(appDir, "<app>"))].join(" ");
R.nodeOptions = env.NODE_OPTIONS ?? null;

const child = spawn(process.execPath, args, { cwd: appDir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));
const killAll = () => {
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 1500).unref();
};
process.on("exit", killAll);
process.on("uncaughtException", (e) => { console.error(e); R.fatal = String(e.stack); finish(1); });

function finish(code = 0) {
  R.devOutputTail = out.split("\n").filter((l) => !/^\s*$/.test(l)).slice(-40);
  writeFileSync(outJson, JSON.stringify(R, null, 2));
  killAll();
  setTimeout(() => process.exit(code), 1800);
}

const ready = await waitFor(() => /Ready in|✓ Ready/.test(out), 60000);
R.ready = ready;
R.inspectorBanner = [...out.matchAll(/(Debugger listening on \S+|Starting inspector on .*|For help, see.*|Debugger ending.*)/g)].map((m) => m[1].replace(/[0-9a-f-]{36}/, "<uuid>"));
if (!ready) { R.error = "not ready"; finish(1); await sleep(1e9); }

// ---------------------------------------------------------------------------------------------
// 1. topology
async function topology() {
  const tree = processTree(child.pid);
  const ports = listeningPorts(tree.map((p) => p.pid));
  const procs = [];
  for (const p of tree) {
    const entry = {
      pid: p.pid, ppid: p.ppid,
      command: p.command.replace(appDir, "<app>").replace(/\/Users\/[^ ]*\/bin\/node/, "node").slice(0, 200),
      listens: ports[p.pid] ?? [],
      targets: [],
    };
    for (const addr of entry.listens) {
      const port = addr.split(":").pop();
      const version = await getJson(`http://127.0.0.1:${port}/json/version`);
      if (!version.Browser) continue;
      const list = await getJson(`http://127.0.0.1:${port}/json/list`);
      for (const t of list) {
        const c = connect(t.webSocketDebuggerUrl);
        await c.opened;
        const who = await c.send("Runtime.evaluate", {
          expression: `JSON.stringify({pid: process.pid, ppid: process.ppid, title: process.title, argv1: process.argv[1], execArgv: process.execArgv, NODE_OPTIONS: process.env.NODE_OPTIONS ?? null, NEXT_PRIVATE_WORKER: process.env.NEXT_PRIVATE_WORKER ?? null, TURBOPACK: process.env.TURBOPACK ?? null, NEXT_RUNTIME: process.env.NEXT_RUNTIME ?? null, __NEXT_DEV_SERVER: process.env.__NEXT_DEV_SERVER ?? null})`,
          returnByValue: true,
        });
        c.close();
        const w = JSON.parse(who.result.value);
        w.argv1 = w.argv1?.replace(appDir, "<app>");
        entry.targets.push({
          port: Number(port), browser: version.Browser, protocol: version["Protocol-Version"],
          type: t.type, title: t.title?.replace(appDir, "<app>"), url: t.url?.replace(appDir, "<app>"),
          faviconUrl: t.faviconUrl, idLast4: t.id.slice(-4), fields: Object.keys(t).sort(), identity: w,
        });
      }
    }
    procs.push(entry);
  }
  return procs;
}
R.topology = await topology();
const httpOwner = R.topology.find((p) => p.listens.some((a) => a.endsWith(":" + httpPort)));
R.httpOwnerPid = httpOwner?.pid ?? null;
const serverTarget = httpOwner?.targets[0];
log("topology", JSON.stringify(R.topology.map((p) => [p.pid, p.listens, p.targets.map((t) => t.port)])));
if (!serverTarget || !(all || phases.has("debug"))) { finish(0); await sleep(1e9); }

// ---------------------------------------------------------------------------------------------
// 2. attach to the process that owns the HTTP port
const wsUrl = (await getJson(`http://127.0.0.1:${serverTarget.port}/json/list`))[0].webSocketDebuggerUrl;
const cdp = connect(wsUrl);
await cdp.opened;
const scripts = new Map(); // scriptId -> params
const contexts = [];
const events = [];
cdp.on((m) => {
  if (m.method === "Debugger.scriptParsed") scripts.set(m.params.scriptId, { ...m.params, seenAt: Date.now() });
  else if (m.method === "Runtime.executionContextCreated") contexts.push(m.params.context);
  else events.push({ ...m, at: Date.now() });
});
await cdp.send("Runtime.enable");
await cdp.send("Debugger.enable");
await cdp.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
await sleep(500);
R.scriptsAtAttach = scripts.size;

const HELPER = `Object.defineProperty(globalThis, Symbol.for("kosmo-tui"), { configurable: true, enumerable: false,
  value: function kosmoHit(tag, capture) { let v; try { v = capture(); } catch (e) { v = { captureError: String(e) }; }
    console.context("kosmo-tui").trace("KOSMO_TP", tag, JSON.stringify(v)); } }), "installed"`;
R.helperInstall = (await cdp.send("Runtime.evaluate", { expression: HELPER, returnByValue: true })).result.value;

const base = `http://localhost:${httpPort}`;
async function req(pathname, init) {
  const t0 = Date.now();
  try {
    const r = await fetch(base + pathname, init);
    const body = await r.text();
    return { status: r.status, ms: Date.now() - t0, mw: r.headers.get("x-mw"), body: body.slice(0, 160) };
  } catch (e) {
    return { error: String(e), ms: Date.now() - t0 };
  }
}
function findActionId() {
  const cands = [".next/server/server-reference-manifest.json", ".next/dev/server/server-reference-manifest.json"];
  for (const c of cands) {
    const p = path.join(appDir, c);
    if (!existsSync(p)) continue;
    const j = JSON.parse(readFileSync(p, "utf8"));
    const ids = Object.keys(j.node ?? {});
    if (ids.length) return { id: ids[0], manifest: c, entry: j.node[ids[0]] };
  }
  return null;
}
async function callAction() {
  const a = findActionId();
  if (!a) return { error: "no action id" };
  return {
    manifest: a.manifest,
    layers: a.entry.layer ?? null,
    ...(await req("/", {
      method: "POST",
      headers: { "Next-Action": a.id, "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component", Origin: base },
      body: JSON.stringify([" hi "]),
    })),
  };
}

// warm-up: compile everything once
R.warmup = {
  page: await req("/"),
  ping: await req("/api/ping?qty=2"),
  action: await callAction(),
};
await sleep(800);

// ---------------------------------------------------------------------------------------------
// 3. registry snapshot
function classifyUrl(u) {
  if (!u) return "(empty)";
  const m = u.match(/^([a-z][a-z0-9+.-]*):/i);
  if (m) {
    if (m[1] === "file") return u.includes("/node_modules/") ? "file:// node_modules" : u.includes("/.next/") ? "file:// .next" : "file:// other";
    if (m[1] === "webpack-internal") return "webpack-internal:" + (u.match(/^webpack-internal:\/\/\/(\([^)]*\))?/)?.[1] ?? "");
    return m[1] + ":";
  }
  if (u.startsWith("/")) return u.includes("/node_modules/") ? "abs node_modules" : u.includes("/.next/") ? "abs .next" : "abs other";
  return "other:" + u.slice(0, 20);
}
const mapCache = new Map();
function mapOf(s) {
  if (mapCache.has(s.scriptId)) return mapCache.get(s.scriptId);
  let r;
  try { r = loadMapFor(s); } catch (e) { r = { kind: "error", error: String(e) }; }
  mapCache.set(s.scriptId, r);
  return r;
}
const FILES = {
  ROUTE: "src/app/api/ping/route.ts",
  ROUTE_LIB: "src/lib/pricing.ts",
  RSC: "src/app/page.tsx",
  RSC_LIB: "src/lib/greet.ts",
  CLIENT_RENDER: "src/app/counter.tsx",
  CLIENT_BUMP: "src/app/counter.tsx",
  ACTION: "src/app/actions.ts",
  MW: process.env.MW_FILE ?? "src/middleware.ts",
};
const CAPTURE = {
  ROUTE: ["qty", "item"], ROUTE_LIB: ["item", "qty"], RSC: ["message"], RSC_LIB: ["name"],
  CLIENT_RENDER: ["count", "start"], CLIENT_BUMP: ["n"], ACTION: ["text"], MW: ["request"],
};
const lineOfTag = (file, tag) => readFileSync(path.join(appDir, file), "utf8").split("\n").findIndex((l) => l.includes("LINE_" + tag)) + 1;

function registrySnapshot(filterFn = () => true) {
  const byKind = {};
  const mapKinds = {};
  const app = [];
  for (const s of scripts.values()) {
    if (!filterFn(s)) continue;
    const k = classifyUrl(s.url);
    byKind[k] = (byKind[k] ?? 0) + 1;
    const mk = !s.sourceMapURL ? "none" : s.sourceMapURL.startsWith("data:") ? "data:" : /^https?:/.test(s.sourceMapURL) ? "http" : "relative/file";
    mapKinds[k + " | map " + mk] = (mapKinds[k + " | map " + mk] ?? 0) + 1;
    if (/node_modules|^node:|^internal\//.test(s.url)) continue;
    if (!s.url || (!s.url.includes(appDir) && !s.url.startsWith("webpack") && !s.url.startsWith("turbopack"))) continue;
    const m = mapOf(s);
    const srcs = m.map ? (m.map.sections ? m.map.sections.flatMap((x) => x.map.sources ?? []) : m.map.sources ?? []) : [];
    const appSrcs = srcs.filter((x) => /src\/(app|lib|middleware)/.test(x));
    if (!appSrcs.length && !/src\/(app|lib|middleware)/.test(s.url)) continue;
    app.push({
      scriptId: s.scriptId, ctx: s.executionContextId, url: s.url.replace(appDir, "<app>"), hasSourceURL: !!s.hasSourceURL,
      sourceMapURL: s.sourceMapURL ? (s.sourceMapURL.startsWith("data:") ? s.sourceMapURL.slice(0, 40) + "…" : s.sourceMapURL.replace(appDir, "<app>")) : "",
      mapKind: m.kind, indexMap: !!m.map?.sections, sections: m.map?.sections?.length ?? 0,
      sourceRoot: m.map?.sourceRoot ?? (m.map?.sections ? m.map.sections[0]?.map?.sourceRoot : undefined),
      appSources: appSrcs.map((x) => x.replace(appDir, "<app>")),
      hasSourcesContent: !!(m.map?.sourcesContent?.length || m.map?.sections?.some((x) => x.map.sourcesContent?.length)),
      hash: s.hash?.slice(0, 12), length: s.length, startLine: s.startLine, startColumn: s.startColumn,
      isModule: s.isModule, scriptLanguage: s.scriptLanguage,
    });
  }
  return { total: scripts.size, byKind, mapKinds, appScripts: app };
}
R.registry = registrySnapshot();
R.executionContexts = contexts.map((c) => ({ id: c.id, name: c.name, origin: c.origin, auxData: c.auxData }));

// Spec 9.4 normalizer check on every app source seen
R.normalizer = {};
for (const s of R.registry.appScripts) {
  for (const src of s.appSources) {
    const file = Object.values(FILES).find((f) => src.includes(f.replace(/^src\//, "")));
    if (!file) continue;
    const norm = specNormalize(s.sourceRoot, src.replace("<app>", appDir));
    R.normalizer[src] = { sourceRoot: s.sourceRoot ?? null, normalized: norm.replace(appDir, "<app>"), matches: specMatches(s.sourceRoot, src.replace("<app>", appDir), file), file };
  }
}

// ---------------------------------------------------------------------------------------------
// 4. tracepoints
function generatedFor(s, file, line) {
  const m = mapOf(s);
  if (!m.map) return [];
  let tm;
  try { tm = new AnyMap(m.map, s.url.startsWith("/") ? "file://" + s.url : s.url); } catch (e) { return [{ error: String(e) }]; }
  const hits = [];
  eachMapping(tm, (mp) => {
    if (mp.originalLine !== line || !mp.source) return;
    if (!specMatches(null, mp.source, file)) return;
    hits.push({ line: mp.generatedLine, column: mp.generatedColumn, origCol: mp.originalColumn, source: mp.source.replace(appDir, "<app>") });
  });
  hits.sort((a, b) => a.line - b.line || a.column - b.column);
  return hits;
}
function cond(tag, names) {
  const cap = names.map((n) => `${JSON.stringify(n)}: (() => { try { return typeof ${n} === "function" ? "[fn]" : (${n} && typeof ${n} === "object" && ${n}.constructor && ${n}.constructor.name !== "Object" ? "[" + ${n}.constructor.name + "]" : ${n}); } catch (e) { return { $type: "unavailable", e: String(e).slice(0, 60) }; } })()`).join(", ");
  return `(globalThis[Symbol.for("kosmo-tui")](${JSON.stringify(tag)}, () => ({ ${cap} })), false)`;
}
const bps = []; // {tag, breakpointId, scriptId, via}
async function armTag(tag, { onlyNewSince = 0, via = "scriptId" } = {}) {
  const file = FILES[tag];
  const line = lineOfTag(file, tag);
  const res = { file, line, scripts: [] };
  for (const s of scripts.values()) {
    if (s.seenAt < onlyNewSince) continue;
    if (/node_modules|^node:|^internal\//.test(s.url)) continue;
    if (!s.sourceMapURL) continue;
    const gens = generatedFor(s, file, line);
    if (!gens.length || gens[0].error) continue;
    const g = gens[0];
    const lineNumber = g.line - 1 + (s.startLine ?? 0);
    const columnNumber = g.column + (g.line === 1 ? s.startColumn ?? 0 : 0);
    const entry = { scriptId: s.scriptId, url: s.url.replace(appDir, "<app>"), gen: `${lineNumber}:${columnNumber}`, nGen: gens.length, mappedSource: g.source };
    try {
      if (via === "scriptHash") {
        const r = await cdp.send("Debugger.setBreakpointByUrl", { scriptHash: s.hash, lineNumber, columnNumber, condition: cond(tag, CAPTURE[tag]) });
        entry.via = "scriptHash"; entry.locations = r.locations.length; bps.push({ tag, breakpointId: r.breakpointId, via });
      } else {
        const r = await cdp.send("Debugger.setBreakpoint", { location: { scriptId: s.scriptId, lineNumber, columnNumber }, condition: cond(tag, CAPTURE[tag]) });
        entry.actual = `${r.actualLocation.lineNumber}:${r.actualLocation.columnNumber}`;
        // map back: does the actual location still point into the tagged line?
        const tm = new AnyMap(mapOf(s).map, s.url.startsWith("/") ? "file://" + s.url : s.url);
        const back = originalPositionFor(tm, { line: r.actualLocation.lineNumber - (s.startLine ?? 0) + 1, column: r.actualLocation.columnNumber });
        entry.backMapped = back.source ? `${back.source.replace(appDir, "<app>").split("/").slice(-2).join("/")}:${back.line}:${back.column}` : null;
        bps.push({ tag, breakpointId: r.breakpointId, scriptId: s.scriptId, via });
      }
    } catch (e) {
      entry.error = String(e.message);
    }
    res.scripts.push(entry);
  }
  return res;
}
function hitsSince(t0) {
  const hits = [];
  for (const e of events) {
    if (e.at < t0) continue;
    if (e.method === "Runtime.consoleAPICalled" && e.params.args?.[0]?.value === "KOSMO_TP") {
      const st = e.params.stackTrace;
      const frames = (st?.callFrames ?? []).slice(0, 4).map((f) => `${f.functionName || "(anon)"}@${f.url.replace(appDir, "<app>")}:${f.lineNumber}:${f.columnNumber}#${f.scriptId}`);
      const asyncChain = [];
      for (let p = st?.parent; p && asyncChain.length < 4; p = p.parent) asyncChain.push(p.description + ": " + p.callFrames.slice(0, 2).map((f) => `${f.functionName || "(anon)"}@${f.url.replace(appDir, "<app>").split("/").slice(-3).join("/")}`).join(" < "));
      hits.push({ tag: e.params.args[1].value, values: e.params.args[2].value, type: e.params.type, context: e.params.context, ctxId: e.params.executionContextId, frames, asyncChain, parentId: !!st?.parentId });
    }
    if (e.method === "Runtime.exceptionThrown") {
      const d = e.params.exceptionDetails;
      hits.push({ exception: (d.exception?.description ?? d.text ?? "").split("\n")[0].slice(0, 160), url: d.url?.replace(appDir, "<app>"), ctxId: d.executionContextId });
    }
    if (e.method === "Debugger.paused") hits.push({ paused: e.params.reason });
  }
  return hits;
}
const summarize = (hits) => {
  const c = {};
  for (const h of hits) { const k = h.tag ?? (h.exception ? "exception" : "paused"); c[k] = (c[k] ?? 0) + 1; }
  return c;
};

if (all || phases.has("tp")) {
  R.arm = {};
  for (const tag of ["ROUTE", "ROUTE_LIB", "RSC", "RSC_LIB", "CLIENT_RENDER", "ACTION", "MW"]) {
    R.arm[tag] = await armTag(tag, { via: tag === "ROUTE" ? "scriptHash" : "scriptId" });
  }
  const tArm = Date.now();
  const t0 = Date.now();
  R.round1 = { ping: await req("/api/ping?qty=3"), page: await req("/"), action: await callAction() };
  await sleep(1000);
  const h1 = hitsSince(t0);
  R.round1.counts = summarize(h1);
  R.round1.samples = {};
  for (const h of h1) { const k = h.tag ?? (h.exception ? "exception" : "paused"); if (!R.round1.samples[k]) R.round1.samples[k] = h; }
  R.round1.hitScripts = {};
  for (const h of h1) if (h.tag) { const fr = h.frames[2] ?? ""; (R.round1.hitScripts[h.tag] ??= []).push(fr.replace(/^.*@/, "")); }
  R.round1.appScriptsParsedAfterArm = [...scripts.values()].filter((s) => s.seenAt >= tArm && s.url && !/node_modules|^node:|^internal\//.test(s.url) && /src\/(app|lib)|middleware/.test(s.url)).map((s) => ({ id: s.scriptId, url: s.url.replace(appDir, "<app>"), hash: s.hash.slice(0, 12), smu: (s.sourceMapURL || "").slice(0, 60) }));
  R.fakeReactScripts = [...scripts.values()].filter((s) => /^(about|rsc):\/\/React\//.test(s.url)).slice(0, 6).map((s) => ({ id: s.scriptId, url: s.url.replace(appDir, "<app>"), smu: (s.sourceMapURL || "").replace(appDir, "<app>").slice(0, 160), len: s.length }));
  R.fakeReactScriptCount = [...scripts.values()].filter((s) => /^(about|rsc):\/\/React\//.test(s.url)).length;
  // round 2: re-resolve every tag on scripts that appeared after arming, fire again
  R.rearm = {};
  for (const tag of ["RSC", "RSC_LIB", "CLIENT_RENDER"]) R.rearm[tag] = await armTag(tag, { onlyNewSince: tArm });
  const t2 = Date.now();
  R.round2 = { page: await req("/") };
  await sleep(1000);
  const h2r = hitsSince(t2);
  R.round2.counts = summarize(h2r);
  R.round2.hitScripts = {};
  for (const h of h2r) if (h.tag) { const fr = h.frames[2] ?? ""; (R.round2.hitScripts[h.tag] ??= []).push(fr.replace(/^.*@/, "") + " " + h.values.slice(0, 80)); }
  R.round2.appScriptsParsed = [...scripts.values()].filter((s) => s.seenAt >= t2 && s.url && /src\/(app|lib)/.test(s.url)).map((s) => s.url.replace(appDir, "<app>") + "#" + s.scriptId);

  // edge: if the middleware condition threw in the vm context, install the helper into every non-main context
  const mwThrew = h1.some((h) => h.exception);
  if (mwThrew || !R.round1.counts.MW) {
    const installed = [];
    for (const c of contexts) {
      if (c.auxData?.isDefault) continue;
      try {
        const r = await cdp.send("Runtime.evaluate", { expression: HELPER, contextId: c.id, returnByValue: true });
        installed.push({ ctx: c.id, name: c.name, r: r.result.value ?? r.exceptionDetails?.text });
      } catch (e) { installed.push({ ctx: c.id, error: String(e.message) }); }
    }
    const t1 = Date.now();
    const pr = await req("/api/ping?qty=5");
    await sleep(800);
    const h2 = hitsSince(t1);
    R.edgeRetry = { installedInto: installed, ping: pr, counts: summarize(h2), mw: h2.find((h) => h.tag === "MW") ?? null, exc: h2.find((h) => h.exception) ?? null };
  }
}

// ---------------------------------------------------------------------------------------------
// 5. HMR: edit a server lib file without moving the tagged line; then with a line shift
async function hmrStep(name, mutate) {
  const before = new Set(scripts.keys());
  const tEdit = Date.now();
  mutate();
  await sleep(bundler === "turbopack" ? 2500 : 3500);
  const t0 = Date.now();
  const ping = await req("/api/ping?qty=4");
  await sleep(900);
  const newScripts = [...scripts.values()].filter((s) => !before.has(s.scriptId));
  const app = newScripts.filter((s) => s.url && !/node_modules|^node:|^internal\//.test(s.url) && (s.url.includes(appDir) || /^(webpack|turbopack)/.test(s.url)));
  const hits = hitsSince(t0);
  const oldPricing = R.registry.appScripts.filter((s) => s.appSources.some((x) => x.includes("lib/pricing.ts")) || s.url.includes("pricing"));
  const newPricing = app.filter((s) => { const m = mapOf(s); const srcs = m.map ? (m.map.sections ? m.map.sections.flatMap((x) => x.map.sources) : m.map.sources) : []; return srcs.some((x) => x?.includes("lib/pricing.ts")) || s.url.includes("pricing"); });
  const r = {
    ping,
    newScriptsTotal: newScripts.length,
    newAppScripts: app.map((s) => ({ id: s.scriptId, url: s.url.replace(appDir, "<app>"), hasSourceURL: s.hasSourceURL, hash: s.hash?.slice(0, 12), mapKind: mapOf(s).kind })).slice(0, 30),
    sameUrlAsBefore: newPricing.map((s) => oldPricing.some((o) => o.url === s.url.replace(appDir, "<app>"))),
    routeHashReused: app.filter((s) => s.url.includes("route")).map((s) => R.registry.appScripts.some((o) => o.hash === s.hash?.slice(0, 12))),
    hitsWithoutReResolve: summarize(hits),
    hitSamples: hits.filter((h) => h.tag).slice(0, 3),
  };
  // re-resolve ROUTE_LIB on new scripts only and fire again
  const armed = await armTag("ROUTE_LIB", { onlyNewSince: tEdit });
  const t1 = Date.now();
  await req("/api/ping?qty=6");
  await sleep(900);
  r.reResolve = { armed: armed.scripts, hits: summarize(hitsSince(t1)) };
  R[name] = r;
}
if (all || phases.has("hmr")) {
  const libPath = path.join(appDir, "src/lib/pricing.ts");
  const orig = readFileSync(libPath, "utf8");
  try {
    await hmrStep("hmrAppend", () => writeFileSync(libPath, orig + "export const hmrMarker = 1;\n"));
    await hmrStep("hmrShift", () => writeFileSync(libPath, "// shifted\n" + orig + "export const hmrMarker = 2;\n"));
  } finally {
    writeFileSync(libPath, orig);
  }
  R.scriptsTotalEnd = scripts.size;
}

// ---------------------------------------------------------------------------------------------
// 6. cleanup: remove our breakpoints and helper, detach
for (const b of bps) { try { await cdp.send("Debugger.removeBreakpoint", { breakpointId: b.breakpointId }); } catch {} }
try { await cdp.send("Runtime.evaluate", { expression: `delete globalThis[Symbol.for("kosmo-tui")]` }); } catch {}
R.stdoutLeak = /KOSMO_TP/.test(out);
cdp.close();
finish(0);
