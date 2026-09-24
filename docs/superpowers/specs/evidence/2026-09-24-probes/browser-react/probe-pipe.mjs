// --remote-debugging-pipe: no TCP listener, only the parent process can drive the browser.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { launch, sleep } from "./cdp.mjs";

const br = launch({ pipe: true });
try {
  const cdp = br.cdp;
  const v = await cdp.send("Browser.getVersion");
  console.log("pipe Browser.getVersion:", v.product, v.protocolVersion);
  await sleep(500);
  let listen = "";
  try { listen = execFileSync("lsof", ["-a", "-p", String(br.child.pid), "-iTCP", "-sTCP:LISTEN", "-P", "-n"], { encoding: "utf8" }); } catch { listen = "(none)"; }
  console.log("LISTEN sockets of browser pid:", listen.trim() || "(none)");
  console.log("DevToolsActivePort exists:", existsSync(path.join(br.profile, "DevToolsActivePort")));
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const r = await cdp.send("Runtime.evaluate", { expression: "1+1", returnByValue: true }, sessionId);
  console.log("flat session over pipe evaluate:", r.result.value);
  const cl = await cdp.send("Browser.getBrowserCommandLine").catch((e) => ({ error: e.message }));
  console.log("Browser.getBrowserCommandLine:", cl.error ?? cl.arguments.filter((a) => /user-data-dir|remote-debugging|enable-automation/.test(a)));
  await cdp.send("Browser.close").catch(() => {});
} catch (e) { console.log("ERROR", e.stack); }
finally { await sleep(300); br.cleanup(); console.log("exit", br.child.exitCode, br.child.signalCode); process.exit(0); }
