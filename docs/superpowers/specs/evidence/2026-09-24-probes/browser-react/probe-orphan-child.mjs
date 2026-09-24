// Parent launches Chrome (pipe or port) and prints its pid, then waits to be SIGKILLed.
import { launch } from "./cdp.mjs";
const pipe = process.argv[2] === "pipe";
const br = launch({ pipe });
if (pipe) await br.cdp.send("Browser.getVersion");
else await new Promise((r) => setTimeout(r, 1500));
console.log(JSON.stringify({ pid: br.child.pid, profile: br.profile }));
setInterval(() => {}, 1000);
