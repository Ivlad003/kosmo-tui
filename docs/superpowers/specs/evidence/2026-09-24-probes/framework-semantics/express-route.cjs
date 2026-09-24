const express = require("/Users/kosmodev/Documents/pet_project/kosmo-callflow/node_modules/express");
const http = require("node:http");
const app = express();
const orders = express.Router({ mergeParams: true });
orders.get("/:oid", (req, res) => res.json({ baseUrl: req.baseUrl, routePath: req.route.path, originalUrl: req.originalUrl }));
app.use("/users/:uid/orders", orders);
const server = http.createServer(app).listen(0, "127.0.0.1", async () => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}/users/42/orders/7?x=1`);
  console.log(JSON.stringify(await r.json()));
  server.close();
});
