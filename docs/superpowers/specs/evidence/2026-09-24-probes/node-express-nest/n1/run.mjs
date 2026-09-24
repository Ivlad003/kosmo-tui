import { launch, connect, Registry, HELPER_SRC, conditionFor, fmtFrames, sleep, killTree, shortUrl } from "../cdp.mjs";
import { execSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
const TM = createRequire("/Users/kosmodev/Documents/pet_project/kosmo-callflow/package.json")("@jridgewell/trace-mapping");

const DIR = path.dirname(new URL(import.meta.url).pathname);
const N22 = "/Users/kosmodev/.nvm/versions/node/v22.22.0/bin/node";
const N25 = "/Users/kosmodev/.nvm/versions/node/v25.2.1/bin/node";
const TSX = "/Users/kosmodev/Documents/pet_project/kosmo-callflow/node_modules/tsx/dist/cli.mjs";
const TSXDIR = "/Users/kosmodev/Documents/pet_project/kosmo-callflow/node_modules/tsx";
const TSNODE = "/Users/kosmodev/.npm/_npx/1bf7c3c15bf47d04/node_modules/ts-node/dist/bin.js";

const scenarios = {
  "cjs@22": { node: N22, args: ["--inspect=127.0.0.1:0", "cjs.js"], file: "cjs.js", line: 3 },
  "esm@22": { node: N22, args: ["--inspect=127.0.0.1:0", "esm.mjs"], file: "esm.mjs", line: 3 },
  "strip@22": { node: N22, args: ["--inspect=127.0.0.1:0", "app.ts"], file: "app.ts", line: 5 },
  "strip-flag@22": { node: N22, args: ["--experimental-strip-types", "--inspect=127.0.0.1:0", "app.ts"], file: "app.ts", line: 5 },
  "strip@25": { node: N25, args: ["--inspect=127.0.0.1:0", "app.ts"], file: "app.ts", line: 5 },
  "strip-enum@25": { node: N25, args: ["--inspect=127.0.0.1:0", "enum.ts"], file: "enum.ts", line: 5 },
  "transform@22": { node: N22, args: ["--experimental-transform-types", "--inspect=127.0.0.1:0", "enum.ts"], file: "enum.ts", line: 5 },
  "transform@25": { node: N25, args: ["--experimental-transform-types", "--inspect=127.0.0.1:0", "enum.ts"], file: "enum.ts", line: 5 },
  "tsx-cli@22": { node: N22, args: [TSX, "--inspect=127.0.0.1:0", "app.ts"], file: "app.ts", line: 5 },
  "tsx-import@22": { node: N22, args: ["--inspect=127.0.0.1:0", "--import", `file://${TSXDIR}/dist/loader.mjs`, "app.ts"], file: "app.ts", line: 5 },
  "tsx-cjs@22": { node: N22, args: ["--inspect=127.0.0.1:0", "--require", `${TSXDIR}/dist/cjs/index.cjs`, "cjsapp.cts"], file: "cjsapp.cts", line: 4 },
  "ts-node@22": { node: N22, args: ["--inspect=127.0.0.1:0", TSNODE, "--transpile-only", "app.ts"], file: "app.ts", line: 5, env: { TS_NODE_COMPILER_OPTIONS: '{"module":"commonjs"}' } },
  "ts-node@25": { node: N25, args: ["--inspect=127.0.0.1:0", TSNODE, "--transpile-only", "app.ts"], file: "app.ts", line: 5, env: { TS_NODE_COMPILER_OPTIONS: '{"module":"commonjs"}' } },
};

function tree(rootPid) {
  const ps = execSync("ps -axo pid=,ppid=,command=").toString().trim().split("\n").map((l) => { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l); return { pid: +m[1], ppid: +m[2], cmd: m[3] }; });
  const out = []; const walk = (p, d) => { for (const c of ps.filter((x) => x.ppid === p)) { out.push("  ".repeat(d) + `${c.pid} ${c.cmd.slice(0, 150)}`); walk(c.pid, d + 1); } };
  const me = ps.find((x) => x.pid === rootPid); if (me) out.push(`${me.pid} ${me.cmd.slice(0, 150)}`); walk(rootPid, 1);
  let lsof = ""; try { lsof = execSync(`lsof -a -iTCP -sTCP:LISTEN -P -n -Fpn -p ${[rootPid, ...ps.filter((x) => x.ppid === rootPid).map((x) => x.pid)].join(",")}`).toString().replace(/\n/g, " "); } catch {}
  return out.join("\n") + "\n  lsof LISTEN: " + lsof;
}

