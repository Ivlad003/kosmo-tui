// Throwaway CDP probe: does a non-pausing tracepoint give us the call path + values without stopping the app?
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const targetPath = here + "target.mjs";
const targetUrl = pathToFileURL(targetPath).href;
const src = readFileSync(targetPath, "utf8").split("\n");
const lineOf = (tag) => src.findIndex((l) => l.includes(tag)); // 0-based, as CDP wants

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = { node: process.version, hasGlobalWebSocket: typeof WebSocket === "function" };

const child = spawn(process.execPath, ["--inspect=127.0.0.1:0", targetPath], { stdio: ["pipe", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => (stdout += d));
child.stderr.on("data", (d) => (stderr += d));
const waitFor = async (pred, ms = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(20);
  }
  return false;
};
const send = (cmd) => child.stdin.write(cmd + "\n");
const lastMatch = (re) => {
  const all = [...stdout.matchAll(new RegExp(re.source, "g"))];
  return all.length ? all[all.length - 1] : null;
};

await waitFor(() => /ws:\/\/\S+/.test(stderr) && stdout.includes("READY"));
const wsUrl = stderr.match(/ws:\/\/\S+/)[0];
const port = new URL(wsUrl).port;

// Discovery: /json/list and /json/version, and the bare-port connect the user first imagined.
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
results.discovery = {
  listLength: list.length,
  listFields: Object.keys(list[0]).sort(),
  listUrl: list[0].url,
  browser: version.Browser,
  wsMatchesList: list[0].webSocketDebuggerUrl === wsUrl,
};
results.bareWsConnect = await new Promise((resolve) => {
  const w = new WebSocket(`ws://127.0.0.1:${port}`);
  w.onopen = () => (w.close(), resolve("opened"));
  w.onerror = () => resolve("rejected");
  setTimeout(() => resolve("timeout"), 2000);
});

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else for (const l of listeners) l(m);
  };
  const opened = new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  return {
    ws,
    opened,
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params }));
      }),
    on: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
  };
}

const cdp = connect(wsUrl);
await cdp.opened;
const events = [];
cdp.on((m) => events.push(m));
const scripts = new Map();
cdp.on((m) => m.method === "Debugger.scriptParsed" && scripts.set(m.params.url, m.params));
await cdp.send("Runtime.enable");
await cdp.send("Debugger.enable");
await cdp.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
await waitFor(() => scripts.has(targetUrl) && scripts.has("/virtual/project/src/pricing.ts"));
results.scriptUrls = {
  target: scripts.has(targetUrl) ? "file:// url" : "missing",
  ssr: scripts.get("/virtual/project/src/pricing.ts")
    ? { hasSourceURL: scripts.get("/virtual/project/src/pricing.ts").hasSourceURL }
    : "missing",
};

send("ctx");
await waitFor(() => stdout.includes("CTX"));
results.consoleContextInTarget = lastMatch(/CTX (\S+)/)[1];

const countSince = (from, pred) => events.slice(from).filter(pred).length;
const gap = async () => {
  const before = stdout.length;
  send("gap");
  await waitFor(() => stdout.slice(before).includes("GAP"));
  return Number(stdout.slice(before).match(/GAP (\d+)/)[1]);
};
const frames = (st) =>
  (st?.callFrames ?? []).map((f) => `${f.functionName || "(anon)"}@${f.url.split("/").pop()}:${f.lineNumber + 1}`);
const chain = (st) => {
  const out = [];
  for (let p = st?.parent; p; p = p.parent) out.push({ description: p.description, frames: frames(p) });
  return out;
};

