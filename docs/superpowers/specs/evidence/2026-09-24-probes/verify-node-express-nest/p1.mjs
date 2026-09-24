import { launch, connect, sleep, decodeMap } from "./c.mjs";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
const TM = createRequire("/Users/kosmodev/Documents/pet_project/kosmo-callflow/package.json")("@jridgewell/trace-mapping");
const N22 = "/Users/kosmodev/.nvm/versions/node/v22.22.0/bin/node", N25 = "/Users/kosmodev/.nvm/versions/node/v25.2.1/bin/node";
const TSX = "/Users/kosmodev/Documents/pet_project/kosmo-callflow/node_modules/tsx/dist/cli.mjs";
const TSNODE = "/Users/kosmodev/.npm/_npx/1bf7c3c15bf47d04/node_modules/ts-node/dist/bin.js";
const D = new URL("./n/", import.meta.url).pathname;
const sc = {
  cjs22: [N22, ["--inspect=127.0.0.1:0", "cjs.js"], "cjs.js"],
  esm22: [N22, ["--inspect=127.0.0.1:0", "esm.mjs"], "esm.mjs"],
  strip22: [N22, ["--inspect=127.0.0.1:0", "app.ts"], "app.ts"],
  strip25: [N25, ["--inspect=127.0.0.1:0", "app.ts"], "app.ts"],
  transform22: [N22, ["--experimental-transform-types", "--inspect=127.0.0.1:0", "enum.ts"], "enum.ts"],
  transform25: [N25, ["--experimental-transform-types", "--inspect=127.0.0.1:0", "enum.ts"], "enum.ts"],
  tsx22: [N22, [TSX, "--inspect=127.0.0.1:0", "app.ts"], "app.ts"],
  tsnode22: [N22, ["--inspect=127.0.0.1:0", TSNODE, "--transpile-only", "app.ts"], "app.ts", { TS_NODE_COMPILER_OPTIONS: '{"module":"commonjs"}' }],
};
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(sc)) {
  const [node, args, file, env] = sc[name];
  const t = launch(node, args, { cwd: D, env });
  const url = await Promise.race([t.ws, sleep(8000).then(() => null)]);
  if (!url) { console.log(name, "NO WS", t.out.stderr.slice(0, 300)); t.ch.kill("SIGKILL"); continue; }
  await sleep(500);
  const c = await connect(url); const scripts = [];
  c.on("Debugger.scriptParsed", (p) => scripts.push(p));
  await c.send("Debugger.enable"); await sleep(300);
  const pid = (await c.send("Runtime.evaluate", { expression: "process.pid", returnByValue: true })).result.value;
  const s = scripts.find((x) => x.url.endsWith("/" + file));
  const src = (await c.send("Debugger.getScriptSource", { scriptId: s.scriptId })).scriptSource;
  const L = src.split("\n");
  const m = decodeMap(s);
  console.log(`\n== ${name} spawned=${t.ch.pid} cdpPid=${pid} scripts=${scripts.length} wasm=${scripts.filter(x=>x.url.startsWith("wasm:")).map(x=>x.url+" len="+x.length).join(",")}`);
  console.log(` url=${s.url} isModule=${s.isModule} hasSourceURL=${s.hasSourceURL} sourceMapURL=${s.sourceMapURL ? (s.sourceMapURL.startsWith("data:") ? "data:" + s.sourceMapURL.length + "B" : s.sourceMapURL) : "''"} genLines=${L.length}`);
  console.log(` tail=${JSON.stringify(L.slice(-2).map(x=>x.slice(0,90)))}`);
  console.log(` gen1=${JSON.stringify(L[0].slice(0,100))} gen2=${JSON.stringify((L[1]||"").slice(0,100))} gen2len=${(L[1]||"").length}`);
  if (m) { const mm = new TM.TraceMap(m, s.url); console.log(` map.sources=${JSON.stringify(m.sources)} sourceRoot=${JSON.stringify(m.sourceRoot)} sourcesContent=${!!m.sourcesContent} resolved=${JSON.stringify(mm.resolvedSources)}`);
    const all = TM.allGeneratedPositionsFor(mm, { source: mm.resolvedSources[0], line: 5, column: 0 }); const lub = TM.generatedPositionFor(mm, { source: mm.resolvedSources[0], line: 5, column: 0, bias: TM.LEAST_UPPER_BOUND });
    console.log(` orig5 -> LUB ${lub.line}:${lub.column}; all(line5,col0)=${JSON.stringify(all).slice(0,200)}`); }
  c.close(); try { execSync(`pkill -KILL -P ${t.ch.pid}`); } catch {} t.ch.kill("SIGKILL"); await sleep(200);
}
process.exit(0);
