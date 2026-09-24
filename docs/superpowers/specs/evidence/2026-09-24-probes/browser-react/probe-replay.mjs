// Are kosmo-tui console messages from an earlier CDP session replayed to a new session on Runtime.enable?
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { launch, waitActivePort, connectWs, sleep, SCRATCH } from "./cdp.mjs";
import { HELPER, condition } from "./helper.mjs";
const server = spawn(process.execPath, [`${SCRATCH}/site/server.mjs`], { stdio: ["ignore", "pipe", "inherit"] });
const { port: sitePort } = await new Promise((r) => server.stdout.once("data", (d) => r(JSON.parse(d))));
const br = launch({});
process.on("exit", () => { br.cleanup(); server.kill(); });
try {
  const { port, path: p } = await waitActivePort(br.profile);
  const mode = (f) => (statSync(f).mode & 0o777).toString(8);
  console.log("profile dir mode", mode(br.profile), "DevToolsActivePort mode", mode(path.join(br.profile, "DevToolsActivePort")));
  const A = await connectWs(`ws://127.0.0.1:${port}${p}`);
  const { targetInfos } = await A.send("Target.getTargets");
  const pageT = targetInfos.find((t) => t.type === "page");
  const { sessionId } = await A.send("Target.attachToTarget", { targetId: pageT.targetId, flatten: true });
  const SA = A.session(sessionId);
  let aHits = 0; A.on((m) => { if (m.method === "Runtime.consoleAPICalled" && m.params.context?.startsWith("kosmo-tui#")) aHits++; });
  await SA.send("Page.enable"); await SA.send("Runtime.enable"); await SA.send("Debugger.enable");
  await SA.send("Page.navigate", { url: `http://127.0.0.1:${sitePort}/` }); await sleep(800);
  await SA.send("Runtime.evaluate", { expression: HELPER });
  let appId; A.on(() => {});
  const { result } = await SA.send("Runtime.evaluate", { expression: "1" });
  const scripts = []; // find app.js via getPossible... simpler: setBreakpointByUrl
  const bp = await SA.send("Debugger.setBreakpointByUrl", { url: `http://127.0.0.1:${sitePort}/app.js`, lineNumber: 3, condition: condition(1, ["n"]) });
  await sleep(500);
  await SA.send("Debugger.removeBreakpoint", { breakpointId: bp.breakpointId });
  console.log("session A got", aHits, "kosmo msgs; disconnecting A (breakpoints of A are dropped)");
  A.close(); await sleep(300);
  const B = await connectWs(`ws://127.0.0.1:${port}${p}`);
  const { sessionId: sb } = await B.send("Target.attachToTarget", { targetId: pageT.targetId, flatten: true });
  let replayed = 0, other = 0; B.on((m) => { if (m.method === "Runtime.consoleAPICalled") { if (m.params.context?.startsWith("kosmo-tui#")) replayed++; else other++; } });
  await B.send("Runtime.enable", {}, sb); await sleep(500);
  const helperStill = await B.send("Runtime.evaluate", { expression: "typeof globalThis[Symbol.for('kosmo-tui')]", returnByValue: true }, sb);
  console.log("session B after Runtime.enable: replayed kosmo msgs", replayed, "other", other, "| helper left in page after A detached:", helperStill.result.value);
  B.close();
} catch (e) { console.log("ERROR", e.stack); } finally { await sleep(200); br.cleanup(); server.kill(); process.exit(0); }
