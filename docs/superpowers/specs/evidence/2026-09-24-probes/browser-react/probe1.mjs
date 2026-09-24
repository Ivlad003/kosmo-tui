// Probe 1: headless Chrome, temp profile, non-pausing tracepoint via CDP in page, worker and OOPIF.
import { spawn } from "node:child_process";
import http from "node:http";
import { launch, waitActivePort, connectWs, sleep, maskWs, CHROME, CFT, SCRATCH } from "./cdp.mjs";
import { HELPER, condition } from "./helper.mjs";

const bin = process.argv[2] === "cft" ? CFT : CHROME;
const log = (...a) => console.log(...a);
const server = spawn(process.execPath, [`${SCRATCH}/site/server.mjs`], { stdio: ["ignore", "pipe", "inherit"] });
const { port: sitePort } = await new Promise((r) => server.stdout.once("data", (d) => r(JSON.parse(d))));
const br = launch({ bin });
const cleanup = () => { br.cleanup(); server.kill("SIGTERM"); };
process.on("exit", cleanup);
const timer = setTimeout(() => { log("TIMEOUT"); process.exit(2); }, 60000);

try {
  const { port, path: wsPath } = await waitActivePort(br.profile);
  log("chrome pid", br.child.pid, "devtools port", port, "path", maskWs(wsPath));
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  log("/json/version", { Browser: version.Browser, "Protocol-Version": version["Protocol-Version"], "User-Agent": version["User-Agent"], webSocketDebuggerUrl: maskWs(version.webSocketDebuggerUrl) });

  // --- Security checks on the HTTP endpoint and WS upgrade ---
  const raw = (headers, p = "/json/version") => new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, headers }, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, body: b.slice(0, 120) })); });
    req.on("upgrade", (res, sock) => { resolve({ status: res.statusCode, upgraded: true }); sock.destroy(); });
    req.on("error", (e) => resolve({ error: e.message })); req.end();
  });
  log("Host: evil.example ->", await raw({ Host: "evil.example" }));
  log("Host: localhost ->", (await raw({ Host: `localhost:${port}` })).status);
  const wsHeaders = (extra) => ({ Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", ...extra });
  log("WS upgrade Origin: http://evil.example ->", await raw(wsHeaders({ Origin: "http://evil.example" }), wsPath));
  log("WS upgrade Origin: http://127.0.0.1:5173 ->", await raw(wsHeaders({ Origin: `http://127.0.0.1:${sitePort}` }), wsPath));
  log("WS upgrade no Origin ->", await raw(wsHeaders({}), wsPath));
  log("PUT-less /json/new ->", await raw({}, "/json/new?about:blank"));

  const cdp = await connectWs(`ws://127.0.0.1:${port}${wsPath}`);
  log("global WebSocket to browser endpoint: connected");

  const events = { console: [], pausedCount: 0, attached: [], ctxDestroyed: 0, ctxCleared: 0, exceptions: [], scripts: [], binding: [] };
  const sessions = new Map(); // sessionId -> {type,url}
  cdp.on((m) => {
    if (m.method === "Runtime.consoleAPICalled") {
      if (m.params.context?.startsWith("kosmo-tui#")) events.console.push({ sessionId: m.sessionId, context: m.params.context, type: m.params.type, args: m.params.args.map((a) => a.value), stack: m.params.stackTrace });
    } else if (m.method === "Debugger.paused") { events.pausedCount++; cdp.send("Debugger.resume", {}, m.sessionId); }
    else if (m.method === "Target.attachedToTarget") events.attached.push({ type: m.params.targetInfo.type, url: m.params.targetInfo.url, sessionId: m.params.sessionId, waiting: m.params.waitingForDebugger });
    else if (m.method === "Runtime.executionContextDestroyed") events.ctxDestroyed++;
    else if (m.method === "Runtime.executionContextsCleared") events.ctxCleared++;
    else if (m.method === "Runtime.exceptionThrown") events.exceptions.push(m.params.exceptionDetails.text + " " + (m.params.exceptionDetails.exception?.description ?? ""));
    else if (m.method === "Debugger.scriptParsed" && /^https?:/.test(m.params.url)) events.scripts.push({ sessionId: m.sessionId, ...m.params });
    else if (m.method === "Runtime.bindingCalled") events.binding.push({ sessionId: m.sessionId, name: m.params.name, payload: m.params.payload });
  });

  const targets = await cdp.send("Target.getTargets");
  log("targets at start", targets.targetInfos.map((t) => t.type + " " + t.url));
  const pageT = targets.targetInfos.find((t) => t.type === "page");
  const { sessionId: pageS } = await cdp.send("Target.attachToTarget", { targetId: pageT.targetId, flatten: true });
  const P = cdp.session(pageS);

  // Auto-attach children (workers, OOPIFs). Each child gets the same setup, recursively.
  async function setupChild(sessionId, type) {
    const S = cdp.session(sessionId);
    await S.send("Runtime.enable");
    await S.send("Debugger.enable");
    await S.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
    if (type === "iframe") {
      await S.send("Page.enable").catch(() => {});
      await S.send("Page.addScriptToEvaluateOnNewDocument", { source: HELPER, runImmediately: true }).catch((e) => log("iframe addScript", e.message));
      await S.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    } else {
      const r = await S.send("Runtime.evaluate", { expression: HELPER, returnByValue: true }).catch((e) => ({ error: e.message }));
      log(`helper in ${type} before run:`, r.result?.value ?? r.error ?? r.exceptionDetails?.text);
    }
    await S.send("Runtime.runIfWaitingForDebugger");
  }
  cdp.on((m) => { if (m.method === "Target.attachedToTarget") setupChild(m.params.sessionId, m.params.targetInfo.type).catch((e) => log("setupChild", e.message)); });

  await P.send("Page.enable");
  const addScript = await P.send("Page.addScriptToEvaluateOnNewDocument", { source: HELPER, runImmediately: true });
  await P.send("Runtime.enable");
  await P.send("Debugger.enable");
  await P.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
  await P.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await P.send("Runtime.addBinding", { name: "__kosmoTuiBinding" });

  await P.send("Page.navigate", { url: `http://127.0.0.1:${sitePort}/` });
  await sleep(1200);
  log("auto-attached", events.attached.map((a) => `${a.type} ${a.url} waiting=${a.waiting}`));
  const describe = (s) => ({ url: s.url, hasSourceURL: s.hasSourceURL, sourceMapURL: s.sourceMapURL || "", isModule: s.isModule, embedderName: s.embedderName, aux: s.executionContextAuxData, scriptLanguage: s.scriptLanguage, startLine: s.startLine });
  for (const s of events.scripts) log("scriptParsed", describe(s));

  const appScript = events.scripts.find((s) => s.url.endsWith("/app.js") && s.sessionId === pageS);
  const workerScript = events.scripts.find((s) => s.url.endsWith("/worker.js"));
  const frameScript = events.scripts.find((s) => s.url.endsWith("/frame.js"));

  // tracepoint in page by scriptId (line 4 1-based = "const doubled" -> 0-based 3)
  const bp1 = await P.send("Debugger.setBreakpoint", { location: { scriptId: appScript.scriptId, lineNumber: 3 }, condition: condition(1, ["n", "user", "doubled", "notDefinedHere"]) });
  log("page setBreakpoint actualLocation", bp1.actualLocation);
  if (workerScript) {
    const W = cdp.session(workerScript.sessionId);
    const bpw = await W.send("Debugger.setBreakpoint", { location: { scriptId: workerScript.scriptId, lineNumber: 1 }, condition: condition(2, ["k"]) });
    log("worker setBreakpoint", bpw.actualLocation);
  }
  if (frameScript) {
    const F = cdp.session(frameScript.sessionId);
    const bpf = await F.send("Debugger.setBreakpoint", { location: { scriptId: frameScript.scriptId, lineNumber: 1 }, condition: condition(3, ["j"]) });
    log("frame setBreakpoint", bpf.actualLocation, "frame session is separate target:", frameScript.sessionId !== pageS);
  }

  // second client = "DevTools frontend" observer
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  log("/json/list", list.map((t) => ({ type: t.type, url: t.url, id: maskWs(t.id), parentId: t.parentId ? maskWs(t.parentId) : undefined })));
  const pageEntry = list.find((t) => t.type === "page");
  const obs = await connectWs(pageEntry.webSocketDebuggerUrl.replace("localhost", "127.0.0.1"));
  const obsSeen = { kosmo: 0, binding: 0, other: 0 };
  obs.on((m) => { if (m.method === "Runtime.consoleAPICalled") { if (m.params.context?.startsWith("kosmo-tui#")) obsSeen.kosmo++; else obsSeen.other++; } if (m.method === "Runtime.bindingCalled") obsSeen.binding++; });
  await obs.send("Runtime.enable");

  await P.send("Runtime.evaluate", { expression: "window.__gap = 0" });
  const t0 = events.console.length;
  await sleep(1500);
  const pageHits = events.console.filter((e) => e.args[1] === 1);
  log("hits in 1.5s window: page", pageHits.length, "worker", events.console.filter((e) => e.args[1] === 2).length, "frame", events.console.filter((e) => e.args[1] === 3).length, "paused events", events.pausedCount);
  log("observer (2nd client, like DevTools) saw kosmo-tui console msgs:", obsSeen.kosmo, "other:", obsSeen.other);
  const sample = pageHits.at(-1);
  if (sample) {
    log("sample args", sample.type, sample.context, sample.args);
    log("distinct contexts", [...new Set(events.console.map((e) => e.sessionId.slice(-4) + ":" + e.context))]);
    const frames = (st) => st.callFrames.map((f) => `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}:${f.columnNumber + 1}`);
    let st = sample.stack, depth = 0;
    log("sync frames", frames(st));
    while (st.parent && depth++ < 6) { st = st.parent; log(`async parent [${st.description}]`, frames(st)); }
    log("parentId present?", Boolean(sample.stack.parentId));
  }
  const pageSeen = await P.send("Runtime.evaluate", { expression: "JSON.stringify({seen: [...new Set(window.__seen)], gap: Math.round(window.__gap), hasKey: Object.getOwnPropertySymbols(globalThis).map(String), enumerable: Object.keys(globalThis).includes('kosmo-tui'), binding: typeof window.__kosmoTuiBinding})", returnByValue: true });
  log("page view", pageSeen.result.value);
  log("exceptions", events.exceptions.slice(0, 3));

  // Binding channel: quiet path, no console message
  await P.send("Debugger.removeBreakpoint", { breakpointId: bp1.breakpointId });
  const bpB = await P.send("Debugger.setBreakpoint", { location: { scriptId: appScript.scriptId, lineNumber: 3 }, condition: `(globalThis.__kosmoTuiBinding?.(JSON.stringify({tp: 9, n, stack: new Error().stack})), false)` });
  const c0 = events.console.length, ob0 = obsSeen.kosmo + obsSeen.other;
  await sleep(500);
  log("binding channel: bindingCalled on our session", events.binding.filter((b) => b.sessionId === pageS).length, "observer bindingCalled", obsSeen.binding, "new console msgs", events.console.length - c0, "observer console", obsSeen.kosmo + obsSeen.other - ob0);
  if (events.binding[0]) log("binding payload sample", events.binding[0].payload.slice(0, 300));
  await P.send("Debugger.removeBreakpoint", { breakpointId: bpB.breakpointId });

  // Reload: scriptId breakpoint vs byUrl breakpoint, helper persistence, context events
  const byUrl = await P.send("Debugger.setBreakpointByUrl", { url: appScript.url, lineNumber: 3, condition: condition(4, ["n"]) });
  log("setBreakpointByUrl locations", byUrl.locations.length);
  const bp5 = await P.send("Debugger.setBreakpoint", { location: { scriptId: appScript.scriptId, lineNumber: 3 }, condition: condition(5, ["n"]) });
  const before = events.console.length; const cd0 = events.ctxDestroyed, cc0 = events.ctxCleared; const nScripts = events.scripts.length;
  await P.send("Page.reload", { ignoreCache: true });
  await sleep(1500);
  const after = events.console.slice(before);
  const newApp = events.scripts.slice(nScripts).filter((s) => s.url.endsWith("/app.js"));
  log("after reload: ctxDestroyed", events.ctxDestroyed - cd0, "ctxCleared", events.ctxCleared - cc0, "new app.js scriptIds", newApp.map((s) => s.scriptId), "old", appScript.scriptId);
  log("after reload hits: byUrl(tp4)", after.filter((e) => e.args[1] === 4).length, "scriptId(tp5)", after.filter((e) => e.args[1] === 5).length);
  await P.send("Debugger.removeBreakpoint", { breakpointId: byUrl.breakpointId });
  await P.send("Debugger.removeBreakpoint", { breakpointId: bp5.breakpointId }).catch((e) => log("remove stale scriptId bp:", e.message));

  // Hot loop cost: condition false vs no breakpoint
  const newAppScript = newApp.at(-1);
  const base = (await P.send("Runtime.evaluate", { expression: "runHot(200000)", returnByValue: true })).result.value;
  const hotBp = await P.send("Debugger.setBreakpoint", { location: { scriptId: newAppScript.scriptId, lineNumber: 14, columnNumber: 20 }, condition: "false" });
  log("hot bp at", hotBp.actualLocation);
  const withBp = (await P.send("Runtime.evaluate", { expression: "runHot(200000)", returnByValue: true })).result.value;
  await P.send("Debugger.removeBreakpoint", { breakpointId: hotBp.breakpointId });
  log(`hot loop 200k: no bp ${base.toFixed(1)} ms, condition=false ${withBp.toFixed(1)} ms => ${((withBp - base) / 200).toFixed(1)} us/pass`);

  // Exposure of the profile's secrets through a page target
  const pageSecrets = await P.send("Runtime.evaluate", { expression: "JSON.stringify({cookie: document.cookie, ls: localStorage.getItem('token')})", returnByValue: true });
  log("page Runtime.evaluate sees", pageSecrets.result.value);
  const allCookies = await cdp.send("Storage.getCookies", {});
  log("browser Storage.getCookies (incl HttpOnly):", allCookies.cookies.map((c) => `${c.name}@${c.domain} httpOnly=${c.httpOnly}`));

  log("chrome stderr mentions KOSMO_TP:", br.stderr.includes("KOSMO_TP"), "| stderr lines:", br.stderr.split("\n").filter(Boolean).length);
  log("stderr head:", br.stderr.split("\n").slice(0, 4).map(maskWs));
  await cdp.send("Browser.close").catch(() => {});
  obs.close(); cdp.close();
} catch (e) {
  log("ERROR", e.stack);
} finally {
  clearTimeout(timer);
  await sleep(300);
  cleanup();
  log("cleanup done; chrome exitCode", br.child.exitCode, "signal", br.child.signalCode);
  process.exit(0);
}
