import http from "node:http";
import net from "node:net";
// fake "proxy" that records any connection, and a real target server
let proxyHits = [];
const proxy = net.createServer((s) => { s.once("data", (d) => proxyHits.push(d.toString().split("\r\n")[0])); s.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"); });
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const target = http.createServer((q, s) => s.end('{"Browser":"node.js/vX"}'));
await new Promise((r) => target.listen(0, "127.0.0.1", r));
const pport = proxy.address().port, tport = target.address().port;
const res = { node: process.version, env: { NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY ?? null } };
if (process.argv[2] === "child") {
  // nothing
}
