import { spawn } from "node:child_process";
import { launch, sleep, DIR } from "./cdp.mjs";
const s = spawn(process.execPath, [DIR + "/sw-server.mjs"], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((r) => s.stdout.once("data", (d) => r(JSON.parse(d).port)));
for (const [label, params] of [
  ["no setAutoAttach", null],
  ["filter exclude service_worker+worker, wait:true", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "iframe" }, { type: "worker", exclude: true }, { type: "service_worker", exclude: true }] }],
  ["no filter, wait:true, resume all", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }],
]) {
  const br = launch({ pipe: true }); const cdp = br.cdp; const att = [];
  cdp.on((m) => { if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type !== "page") { att.push(`${m.params.targetInfo.type} w=${m.params.waitingForDebugger}`); cdp.send("Runtime.runIfWaitingForDebugger", {}, m.params.sessionId).catch(() => {}); } });
  try {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: targetInfos.find((t) => t.type === "page").targetId, flatten: true });
    const S = cdp.session(sessionId);
    await S.send("Page.enable"); await S.send("Runtime.enable");
    if (params) await S.send("Target.setAutoAttach", params);
    await S.send("Page.navigate", { url: `http://127.0.0.1:${port}/` }); await sleep(3000);
    const v = (await S.send("Runtime.evaluate", { expression: "window.__sw", returnByValue: true })).result.value;
    const sws = (await cdp.send("Target.getTargets")).targetInfos.filter((t) => t.type === "service_worker").map((t) => `attached=${t.attached}`);
    console.log(`[SW ${label}] page-attached: ${JSON.stringify(att)} | __sw=${v} | service_worker targets: ${JSON.stringify(sws)}`);
    await cdp.send("Browser.close").catch(() => {});
  } catch (e) { console.log("ERROR", e.message); } finally { await sleep(200); br.cleanup(); }
}
s.kill(); process.exit(0);
