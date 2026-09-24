import { launch, connect, Registry, HELPER_SRC, conditionFor, sleep, killTree, shortUrl } from "../cdp.mjs";
import { execSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
const TM = createRequire("/Users/kosmodev/Documents/pet_project/kosmo-callflow/package.json")("@jridgewell/trace-mapping");

const DIR = path.dirname(new URL(import.meta.url).pathname);
const N22 = "/Users/kosmodev/.nvm/versions/node/v22.22.0/bin/node";
const N25 = "/Users/kosmodev/.nvm/versions/node/v25.2.1/bin/node";
const NEST = path.join(DIR, "node_modules/@nestjs/cli/bin/nest.js");
const mode = process.argv[2];
const verbose = process.argv.includes("-v");
const modes = {
  "direct-tsc": () => { execSync(`${N22} ${NEST} build`, { cwd: DIR, stdio: "ignore" }); return { node: N22, args: ["--inspect=127.0.0.1:0", "dist/main.js"] }; },
  "direct-swc": () => { execSync(`${N22} ${NEST} build -b swc`, { cwd: DIR, stdio: "ignore" }); return { node: N22, args: ["--inspect=127.0.0.1:0", "dist/main.js"] }; },
  "cli-debug": () => ({ node: N22, args: [NEST, "start", "--debug", "127.0.0.1:0"] }),
  "cli-swc-debug": () => ({ node: N22, args: [NEST, "start", "-b", "swc", "--debug", "127.0.0.1:0"] }),
  "tsx": () => ({ node: N22, args: ["--inspect=127.0.0.1:0", "--import", "tsx", "src/main.ts"] }),
  "ts-node": () => ({ node: N22, args: ["--inspect=127.0.0.1:0", "/Users/kosmodev/.npm/_npx/1bf7c3c15bf47d04/node_modules/ts-node/dist/bin.js", "--transpile-only", "src/main.ts"] }),
  "strip25": () => ({ node: N25, args: ["--inspect=127.0.0.1:0", "src/main.ts"] }),
};
const TPS = [
  { id: "middleware", file: "logger.middleware.ts", line: 6, names: ["req"] },
  { id: "guard", file: "auth.guard.ts", line: 6, names: ["context"] },
  { id: "interceptor.before", file: "timing.interceptor.ts", line: 7, names: ["context", "next"] },
  { id: "pipe", file: "parse-id.pipe.ts", line: 6, names: ["value", "metadata"] },
  { id: "handler", file: "cart.controller.ts", line: 17, names: ["id", "auth", "this"] },
  { id: "service", file: "cart.service.ts", line: 7, names: ["id"] },
  { id: "interceptor.after", file: "timing.interceptor.ts", line: 10, names: ["body", "started"] },
  { id: "filter", file: "http-error.filter.ts", line: 6, names: ["exception", "host"] },
];
const PAUSE = { file: "cart.controller.ts", line: 23 };

const cfg = modes[mode]();
const t = launch({ node: cfg.node, args: cfg.args, cwd: DIR, env: { PORT: "0" } });
const ws = await Promise.race([t.ws, sleep(20000).then(() => null)]);
let port; for (let i = 0; i < 100 && !port && ws; i++) { await sleep(100); port = /PORT (\d+)/.exec(t.out.stdout)?.[1]; if (t.out.exit) break; }
console.log(`===== ${mode}: ${cfg.args.join(" ").replace(/\/\S*\/node_modules\//g, "nm:/")}`);
function tree(rootPid) {
  const ps = execSync("ps -axo pid=,ppid=,command=").toString().trim().split("\n").map((l) => { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l); return { pid: +m[1], ppid: +m[2], cmd: m[3] }; });
  const out = [], all = [rootPid]; const walk = (p, d) => { for (const c of ps.filter((x) => x.ppid === p)) { all.push(c.pid); out.push("  ".repeat(d) + `${c.pid} ${c.cmd.replace(/\/\S*\/node_modules\//g, "nm:/").replace(/\/Users\/kosmodev\/.nvm\/versions\/node\//g, "").slice(0, 170)}`); walk(c.pid, d + 1); } };
  const me = ps.find((x) => x.pid === rootPid); if (me) out.push(`${me.pid} ${me.cmd.replace(/\/\S*\/node_modules\//g, "nm:/").replace(/\/Users\/kosmodev\/.nvm\/versions\/node\//g, "").slice(0, 170)}`); walk(rootPid, 1);
  let lsof = ""; try { lsof = execSync(`lsof -a -iTCP -sTCP:LISTEN -P -n -Fpn -p ${all.join(",")}`).toString().replace(/\n/g, " "); } catch {}
  return { text: out.join("\n") + "\n  LISTEN: " + lsof, pids: all };
}
const tr = tree(t.child.pid);
console.log("process tree:\n" + tr.text);
if (!ws || !port) { console.log("NO APP. stdout:", t.out.stdout.slice(0, 500), "\nstderr:", t.out.stderr.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 1500)); for (const p of tr.pids.reverse()) try { process.kill(p, "SIGKILL"); } catch {} process.exit(0); }
const c = await connect(ws);
const reg = new Registry();
c.on("Debugger.scriptParsed", (p) => { if (!p.url.startsWith("kosmo-tui://")) reg.add(p); });
const hits = [], pauses = [], errs = [];
c.on("Runtime.consoleAPICalled", (p) => { if (p.context?.startsWith("kosmo-tui")) hits.push(p); });
c.on("Runtime.exceptionThrown", (p) => errs.push(p.exceptionDetails));
c.on("Debugger.paused", async (p) => { pauses.push(p); const local = p.callFrames[0].scopeChain.find((s) => s.type === "local"); if (local) p._local = (await c.send("Runtime.getProperties", { objectId: local.object.objectId, ownProperties: true })).result.map((x) => `${x.name}=${x.value?.description ?? x.value?.value ?? x.value?.type}`.slice(0, 60)); const th = p.callFrames[0].this; if (th.objectId) p._this = (await c.send("Runtime.getProperties", { objectId: th.objectId, ownProperties: true })).result.map((x) => `${x.name}=${x.value?.className ?? x.value?.type}`); await c.send("Debugger.resume"); });
await c.send("Runtime.enable"); await c.send("Debugger.enable");
await c.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
await sleep(400);
const pid = (await c.send("Runtime.evaluate", { expression: "process.pid" })).result.value;
console.log(`CDP process.pid=${pid}; execArgv=${(await c.send("Runtime.evaluate", { expression: "JSON.stringify(process.execArgv)" })).result.value}; sourceMapsEnabled=${(await c.send("Runtime.evaluate", { expression: "String(process.sourceMapsEnabled)" })).result.value}`);
const user = [...reg.scripts.values()].filter((s) => s.url && !/node_modules|^node:|^wasm:/.test(s.url) && s.url.startsWith("file:"));
console.log(`scripts: ${reg.scripts.size} total, user=${user.length}, node_modules=${[...reg.scripts.values()].filter((s) => /node_modules/.test(s.url)).length}`);
for (const s of user.slice(0, verbose ? 99 : 3)) { const m = reg.mapFor(s); console.log(`  ${shortUrl(s.url, DIR)} sourceMapURL=${s.sourceMapURL?.startsWith("data:") ? "data:(" + s.sourceMapURL.length + "B)" : JSON.stringify(s.sourceMapURL)} map.sources=${JSON.stringify(m?.sources)} sourceRoot=${JSON.stringify(m?.sourceRoot ?? null)} sourcesContent=${m?.sourcesContent ? "yes" : "no"} resolved=${m?.resolvedSources?.[0]?.replace(DIR, "<root>")}`); }
await c.send("Runtime.evaluate", { expression: HELPER_SRC + "\n//# sourceURL=kosmo-tui://helper" });

