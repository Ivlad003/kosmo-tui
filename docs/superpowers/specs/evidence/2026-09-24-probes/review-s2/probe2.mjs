import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = fileURLToPath(new URL(".", import.meta.url));
const targetPath = here + "target2.mjs";
const targetUrl = pathToFileURL(targetPath).href;
const src = readFileSync(targetPath, "utf8").split("\n");
const lineOf = (tag) => src.findIndex((l) => l.includes(tag));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = { node: process.version };
const child = spawn(process.execPath, ["--expose-gc", "--inspect=127.0.0.1:0", targetPath], { stdio: ["pipe", "pipe", "pipe"] });
let stdout = "", stderr = "";
child.stdout.on("data", (d) => (stdout += d));
child.stderr.on("data", (d) => (stderr += d));
const waitFor = async (pred, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(20); } return false; };
const send = (c) => child.stdin.write(c + "\n");
await waitFor(() => /ws:\/\/\S+/.test(stderr) && stdout.includes("READY"));
const wsUrl = stderr.match(/ws:\/\/\S+/)[0];
function connect(url) {
  const ws = new WebSocket(url); let id = 0; const pending = new Map(); const listeners = new Set();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } else for (const l of listeners) l(m); };
  const opened = new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  return { ws, opened, send: (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); }), on: (fn) => (listeners.add(fn), () => listeners.delete(fn)) };
}
const cdp = connect(wsUrl); await cdp.opened;
const events = []; cdp.on((m) => events.push(m));
// (b) pid check before Runtime.enable
try {
  const r = await cdp.send("Runtime.evaluate", { expression: "process.pid", throwOnSideEffect: true, returnByValue: true });
  R.b_pid = { result: r.result, exceptionDetails: r.exceptionDetails?.exception?.description ?? r.exceptionDetails?.text ?? null, childPid: child.pid };
} catch (e) { R.b_pid = { protocolError: e.message }; }
const scripts = new Map();
cdp.on((m) => m.method === "Debugger.scriptParsed" && scripts.set(m.params.url, m.params));
await cdp.send("Runtime.enable");
await cdp.send("Debugger.enable");
await cdp.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
await cdp.send("Debugger.setBlackboxPatterns", { patterns: ["/node_modules/"] });
await cdp.send("Debugger.setPauseOnExceptions", { state: "none" });
await waitFor(() => scripts.has(targetUrl));
const tScript = scripts.get(targetUrl);
R.scriptParsedKeys = Object.keys(tScript).sort();
// install helper
const helperSrc = `Object.defineProperty(globalThis, Symbol.for("kosmo-tui"), { enumerable: false, configurable: true, writable: false, value: (() => {
  const ctx = console.context("kosmo-tui");
  const enc = (v) => JSON.stringify(v, (k, x) => x === undefined ? { $type: "undefined" } : x);
  return function kosmoHelper(tpId, cap) {
    let vals;
    if (typeof cap === "function") { try { vals = cap(); } catch (e) { vals = { $captureError: String(e) }; } }
    else { vals = {}; for (const k of Object.keys(cap)) { try { vals[k] = cap[k](); } catch (e) { vals[k] = { $type: "unavailable", why: String(e) }; } } }
    ctx.trace("KOSMO_TP", tpId, enc(vals));
  };
})() }); "installed"`;
R.helperInstall = (await cdp.send("Runtime.evaluate", { expression: helperSrc, returnByValue: true })).result.value;
const H = `globalThis[Symbol.for("kosmo-tui")]`;
const frames = (st) => (st?.callFrames ?? []).map((f) => `${f.functionName || "(anon)"}@${f.url.split("/").pop()}:${f.lineNumber + 1}`);
async function tp(name, line, condition, waitMs = 400) {
  const from = events.length, outFrom = stdout.length, errFrom = stderr.length;
  const bp = await cdp.send("Debugger.setBreakpointByUrl", { url: targetUrl, lineNumber: line, condition });
  await sleep(waitMs);
  await cdp.send("Debugger.removeBreakpoint", { breakpointId: bp.breakpointId });
  await sleep(50);
  const mine = events.slice(from);
  const hits = mine.filter((m) => m.method === "Runtime.consoleAPICalled" && m.params.args[0]?.value === "KOSMO_TP");
  const f = hits[0]?.params;
  R[name] = {
    resolvedAt: bp.locations.map((l) => l.lineNumber + 1 + ":" + l.columnNumber),
    hits: hits.length,
    paused: mine.filter((m) => m.method === "Debugger.paused").length,
    exceptionThrown: [...new Set(mine.filter((m) => m.method === "Runtime.exceptionThrown").map((m) => m.params.exceptionDetails.exception?.description?.split("\n")[0]))],
    firstPayload: f?.args?.[2]?.value,
    context: f?.context,
    syncFrames: frames(f?.stackTrace),
    asyncParent: f?.stackTrace?.parent ? { description: f.stackTrace.parent.description, frames: frames(f.stackTrace.parent) } : null,
    parentId: f?.stackTrace?.parentId ?? null,
    stdoutLeak: stdout.slice(outFrom).includes("KOSMO"), stderrLeak: stderr.slice(errFrom).includes("KOSMO"),
  };
}
const LTP = lineOf("LINE_TP"), LIN = lineOf("LINE_INNER");
await tp("c1_singleClosure_item_qty", LTP, `(${H}(1, () => ({ item, qty })), false)`);
await tp("c2_singleClosure_with_TDZ_later", LTP, `(${H}(2, () => ({ item, qty, later })), false)`);
await tp("c3_singleClosure_with_missing_name", LTP, `(${H}(3, () => ({ item, qty, nope })), false)`);
await tp("c4_perName_item_qty_later_nope_price", LTP, `(${H}(4, { item: () => item, qty: () => qty, later: () => later, nope: () => nope, price: () => price }), false)`);
await tp("c5_inner_outerScopes", LIN, `(${H}(5, { a: () => a, usedOuter: () => usedOuter, hiddenOuter: () => hiddenOuter, modUnused: () => modUnused }), false)`);
await tp("c6_direct_TDZ_in_condition_no_closure", LTP, `(${H}(6, { later: (() => { try { return later } catch (e) { return String(e) } })() }), false)`);
// typeof check on TDZ name directly
await tp("c7_direct_typeof_later", LTP, `(${H}(7, { t: typeof later }), false)`);
console.log(JSON.stringify(R, null, 2));
child.kill(); process.exit(0);
