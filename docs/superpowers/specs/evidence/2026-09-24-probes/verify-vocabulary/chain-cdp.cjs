// In-process inspector session: what a CDP console.trace (the spec 9.6 tracepoint path) shows for Express layers.
const inspector = require("node:inspector");
const s = new inspector.Session(); s.connect();
const post = (m, p) => new Promise((res, rej) => s.post(m, p, (e, r) => e ? rej(e) : res(r)));
const traces = [];
s.on("Runtime.consoleAPICalled", ({ params }) => {
  if (params.type !== "trace") return;
  const parts = []; let st = params.stackTrace;
  while (st) { parts.push((st.description ? `[${st.description}] ` : "") + st.callFrames.map(f => f.functionName || "(anon)").filter(n => /^(mw|h|eh)/.test(n)).join(" < ")); st = st.parent; }
  traces.push(params.args[0].value + ": " + parts.join(" || "));
});
(async () => {
  await post("Runtime.enable"); await post("Debugger.enable"); await post("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
  const express = require("/Users/kosmodev/Documents/pet_project/kosmo-callflow/node_modules/express");
  const http = require("node:http");
  const app = express();
  app.use(function mwCors(req, res, next) { next(); });
  app.use(function mwJson(req, res, next) { console.trace("mwJson"); next(); });
  app.use(async function mwAuthAsync(req, res, next) { await new Promise((r) => setTimeout(r, 1)); console.trace("mwAuthAsync"); next(); });
  const api = express.Router();
  api.get("/orders/:id", function hGetOrder(req, res) { console.trace("hGetOrder"); res.json({ ok: 1 }); });
  app.use("/api", api);
  const server = http.createServer(app).listen(0, "127.0.0.1", async () => {
    await fetch(`http://127.0.0.1:${server.address().port}/api/orders/7`);
    server.close(); s.disconnect();
    process.stdout.write(traces.join("\n") + "\n");
  });
})();
