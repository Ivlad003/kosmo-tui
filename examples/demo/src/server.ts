import { createServer } from "node:http";
import { loadCart } from "./cart.js";

export const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/cart") {
    try {
      response.end(JSON.stringify(await loadCart("u_42")));
    } catch (error) {
      response.statusCode = 500;
      response.end(String(error));
    }
    return;
  }
  response.statusCode = request.url === "/health" ? 200 : 404;
  response.end();
});
