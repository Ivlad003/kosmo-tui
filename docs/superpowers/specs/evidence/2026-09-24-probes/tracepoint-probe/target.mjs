// Throwaway probe target: a tiny "server" that keeps doing async work so pauses show up as tick gaps.
const out = (...a) => process.stdout.write(a.join(" ") + "\n");

async function fetchPrice(id) {
  await new Promise((r) => setTimeout(r, 2));
  return id * 10;
}
async function calculateLineTotal(item, qty) {
  const price = await fetchPrice(item.id);
  const total = price * qty; // LINE_TP
  return total;
}
async function handler(n) {
  return calculateLineTotal({ id: n, name: "item" + n, token: "secret-" + n }, (n % 3) + 1);
}
function hot(x) {
  const y = x * 2; // LINE_HOT
  return y + 1;
}

// Vite-SSR-like module: body of an AsyncFunction with a //# sourceURL pointing at an absolute path.
const AsyncFunction = (async () => {}).constructor;
const ssrBody = `
async function applyDiscount(total, pct) {
  const discounted = total * (1 - pct / 100); // LINE_SSR
  return discounted;
}
__exports.applyDiscount = applyDiscount;
//# sourceURL=/virtual/project/src/pricing.ts`;
const __exports = {};
await new AsyncFunction("__exports", ssrBody)(__exports);

let n = 0;
let last = Date.now();
let maxGap = 0;
setInterval(async () => {
  const now = Date.now();
  maxGap = Math.max(maxGap, now - last);
  last = now;
  n++;
  const total = await handler(n);
  await __exports.applyDiscount(total, 10);
  if (n % 50 === 0) out("tick", n);
}, 10);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const cmd of chunk.split("\n").filter(Boolean)) {
    if (cmd === "gap") {
      out("GAP", maxGap);
      maxGap = 0;
    } else if (cmd === "bench") {
      const t0 = process.hrtime.bigint();
      let s = 0;
      for (let i = 0; i < 200000; i++) s += hot(i);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      out("BENCH", ms.toFixed(1), s);
    } else if (cmd === "ctx") {
      out("CTX", typeof console.context);
    } else if (cmd === "exit") {
      out("EXITING");
      process.exit(0);
    }
  }
});
out("READY", process.version);
