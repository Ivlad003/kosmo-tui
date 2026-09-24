// Independent re-check of the nextjs researcher's claims (throwaway).
// node verify.mjs <appDir> <webpack|turbopack> <env=ADDR|flag=ADDR|none> <httpPort> <out.json> [phases]
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AnyMap, eachMapping, originalPositionFor } from
  "/Users/kosmodev/Documents/pet_project/kosmo-callflow/node_modules/@jridgewell/trace-mapping/dist/trace-mapping.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(p, ms = 20000, step = 50) { const t = Date.now(); while (Date.now() - t < ms) { if (await p()) return true; await sleep(step); } return false; }
async function getJson(u, ms = 800) { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms); try { return await (await fetch(u, { signal: ac.signal })).json(); } catch (e) { return { error: String(e) }; } finally { clearTimeout(t); } }

const [, , appArg, bundler, inspectArg, portArg, outJson, phasesArg = "all"] = process.argv;
const app = path.resolve(appArg), http = Number(portArg), phases = new Set(phasesArg.split(","));
const major = Number(JSON.parse(readFileSync(path.join(app, "node_modules/next/package.json"), "utf8")).version.split(".")[0]);
const R = { next: JSON.parse(readFileSync(path.join(app, "node_modules/next/package.json"), "utf8")).version, node: process.version, bundler, inspectArg };
const args = [path.join(app, "node_modules/next/dist/bin/next"), "dev", "-p", String(http)];
if (bundler === "turbopack" && major < 16) args.push("--turbopack");
if (bundler === "webpack" && major >= 16) args.push("--webpack");
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", FORCE_COLOR: "0" }; delete env.NODE_OPTIONS;
const [mode, addr] = inspectArg.split("=");
if (mode === "env") env.NODE_OPTIONS = `--inspect=${addr}`;
if (mode === "flag") args.push(`--inspect=${addr}`);
const child = spawn(process.execPath, args, { cwd: app, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
let exited = null; child.on("exit", (c, s) => (exited = { c, s }));
const kill = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 1500).unref(); };
process.on("exit", kill);
function finish() { R.tail = out.split("\n").filter(Boolean).map((l) => l.replace(/\u001b\[[0-9;]*m/g, "").replace(/[0-9a-f-]{36}/, "<uuid>")).slice(-25); writeFileSync(outJson, JSON.stringify(R, null, 2)); kill(); setTimeout(() => process.exit(0), 1800); }

R.ready = await waitFor(() => /Ready in/.test(out) || exited, 60000);
R.readyOk = /Ready in/.test(out);
await sleep(600);
// ---- topology, the way spec 9.2 step 1 would see it
const psRows = execFileSync("ps", ["-axo", "pid=,ppid=,ucomm=,command="], { encoding: "utf8" }).split("\n").filter(Boolean).map((l) => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/); return m && { pid: +m[1], ppid: +m[2], ucomm: m[3], command: m[4] }; }).filter(Boolean);
const keep = new Set([child.pid]); for (let g = true; g;) { g = false; for (const r of psRows) if (!keep.has(r.pid) && keep.has(r.ppid)) { keep.add(r.pid); g = true; } }
const tree = psRows.filter((r) => keep.has(r.pid));
R.topology = [];
for (const p of tree) {
  const comm = execFileSync("ps", ["-o", "comm=", "-p", String(p.pid)], { encoding: "utf8" }).trim();
  const commMid = execFileSync("ps", ["-o", "pid=,comm=,command=", "-p", String(p.pid)], { encoding: "utf8" }).trim();
  let txt = ""; try { txt = execFileSync("lsof", ["-a", "-p", String(p.pid), "-d", "txt", "-Fn"], { encoding: "utf8" }).split("\n").find((l) => l.startsWith("n"))?.slice(1); } catch (e) { txt = String(e.stdout).split("\n").find((l) => l.startsWith("n"))?.slice(1); }
  let ls = ""; try { ls = execFileSync("lsof", ["-a", "-p", String(p.pid), "-iTCP", "-sTCP:LISTEN", "-P", "-n", "-Fn"], { encoding: "utf8" }); } catch (e) { ls = String(e.stdout ?? ""); }
  R.topology.push({ pid: p.pid, ppid: p.ppid, ucomm: p.ucomm, commLastCol: comm, commMidCol: commMid.replace(/^\d+\s+/, "").slice(0, 40), command: p.command.replace(app, "<app>").slice(0, 90), txt, listens: ls.split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1)) });
}
if (!phases.has("all") && !phases.has("debug")) { finish(); await sleep(1e9); }

