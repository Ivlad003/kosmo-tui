// node --watch: who listens, restart behaviour, SIGUSR1 to parent
import { spawn, execSync } from "node:child_process";
import { connect, sleep } from "./c.mjs";
import { utimesSync, appendFileSync } from "node:fs";
const NODE = process.argv[2];
const D = new URL("./n/", import.meta.url).pathname;
const ps = () => execSync("ps -axo pid=,ppid=,command=").toString().split("\n").map(l => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map(m => ({ pid: +m[1], ppid: +m[2], cmd: m[3].slice(0, 120) }));
const listen = (pids) => { try { return execSync(`lsof -a -iTCP -sTCP:LISTEN -P -n -Fpn -p ${pids.join(",")}`).toString().replace(/\n/g, " "); } catch { return "(none)"; } };
const withInspect = process.argv[3] === "inspect";
const ch = spawn(NODE, withInspect ? ["--watch", "--inspect=127.0.0.1:9261", "w.js"] : ["--watch", "w.js"], { cwd: D, stdio: ["ignore", "pipe", "pipe"] });
let err = "", out = ""; const t0 = Date.now(); ch.stderr.on("data", d => { err += d; }); ch.stdout.on("data", d => out += d);
await sleep(1200);
let kids = ps().filter(p => p.ppid === ch.pid);
console.log("parent", ch.pid, "kids", JSON.stringify(kids), "listen", listen([ch.pid, ...kids.map(k => k.pid)]));
if (withInspect) {
  const m = /ws:\/\/\S+/.exec(err); const c = await connect(m[0]); let destroyed = null, closedAt = null;
  c.on("Runtime.executionContextDestroyed", () => destroyed = Date.now() - t0);
  c.closed.then(() => closedAt = Date.now() - t0);
  await c.send("Runtime.enable");
  const pid = (await c.send("Runtime.evaluate", { expression: "process.pid", returnByValue: true })).result.value;
  console.log("attached pid", pid);
  appendFileSync(D + "w.js", "\n"); const te = Date.now() - t0;
  await sleep(1500);
  const kids2 = ps().filter(p => p.ppid === ch.pid);
  console.log(`edit@${te}ms socketClosed@${closedAt} ctxDestroyed@${destroyed} newKids ${JSON.stringify(kids2)} listen ${listen([ch.pid, ...kids2.map(k => k.pid)])}`);
  console.log("stderr lines:", JSON.stringify(err.split("\n").filter(l => /listening|Waiting|Restarting|disconnect/i.test(l)).map(l=>l.slice(0,70))));
  console.log("stdout:", JSON.stringify(out.slice(0,200)));
} else {
  process.kill(ch.pid, "SIGUSR1"); await sleep(1000);
  console.log("after USR1 to parent: alive?", (() => { try { process.kill(ch.pid, 0); return "yes"; } catch { return "no"; } })(), "listen", listen([ch.pid, ...kids.map(k => k.pid)]), "stderr", JSON.stringify(err.slice(0, 200)));
  process.kill(kids[0].pid, "SIGUSR1"); await sleep(1000);
  console.log("after USR1 to child:", listen([ch.pid, ...kids.map(k => k.pid)]));
}
for (const k of ps().filter(p => p.ppid === ch.pid)) try { process.kill(k.pid, "SIGKILL"); } catch {}
ch.kill("SIGKILL"); await sleep(300);
console.log("left:", JSON.stringify(ps().filter(p => /w\.js/.test(p.cmd) && /watch|inspect/.test(p.cmd))));
process.exit(0);
