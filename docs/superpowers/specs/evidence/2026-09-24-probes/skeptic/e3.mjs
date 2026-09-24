import { startTarget, connect, sleep, waitFor } from "./lib.mjs";
const file = new URL("./t3.mjs", import.meta.url).pathname;
const out = { node: process.version };
for (const mode of ["plain", "notify"]) {
  const t = await startTarget(["--expose-gc", "--inspect=127.0.0.1:0"], file);
  await waitFor(() => t.stdout.includes("READY"));
  const c = connect(t.wsUrl); await c.opened;
  const ev = [];
  c.on((m) => { if (/executionContext|NodeRuntime/.test(m.method)) ev.push({ m: m.method, id: m.params.context?.id ?? m.params.executionContextId, name: m.params.context?.name, isDefault: m.params.context?.auxData?.isDefault }); });
  await c.send("Runtime.enable");
  if (mode === "notify") await c.send("NodeRuntime.notifyWhenWaitingForDisconnect", { enabled: true });
  t.send("vm"); await waitFor(() => t.stdout.includes("GCED")); await sleep(200);
  const alive1 = t.child.exitCode === null;
  t.send("exit"); await sleep(500);
  out[mode] = { ev, aliveAfterVmGc: alive1, stderrTail: t.stderr.split("\n").filter(Boolean).slice(-1)[0], exitedBeforeClose: t.child.exitCode };
  c.close(); await sleep(300); t.child.kill();
}
console.log(JSON.stringify(out));
process.exit(0);
