const out = (...a) => process.stdout.write(a.join(" ") + "\n");
const performance = "module-level-shadow";   // shadows the global, NOT referenced by f
function f(item, qty) {
  const t = item.id * qty; // LINE_F
  return t;
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const cmd of chunk.split("\n").filter(Boolean)) {
    if (cmd.startsWith("run")) {
      const n = Number(cmd.slice(3));
      const t0 = process.hrtime.bigint();
      let s = 0;
      for (let i = 0; i < n; i++) s += f({ id: i }, 2);
      out("RUN", (Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1), s);
    }
  }
});
out("READY");
