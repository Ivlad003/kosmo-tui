import net from "node:net"; import { spawn } from "node:child_process";
let proxyConns = 0, targetConns = 0;
const proxy = net.createServer(s => { proxyConns++; s.destroy(); }).listen(0, "127.0.0.1");
const target = net.createServer(s => { targetConns++; s.destroy(); }).listen(0, "127.0.0.1");
await new Promise(r => setTimeout(r, 200));
const pp = proxy.address().port, tp = target.address().port;
const child = `
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1", "::1", "[::1]", "localhost"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;
const which = process.argv[1];
if (which === "ws") { const ws = new WebSocket("ws://127.0.0.1:${tp}/x"); ws.onerror = () => {}; ws.onclose = () => process.exit(0); setTimeout(() => process.exit(0), 1500); }
else if (which === "fetch") { fetch("http://127.0.0.1:${tp}/json/version").catch(() => {}).finally(() => setTimeout(() => process.exit(0), 300)); }
else { const http = require("http"); http.get("http://127.0.0.1:${tp}/json/version").on("error", () => {}).on("close", () => process.exit(0)); setTimeout(() => process.exit(0), 1500); }
`;
for (const which of ["ws", "fetch", "httpget-default-agent"]) {
  proxyConns = 0; targetConns = 0;
  await new Promise(r => { const c = spawn(process.execPath, ["-e", child, which], { env: { ...process.env, NODE_USE_ENV_PROXY: "1", HTTP_PROXY: `http://127.0.0.1:${pp}`, http_proxy: `http://127.0.0.1:${pp}`, NO_PROXY: "", no_proxy: "" }, stdio: "inherit" }); c.on("exit", r); });
  await new Promise(r => setTimeout(r, 100));
  console.log(process.version, which, "proxyConns", proxyConns, "targetConns", targetConns);
}
proxy.close(); target.close();
