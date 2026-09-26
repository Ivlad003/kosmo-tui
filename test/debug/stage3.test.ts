/**
 * Live paths of the remaining spec items: source-mapped arming and `:max-pause` on a real Node
 * inspector, SIGUSR1 discovery, and (when a Chromium is installed) a tracepoint hit in the browser.
 */
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { findBrowser } from "../../src/debug/browser.js";
import { DebugController, type DebugEvent } from "../../src/debug/port.js";
import { findInspectorOfPid } from "../../src/debug/scan.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await sleep(50);
  }
  return read();
}

/** Attaches through the confirm screen, as the UI does. */
async function attachConfirmed(controller: DebugController, events: DebugEvent[], port: number): Promise<void> {
  await controller.handle({ type: "attachAddress", host: "127.0.0.1", port });
  const ask = events.find((event) => event.type === "confirm");
  if (ask?.type !== "confirm") throw new Error("no confirm");
  await controller.handle(ask.request.command);
}

const children: ChildProcess[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(() => resolve(undefined)));
});

describe("stage 2/3 live", () => {
  it("arms through an inline source map and anchors after the header", async () => {
    const port = await freePort();
    const dir = await mkdtemp(path.join(tmpdir(), "kosmo-map-"));
    await mkdir(path.join(dir, "src"));
    await mkdir(path.join(dir, "dist"));
    const original = [
      "// leading comment lines shift nothing here, the map does the work",
      "export interface Item { qty: number }",
      "",
      "export function total(item: Item, qty: number): number {",
      "  return item.qty * qty;",
      "}",
      "setInterval(() => total({ qty: 2 }, 3), 30);",
      ""
    ].join("\n");
    await writeFile(path.join(dir, "src", "app.ts"), original);
    const out = ts.transpileModule(original, {
      fileName: path.join(dir, "src", "app.ts"),
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        inlineSourceMap: true,
        inlineSources: true,
        // Blank lines and the interface disappear from the output: the generated line differs.
        removeComments: true
      }
    });
    const compiled = path.join(dir, "dist", "app.js");
    // `transpileModule` knows no outDir, so its `sources` is the bare name; real tsc writes `../src/app.ts`.
    const generated = out.outputText.replace(
      /sourceMappingURL=data:application\/json;base64,(\S+)/,
      (_m, b64: string) => {
        const map = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as { sources: string[] };
        map.sources = ["../src/app.ts"];
        return `sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`;
      }
    );
    await writeFile(compiled, generated);
    // The file on disk moved on since the build: two lines on top. The map's `sourcesContent` is the
    // witness of the built text, so the point at disk line 6 must be re-anchored to map line 4.
    await writeFile(path.join(dir, "src", "app.ts"), `// edited after build\n// edited after build\n${original}`);
    const child = spawn(process.execPath, [`--inspect=127.0.0.1:${port}`, compiled], { stdio: "ignore" });
    children.push(child);
    const controller = new DebugController();
    const events: DebugEvent[] = [];
    controller.on((event) => events.push(event));
    await sleep(250);
    await attachConfirmed(controller, events, port);
    await controller.handle({
      type: "arm",
      id: 1,
      kind: "tp",
      file: "src/app.ts",
      root: dir,
      line: 6,
      endLine: 8,
      names: ["item", "qty"],
      sameCase: false,
      cap: 100,
      runtime: "node"
    });
    const state = events.find((event) => event.type === "pointState");
    expect(state?.type === "pointState" ? state.state : "").toBe(
      "node: resolved (1 scripts) · map-untrusted · re-anchored"
    );
    const hit = await waitFor(() => events.find((event) => event.type === "hit"), 2000);
    await controller.close();
    expect(hit?.type).toBe("hit");
    if (hit?.type === "hit") {
      expect(hit.text).toContain("node");
      expect(hit.text).toContain('"item":{"qty":2}');
      expect(hit.text).toContain('"qty":3');
    }
  });

  it("max-pause resumes our own breakpoint pause", async () => {
    const port = await freePort();
    const dir = await mkdtemp(path.join(tmpdir(), "kosmo-pause-"));
    const file = path.join(dir, "app.js");
    await writeFile(file, "function work(n) {\n  return n + 1;\n}\nsetInterval(() => work(1), 30);\n");
    const child = spawn(process.execPath, [`--inspect=127.0.0.1:${port}`, file], { stdio: "ignore" });
    children.push(child);
    const controller = new DebugController();
    const events: DebugEvent[] = [];
    controller.on((event) => events.push(event));
    await sleep(250);
    await attachConfirmed(controller, events, port);
    await controller.handle({ type: "maxPause", seconds: 1 });
    await controller.handle({
      type: "arm",
      id: 1,
      kind: "bp",
      file,
      root: null,
      line: 1,
      names: ["n"],
      sameCase: false,
      cap: 100,
      runtime: null
    });
    const paused = await waitFor(() => events.find((event) => event.type === "paused" && event.text !== null), 2000);
    expect(paused?.type).toBe("paused");
    if (paused?.type === "paused") expect(paused.text).toBe("PAUSED node other");
    // Scope values of the top frame follow a moment later (spec 9.7).
    const withScopes = await waitFor(
      () => events.find((event) => event.type === "paused" && event.scopes.length > 0),
      1500
    );
    const scopes = withScopes?.type === "paused" ? withScopes.scopes : [];
    expect(scopes.slice(0, 2)).toEqual(["local:", "  n = 1"]);
    expect(scopes).toContain("closure:");
    const from = events.indexOf(paused!);
    const after = await waitFor(
      () => events.slice(from).find((event) => event.type === "paused" && event.text === null),
      3000
    );
    await controller.close();
    expect(after).toBeDefined();
    expect(events.some((event) => event.type === "banner" && event.text.startsWith("max-pause: resumed"))).toBe(true);
  });

  it("finds the inspector a process opens on SIGUSR1", async () => {
    if (process.platform === "win32") return;
    const dir = await mkdtemp(path.join(tmpdir(), "kosmo-usr1-"));
    const file = path.join(dir, "app.js");
    await writeFile(file, "setInterval(() => {}, 1000);\n");
    const child = spawn(process.execPath, [file], { stdio: "ignore" });
    children.push(child);
    await sleep(200);
    expect(await findInspectorOfPid(child.pid!, 300)).toBeNull();
    child.kill("SIGUSR1");
    const found = await findInspectorOfPid(child.pid!, 4000);
    expect(found).not.toBeNull();
    expect(found?.browser.startsWith("node.js/")).toBe(true);
    expect(found?.host.startsWith("127.")).toBe(true);
  });

  it("records a browser tracepoint hit through a launched Chromium", async () => {
    if (findBrowser(process.env) === null) return;
    const dir = await mkdtemp(path.join(tmpdir(), "kosmo-web-"));
    const script = "function greet(name) {\n  return 'hi ' + name;\n}\nsetInterval(() => greet('you'), 50);\n";
    await writeFile(path.join(dir, "app.js"), script);
    const server = http.createServer((req, res) => {
      if (req.url === "/app.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(script);
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<!doctype html><script src="/app.js"></script><p>kosmo</p>');
    });
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
    const controller = new DebugController();
    const events: DebugEvent[] = [];
    controller.on((event) => events.push(event));
    await controller.handle({ type: "launchBrowser", url: `http://localhost:${port}/`, confirmed: true });
    const attached = events.find((event) => event.type === "attached" && event.browser !== null);
    expect(attached?.type).toBe("attached");
    await sleep(500);
    await controller.handle({
      type: "arm",
      id: 1,
      kind: "tp",
      file: "app.js",
      root: dir,
      line: 1,
      names: ["name"],
      sameCase: false,
      cap: 100,
      runtime: "browser"
    });
    const hit = await waitFor(() => events.find((event) => event.type === "hit"), 12000);
    await controller.close();
    expect(hit?.type).toBe("hit");
    if (hit?.type === "hit") {
      expect(hit.text).toContain("browser");
      expect(hit.text).toContain('"name":"hi you"'.replace("hi you", "you"));
    }
  }, 40000);
});
