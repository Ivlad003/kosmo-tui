import { startTarget, connect, sleep, waitFor } from "./lib.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const file = new URL("./t0.mjs", import.meta.url).pathname;
const line = readFileSync(file, "utf8").split("\n").findIndex((l) => l.includes("LINE_CALC"));
const t = await startTarget(["--inspect=127.0.0.1:0"], file);
await waitFor(() => t.stdout.includes("READY"));
const c = connect(t.wsUrl); await c.opened;
const out = { node: process.version };
const msgs = []; const exc = []; let pauses = 0;
c.on((m) => { if (m.method === "Runtime.consoleAPICalled") msgs.push(m.params); if (m.method === "Runtime.exceptionThrown") exc.push(m.params.exceptionDetails.exception?.description?.split("\n")[0]); if (m.method === "Debugger.paused") { pauses++; c.send("Debugger.resume"); } });
await c.send("Runtime.enable"); await c.send("Debugger.enable");
await c.send("Runtime.evaluate", { expression: `Object.defineProperty(globalThis, Symbol.for("kt"), { value: (tp, names, thunks) => { const o = {}; if (!names) { try { const v = thunks(); for (const k in v) o[k] = v[k]; } catch (e) { o.$captureError = String(e); } } else names.forEach((n, i) => { try { o[n] = thunks[i](); } catch (e) { o[n] = { $type: "unavailable", why: String(e) }; } }); console.context("kosmo-tui").trace("KOSMO_TP", tp, JSON.stringify(o)); }, enumerable: false })` });
const H = `globalThis[Symbol.for("kt")]`;
const conds = {
  single_ok: `(${H}(1, null, () => ({ item, qty })), false)`,
  single_tdz: `(${H}(2, null, () => ({ item, qty, later })), false)`,
  single_missing: `(${H}(3, null, () => ({ item, qty, nope })), false)`,
  per_name: `(${H}(4, ["item","qty","later","nope","price"], [() => item, () => qty, () => later, () => nope, () => price]), false)`,
  kw_this: `(${H}(5, null, () => ({ this })), false)`,
  kw_class: `(${H}(6, null, () => ({ class: 1, delete })), false)`,
};
const r = {};
for (const [k, cond] of Object.entries(conds)) {
  msgs.length = 0; exc.length = 0;
  const bp = await c.send("Debugger.setBreakpointByUrl", { url: pathToFileURL(file).href, lineNumber: line, condition: cond });
  t.send("run"); await sleep(300);
  r[k] = { locs: bp.locations.length, msgs: msgs.map((m) => ({ ctx: m.context, args: m.args.map((a) => a.value) })), exc: [...exc] };
  await c.send("Debugger.removeBreakpoint", { breakpointId: bp.breakpointId });
}
out.r = r; out.pauses = pauses;
console.log(JSON.stringify(out, null, 1));
t.send("exit"); c.close(); setTimeout(() => process.exit(0), 300);
