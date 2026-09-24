import { launch, connect, sleep, killTree } from "../cdp.mjs";
import { pathToFileURL } from "node:url";
import path from "node:path";
const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "e5");
const t = launch({ node: "/Users/kosmodev/.nvm/versions/node/v22.22.0/bin/node", args: ["--inspect=127.0.0.1:0", "app.js"], cwd: DIR, env: { KEEP_ALIVE: "1" } });
const ws = await t.ws; let port; for (let i = 0; i < 50 && !port; i++) { await sleep(100); port = /PORT (\d+)/.exec(t.out.stdout)?.[1]; }
const c = await connect(ws); const ex = []; const parsed = [];
c.on("Runtime.exceptionThrown", (p) => ex.push(p.exceptionDetails));
c.on("Debugger.scriptParsed", (p) => parsed.push(p));
await c.send("Runtime.enable"); await c.send("Debugger.enable"); await sleep(200);
const n0 = parsed.length;
const url = pathToFileURL(path.join(DIR, "app.js")).href;
await c.send("Debugger.setBreakpointByUrl", { url, lineNumber: 27, condition: `(globalThis[Symbol.for("kosmo-tui-missing")]("tp9", [["id", () => id]]), false)\n//# sourceURL=kosmo-tui://tp/tp9` });
await fetch(`http://127.0.0.1:${port}/api/cart/1`, { headers: { authorization: "x" } }).then((r) => r.text());
await sleep(200);
for (const e of ex) console.log("condition exceptionThrown:", JSON.stringify({ text: e.text, url: e.url, scriptId: e.scriptId, lineNumber: e.lineNumber, columnNumber: e.columnNumber, desc: e.exception?.description?.slice(0, 120), stackTop: e.stackTrace?.callFrames?.slice(0, 2) }));
console.log("new scripts parsed after condition eval:", parsed.slice(n0).map((p) => ({ url: p.url, hasSourceURL: p.hasSourceURL, len: p.length })));
c.close(); killTree(t.child); process.exit(0);
