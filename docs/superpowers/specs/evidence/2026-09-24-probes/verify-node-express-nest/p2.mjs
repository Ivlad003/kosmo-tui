// tsx without --inspect, then SIGUSR1 to child vs parent; check map sourcesContent
import { spawn, execSync } from "node:child_process";
import { connect, sleep, decodeMap } from "./c.mjs";
const N22 = "/Users/kosmodev/.nvm/versions/node/v22.22.0/bin/node";
const TSX = "/Users/kosmodev/Documents/pet_project/kosmo-callflow/node_modules/tsx/dist/cli.mjs";
const D = new URL("./n/", import.meta.url).pathname;
const kids = (p) => execSync("ps -axo pid=,ppid=,command=").toString().split("\n").map(l => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).filter(m => +m[2] === p).map(m => ({ pid: +m[1], cmd: m[3].slice(0, 140) }));
const listen = (pids) => { try { return execSync(`lsof -a -iTCP -sTCP:LISTEN -P -n -Fpn -p ${pids.join(",")}`).toString().replace(/\n/g, " "); } catch { return "(none)"; } };
const mode = process.argv[2];
const ch = spawn(N22, mode === "watch" ? [TSX, "watch", "app.ts"] : [TSX, "app.ts"], { cwd: D, stdio: ["ignore", "pipe", "pipe"] });
let err = ""; ch.stderr.on("data", d => err += d);
await sleep(1500);
const k1 = kids(ch.pid); console.log("parent", ch.pid, "children", JSON.stringify(k1));
const app = k1.find(k => /app\.ts/.test(k.cmd)) ?? k1[0];
const target = process.argv[3] === "parent" ? ch.pid : app.pid;
process.kill(target, "SIGUSR1"); await sleep(800);
console.log("signalled", target, "listen:", listen([ch.pid, app.pid]));
const m = /ws:\/\/\S+/.exec(err);
if (m) {
  const c = await connect(m[0]); const sc = []; c.on("Debugger.scriptParsed", p => sc.push(p));
  await c.send("Debugger.enable"); await sleep(300);
  const pid = (await c.send("Runtime.evaluate", { expression: "process.pid", returnByValue: true })).result.value;
  const s = sc.find(x => x.url.endsWith("/app.ts"));
  const j = await (await fetch(m[0].replace("ws://", "http://").replace(/\/[^/]+$/, "/json/list"))).json();
  console.log("cdp pid", pid, "json/list title/url", j[0].title, j[0].url);
  console.log("user script:", s ? `${s.url} map=${!!s.sourceMapURL} sourcesContent=${!!decodeMap(s)?.sourcesContent}` : "none (supervisor?)");
  c.close();
}
try { execSync(`pkill -KILL -P ${app.pid}`); } catch {} try { process.kill(app.pid, "SIGKILL"); } catch {} ch.kill("SIGKILL"); await sleep(300);
console.log("left:", JSON.stringify(kids(ch.pid)));
process.exit(0);
