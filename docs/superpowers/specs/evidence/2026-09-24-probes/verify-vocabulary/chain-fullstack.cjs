Error.stackTraceLimit = Infinity;
const express = require("/Users/kosmodev/Documents/pet_project/kosmo-callflow/node_modules/express");
const http = require("node:http");
const log = [];
const frames = () => new Error().stack.split("\n").slice(2).map((l) => l.trim().replace(/\(.*node_modules\//, "(nm/").replace(/\(\/private.*\//, "(")).filter(l=>!/node:internal/.test(l));
const app = express();
app.use(function mwCors(req, res, next) { next(); });
app.use(function mwJson(req, res, next) { log.push({ step: "mwJson", frames: frames() }); next(); });
app.use(async function mwAuthAsync(req, res, next) { await new Promise((r) => setTimeout(r, 1)); next(); });
const api = express.Router();
api.get("/orders/:id", function hGetOrder(req, res) { log.push({ step: "hGetOrder", frames: frames() }); res.status(200).json({ ok: 1 }); });
app.use("/api", api);
const server = http.createServer(app).listen(0, "127.0.0.1", async () => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/orders/7`);
  console.log(r.status);
  for (const e of log) { console.log(e.step); for (const f of e.frames) console.log("   ", f); }
  server.close();
});
