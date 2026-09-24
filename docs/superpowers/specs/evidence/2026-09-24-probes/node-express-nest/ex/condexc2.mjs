import { launch, connect, sleep, killTree, HELPER_SRC as HELPER } from "../cdp.mjs";
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
await c.send("Debugger.setBreakpointByUrl", { url, lineNumber: 27, condition: `(globalThis[Symbol.for("kosmo-tui")]("tp9", [["id", () => id]]), false)\n//# sourceURL=kosmo-tui://tp/tp9` });
await c.send("Runtime.evaluate", { expression: HELPER + "\n//# sourceURL=kosmo-tui://helper" }); const hits = []; c.on("Runtime.consoleAPICalled", (p) => hits.push(p)); for (let i = 0; i < 20; i++) await fetch(`http://127.0.0.1:${port}/api/cart/${i}`, { headers: { authorization: "x" } }).then((r) => r.text()); console.log("hits", hits.length, "top frames of hit:", JSON.stringify(hits[0].stackTrace.callFrames.slice(0, 3).map((f) => [f.functionName, f.url])));
await sleep(200);
for (const e of ex) console.log("condition exceptionThrown:", JSON.stringify({ text: e.text, url: e.url, scriptId: e.scriptId, lineNumber: e.lineNumber, columnNumber: e.columnNumber, desc: e.exception?.description?.slice(0, 120), stackTop: e.stackTrace?.callFrames?.slice(0, 2) }));
console.log("scriptParsed after 20 condition evals:", parsed.slice(n0).length, [...new Set(parsed.slice(n0).map((p) => p.url))]);
c.close(); killTree(t.child); process.exit(0);
