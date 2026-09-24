import { launch, connect, sleep, HELPER_SRC, conditionFor } from "../cdp.mjs";
import { execSync } from "node:child_process";
import path from "node:path";
const DIR = path.dirname(new URL(import.meta.url).pathname);
const N22 = "/Users/kosmodev/.nvm/versions/node/v22.22.0/bin/node";
const cli = process.argv[2] === "cli";
if (!cli) execSync(`${N22} node_modules/@nestjs/cli/bin/nest.js build`, { cwd: DIR, stdio: "ignore" });
const t = launch({ node: N22, args: cli ? ["node_modules/@nestjs/cli/bin/nest.js", "start", "--debug", "127.0.0.1:0"] : ["--inspect=127.0.0.1:0", "dist/main.js"], cwd: DIR, env: { PORT: "0" } });
const ws = await t.ws; let port; for (let i = 0; i < 100 && !port; i++) { await sleep(100); port = /PORT (\d+)/.exec(t.out.stdout)?.[1]; }
const c = await connect(ws); const hits = [];
c.on("Runtime.consoleAPICalled", (p) => { if (p.context?.startsWith("kosmo-tui")) hits.push(p); });
await c.send("Runtime.enable"); await c.send("Debugger.enable"); await sleep(300);
await c.send("Runtime.evaluate", { expression: HELPER_SRC });
await c.send("Debugger.setBreakpointByUrl", { urlRegex: "dist/http-error\\.filter\\.js$", lineNumber: 12, condition: conditionFor("f", ["String(exception.stack).split('\\n').slice(0,3).join(' | ')"]) });
await fetch(`http://127.0.0.1:${port}/cart/42/items`, { method: "POST", headers: { authorization: "x", "content-type": "application/json" }, body: '{"qty":11}' }).then((r) => r.text());
await sleep(200);
console.log(cli ? "nest start --debug (--enable-source-maps):" : "node --inspect dist/main.js (no source maps):", JSON.parse(hits[0].args[2].value)[Object.keys(JSON.parse(hits[0].args[2].value))[0]].replace(/\/private\/tmp\/\S*\/nest\//g, "<root>/"));
c.close(); try { execSync(`pkill -KILL -P ${t.child.pid}`); } catch {} t.child.kill("SIGKILL"); process.exit(0);