async function tracepoint(name, { location, byUrl, condition, waitMs = 1500 }) {
  await gap(); // reset the target's max tick gap
  const from = events.length;
  const outFrom = stdout.length;
  const errFrom = stderr.length;
  const bp = byUrl
    ? await cdp.send("Debugger.setBreakpointByUrl", { ...byUrl, condition })
    : await cdp.send("Debugger.setBreakpoint", { location, condition });
  await sleep(waitMs);
  const maxGapMs = await gap();
  await cdp.send("Debugger.removeBreakpoint", { breakpointId: bp.breakpointId });
  const mine = events.slice(from);
  const consoleHits = mine.filter((m) => m.method === "Runtime.consoleAPICalled");
  const bindingHits = mine.filter((m) => m.method === "Runtime.bindingCalled");
  const first = consoleHits[0]?.params;
  const r = {
    resolved: byUrl ? bp.locations.length : bp.actualLocation ? 1 : 0,
    paused: countSince(from, (m) => m.method === "Debugger.paused"),
    consoleHits: consoleHits.length,
    bindingHits: bindingHits.length,
    exceptionThrown: mine
      .filter((m) => m.method === "Runtime.exceptionThrown")
      .map((m) => m.params.exceptionDetails.exception?.description?.split("\n")[0] ?? m.params.exceptionDetails.text)
      .slice(0, 2),
    maxTickGapMs: maxGapMs,
    leakedToTargetStdout: stdout.slice(outFrom).includes("KOSMO"),
    leakedToTargetStderr: stderr.slice(errFrom).includes("KOSMO"),
  };
  if (first) {
    r.first = {
      type: first.type,
      context: first.context,
      args: first.args.map((a) => a.value ?? a.description),
      syncFrames: frames(first.stackTrace),
      asyncParents: chain(first.stackTrace),
      parentId: first.stackTrace?.parentId ?? null,
    };
    if (first.stackTrace?.parentId) {
      const more = await cdp.send("Debugger.getStackTrace", { stackTraceId: first.stackTrace.parentId });
      r.first.viaGetStackTrace = { description: more.stackTrace.description, frames: frames(more.stackTrace) };
    }
  }
  if (bindingHits[0]) r.firstBinding = JSON.parse(bindingHits[0].params.payload);
  results[name] = r;
}

const tpLine = lineOf("LINE_TP");
const hotLine = lineOf("LINE_HOT");
const ssr = scripts.get("/virtual/project/src/pricing.ts");
const ssrSrc = (await cdp.send("Debugger.getScriptSource", { scriptId: ssr.scriptId })).scriptSource.split("\n");
const ssrLine = ssrSrc.findIndex((l) => l.includes("LINE_SSR"));
const cap = (g, n) => `(globalThis.${g} ??= { n: 0 }).n++ < ${n}`;
const capture = "JSON.stringify({ item, qty, price })";

// A: console.context(...).log tracepoint, capped at 5 hits inside the VM, never pauses.
await tracepoint("A_contextLog", {
  byUrl: { url: targetUrl, lineNumber: tpLine },
  condition: `(${cap("__kA", 5)} && console.context("kosmo-tui").log("KOSMO_HIT", ${capture}), false)`,
});
// B: same with .trace, which the protocol says reports the async chain automatically.
await tracepoint("B_contextTrace", {
  byUrl: { url: targetUrl, lineNumber: tpLine },
  condition: `(${cap("__kB", 5)} && console.context("kosmo-tui").trace("KOSMO_HIT", ${capture}), false)`,
});
// C: Runtime.addBinding: no console at all; stack via new Error().stack in the payload.
await cdp.send("Runtime.addBinding", { name: "__kosmoHit" });
await tracepoint("C_binding", {
  byUrl: { url: targetUrl, lineNumber: tpLine },
  condition: `(${cap("__kC", 5)} && __kosmoHit(JSON.stringify({ item, qty, price, stack: new Error().stack.split("\\n").slice(1, 8) })), false)`,
});
// D: a condition that throws: does it pause, and do we hear about it?
await tracepoint("D_throwingCondition", {
  byUrl: { url: targetUrl, lineNumber: tpLine },
  condition: `(notDefinedAnywhere.x, false)`,
  waitMs: 600,
});
// E: Vite-SSR-like AsyncFunction script with //# sourceURL: breakpoint by scriptId.
await tracepoint("E_ssrScriptById", {
  location: { scriptId: ssr.scriptId, lineNumber: ssrLine },
  condition: `(${cap("__kE", 3)} && console.context("kosmo-tui").log("KOSMO_HIT", JSON.stringify({ total, pct })), false)`,
});

