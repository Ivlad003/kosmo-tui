// Tiny loopback server for the browser tracepoint probe.
import http from "node:http";

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>kosmo probe</title></head>
<body>
<h1>probe</h1>
<iframe id="xo" src="http://localhost:__PORT__/frame.html"></iframe>
<script>
  // Page code that tries to observe console usage.
  window.__seen = [];
  for (const m of ["log", "trace", "debug", "info"]) {
    const orig = console[m].bind(console);
    console[m] = (...a) => { window.__seen.push(m); return orig(...a); };
  }
  document.cookie = "sid=page-cookie-secret; path=/";
  localStorage.setItem("token", "ls-secret");
</script>
<script src="/app.js"></script>
</body></html>`;

const app = `// app.js
let counter = 0;
function tick(n, user) {
  const doubled = n * 2;
  return doubled + user.id;
}
function schedule() {
  setTimeout(() => {
    Promise.resolve().then(() => {
      tick(++counter, { id: 7, password: "hunter2", nested: { token: "t0k" } });
    });
  }, 0);
}
setInterval(schedule, 10);
// hot loop used for cost measurement
function hot(i) { return i + 1; }
window.runHot = (n) => { const t = performance.now(); let s = 0; for (let i = 0; i < n; i++) s = hot(s); return performance.now() - t; };
// dedicated worker
const w = new Worker("/worker.js");
w.onmessage = () => {};
// gap monitor: largest main-thread gap between 10ms ticks
window.__gap = 0; let last = performance.now();
setInterval(() => { const now = performance.now(); window.__gap = Math.max(window.__gap, now - last); last = now; }, 10);
`;

const worker = `// worker.js
function workerStep(k) { return k * 3; }
let k = 0;
setInterval(() => { postMessage(workerStep(++k)); }, 20);
`;

const frame = `<!doctype html><html><body><script src="/frame.js"></script></body></html>`;
const frameJs = `// frame.js
function frameStep(j) { return j - 1; }
let j = 0;
setInterval(() => frameStep(++j), 25);
`;

const server = http.createServer((req, res) => {
  const port = server.address().port;
  const url = new URL(req.url, "http://x");
  const routes = {
    "/": ["text/html", page.replaceAll("__PORT__", String(port))],
    "/app.js": ["text/javascript", app],
    "/worker.js": ["text/javascript", worker],
    "/frame.html": ["text/html", frame],
    "/frame.js": ["text/javascript", frameJs],
  };
  const r = routes[url.pathname];
  if (!r) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": r[0], "set-cookie": "httponly_sid=http-only-secret; HttpOnly; Path=/" });
  res.end(r[1]);
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + "\n");
});
// frame on "localhost" needs the same port on ::1/127.0.0.1; localhost resolves to 127.0.0.1 in Chrome's resolver too.
process.on("SIGTERM", () => process.exit(0));
