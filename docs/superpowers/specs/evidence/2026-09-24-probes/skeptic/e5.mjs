import { startTarget, connect, sleep, waitFor } from "./lib.mjs";
const file = new URL("./t5.mjs", import.meta.url).pathname;
const out = { node: process.version };
for (const flag of ["--inspect-brk", "--inspect-wait", "--inspect"]) {
  const t = await startTarget([`${flag}=127.0.0.1:0`], file);
  await sleep(200);
  const c = connect(t.wsUrl); await c.opened;
  const ev = [];
  c.on((m) => { if (m.method === "Debugger.paused") ev.push(m.params.reason); });
  const r = {};
  const ev1 = await c.send("Runtime.evaluate", { expression: "process.pid", throwOnSideEffect: true });
  r.pidBefore = ev1.result.type === "number" ? (ev1.result.value === t.child.pid) : ev1.result.type;
  const ev2 = await c.send("Runtime.evaluate", { expression: "JSON.stringify([typeof process, Object.keys(process).length, typeof process.ppid, typeof process.argv, typeof process.getBuiltinModule, typeof process.cwd])", throwOnSideEffect: false });
  r.probe = ev2.result.value;
  await c.send("Runtime.enable"); await c.send("Debugger.enable");
  await c.send("Debugger.setSkipAllPauses", { skip: flag === "--inspect-brk" ? true : false });
  await c.send("Runtime.runIfWaitingForDebugger");
  await sleep(400);
  r.pausesWithSkip = [...ev];
  r.running = t.stdout.includes("RUNNING");
  const ev3 = await c.send("Runtime.evaluate", { expression: "process.pid", throwOnSideEffect: true });
  r.pidAfter = ev3.result.value === t.child.pid;
  out[flag] = r;
  c.close(); await sleep(100); t.child.kill();
}
console.log(JSON.stringify(out));
process.exit(0);
