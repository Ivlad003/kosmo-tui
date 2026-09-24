import { launch, sleep } from "./cdp.mjs";
for (const url of ["http://[::1]:3299/", "http://localhost:3299/"]) {
  const br = launch({ pipe: true }); const cdp = br.cdp; let S; const ws = [];
  cdp.on((m) => { if (m.method === "Network.webSocketHandshakeResponseReceived") ws.push(m.params.response.status); if (m.method === "Network.webSocketCreated") ws.push("created " + m.params.url.replace(/\?.*/, "")); });
  try {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: targetInfos.find((t) => t.type === "page").targetId, flatten: true });
    S = cdp.session(sessionId);
    await S.send("Network.enable"); await S.send("Page.enable"); await S.send("Runtime.enable");
    await S.send("Page.navigate", { url }); await sleep(4000);
    const r = await S.send("Runtime.evaluate", { expression: "document.querySelector('#inc') && (document.querySelector('#inc').click(), new Promise(r => setTimeout(() => r(document.querySelector('#inc').textContent), 300)))", awaitPromise: true, returnByValue: true });
    console.log(url, "| ws events:", ws, "| button after click:", r.result.value);
    await cdp.send("Browser.close").catch(() => {});
  } catch (e) { console.log("ERROR", e.message); } finally { await sleep(200); br.cleanup(); }
}
process.exit(0);
