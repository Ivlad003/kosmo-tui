import { launch, connect, sleep } from "./c.mjs";
for (const f of ["cjs.js", "esm.mjs", "rej.js"]) {
  const t = launch("/Users/kosmodev/.nvm/versions/node/v22.22.0/bin/node", ["--inspect=127.0.0.1:0", f], { cwd: new URL("./u/", import.meta.url).pathname });
  const c = await connect(await t.ws); const ex = []; let wfd = false, ctxd = false;
  c.on("Runtime.exceptionThrown", (p) => ex.push(p.exceptionDetails)); c.on("NodeRuntime.waitingForDisconnect", () => wfd = true); c.on("Runtime.executionContextDestroyed", () => ctxd = true);
  await c.send("NodeRuntime.notifyWhenWaitingForDisconnect", { enabled: true }); await c.send("Runtime.enable");
  await sleep(1200);
  const e = ex[0];
  console.log(f, JSON.stringify({ text: e?.text, url: e?.url, frame0url: e?.stackTrace?.callFrames?.[0]?.url, desc: e?.exception?.description?.split("\n")[0] }), "waitingForDisconnect", wfd, "ctxDestroyed", ctxd, "stderr tail", JSON.stringify(t.out.stderr.split("\n").filter(l=>/Waiting|Error/.test(l)).slice(0,2)));
  c.close(); await sleep(300); console.log("  exit after close:", JSON.stringify(t.out.exit)); t.ch.kill("SIGKILL");
}
process.exit(0);