async function run(name) {
  const sc = scenarios[name];
  const t = launch({ node: sc.node, args: sc.args, cwd: DIR, env: sc.env || {} });
  const wsUrl = await Promise.race([t.ws, sleep(8000).then(() => null)]);
  console.log(`\n===== ${name}  (${sc.node.split("/").at(-3)} ${sc.args.join(" ").replace(/\/Users\/kosmodev\S*\//g, "…/")})`);
  if (!wsUrl) { console.log("no ws url; stderr:", t.out.stderr.slice(0, 600)); killTree(t.child); return; }
  await sleep(400);
  console.log("process tree:\n" + tree(t.child.pid));
  await sleep(200);
  if (t.out.exit) { console.log("target exited:", JSON.stringify(t.out.exit), "stderr:", t.out.stderr.replace(/Debugger listening.*\n|For help.*\n/g, "").slice(0, 700)); return; }
  const c = await connect(wsUrl);
  const reg = new Registry();
  c.on("Debugger.scriptParsed", (p) => reg.add(p));
  const hits = [], errs = [];
  c.on("Runtime.consoleAPICalled", (p) => { if (p.context && p.context.startsWith("kosmo-tui")) hits.push(p); });
  c.on("Runtime.exceptionThrown", (p) => errs.push(p.exceptionDetails));
  await c.send("Runtime.enable");
  await c.send("Debugger.enable");
  await c.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
  await sleep(300);
  const pid = await c.send("Runtime.evaluate", { expression: "process.pid", throwOnSideEffect: true });
  console.log("process.pid via CDP:", pid.result.value, "spawned pid:", t.child.pid);
  const user = [...reg.scripts.values()].filter((s) => s.url && !s.url.startsWith("node:") && !/node_modules/.test(s.url) && !s.url.startsWith("internal"));
  console.log(`scripts: total=${reg.scripts.size}, user=${user.length}; first node_modules url sample: ${[...reg.scripts.values()].find((s) => /node_modules/.test(s.url))?.url?.slice(0, 120) ?? "-"}`);
  for (const s of user) console.log(`  url=${s.url}  isModule=${s.isModule} hasSourceURL=${s.hasSourceURL} startLine=${s.startLine} len=${s.length} sourceMapURL=${s.sourceMapURL ? (s.sourceMapURL.startsWith("data:") ? `data:(${s.sourceMapURL.length}B)` : s.sourceMapURL) : "''"} embedder=${s.embedderName ?? "-"}`);
  // resolution
  await c.send("Runtime.evaluate", { expression: HELPER_SRC });
  let set = 0;
  for (const s of user) {
    let gen = null;
    const m = reg.mapFor(s);
    if (m) {
      const src = m.resolvedSources.find((x) => x && x.endsWith("/" + sc.file));
      console.log(`  map for ${shortUrl(s.url, DIR)}: sources=${JSON.stringify(m.sources)} sourceRoot=${JSON.stringify(m.sourceRoot ?? null)} sourcesContent=${m.sourcesContent ? "yes" : "no"} names=${m.names.length}`);
      if (src) { const g = TM.generatedPositionFor(m, { source: src, line: sc.line, column: 0, bias: TM.LEAST_UPPER_BOUND }); const e = TM.generatedPositionFor(m, { source: src, line: sc.line + 1, column: 0, bias: TM.LEAST_UPPER_BOUND }); gen = g.line ? { line0: g.line - 1, col0: g.column, end: e.line ? { lineNumber: e.line - 1, columnNumber: e.column } : { lineNumber: g.line, columnNumber: 0 } } : null; }
    } else if (s.url.endsWith("/" + sc.file)) gen = { line0: sc.line - 1, col0: 0, end: { lineNumber: sc.line, columnNumber: 0 } };
    if (!gen) continue;
    const pos = await c.send("Debugger.getPossibleBreakpoints", { start: { scriptId: s.scriptId, lineNumber: gen.line0, columnNumber: gen.col0 }, end: { scriptId: s.scriptId, ...gen.end } });
    const loc = pos.locations[0] ?? { scriptId: s.scriptId, lineNumber: gen.line0, columnNumber: 0 };
    const bp = await c.send("Debugger.setBreakpoint", { location: { scriptId: loc.scriptId, lineNumber: loc.lineNumber, columnNumber: loc.columnNumber }, condition: conditionFor("tp1", ["item", "qty", "total"]) });
    console.log(`  tracepoint: original ${sc.file}:${sc.line} -> generated ${loc.lineNumber + 1}:${loc.columnNumber + 1} (bp ${bp.breakpointId.slice(0, 40)}) actual=${bp.actualLocation.lineNumber + 1}:${bp.actualLocation.columnNumber + 1} backmap=${reg.original(s.scriptId, bp.actualLocation.lineNumber, bp.actualLocation.columnNumber) ?? "(no map)"}`);
    set++;
  }
  let paused = 0; c.on("Debugger.paused", () => paused++);
  await sleep(700);
  console.log(`hits=${hits.length} paused=${paused} exceptions=${errs.length}${errs[0] ? " " + errs[0].exception?.description?.slice(0, 120) : ""}`);
  if (hits[0]) {
    const h = hits[0];
    console.log(`  consoleAPICalled type=${h.type} context=${h.context} args=${h.args.map((a) => a.value ?? a.type).join(" | ").slice(0, 300)}`);
    console.log(fmtFrames(reg, h.stackTrace, DIR));
  }
  console.log("stdout of target (should not contain KOSMO_TP):", JSON.stringify(t.out.stdout.slice(0, 200)), "stderr tail:", JSON.stringify(t.out.stderr.replace(/Debugger listening.*\n|For help.*\n/g, "").slice(0, 300)));
  c.close();
  try { execSync(`pkill -KILL -P ${t.child.pid}`); } catch {}
  killTree(t.child);
  await sleep(200);
}

const pick = process.argv.slice(2);
for (const n of pick.length ? pick : Object.keys(scenarios)) { try { await run(n); } catch (e) { console.log("RUN FAILED:", e.message || e.type); } }
process.exit(0);
