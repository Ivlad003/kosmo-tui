// Port mode: Origin/Host checks with one fresh TCP connection per request and spacing; plus orphan behaviour.
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { launch, activePort, sleep, DIR } from "./cdp.mjs";
const log = (...a) => console.log(...a);

const br = launch({ pipe: false });
try {
  const { port, path } = await activePort(br.profile);
  const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  log("[port] /json/version Browser:", v.Browser, "| UA headless:", /HeadlessChrome/.test(v["User-Agent"]));
  const up = (origin, host) => new Promise((resolve) => {
    const headers = { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" };
    if (origin) headers.Origin = origin; if (host) headers.Host = host;
    const req = http.request({ host: "127.0.0.1", port, path, headers, agent: false });
    req.on("upgrade", (res, s) => { resolve(res.statusCode); s.destroy(); });
    req.on("response", (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve(`${res.statusCode} ${b.slice(0, 40)}`)); });
    req.on("error", (e) => resolve("error " + e.message)); req.setTimeout(3000, () => { req.destroy(); resolve("timeout"); }); req.end();
  });
  const origins = ["http://127.0.0.1", "http://evil.example", "http://127.0.0.1", `http://127.0.0.1:${port}`, "http://127.0.0.1:5173", "http://localhost:5173", "http://localhost", "http://[::1]:5173", "null", "devtools://devtools", null, "http://127.0.0.1:80"];
  for (const o of origins) { log(`[origin] ${o ?? "(none)"} ->`, await up(o)); await sleep(1200); }
  for (const h of ["evil.example", "localhost", "10.1.2.3:9", "foo.localhost"]) { log(`[host] ${h} ->`, await up(null, h)); await sleep(800); }
} catch (e) { log("ERROR", e.stack); } finally { br.cleanup(); }

// Orphan behaviour: child launches Chrome, parent SIGKILLs child, then checks the Chrome pid.
for (const mode of ["pipe", "port"]) {
  const child = spawn(process.execPath, ["-e", `
    import("${DIR}/cdp.mjs").then(async ({ launch, sleep }) => {
      const b = launch({ pipe: ${mode === "pipe"} });
      if (${mode === "pipe"}) await b.cdp.send("Browser.getVersion"); else await sleep(1500);
      process.stdout.write(JSON.stringify({ pid: b.child.pid, profile: b.profile }) + "\\n");
      setInterval(() => {}, 1000);
    });`], { stdio: ["ignore", "pipe", "inherit"] });
  const info = await new Promise((r) => child.stdout.once("data", (d) => r(JSON.parse(d))));
  child.kill("SIGKILL");
  await sleep(3000);
  let alive = true; try { process.kill(info.pid, 0); } catch { alive = false; }
  let helpers = ""; try { helpers = execFileSync("pgrep", ["-f", info.profile], { encoding: "utf8" }).trim().split("\n").length + " procs"; } catch { helpers = "0 procs"; }
  log(`[orphan ${mode}] chrome pid alive 3s after parent SIGKILL: ${alive} | processes with this profile: ${helpers}`);
  try { execFileSync("pkill", ["-9", "-f", info.profile]); } catch {}
  await sleep(500);
  try { execFileSync("rm", ["-rf", info.profile]); } catch {}
}
process.exit(0);
