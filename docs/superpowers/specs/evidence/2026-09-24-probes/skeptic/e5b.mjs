import { startTarget, connect, sleep } from "./lib.mjs";
const file = new URL("./t5.mjs", import.meta.url).pathname;
const t = await startTarget([`--inspect-brk=127.0.0.1:0`], file);
await sleep(200);
const c = connect(t.wsUrl); await c.opened;
const exprs = ["process.getBuiltinModule('node:process').pid", "process.report && process.report.getReport().header.processId", "process.debugPort", "process.getBuiltinModule('node:inspector').url()"];
const r = { node: process.version, childPid: t.child.pid };
for (const e of exprs) { const x = await c.send("Runtime.evaluate", { expression: e }); r[e] = x.exceptionDetails ? "EXC " + x.exceptionDetails.exception?.description?.split("\n")[0] : x.result.value ?? x.result.type; }
console.log(JSON.stringify(r)); c.close(); t.child.kill(); process.exit(0);