const srv = R.topology.find((p) => p.listens.some((a) => a.endsWith(":" + http)));
const inspAddr = srv?.listens.find((a) => !a.endsWith(":" + http));
R.serverInspector = inspAddr;
const list = await getJson(`http://${inspAddr}/json/list`);
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let id = 0; const pend = new Map(); const events = []; const scripts = new Map(); const contexts = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.j(new Error(m.error.message)) : p.r(m.result); return; }
  if (m.method === "Debugger.scriptParsed") scripts.set(m.params.scriptId, { ...m.params, at: Date.now() });
  else if (m.method === "Runtime.executionContextCreated") contexts.set(m.params.context.id, m.params.context);
  else if (m.method === "Runtime.executionContextDestroyed") { const c = contexts.get(m.params.executionContextId); events.push({ method: m.method, name: c?.name, isDefault: c?.auxData?.isDefault, at: Date.now() }); }
  else events.push({ ...m, at: Date.now() }); };
const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; pend.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })); });
R.pidCheck = (await send("Runtime.evaluate", { expression: "process.pid", returnByValue: true })).result.value === srv.pid;
await send("Runtime.enable"); await send("Debugger.enable"); await send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
await sleep(400);
// spec 9.6 helper, verbatim mechanism: node:inspector console, Symbol.for("kosmo-tui:"+nonce), ?.hit
const nonce = "n" + Math.random().toString(16).slice(2);
const HELPER = `(() => { const ctx = process.getBuiltinModule("node:inspector").console.context("kosmo-tui");
  Object.defineProperty(globalThis, Symbol.for("kosmo-tui:${nonce}"), { enumerable: false, configurable: true, writable: false, value: {
    hit(tp, thunks) { const v = thunks.map((t) => { try { const x = t(); return typeof x === "object" && x ? JSON.parse(JSON.stringify(x)) : x; } catch (e) { return { $type: "unavailable", reason: String(e.message) }; } });
      ctx.trace("KOSMO_TP", "${nonce}", tp, JSON.stringify(v)); } } }); return typeof ctx.trace; })()`;
R.helper = (await send("Runtime.evaluate", { expression: HELPER, returnByValue: true })).result;
const cond = (tp, names) => `(globalThis[Symbol.for("kosmo-tui:${nonce}")]?.hit(${JSON.stringify(tp)}, [${names.map((n) => `() => ${n}`).join(", ")}]), false)`;

const base = `http://localhost:${http}`;
const req = async (p) => { try { const r = await fetch(base + p); await r.text(); return r.status; } catch (e) { return String(e); } };
R.warm = { page: await req("/") };
await sleep(800);

function mapOf(s) {
  const u = s.sourceMapURL; if (!u) return null;
  try {
    if (u.startsWith("data:")) { const c = u.indexOf(","); const meta = u.slice(5, c); const b = u.slice(c + 1); return JSON.parse(meta.includes("base64") ? Buffer.from(b, "base64").toString() : decodeURIComponent(b)); }
    const abs = new URL(u, s.url.startsWith("/") ? "file://" + s.url : s.url).href;
    if (abs.startsWith("file:")) return JSON.parse(readFileSync(fileURLToPath(abs), "utf8"));
  } catch { return null; }
  return null;
}
const rawSources = (m) => (m.sections ? m.sections.flatMap((x) => x.map.sources ?? []) : m.sources ?? []);
const classify = (u) => !u ? "(empty)" : /^about:\/\/React\//.test(u) ? "about://React" : /^evalmachine/.test(u) ? "evalmachine" : u.startsWith("node:") ? "node:" : u.includes("node_modules") ? "node_modules" : /^webpack-internal/.test(u) ? "webpack-internal" : u.startsWith("file://") ? "file://" : u.slice(0, 12);
function registry() { const k = {}; for (const s of scripts.values()) { const c = classify(s.url); k[c] = (k[c] ?? 0) + 1; } return k; }
R.registryAfterWarm = registry();
// raw map sources for app files (to check `_N_E` / webpack:// claims)
R.rawSourceSamples = {};
for (const s of scripts.values()) { if (!s.url || /node_modules|^node:/.test(s.url)) continue; const m = mapOf(s); if (!m) continue; for (const src of rawSources(m)) if (/src\/(app|lib)|middleware/.test(src)) { const key = classify(s.url) + " " + src.replace(app, "<app>"); R.rawSourceSamples[key] = (R.rawSourceSamples[key] ?? 0) + 1; } }

