import net from "node:net"; import http from "node:http"; import { spawn } from "node:child_process";
const hits = [];
const proxy = net.createServer((s) => { s.once("data", (d) => { hits.push(d.toString().split("\r\n")[0]); s.destroy(); }); });
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const target = http.createServer((q, s) => s.end("{}"));
await new Promise((r) => target.listen(0, "127.0.0.1", r));
const tp = target.address().port;
const client = (mitigate) => `
${mitigate ? 'process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1,::1,localhost";' : ""}
const http = await import("node:http");
const res = {};
try { await fetch("http://127.0.0.1:${tp}/json/version", { signal: AbortSignal.timeout(800) }); res.fetch = "ok"; } catch (e) { res.fetch = "err " + (e.cause?.code ?? e.message); }
await new Promise((r) => { const ws = new WebSocket("ws://127.0.0.1:${tp}/x"); ws.onerror = () => { res.ws = "error"; r(); }; ws.onopen = () => { res.ws = "open"; r(); }; setTimeout(r, 800); });
await new Promise((r) => { http.get("http://127.0.0.1:${tp}/json/version", ${mitigate ? "{ agent: new http.Agent() }," : ""} (s) => { res.http = s.statusCode; s.resume(); r(); }).on("error", (e) => { res.http = "err " + e.code; r(); }); setTimeout(r, 800); });
console.log(JSON.stringify(res)); process.exit(0);`;
const run = (bin, env, mitigate) => new Promise((r) => { const c = spawn(bin, ["--input-type=module", "-e", client(mitigate)], { env: { ...process.env, ...env } }); let o = ""; c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", (d) => (o += d)); c.on("exit", () => r(o.trim())); setTimeout(() => c.kill(), 5000); });
const pp = `http://127.0.0.1:${proxy.address().port}`;
for (const v of ["22.22.0", "25.2.1"]) {
  const bin = `${process.env.HOME}/.nvm/versions/node/v${v}/bin/node`;
  for (const [label, env, mit] of [["noflag", { HTTP_PROXY: pp, http_proxy: pp }, false], ["flag", { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: pp, http_proxy: pp }, false], ["flag+mitigation", { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: pp, http_proxy: pp }, true]]) {
    hits.length = 0; const o = await run(bin, env, mit);
    console.log(v, label, o.split("\n").pop(), "proxyHits=", JSON.stringify(hits));
  }
}
proxy.close(); target.close();
