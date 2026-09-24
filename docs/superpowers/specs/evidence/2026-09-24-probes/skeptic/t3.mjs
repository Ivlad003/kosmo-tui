import { createInterface } from "node:readline";
import vm from "node:vm";
createInterface({ input: process.stdin }).on("line", (l) => {
  if (l === "vm") { let c = vm.createContext({}); vm.runInContext("1+1", c); c = null; setTimeout(() => { globalThis.gc(); globalThis.gc(); console.log("GCED"); }, 50); }
  if (l === "exit") { console.log("EXITING"); process.stdin.destroy(); }
});
console.log("READY");