async function resolveAndSet(file, line, condition) {
  const out = [];
  for (const s of user) {
    const m = reg.mapFor(s); let g, e;
    if (m) {
      const src = m.resolvedSources.find((x) => x && x.endsWith("/src/" + file)); if (!src) continue;
      g = TM.generatedPositionFor(m, { source: src, line, column: 0, bias: TM.LEAST_UPPER_BOUND });
      e = TM.generatedPositionFor(m, { source: src, line: line + 1, column: 0, bias: TM.LEAST_UPPER_BOUND });
      if (!g.line) continue;
      g = { lineNumber: g.line - 1, columnNumber: g.column }; e = e.line ? { lineNumber: e.line - 1, columnNumber: e.column } : { lineNumber: g.lineNumber + 1, columnNumber: 0 };
    } else if (s.url.endsWith("/src/" + file)) { g = { lineNumber: line - 1, columnNumber: 0 }; e = { lineNumber: line, columnNumber: 0 }; }
    else continue;
    const pos = await c.send("Debugger.getPossibleBreakpoints", { start: { scriptId: s.scriptId, ...g }, end: { scriptId: s.scriptId, ...e } });
    const loc = pos.locations[0] ?? { scriptId: s.scriptId, ...g };
    const r = await c.send("Debugger.setBreakpoint", { location: { scriptId: s.scriptId, lineNumber: loc.lineNumber, columnNumber: loc.columnNumber }, ...(condition ? { condition } : {}) });
    out.push(`${shortUrl(s.url, DIR)}:${r.actualLocation.lineNumber + 1}:${r.actualLocation.columnNumber + 1} (back=${reg.original(s.scriptId, r.actualLocation.lineNumber, r.actualLocation.columnNumber)?.replace(/.*\/src\//, "src/")})`);
  }
  return out;
}
for (const tp of TPS) tp.res = await resolveAndSet(tp.file, tp.line, conditionFor(tp.id, tp.names) + `\n//# sourceURL=kosmo-tui://tp/${tp.id}`);
const pres = await resolveAndSet(PAUSE.file, PAUSE.line, null);
console.log("resolution:"); for (const tp of TPS) console.log(`  ${tp.id.padEnd(19)} src/${tp.file}:${tp.line} -> ${tp.res.join(" | ") || "UNRESOLVED"}`); console.log(`  PAUSE               src/${PAUSE.file}:${PAUSE.line} -> ${pres.join(" | ")}`);

