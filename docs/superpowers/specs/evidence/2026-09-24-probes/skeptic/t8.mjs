import { createInterface } from "node:readline";
function calc(item, qty) {
  const p = item.price * qty; // LINE_CALC
  return p;
}
createInterface({ input: process.stdin }).on("line", (l) => { if (l === "run") { const t0 = performance.now(); for (let i = 0; i < 200; i++) calc({ id: i, price: 1 }, 2); console.log("DONE " + (performance.now() - t0).toFixed(1)); } if (l === "exit") process.exit(0); });
console.log("READY");
