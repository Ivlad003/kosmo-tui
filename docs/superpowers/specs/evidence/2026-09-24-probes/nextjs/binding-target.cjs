const vm = require("vm");
let n = 0;
process.stdin.on("data", () => {
  const ctx = vm.createContext({ console: { log() {} } }, { name: "Edge Runtime" });
  const r = vm.runInContext(`(function(){ const a = 1; /*LINE*/ return typeof globalThis.__kosmoEdgeHit + ":" + typeof globalThis.__kosmoMainOnly; })()`, ctx, { filename: "/tmp/edge-chunk-" + (++n) + ".js" });
  console.log("RES " + r);
});
console.log("READY");
