// Throwaway probe: what does kosmo-tui see when `next dev` restarts next-server (next.config edit)?
// Usage: node probe-restart.mjs <appDir> <webpack|turbopack> <httpPort> <outJson>
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sleep, waitFor, getJson, connect, processTree, listeningPorts } from "./cdp.mjs";

const [, , appDirArg, bundler, httpPortArg, outJson] = process.argv;
const appDir = path.resolve(appDirArg);
const httpPort = Number(httpPortArg);
const major = Number(JSON.parse(readFileSync(path.join(appDir, "node_modules/next/package.json"), "utf8")).version.split(".")[0]);
const args = [path.join(appDir, "node_modules/next/dist/bin/next"), "dev", "-p", String(httpPort)];
if (bundler === "turbopack" && major < 16) args.push("--turbopack");
if (bundler === "webpack" && major >= 16) args.push("--webpack");
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", FORCE_COLOR: "0", NODE_OPTIONS: "--inspect=127.0.0.1:9400" };
const child = spawn(process.execPath, args, { cwd: appDir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));
const R = {};
const cfg = path.join(appDir, "next.config.mjs");
const origCfg = readFileSync(cfg, "utf8");
const killAll = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
process.on("exit", () => { writeFileSync(cfg, origCfg); killAll(); });
await waitFor(() => /Ready in/.test(out), 60000);
const tree0 = processTree(child.pid);
R.before = tree0.map((p) => ({ pid: p.pid, cmd: p.command.slice(0, 40), cwdSameAsApp: null }));
// cwd of each process, as spec 9.2 step 5 reads it
for (const p of R.before) {
  const o = await new Promise((r) => { const c = spawn("lsof", ["-a", "-p", String(p.pid), "-d", "cwd", "-Fn"]); let s = ""; c.stdout.on("data", (d) => (s += d)); c.on("close", () => r(s)); });
  p.cwdSameAsApp = o.split("\n").find((l) => l.startsWith("n"))?.slice(1) === appDir || o.includes(appDir);
}
const l = await getJson("http://127.0.0.1:9401/json/list");
const cdp = connect(l[0].webSocketDebuggerUrl);
await cdp.opened;
const ev = [];
const detachOnDestroy = process.env.DETACH === "1";
cdp.on((m) => { if (/executionContext|Inspector\.|Runtime\.executionContextsCleared/.test(m.method)) ev.push({ m: m.method, p: m.params, at: Date.now() }); if (detachOnDestroy && m.method === "Runtime.executionContextDestroyed" && m.params.executionContextId === 1) cdp.ws.close(); });
let closedAt = null;
cdp.ws.onclose = () => (closedAt = Date.now());
try { R.notifyWhenWaiting = await cdp.send("NodeRuntime.notifyWhenWaitingForDisconnect", { enabled: true }); } catch (e) { R.notifyWhenWaiting = String(e.message); }
cdp.on((m) => { if (m.method === "NodeRuntime.waitingForDisconnect") { ev.push({ m: m.method, at: Date.now() }); if (process.env.DETACH === "2") cdp.ws.close(); } });
await cdp.send("Runtime.enable");
await sleep(300);
await sleep(2500);
ev.length = 0;
const t0 = Date.now();
writeFileSync(cfg, origCfg + "\n// restart " + Date.now() + "\n");
await waitFor(() => closedAt !== null, 20000);
await waitFor(async () => Array.isArray(await getJson("http://127.0.0.1:9401/json/list", 300)), 20000, 200);
await sleep(1500);
const tree1 = processTree(child.pid);
R.restart = {
  eventsBeforeClose: ev.map((e) => ({ m: e.m, ctx: e.p?.executionContextId ?? e.p?.context?.id, reason: e.p?.reason, dt: e.at - t0 })),
  socketClosedAfterMs: closedAt ? closedAt - t0 : null,
  after: tree1.map((p) => `${p.pid} ${p.command.slice(0, 40)}`),
  portsAfter: listeningPorts(tree1.map((p) => p.pid)),
  newChildOnSamePort: (await getJson("http://127.0.0.1:9401/json/list")).length === 1,
  log: out.split("\n").filter((x) => /restart|Found a change|Debugger listening/i.test(x)).map((x) => x.replace(/\u001b\[[0-9;]*m/g, "").replace(/[0-9a-f-]{36}/, "<uuid>")).slice(-6),
};
writeFileSync(outJson, JSON.stringify(R, null, 2));
process.exit(0);