// F: overhead of a capped tracepoint on a hot line (200k calls).
const bench = async () => {
  const before = stdout.length;
  send("bench");
  await waitFor(() => stdout.slice(before).includes("BENCH"), 30000);
  return Number(stdout.slice(before).match(/BENCH (\S+)/)[1]);
};
const baseMs = await bench();
const hotBp = await cdp.send("Debugger.setBreakpointByUrl", {
  url: targetUrl,
  lineNumber: hotLine,
  condition: `(${cap("__kF", 5)} && console.context("kosmo-tui").log("KOSMO_HIT", x), false)`,
});
const tpMs = await bench();
await cdp.send("Debugger.removeBreakpoint", { breakpointId: hotBp.breakpointId });
const afterMs = await bench();
results.F_hotLine200k = { baselineMs: baseMs, withCappedTracepointMs: tpMs, afterRemoveMs: afterMs };

// F2: no in-VM cap; the CLIENT removes the breakpoint on the 5th hit it receives. Can the removal
// interrupt a synchronous hot loop, or does the loop run to the end at full per-hit cost?
let f2hits = 0;
let f2bp = null;
let f2removedAtHit = null;
const offF2 = cdp.on((m) => {
  if (m.method !== "Runtime.consoleAPICalled" || m.params.args[0]?.value !== "KOSMO_F2") return;
  f2hits++;
  if (f2hits === 5 && f2bp) {
    f2removedAtHit = f2hits;
    cdp.send("Debugger.removeBreakpoint", { breakpointId: f2bp });
  }
});
f2bp = (
  await cdp.send("Debugger.setBreakpointByUrl", {
    url: targetUrl,
    lineNumber: hotLine,
    condition: `(console.context("kosmo-tui").log("KOSMO_F2", x), false)`,
  })
).breakpointId;
const f2ms = await bench();
await sleep(500);
offF2();
results.F2_clientRemovesAfter5 = { benchMs: f2ms, hitsReceived: f2hits, removedAtHit: f2removedAtHit };

// G: a real pausing breakpoint, then drop the socket WITHOUT resuming: does the app come back?
const tickNow = () => Number(lastMatch(/tick (\d+)/)?.[1] ?? 0);
await cdp.send("Debugger.setBreakpointByUrl", { url: targetUrl, lineNumber: tpLine });
const pausedOk = await waitFor(() => events.some((m) => m.method === "Debugger.paused"), 3000);
const tickAtPause = tickNow();
await sleep(700);
const tickStillPaused = tickNow();
cdp.ws.close();
await sleep(1500);
results.G_disconnectWhilePaused = {
  paused: pausedOk,
  ticksWhilePaused: tickStillPaused - tickAtPause,
  ticksAfterDisconnect: tickNow() - tickStillPaused,
};

// H: process exit while a session is attached: does it hang on "Waiting for the debugger to disconnect"?
const cdp2 = connect(wsUrl);
await cdp2.opened;
await cdp2.send("Runtime.enable");
let ctxDestroyed = false;
cdp2.on((m) => m.method === "Runtime.executionContextDestroyed" && (ctxDestroyed = true));
let exited = false;
child.on("exit", () => (exited = true));
send("exit");
await sleep(1500);
results.H_exitWhileAttached = {
  exitedWithin1500ms: exited,
  executionContextDestroyedSeen: ctxDestroyed,
  waitingMessage: /Waiting for the debugger to disconnect/.test(stderr),
};
cdp2.ws.close();
await waitFor(() => exited, 3000);
results.H_exitWhileAttached.exitedAfterClose = exited;

console.log(JSON.stringify(results, null, 2));
child.kill();
process.exit(0);
