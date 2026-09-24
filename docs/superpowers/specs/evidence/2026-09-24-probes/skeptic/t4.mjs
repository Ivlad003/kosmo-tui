import { createInterface } from "node:readline";
const AsyncFunction = (async () => {}).constructor;
const code = (v) => `
function calc(item, qty) {
  const p = item.price * qty; // V${v}
  return p;
}
return calc;
//# sourceURL=/virtual/mod.ts`;
let fn;
globalThis.load = async (v) => { fn = await new AsyncFunction(code(v))(); };
createInterface({ input: process.stdin }).on("line", async (l) => {
  if (l.startsWith("load")) { await load(l.slice(5)); console.log("LOADED"); }
  if (l === "run") fn({ price: 2 }, 3);
  if (l === "exit") process.exit(0);
});
console.log("READY");
