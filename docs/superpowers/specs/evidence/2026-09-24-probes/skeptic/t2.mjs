import { createInterface } from "node:readline";
function calc(item, qty) {
  const price = item.price * qty; // LINE_CALC
  const next = price + 1; // LINE_NEXT
  return next;
}
function dbg() { debugger; return 1; }
let ticks = 0; setInterval(() => ticks++, 10);
globalThis.run = () => calc({ id: 5, price: 10 }, 3);
createInterface({ input: process.stdin }).on("line", (l) => { if (l === "run") run(); if (l === "dbg") dbg(); if (l === "ticks") console.log("TICKS " + ticks); if (l === "exit") process.exit(0); });
console.log("READY");
