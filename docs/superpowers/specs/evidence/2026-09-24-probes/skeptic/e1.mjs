import { startTarget, connect, sleep, waitFor } from "./lib.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const file = new URL("./t0.mjs", import.meta.url).pathname;
const line = readFileSync(file, "utf8").split("\n").findIndex((l) => l.includes("LINE_CALC"));
const t = await startTarget(["--inspect=127.0.0.1:0"], file);
await waitFor(() => t.stdout.includes("READY"));
const out = { node: process.version };
// session 1
{
  const c = connect(t.wsUrl); await c.opened;
  await c.send("Runtime.enable"); await c.send("Debugger.enable");
  await c.send("Runtime.evaluate", { expression: `Object.defineProperty(globalThis, Symbol.for("kt"), { value: (tp, v) => console.context("kosmo-tui").trace("KOSMO_TP", tp, "s1"), configurable: true })` });
  const bp = await c.send("Debugger.setBreakpointByUrl", { url: pathToFileURL(file).href, lineNumber: line, condition: `(globalThis[Symbol.for("kt")](1), false)` });
  for (let i = 0; i < 10; i++) t.send("run");
  await sleep(300);
  await c.send("Runtime.evaluate", { expression: `delete globalThis[Symbol.for("kt")]` });
  c.close(); await sleep(300);
}
// no-client period: app logs? plus a console.log from app
// session 2
{
  const c = connect(t.wsUrl); await c.opened;
  const r = await c.send("Runtime.enable");
  const idx = c.log.findIndex((m) => m.id === 1);
  const before = c.log.slice(0, idx).filter((m) => m.method === "Runtime.consoleAPICalled");
  const after = c.log.slice(idx + 1).filter((m) => m.method === "Runtime.consoleAPICalled");
  out.replayBeforeResponse = before.length;
  out.replayAfterResponse = after.length;
  out.sample = before.slice(0,3).map((b) => ({ ctx: b.params.context, type: b.params.type, args: b.params.args.map((a) => a.value) }));
  await sleep(200);
  out.afterLater = c.log.filter((m) => m.method === "Runtime.consoleAPICalled").length - before.length;
  // discardConsoleEntries then new session
  await c.send("Runtime.discardConsoleEntries");
  c.close(); await sleep(200);
  const c3 = connect(t.wsUrl); await c3.opened; await c3.send("Runtime.enable");
  out.replayAfterDiscard = c3.log.filter((m) => m.method === "Runtime.consoleAPICalled").length;
  c3.close();
}
console.log(JSON.stringify(out));
t.send("exit"); setTimeout(() => process.exit(0), 300);
