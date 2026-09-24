// What Origin does Node's global WebSocket send, and how does Chrome treat Origin variants / --remote-allow-origins.
import http from "node:http";
import { launch, waitActivePort, sleep } from "./cdp.mjs";

// 1) headers sent by Node's global WebSocket
const seen = await new Promise((resolve) => {
  const srv = http.createServer();
  srv.on("upgrade", (req, sock) => { resolve(req.headers); sock.destroy(); srv.close(); });
  srv.listen(0, "127.0.0.1", () => { const ws = new WebSocket(`ws://127.0.0.1:${srv.address().port}/x`); ws.onerror = () => {}; });
});
console.log(process.version, "Node WebSocket upgrade headers:", Object.keys(seen).join(","), "origin=", seen.origin ?? "(none)");

async function check(extra) {
  const br = launch({ extra });
  try {
    const { port, path } = await waitActivePort(br.profile);
    const up = (origin) => new Promise((resolve) => {
      const headers = { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" };
      if (origin) headers.Origin = origin;
      const req = http.request({ host: "127.0.0.1", port, path, headers });
      req.on("upgrade", (res, s) => { resolve(res.statusCode); s.destroy(); });
      req.on("response", (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve(`${res.statusCode} ${b.slice(0, 60)}`)); });
      req.on("error", (e) => resolve("error " + e.message)); req.end();
    });
    const r = {};
    for (const o of [null, "http://evil.example", `http://127.0.0.1:${port}`, "http://localhost:5173", "null", "devtools://devtools"]) { r[o ?? "(none)"] = await up(o); await sleep(100); }
    console.log("flags", extra.join(" ") || "(none)", r);
  } finally { br.cleanup(); }
}
await check([]);
await check(["--remote-allow-origins=http://localhost:5173"]);
process.exit(0);
