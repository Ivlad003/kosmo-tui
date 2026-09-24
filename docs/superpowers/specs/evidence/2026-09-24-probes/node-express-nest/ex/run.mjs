import { launch, connect, Registry, HELPER_SRC, conditionFor, fmtFrames, sleep, killTree, shortUrl } from "../cdp.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const N22 = "/Users/kosmodev/.nvm/versions/node/v22.22.0/bin/node";
const [which, blackbox = "no", keep = "keep"] = process.argv.slice(2);
const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), which);
const file = path.join(DIR, "app.js");
const url = pathToFileURL(file).href;

const t = launch({ node: N22, args: ["--inspect=127.0.0.1:0", "app.js"], cwd: DIR, env: keep === "keep" ? { KEEP_ALIVE: "1" } : {} });
const ws = await t.ws;
let port; for (let i = 0; i < 50 && !port; i++) { await sleep(100); port = /PORT (\d+)/.exec(t.out.stdout)?.[1]; }
console.log(`===== ${which} ${/express (\S+)/.exec(t.out.stdout)?.[1]} blackbox=${blackbox} keepAlive=${keep}`);
const c = await connect(ws);
const reg = new Registry();
c.on("Debugger.scriptParsed", (p) => reg.add(p));
const hits = [], pauses = [], errs = [];
c.on("Runtime.consoleAPICalled", (p) => { if (p.context?.startsWith("kosmo-tui")) hits.push(p); });
c.on("Runtime.exceptionThrown", (p) => errs.push(p.exceptionDetails));
c.on("Debugger.paused", async (p) => {
  pauses.push(p);
  await c.send("Debugger.resume");
});
await c.send("Runtime.enable");
await c.send("Debugger.enable");
await c.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
if (blackbox === "bb") await c.send("Debugger.setBlackboxPatterns", { patterns: ["/node_modules/"] });
await c.send("Debugger.setPauseOnExceptions", { state: "none" });
await sleep(300);
const nm = [...reg.scripts.values()].filter((s) => /node_modules/.test(s.url));
console.log(`scripts: ${reg.scripts.size} total, ${nm.length} node_modules; express-related sample urls: ${nm.filter((s) => /express|router/.test(s.url)).map((s) => shortUrl(s.url)).slice(0, 12).join(", ")}`);
await c.send("Runtime.evaluate", { expression: HELPER_SRC });
const tps = [
  { id: "auth", line: 10, names: ["req", "res", "next"] },
  { id: "raw-auth", line: 11, names: ["req"] },
  { id: "getCart", line: 18, names: ["req", "res"] },
  { id: "loadCart", line: 28, names: ["id"] },
  { id: "errorHandler", line: 32, names: ["err", "req"] },
];
for (const tp of tps) {
  const r = await c.send("Debugger.setBreakpointByUrl", { url, lineNumber: tp.line - 1, columnNumber: 0, condition: conditionFor(tp.id, tp.names) });
  tp.bp = r.breakpointId; tp.locs = r.locations.map((l) => `${l.lineNumber + 1}:${l.columnNumber + 1}`);
}
const pbp = await c.send("Debugger.setBreakpointByUrl", { url, lineNumber: 21, columnNumber: 0 });
console.log("tracepoints:", tps.map((t) => `${t.id}@${t.line}->${t.locs.join(",")}`).join("  "), " pause-bp addItem@22 ->", pbp.locations.map((l) => `${l.lineNumber + 1}:${l.columnNumber + 1}`).join(","));

const base = `http://127.0.0.1:${port}`;
const H = { authorization: "Bearer s3cr3t-token", cookie: "sid=abc123; theme=dark", "x-api-key": "k-999", "content-type": "application/json", "x-request-id": "r-1" };
async function req(label, p, init = {}) {
  const t0 = performance.now();
  try { const r = await fetch(base + p, { ...init, signal: AbortSignal.timeout(1500) }); const txt = await r.text(); console.log(`  ${label}: ${r.status} ${txt.slice(0, 80)} (${(performance.now() - t0).toFixed(1)} ms)`); }
  catch (e) { console.log(`  ${label}: FAILED ${e.name} ${e.message} (${(performance.now() - t0).toFixed(1)} ms)`); }
}
await req("GET /api/cart/42 (auth)", "/api/cart/42?expand=1", { headers: H });
await req("GET /api/cart/42 (no auth -> next(err))", "/api/cart/42");
await req("POST items qty=1 (pause bp)", "/api/cart/42/items", { method: "POST", headers: H, body: JSON.stringify({ sku: "b", qty: 1, password: "p" }) });
await req("POST items qty=11 (async throw)", "/api/cart/42/items", { method: "POST", headers: H, body: JSON.stringify({ sku: "b", qty: 11 }) });
await sleep(300);
for (const e of errs) console.log(`  exceptionThrown: text=${JSON.stringify(e.text)} desc=${JSON.stringify((e.exception?.description || "").slice(0, 90))} scriptId=${e.scriptId} url=${e.url ?? "-"} line=${e.lineNumber} executionContextId=${e.executionContextId}`);
console.log(`hits=${hits.length} pauses=${pauses.length} conditionExceptions=${errs.length} targetAlive=${!t.out.exit} exit=${JSON.stringify(t.out.exit ?? null)}`);
const seen = new Set();
for (const h of hits) {
  const id = h.args[1]?.value; const json = h.args[2]?.value ?? "";
  const key = id + (seen.has(id) ? "#2" : ""); if (seen.has(id) && id !== "errorHandler") continue; seen.add(id);
  const st = h.stackTrace; let sync = st.callFrames.length, asyncN = 0; for (let p = st.parent; p; p = p.parent) asyncN += p.callFrames.length;
  console.log(`\n--- hit ${key}: capture ${Buffer.byteLength(json)} B; sync frames=${sync} async frames=${asyncN}`);
  console.log("   capture:", json.length > 900 ? json.slice(0, 900) + "…" : json);
  console.log(fmtFrames(reg, st, DIR));
}
for (const p of pauses.slice(0, 1)) {
  console.log(`\n--- PAUSED (reason=${p.reason}, hitBreakpoints=${p.hitBreakpoints?.length}) callFrames=${p.callFrames.length}`);
  for (const f of p.callFrames) console.log(`   ${(f.functionName || "(anonymous)").padEnd(34)} ${shortUrl(f.url, DIR)}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1}  scopes=[${f.scopeChain.map((s) => s.type).join(",")}] this=${f.this.className ?? f.this.type}`);
  let a = p.asyncStackTrace, d = 0; while (a && d < 5) { console.log(`   -- async: ${a.description} --`); for (const f of a.callFrames) console.log(`   ${(f.functionName || "(anonymous)").padEnd(34)} ${shortUrl(f.url, DIR)}:${f.lineNumber + 1}`); a = a.parent; d++; }
}
console.log("\ntarget stdout:", JSON.stringify(t.out.stdout.slice(0, 300)), "\ntarget stderr (sans banner):", JSON.stringify(t.out.stderr.replace(/Debugger listening.*\n|For help.*\n/g, "").slice(0, 600)));
c.close(); killTree(t.child); process.exit(0);
