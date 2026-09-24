// Throwaway probe: SIGUSR1 on a non-inspected `next-server` child, context churn, and a tracepoint
// in the Edge Runtime vm context via a per-context helper + Runtime.addBinding transport.
// Usage: node probe-edge.mjs <appDir> <webpack|turbopack> <httpPort> <outJson>
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sleep, waitFor, getJson, connect, processTree, listeningPorts, loadMapFor, specMatches } from "./cdp.mjs";
import { AnyMap, eachMapping } from
  "/Users/kosmodev/Documents/pet_project/kosmo-callflow/node_modules/@jridgewell/trace-mapping/dist/trace-mapping.mjs";

const [, , appDirArg, bundler, httpPortArg, outJson] = process.argv;
const appDir = path.resolve(appDirArg);
const httpPort = Number(httpPortArg);
const major = Number(JSON.parse(readFileSync(path.join(appDir, "node_modules/next/package.json"), "utf8")).version.split(".")[0]);
const R = { bundler, major };
const args = [path.join(appDir, "node_modules/next/dist/bin/next"), "dev", "-p", String(httpPort)];
if (bundler === "turbopack" && major < 16) args.push("--turbopack");
if (bundler === "webpack" && major >= 16) args.push("--webpack");
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", FORCE_COLOR: "0" };
delete env.NODE_OPTIONS;
const child = spawn(process.execPath, args, { cwd: appDir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));
const killAll = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
process.on("exit", killAll);
const finish = () => { R.devTail = out.split("\n").filter(Boolean).slice(-15); writeFileSync(outJson, JSON.stringify(R, null, 2)); killAll(); process.exit(0); };
process.on("uncaughtException", (e) => { R.fatal = String(e.stack); finish(); });

await waitFor(() => /Ready in/.test(out), 60000);
const base = `http://localhost:${httpPort}`;
await fetch(base + "/api/ping?qty=1").then((r) => r.text());

// SIGUSR1 on the next-server child
const tree = processTree(child.pid);
const server = tree.find((p) => /^next-server/.test(p.command));
R.before = { tree: tree.map((p) => `${p.pid}<${p.ppid} ${p.command.slice(0, 60)}`), ports: listeningPorts(tree.map((p) => p.pid)) };
const tSig = Date.now();
process.kill(server.pid, "SIGUSR1");
let list = null;
await waitFor(async () => { const l = await getJson("http://127.0.0.1:9229/json/list", 300); if (Array.isArray(l)) { list = l; return true; } return false; }, 3000, 100);
R.sigusr1 = { ms: Date.now() - tSig, ok: !!list, portsAfter: listeningPorts(tree.map((p) => p.pid)), banner: out.match(/Debugger listening on \S+/g)?.map((x) => x.replace(/[0-9a-f-]{36}/, "<uuid>")) };
if (!list) finish();
const cdp = connect(list[0].webSocketDebuggerUrl);
await cdp.opened;
R.pidCheck = (await cdp.send("Runtime.evaluate", { expression: "process.pid", throwOnSideEffect: true, returnByValue: true })).result.value === server.pid;
const scripts = new Map();
const contexts = new Map();
const destroyed = [];
const events = [];
cdp.on((m) => {
  if (m.method === "Debugger.scriptParsed") scripts.set(m.params.scriptId, m.params);
  else if (m.method === "Runtime.executionContextCreated") contexts.set(m.params.context.id, m.params.context);
  else if (m.method === "Runtime.executionContextDestroyed") destroyed.push({ id: m.params.executionContextId, name: contexts.get(m.params.executionContextId)?.name, isDefault: contexts.get(m.params.executionContextId)?.auxData?.isDefault });
  else if (m.method === "Runtime.executionContextsCleared") destroyed.push({ cleared: true });
  else events.push(m);
});
await cdp.send("Runtime.enable");
await cdp.send("Debugger.enable");
await cdp.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
await cdp.send("Runtime.addBinding", { name: "__kosmoTuiHit" });
await sleep(300);