const base = `http://127.0.0.1:${port}`; const H = { authorization: "Bearer s3cr3t", cookie: "sid=1", "content-type": "application/json" };
const reqs = [
  ["GET /cart/42 (ok)", "/cart/42", { headers: H }],
  ["GET /cart/abc (pipe throws)", "/cart/abc", { headers: H }],
  ["GET /cart/42 (no auth, guard false)", "/cart/42", {}],
  ["POST /cart/42/items qty=11 (handler throws; pause bp)", "/cart/42/items", { method: "POST", headers: H, body: JSON.stringify({ qty: 11 }) }],
];
const perReq = [];
for (const [label, p, init] of reqs) {
  const before = hits.length; const t0 = performance.now();
  let status = ""; try { const r = await fetch(base + p, { ...init, signal: AbortSignal.timeout(3000) }); status = `${r.status} ${(await r.text()).slice(0, 70)}`; } catch (e) { status = "FAILED " + e.message; }
  await sleep(50);
  perReq.push({ label, status, ms: (performance.now() - t0).toFixed(1), order: hits.slice(before).map((h) => h.args[1].value) });
}
console.log("\nlifecycle order per request (tracepoint hit order):");
for (const r of perReq) console.log(`  ${r.label}: ${r.status} [${r.ms} ms]\n     ${r.order.join(" -> ")}`);
for (const e of errs) console.log(`  exceptionThrown: url=${e.url} ${JSON.stringify(e.exception?.description?.slice(0, 100))}`);

function frames(st, { onlyUser = false } = {}) {
  const lines = []; let cur = st, d = 0, skippedNm = 0;
  const flush = () => { if (skippedNm) { lines.push(`      … ${skippedNm} node_modules/node: frames`); skippedNm = 0; } };
  while (cur && d < 16) {
    if (d > 0) { flush(); lines.push(`    -- async: ${cur.description} --`); }
    for (const f of cur.callFrames) {
      const url = f.url || reg.scripts.get(f.scriptId ?? f.location?.scriptId)?.url || "";
      const ln = f.lineNumber ?? f.location.lineNumber, col = f.columnNumber ?? f.location.columnNumber;
      const isUser = url.startsWith("file:") && !/node_modules/.test(url);
      if (url.startsWith("kosmo-tui://")) continue;
      if (onlyUser && !isUser) { skippedNm++; continue; }
      flush();
      const orig = reg.original(f.scriptId ?? f.location.scriptId, ln, col);
      lines.push(`    ${(f.functionName || "(anonymous)").padEnd(42)} ${shortUrl(url, DIR)}:${ln + 1}:${col + 1}${orig ? "  => " + orig.replace(/.*\/src\//, "src/") : ""}`);
    }
    cur = cur.parent; d++;
  }
  flush(); return lines.join("\n");
}
const shown = new Set();
for (const h of hits) {
  const id = h.args[1].value; if (shown.has(id)) continue; shown.add(id);
  const json = h.args[2].value;
  console.log(`\n--- ${id}: ${Buffer.byteLength(json)} B  ${json.length > 700 ? json.slice(0, 700) + "…" : json}`);
  console.log(frames(h.stackTrace, { onlyUser: !verbose && !["guard", "filter", "interceptor.after"].includes(id) }));
}
for (const p of pauses.slice(0, 1)) {
  console.log(`\n--- PAUSED at handler throw line: ${p.callFrames.length} sync frames`);
  for (const f of p.callFrames.slice(0, verbose ? 99 : 12)) { const url = reg.scripts.get(f.location.scriptId)?.url; const orig = reg.original(f.location.scriptId, f.location.lineNumber, f.location.columnNumber); console.log(`    ${(f.functionName || "(anonymous)").padEnd(42)} ${shortUrl(url, DIR)}:${f.location.lineNumber + 1}${orig ? " => " + orig.replace(/.*\/src\//, "src/") : ""}  frame.url=${JSON.stringify(f.url)} this=${f.this.className ?? f.this.type} scopes=[${f.scopeChain.map((s) => s.type).join(",")}]`); }
  console.log(`    local scope (Runtime.getProperties before resume): ${p._local?.join(", ")}\n    this own props: ${p._this?.join(", ")}`);
}
console.log("\ntarget stderr tail:", JSON.stringify(t.out.stderr.replace(/\x1b\[[0-9;]*m/g, "").replace(/Debugger listening.*\n|For help.*\n/g, "").slice(-500)));
c.close();
for (const p of tr.pids.reverse()) try { process.kill(p, "SIGKILL"); } catch {}
await sleep(200); process.exit(0);
