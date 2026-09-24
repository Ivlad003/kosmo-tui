import vm from "node:vm";
const out = (...a) => process.stdout.write(a.join(" ") + "\n");
const modUnused = "module-level-unused";
function makeInner() {
  const hiddenOuter = 7;
  const usedOuter = 8;
  return function inner(a) {
    const r = a + usedOuter; // LINE_INNER
    return r;
  };
}
const inner = makeInner();
async function fetchPrice(id) {
  await new Promise((r) => setTimeout(r, 1));
  return id * 10;
}
async function calc(item, qty) {
  const price = await fetchPrice(item.id);
  const total = price * qty; // LINE_TP
  let later = total + 1;
  return later;
}
async function handler(n) {
  return calc({ id: n, token: "tok-" + n }, (n % 3) + 1);
}
function withDebugger() {
  debugger; // LINE_DEBUGGER
  return 1;
}
let n = 0;
let dbg = false;
setInterval(async () => {
  n++;
  await handler(n);
  inner(n);
  if (dbg) { dbg = false; withDebugger(); }
  if (n % 50 === 0) out("tick", n);
}, 10);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const cmd of chunk.split("\n").filter(Boolean)) {
    if (cmd === "dbg") dbg = true;
    else if (cmd === "vm") {
      let c = vm.createContext({ x: 1 });
      vm.runInContext("x + 1", c);
      c = null;
      setTimeout(() => { globalThis.gc?.(); globalThis.gc?.(); out("VMDONE"); }, 50);
    } else if (cmd === "newscript") {
      const AF = (async () => {}).constructor;
      new AF("", "return 1;\n//# sourceURL=/virtual/late.ts")();
      out("NEWSCRIPT");
    } else if (cmd === "exit") process.exit(0);
  }
});
out("READY", process.version, process.pid);
