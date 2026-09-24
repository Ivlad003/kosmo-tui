// Does Chrome ignore --remote-debugging-port when --user-data-dir is its *default* dir? Uses a fake HOME only.
import { mkdirSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { launch, sleep, SCRATCH, CHROME, CFT } from "./cdp.mjs";
for (const [label, bin, sub] of [["chrome153", CHROME, "Google/Chrome"], ["cft149", CFT, "Google/Chrome for Testing"]]) {
  for (const headless of [true]) {
    const home = path.join(SCRATCH, "fakehome-" + label);
    const dir = path.join(home, "Library/Application Support", sub);
    mkdirSync(dir, { recursive: true });
    const br = launch({ bin, headless, userDataDir: dir, env: { ...process.env, HOME: home } });
    await sleep(4000);
    const listening = existsSync(path.join(dir, "DevToolsActivePort"));
    const msg = br.stderr.split("\n").find((l) => /non-default data directory|DevTools listening/.test(l)) ?? "(no devtools line)";
    console.log(label, "headless", headless, "DevToolsActivePort:", listening, "|", msg.replace(/[0-9a-f-]{36}/g, "<uuid>"));
    br.kill(); await sleep(500); rmSync(home, { recursive: true, force: true });
  }
}
process.exit(0);
