// Nest: enhancer order via tracepoints, handler path, captures; mode tsc | tsx
import { launch, connect, sleep, decodeMap } from "./c.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
const TM = createRequire("/Users/kosmodev/Documents/pet_project/kosmo-callflow/package.json")("@jridgewell/trace-mapping");
const N22 = "/Users/kosmodev/.nvm/versions/node/v22.22.0/bin/node";
const D = new URL("./nest/", import.meta.url).pathname;
const mode = process.argv[2] || "tsc";
const args = mode === "tsx" ? ["--inspect=127.0.0.1:0", "--import", "tsx", "src/main.ts"] : ["--inspect=127.0.0.1:0", "dist/main.js"];
const t = launch(N22, args, { cwd: D, env: { PORT: "0" } });
const ws = await t.ws; let port;
for (let i = 0; i < 100 && !port; i++) { await sleep(100); port = /PORT (\d+)/.exec(t.out.stdout)?.[1]; }
if (!port) { console.log("no port", t.out.stderr.slice(0, 800)); t.ch.kill("SIGKILL"); process.exit(1); }
const c = await connect(ws); const scripts = new Map(); let n = 0;
c.on("Debugger.scriptParsed", (p) => { scripts.set(p.scriptId, p); n++; });
const hits = [];
c.on("Runtime.consoleAPICalled", (p) => { if (p.context?.startsWith("kosmo-tui")) hits.push(p); });
await c.send("Runtime.enable"); await c.send("Debugger.enable"); await c.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
await sleep(500);
const nm = [...scripts.values()].filter((s) => /node_modules/.test(s.url)).length;
console.log(`mode=${mode} scripts=${scripts.size} node_modules=${nm} node:=${[...scripts.values()].filter(s=>s.url.startsWith("node:")).length}`);
await c.send("Runtime.evaluate", { expression: `Object.defineProperty(globalThis, Symbol.for("kt"), { configurable: true, value: (id, th) => { const o = {}; for (const [k, f] of th) { let v; try { v = f(); } catch (e) { o[k] = "unavail:" + e.name; continue; } o[k] = v === undefined ? "undefined" : (v && typeof v === "object") ? (v.constructor?.name + ":" + Object.keys(v).slice(0,5).join(",")) : v; } process.getBuiltinModule("node:inspector").console.context("kosmo-tui").trace(id, JSON.stringify(o)); return false; } }); 1\n//# sourceURL=kosmo-tui://helper` });
const points = [["logger.middleware.ts", 6, "middleware", ["req"]], ["auth.guard.ts", 6, "guard", ["context"]], ["timing.interceptor.ts", 7, "interceptor.before", []], ["timing.interceptor.ts", 10, "interceptor.after", []], ["parse-id.pipe.ts", 6, "pipe", ["value"]], ["cart.controller.ts", 17, "handler", ["id", "auth", "this"]], ["cart.service.ts", 6, "service", ["id"]], ["http-error.filter.ts", 6, "filter", ["exception"]]];
const user = [...scripts.values()].filter((s) => s.url.includes("/verify-node-express-nest/nest/") && !/node_modules/.test(s.url));
const maps = new Map();
function mapOf(s) { if (maps.has(s.scriptId)) return maps.get(s.scriptId); let m = null; if (s.sourceMapURL) { let raw = decodeMap(s); if (!raw) { const p = path.resolve(path.dirname(fileURLToPath(s.url)), s.sourceMapURL); raw = JSON.parse(readFileSync(p, "utf8")); } m = new TM.TraceMap(raw, s.url); } maps.set(s.scriptId, m); return m; }
for (const [file, line, id, names] of points) {
  for (const s of user) {
    const m = mapOf(s); if (!m) continue;
    const src = m.resolvedSources.find((x) => x?.endsWith("/src/" + file)); if (!src) continue;
    const g = TM.generatedPositionFor(m, { source: src, line, column: 0, bias: TM.LEAST_UPPER_BOUND });
    const pos = await c.send("Debugger.getPossibleBreakpoints", { start: { scriptId: s.scriptId, lineNumber: g.line - 1, columnNumber: g.column }, restrictToFunction: true });
    const loc = pos.locations[0];
    const cond = `(globalThis[Symbol.for("kt")](${JSON.stringify(id)}, [${names.map((x) => `[${JSON.stringify(x)}, () => ${x}]`).join(",")}]), false)\n//# sourceURL=kosmo-tui://tp/${id}`;
    const r = await c.send("Debugger.setBreakpoint", { location: loc, condition: cond });
    const back = TM.originalPositionFor(m, { line: r.actualLocation.lineNumber + 1, column: r.actualLocation.columnNumber });
    console.log(`  tp ${id} ${file}:${line} -> gen ${r.actualLocation.lineNumber + 1}:${r.actualLocation.columnNumber + 1} back ${back.line}:${back.column}`);
  }
}
const base = `http://127.0.0.1:${port}`;
async function req(label, url, init) { hits.length = 0; const r = await fetch(base + url, init); const b = await r.text(); await sleep(150); console.log(`${label}: ${r.status} ${b.slice(0, 80)}\n   order: ${hits.map((h) => h.args[0].value).join(" > ")}`); return [...hits]; }
const H = { authorization: "Bearer s3cr3t" };
const ok = await req("OK", "/cart/42", { headers: H });
await req("pipe throws", "/cart/abc", { headers: H });
await req("guard false", "/cart/42", {});
await req("handler throws", "/cart/42/items", { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ qty: 11 }) });
const hh = ok.find((h) => h.args[0].value === "handler");
if (hh) {
  console.log("   handler capture:", hh.args[1].value);
  let st = hh.stackTrace, seg = 0; const userFrames = [];
  while (st) { const sync = st.callFrames.length; for (const f of st.callFrames) if (f.url && !/node_modules|^node:|kosmo-tui:/.test(f.url)) userFrames.push((seg ? "(async " + (st.description || "") + ") " : "") + f.functionName); if (seg === 0) console.log("   handler sync frames:", sync); st = st.parent; seg++; }
  console.log("   handler user frames (innermost first):", userFrames.join(" <- "));
}
for (const h of ok) { let st = h.stackTrace, fr = 0, seg = 0; while (st) { fr += st.callFrames.length; seg++; st = st.parent; } console.log(`   size ${h.args[0].value}: frames=${fr} segments=${seg} stackJSON=${JSON.stringify(h.stackTrace).length}B msgJSON=${JSON.stringify(h).length}B`); }
const gh = ok.find((h) => h.args[0].value === "guard");
if (gh) console.log("   guard sync frames:", gh.stackTrace.callFrames.length, "has LoggerMiddleware.use in sync stack:", gh.stackTrace.callFrames.some((f) => f.functionName === "use"));
c.close(); t.ch.kill("SIGKILL"); await sleep(200); process.exit(0);
