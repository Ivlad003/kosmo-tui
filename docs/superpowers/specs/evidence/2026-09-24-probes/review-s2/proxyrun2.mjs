import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
let proxyHits = [];
const proxy = net.createServer((s) => { s.once("data", (d) => proxyHits.push(d.toString().split("\r\n")[0])); s.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"); });
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const target = http.createServer((q, s) => s.end('{"Browser":"node.js/vX"}'));
target.on("upgrade", (q, sock) => sock.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
await new Promise((r) => target.listen(0, "127.0.0.1", r));
const pport = proxy.address().port, tport = target.address().port;
const code = `
process.env.NO_PROXY = "127.0.0.1,::1"; process.env.no_proxy = "127.0.0.1,::1"; const r = {};
try { const x = await fetch("http://127.0.0.1:${tport}/json/version"); r.fetch = x.status + " " + (await x.text()).slice(0,40); } catch (e) { r.fetch = "error " + (e.cause?.code ?? e.message); }
r.ws = await new Promise((res) => { const w = new WebSocket("ws://127.0.0.1:${tport}/abcd"); w.onopen = () => res("open"); w.onerror = (e) => res("error"); setTimeout(() => res("timeout"), 2000); });
r.http = await new Promise((res) => { const http = process.getBuiltinModule("node:http"); http.get("http://127.0.0.1:${tport}/json/version", { agent: new http.Agent() }, (s) => { let b=""; s.on("data", d=>b+=d); s.on("end", () => res(s.statusCode + " " + b.slice(0,40))); }).on("error", (e) => res("error " + e.code)); });
console.log(JSON.stringify(r));
`;
for (const node of process.argv.slice(2)) {
  for (const env of [{}, { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://127.0.0.1:" + pport, http_proxy: "http://127.0.0.1:" + pport }]) {
    proxyHits = [];
    const out = await new Promise((resolve) => {
      const c = spawn(node, ["--input-type=module", "-e", code], { env: { PATH: process.env.PATH, ...env } });
      let o = ""; c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", (d) => (o += d)); c.on("exit", () => resolve(o.trim()));
    });
    console.log(node.split("/").at(-3), JSON.stringify(env.NODE_USE_ENV_PROXY ? "NODE_USE_ENV_PROXY=1 HTTP_PROXY=fake" : "no env"), out, "proxyHits:", JSON.stringify(proxyHits));
  }
}
process.exit(0);