function candidates(file) {
  const res = [];
  for (const s of scripts.values()) {
    if (!s.url || /node_modules|^node:|^internal\//.test(s.url)) continue;
    const m = mapOf(s); if (!m) continue;
    let tm; try { tm = new AnyMap(m, s.url.startsWith("/") ? "file://" + s.url : s.url); } catch { continue; }
    const srcs = tm.resolvedSources ?? [];
    if (!srcs.some((x) => x && decodeURI(x).replace(/[?#].*$/, "").endsWith("/" + file))) continue;
    res.push({ s, tm });
  }
  return res;
}
const lineOf = (file, tag) => readFileSync(path.join(app, file), "utf8").split("\n").findIndex((l) => l.includes("LINE_" + tag)) + 1;
const armed = [];
async function arm(tag, file, names, via) {
  const line = lineOf(file, tag); const out = [];
  for (const { s, tm } of candidates(file)) {
    const gens = []; eachMapping(tm, (mp) => { if (mp.originalLine === line && mp.source && decodeURI(mp.source).endsWith("/" + file)) gens.push(mp); });
    if (!gens.length) continue; gens.sort((a, b) => a.generatedLine - b.generatedLine || a.generatedColumn - b.generatedColumn);
    const g = gens[0]; const start = { scriptId: s.scriptId, lineNumber: g.generatedLine - 1 + (s.startLine ?? 0), columnNumber: g.generatedColumn };
    let locs = []; try { locs = (await send("Debugger.getPossibleBreakpoints", { start, restrictToFunction: true })).locations; } catch (e) { out.push({ url: s.url.replace(app, "<app>"), err: e.message }); continue; }
    const loc = locs.find((l) => l.lineNumber > start.lineNumber || (l.lineNumber === start.lineNumber && l.columnNumber >= start.columnNumber)) ?? locs[0];
    if (!loc) { out.push({ url: s.url.replace(app, "<app>"), state: "no-breakable-location" }); continue; }
    const back = originalPositionFor(tm, { line: loc.lineNumber - (s.startLine ?? 0) + 1, column: loc.columnNumber });
    let r;
    if (via === "hash") r = await send("Debugger.setBreakpointByUrl", { scriptHash: s.hash, lineNumber: loc.lineNumber, columnNumber: loc.columnNumber, condition: cond(tag, names) });
    else r = await send("Debugger.setBreakpoint", { location: { scriptId: s.scriptId, lineNumber: loc.lineNumber, columnNumber: loc.columnNumber }, condition: cond(tag, names) });
    armed.push(r.breakpointId);
    out.push({ scriptId: s.scriptId, ctx: s.executionContextId, url: s.url.replace(app, "<app>").slice(0, 110), via, loc: `${loc.lineNumber}:${loc.columnNumber}`, back: back.source ? `${back.source.split("/").pop()}:${back.line}:${back.column}` : null });
  }
  return { line, out };
}
function hits(t0) {
  const h = []; for (const e of events) { if (e.at < t0) continue;
    if (e.method === "Runtime.consoleAPICalled" && e.params.args?.[0]?.value === "KOSMO_TP") { const fr = e.params.stackTrace?.callFrames ?? []; const user = fr.find((f) => !/^$|kosmo/.test(f.url) && f.functionName !== "hit" && !(f.url === "" )); h.push({ tp: e.params.args[2].value, ctx: e.params.executionContextId, context: e.params.context, user: user ? `${user.url.replace(app, "<app>").slice(0, 100)}#${user.scriptId}` : null, v: e.params.args[3].value.slice(0, 120), async: !!e.params.stackTrace?.parent || !!e.params.stackTrace?.parentId }); }
    else if (e.method === "Runtime.exceptionThrown") h.push({ exc: (e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text).split("\n")[0], ctx: e.params.exceptionDetails.executionContextId });
    else if (e.method === "Debugger.paused") h.push({ paused: e.params.reason }); }
  return h;
}
const count = (h) => h.reduce((a, x) => { const k = x.tp ? x.tp + (x.user?.startsWith("about://React") ? "(fake)" : "") : x.exc ? "exception" : "paused"; a[k] = (a[k] ?? 0) + 1; return a; }, {});

// Arm after warming only "/": RSC via hash (all candidates incl. React fakes), RSC_LIB via hash, CLIENT_RENDER via scriptId
R.arm1 = { RSC: await arm("RSC", "src/app/page.tsx", ["message"], "hash"), RSC_LIB: await arm("RSC_LIB", "src/lib/greet.ts", ["name"], "hash"), CLIENT_RENDER: await arm("CLIENT_RENDER", "src/app/counter.tsx", ["count", "start"], "id") };
let t = Date.now(); await req("/"); await sleep(800);
R.round1 = { counts: count(hits(t)), sample: hits(t).slice(0, 12) };
// first compile of another route, then "/" again (claim: page modules re-evaluate with identical hashes)
const tArm2 = Date.now();
R.ping = await req("/api/ping?qty=3"); await sleep(1000);
t = Date.now(); await req("/"); await sleep(800);
R.round2 = { counts: count(hits(t)), newAppScripts: [...scripts.values()].filter((s) => s.at >= tArm2 && /src\/(app|lib)/.test(s.url) && !/^about/.test(s.url)).map((s) => `${s.url.replace(app, "<app>").slice(0, 90)} #${s.scriptId} h=${s.hash.slice(0, 10)}`) };
R.hashesBefore = [...scripts.values()].filter((s) => s.at < tArm2 && /src\/(app|lib)/.test(s.url) && !/^about/.test(s.url)).map((s) => `${s.url.replace(app, "<app>").slice(0, 90)} #${s.scriptId} h=${s.hash.slice(0, 10)}`);

// Edge: spec condition in the Edge Runtime context
const edge = [...contexts.values()].filter((c) => c.name === "Edge Runtime");
R.edgeContexts = edge.map((c) => c.id);
if (edge.length) {
  const cid = edge.at(-1).id;
  const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, contextId: cid, returnByValue: true }); return r.exceptionDetails ? "EXC " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).split("\n")[0] : r.result.value; };
  R.edgeProbe = {
    specCondition: await ev(cond("MW", ["request"])),
    consoleContext: await ev("typeof console.context"),
    consoleTraceSrc: await ev("String(console.trace).slice(0,60)"),
    getBuiltin: await ev("typeof process?.getBuiltinModule"),
    getBuiltinCall: await ev("(() => { try { return typeof process.getBuiltinModule('node:inspector') } catch (e) { return 'throws: ' + e.message } })()"),
    sameGlobal: await ev(`globalThis[Symbol.for("kosmo-tui:${nonce}")] === undefined`),
  };
  R.armMW = await arm("MW", "src/middleware.ts", ["request"], "hash");
  t = Date.now(); R.mwHeader = (await fetch(base + "/api/ping?qty=5")).headers.get("x-mw"); await sleep(800);
  R.mwRound = { counts: count(hits(t)), all: hits(t).slice(0, 5) };
}
R.contextsDestroyed = events.filter((e) => e.method === "Runtime.executionContextDestroyed").map((e) => `${e.name}|${e.isDefault}`).slice(0, 10);
R.registryEnd = registry();
for (const b of armed) { try { await send("Debugger.removeBreakpoint", { breakpointId: b }); } catch {} }
await send("Runtime.evaluate", { expression: `delete globalThis[Symbol.for("kosmo-tui:${nonce}")]` });
R.stdoutLeak = out.includes("KOSMO_TP");
ws.close();
finish();
