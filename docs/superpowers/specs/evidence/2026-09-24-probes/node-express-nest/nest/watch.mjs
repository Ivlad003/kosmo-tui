// nest start --debug <port> --watch [-b swc]: process layout, restart with an attached client
import { connect, sleep, HELPER_SRC, conditionFor } from "../cdp.mjs";
import { spawn, execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const DIR = path.dirname(new URL(import.meta.url).pathname);
const N22 = "/Users/kosmodev/.nvm/versions/node/v22.22.0/bin/node";
const swc = process.argv[2] === "swc";
const PORT = swc ? 9264 : 9263;
const args = [path.join(DIR, "node_modules/@nestjs/cli/bin/nest.js"), "start", "--debug", `127.0.0.1:${PORT}`, "--watch", ...(swc ? ["-b", "swc"] : [])];
const p = spawn(N22, args, { cwd: DIR, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: "0" } });
const t0 = Date.now(); const st = () => ((Date.now() - t0) / 1000).toFixed(2) + "s";
let log = "";
const onData = (tag) => (d) => { for (const l of String(d).replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter(Boolean)) log += `[${st()}] ${tag} ${l.slice(0, 140)}\n`; };
p.stdout.on("data", onData("out")); p.stderr.on("data", onData("err"));
function tree() {
  const ps = execSync("ps -axo pid=,ppid=,command=").toString().trim().split("\n").map((l) => { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l); return { pid: +m[1], ppid: +m[2], cmd: m[3] }; });
  const out = [], all = [p.pid]; const walk = (x, d) => { for (const c of ps.filter((y) => y.ppid === x)) { all.push(c.pid); out.push("  ".repeat(d) + `${c.pid} ${c.cmd.replace(/\/\S*\/node_modules\//g, "nm:/").replace(/\/private\/tmp\/\S*\/nest\//g, "<root>/").slice(0, 150)}`); walk(c.pid, d + 1); } };
  out.push(`${p.pid} ${ps.find((x) => x.pid === p.pid)?.cmd.replace(/\/\S*\/node_modules\//g, "nm:/").slice(0, 150)}`); walk(p.pid, 1);
  let l = ""; try { l = execSync(`lsof -a -iTCP -sTCP:LISTEN -P -n -Fpn -p ${all.join(",")}`).toString().replace(/\n/g, " "); } catch {}
  return { text: out.join("\n") + "\n  LISTEN: " + l, all };
}
async function waitTarget(prevId) {
  for (let i = 0; i < 150; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (l[0] && l[0].id !== prevId) return l[0]; } catch {} await sleep(100); }
  return null;
}
await waitTarget(null);
await sleep(5000);
const tg1 = await waitTarget(null);
log += `[${st()}] (after 5s settle) current target ${tg1.id.slice(-4)}\n`;
console.log(`== nest start --debug --watch${swc ? " -b swc" : ""}\n` + tree().text);
let c; try { c = await connect(`ws://127.0.0.1:${PORT}/${tg1.id}`); } catch (e) { console.log(log + "CONNECT FAILED"); const { all } = tree(); for (const x of all.reverse()) try { process.kill(x, "SIGKILL"); } catch {} process.exit(0); }
let closed = null, destroyed = null;
c.on("Runtime.executionContextDestroyed", () => (destroyed = st()));
await c.send("Runtime.enable"); await c.send("Debugger.enable");
const pid1 = (await c.send("Runtime.evaluate", { expression: "process.pid" })).result.value;
await c.send("Runtime.evaluate", { expression: HELPER_SRC });
await c.send("Debugger.setBreakpointByUrl", { urlRegex: "dist/cart\\.service\\.js$", lineNumber: 13, condition: conditionFor("svc", ["id"]) });
log += `[${st()}] attached to pid ${pid1} (target ${tg1.id.slice(-4)})\n`;
const f = path.join(DIR, "src/cart.service.ts"); const orig = readFileSync(f, "utf8");
writeFileSync(f, orig.replace("qty: 1 }", "qty: 2 }")); log += `[${st()}] edited src/cart.service.ts\n`;
const tg2 = await waitTarget(tg1.id);
log += `[${st()}] new target ${tg2?.id.slice(-4)}; executionContextDestroyed on old socket: ${destroyed}\n`;
await sleep(1500);
console.log("after restart:\n" + tree().text);
const c2 = await connect(`ws://127.0.0.1:${PORT}/${tg2.id}`);
const pid2 = (await c2.send("Runtime.evaluate", { expression: "process.pid" })).result.value;
const helperGone = (await c2.send("Runtime.evaluate", { expression: 'typeof globalThis[Symbol.for("kosmo-tui")]' })).result.value;
log += `[${st()}] new pid ${pid2} (old ${pid1}); helper in new process: ${helperGone}\n`;
writeFileSync(f, orig);
console.log(log);
c2.close();
const { all } = tree(); for (const x of all.reverse()) try { process.kill(x, "SIGKILL"); } catch {}
await sleep(300); process.exit(0);
