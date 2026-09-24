import http from "node:http";
const html = `<!doctype html><body><script>
window.__sw = "pending";
navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready).then(async () => {
  // reload-free: wait until controlled
  if (!navigator.serviceWorker.controller) await new Promise(r => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }));
  const t = await (await fetch("/sw-echo")).text(); window.__sw = t;
}).catch(e => window.__sw = "err " + e.message);
</script></body>`;
const sw = `self.addEventListener("install", e => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", e => { if (new URL(e.request.url).pathname === "/sw-echo") e.respondWith(new Response("from-sw")); });`;
const s = http.createServer((req, res) => {
  if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(html); return; }
  if (req.url === "/sw.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(sw); return; }
  res.writeHead(404); res.end("net");
});
s.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ port: s.address().port }) + "\n"));
