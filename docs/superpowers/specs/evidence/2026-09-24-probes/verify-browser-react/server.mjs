// Independent loopback fixture for re-verifying the browser-react claims.
import http from "node:http";

const inlineMap = (src) =>
  "//# sourceMappingURL=data:application/json;base64," +
  Buffer.from(JSON.stringify({ version: 3, sources: [src], names: [], mappings: "AAAA;AACA;AACA;AACA" })).toString("base64");

const page = `<!doctype html><html><head><meta charset="utf-8"><title>verify</title></head><body>
<iframe id="xo" src="http://localhost:__PORT__/frame.html"></iframe>
<script src="/app.js"></script>
<script type="module" src="/m/root.js"></script>
<script src="/vendor/node_modules/lib.js"></script>
</body></html>`;

// line numbers (0-based) matter: tick body = line 2, mountOnce body = line 5, hot body = line 8
const app = `// app.js
function tick(n, user) {
  const doubled = n * 2;
  return doubled + user.id;
}
function mountOnce(label) {
  return label.length;
}
function hot(i) {
  return i + 1;
}
mountOnce("boot");
let counter = 0;
setInterval(() => { setTimeout(() => { Promise.resolve().then(() => tick(++counter, { id: 7, password: "x" })); }, 0); }, 10);
window.runHot = (n) => { const t = performance.now(); let s = 0; for (let i = 0; i < n; i++) s = hot(s); return performance.now() - t; };
window.__wmsgs = 0;
const w = new Worker("/worker.js");
w.onmessage = () => { window.__wmsgs++; };
window.__gap = 0; let last = performance.now();
setInterval(() => { const now = performance.now(); window.__gap = Math.max(window.__gap, now - last); last = now; }, 10);
`;

const mod = (name, body) => `${body}\n${inlineMap(name + ".src.js")}\n`;
const routes = {
  "/app.js": ["text/javascript", app],
  "/m/root.js": ["text/javascript", mod("root", `import { a } from "./a.js";\nimport { b } from "./b.js";\nwindow.__mods = a() + b();`)],
  "/m/a.js": ["text/javascript", mod("a", `export function a() {\n  return 1;\n}`)],
  "/m/b.js": ["text/javascript", mod("b", `export function b() {\n  return 2;\n}`)],
  "/vendor/node_modules/lib.js": ["text/javascript", mod("lib", `window.__lib = (function libInit() {\n  return 3;\n})();`)],
  "/worker.js": ["text/javascript", `let k = 0;\nsetInterval(() => postMessage(++k), 20);\n`],
  "/frame.html": ["text/html", `<!doctype html><html><body><script src="/frame.js"></script></body></html>`],
  "/frame.js": ["text/javascript", `let j = 0;\nfunction frameStep(x) {\n  return x - 1;\n}\nsetInterval(() => frameStep(++j), 25);\n`],
};

const server = http.createServer((req, res) => {
  const port = server.address().port;
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(page.replaceAll("__PORT__", String(port))); return; }
  const r = routes[url.pathname];
  if (!r) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": r[0], "cache-control": "no-store" });
  res.end(r[1]);
});
server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ port: server.address().port }) + "\n"));
process.on("SIGTERM", () => process.exit(0));
