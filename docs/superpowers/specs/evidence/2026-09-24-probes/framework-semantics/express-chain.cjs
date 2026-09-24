// Throwaway: how Express 5 dispatches a middleware chain, seen from the call stack.
const express = require("/Users/kosmodev/Documents/pet_project/kosmo-callflow/node_modules/express");
const http = require("node:http");
const log = [];
const userFrames = () => new Error().stack.split("\n").slice(2)
  .map((l) => (l.match(/at (?:async )?(\w+) /) || [])[1]).filter((n) => /^(mw|h|eh|api)/.test(n || ""));
const app = express();
app.use(function mwCors(req, res, next) { log.push({ step: "mwCors", onStack: userFrames() }); next(); });
app.use(function mwJson(req, res, next) { log.push({ step: "mwJson", onStack: userFrames() }); next(); });
app.use(async function mwAuthAsync(req, res, next) {
  await new Promise((r) => setTimeout(r, 1));
  log.push({ step: "mwAuthAsync", onStack: userFrames() });
  if (req.url.startsWith("/boom")) throw new Error("auth failed (rejected promise, no next)");
  next();
});
const api = express.Router();
api.get("/orders/:id", function hSkip(req, res, next) { log.push({ step: "hSkip", onStack: userFrames(), route: req.route.path }); next("route"); });
api.get("/orders/:id", function hGetOrder(req, res) { log.push({ step: "hGetOrder", onStack: userFrames(), route: req.baseUrl + req.route.path }); res.status(200).json({ ok: 1 }); });
app.use("/api", api);
app.use(function ehErrors(err, req, res, next) { log.push({ step: "ehErrors(arity " + ehErrors.length + ")", onStack: userFrames(), err: err.message }); res.status(500).end(); });
const server = http.createServer(app).listen(0, "127.0.0.1", async () => {
  const port = server.address().port;
  for (const path of ["/api/orders/7", "/boom"]) {
    log.length = 0;
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    console.log(`\n${path} -> ${r.status}`);
    for (const e of log) console.log(JSON.stringify(e));
  }
  server.close();
});
