import { launch, connect, sleep, decodeMap } from "./c.mjs";
const t = launch("/Users/kosmodev/.nvm/versions/node/v22.22.0/bin/node", ["--inspect=127.0.0.1:0", "--import", "file:///Users/kosmodev/Documents/pet_project/kosmo-callflow/node_modules/tsx/dist/loader.mjs", "appm.mts"], { cwd: new URL("./n/", import.meta.url).pathname });
const c = await connect(await t.ws); const sc = []; c.on("Debugger.scriptParsed", (p) => sc.push(p));
await c.send("Debugger.enable"); await sleep(400);
const s = sc.find((x) => x.url.includes("appm.mts"));
const src = (await c.send("Debugger.getScriptSource", { scriptId: s.scriptId })).scriptSource;
console.log("url", s.url, "isModule", s.isModule, "lines", src.split("\n").length, "line1", JSON.stringify(src.split("\n")[0].slice(0, 120)), "line1len", src.split("\n")[0].length, "sources", JSON.stringify(decodeMap(s)?.sources));
c.close(); t.ch.kill("SIGKILL"); await sleep(200); process.exit(0);