const edgeCtx = [...contexts.values()].find((c) => c.name === "Edge Runtime");
R.edgeContext = edgeCtx ? { id: edgeCtx.id, name: edgeCtx.name, auxData: edgeCtx.auxData } : null;
R.bindingInEdge = edgeCtx ? (await cdp.send("Runtime.evaluate", { expression: "typeof globalThis.__kosmoTuiHit", contextId: edgeCtx.id, returnByValue: true })).result.value : null;
R.edgeConsole = edgeCtx ? (await cdp.send("Runtime.evaluate", { expression: "Object.keys(console).join(',') + ' | context:' + typeof console.context", contextId: edgeCtx.id, returnByValue: true })).result.value : null;
const EDGE_HELPER = `Object.defineProperty(globalThis, Symbol.for("kosmo-tui"), { configurable: true, enumerable: false,
  value: function kosmoHit(tag, capture) { let v; try { v = capture(); } catch (e) { v = { captureError: String(e) }; }
    __kosmoTuiHit(JSON.stringify({ tag, v, stack: String(new Error().stack).split("\\n").slice(2, 7) })); } }), "installed"`;
R.edgeHelper = edgeCtx ? (await cdp.send("Runtime.evaluate", { expression: EDGE_HELPER, contextId: edgeCtx.id, returnByValue: true })).result.value : null;

// arm MW
const file = "src/middleware.ts";
const line = readFileSync(path.join(appDir, file), "utf8").split("\n").findIndex((l) => l.includes("LINE_MW")) + 1;
const armed = [];
for (const s of scripts.values()) {
  if (!s.sourceMapURL || /node_modules|^node:/.test(s.url)) continue;
  const m = loadMapFor(s);
  if (!m.map) continue;
  const tm = new AnyMap(m.map, s.url);
  let best = null;
  eachMapping(tm, (mp) => { if (mp.originalLine === line && mp.source && specMatches(null, mp.source, file) && (!best || mp.generatedLine < best.l || (mp.generatedLine === best.l && mp.generatedColumn < best.c))) best = { l: mp.generatedLine, c: mp.generatedColumn }; });
  if (!best) continue;
  const r = await cdp.send("Debugger.setBreakpoint", { location: { scriptId: s.scriptId, lineNumber: best.l - 1, columnNumber: best.c }, condition: `(globalThis[Symbol.for("kosmo-tui")]("MW", () => ({ path: request.nextUrl.pathname })), false)` });
  armed.push({ url: s.url.replace(appDir, "<app>"), ctx: s.executionContextId, actual: r.actualLocation });
}
R.armed = armed;
const t0 = events.length;
R.ping = await fetch(base + "/api/ping?qty=2").then((r) => ({ status: r.status, mw: r.headers.get("x-mw") }));
await sleep(800);
const mine = events.slice(t0);
R.bindingCalls = mine.filter((e) => e.method === "Runtime.bindingCalled").map((e) => ({ ctx: e.params.executionContextId, payload: JSON.parse(e.params.payload) }));
R.exceptions = mine.filter((e) => e.method === "Runtime.exceptionThrown").map((e) => e.params.exceptionDetails.exception?.description?.split("\n")[0]);
R.leak = /KOSMO|kosmoTuiHit/.test(out);

// middleware HMR: does the Edge Runtime context get replaced?
const mwPath = path.join(appDir, file);
const orig = readFileSync(mwPath, "utf8");
const nCtxBefore = contexts.size;
const nDestroyedBefore = destroyed.length;
try {
  writeFileSync(mwPath, orig + "\nexport const mwMarker = 1;\n");
  await sleep(3000);
  await fetch(base + "/api/ping?qty=3").then((r) => r.text());
  await sleep(800);
} finally { writeFileSync(mwPath, orig); }
R.mwHmr = {
  newContexts: [...contexts.values()].slice(nCtxBefore).map((c) => `${c.id}:${c.name}`),
  destroyed: destroyed.slice(nDestroyedBefore),
  bindingInNewEdge: null,
};
const newEdge = [...contexts.values()].slice(nCtxBefore).find((c) => c.name === "Edge Runtime");
if (newEdge) R.mwHmr.bindingInNewEdge = (await cdp.send("Runtime.evaluate", { expression: "typeof globalThis.__kosmoTuiHit", contextId: newEdge.id, returnByValue: true })).result.value;
R.destroyedTotal = destroyed.length;
R.destroyedSample = destroyed.slice(0, 8);
R.anyDefaultDestroyed = destroyed.some((d) => d.isDefault);
await cdp.send("Runtime.removeBinding", { name: "__kosmoTuiHit" });
cdp.close();
finish();
