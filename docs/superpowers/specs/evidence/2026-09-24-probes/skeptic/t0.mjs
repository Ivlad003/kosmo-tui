import { createInterface } from "node:readline";
function calc(item, qty) {
  const price = item.price * qty; // LINE_CALC
  let later = 1;
  return price + later;
}
globalThis.run = () => calc({ id: 5, price: 10 }, 3);
createInterface({ input: process.stdin }).on("line", (l) => { if (l === "run") run(); if (l === "exit") process.exit(0); });
console.log("READY");
