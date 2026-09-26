import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DebugController, type DebugEvent } from "../../src/debug/port.js";

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

describe("node inspector attach", () => {
  const children: { kill: (signal?: NodeJS.Signals) => boolean }[] = [];
  afterEach(() => {
    for (const child of children) child.kill("SIGKILL");
  });

  it("attaches to a loopback inspector and records a tracepoint hit", async () => {
    const port = await freePort();
    const dir = await mkdtemp(path.join(tmpdir(), "kosmo-debug-"));
    const file = path.join(dir, "app.js");
    await writeFile(file, "function hitMe(item) {\n  return item;\n}\nsetInterval(() => hitMe(1), 30);\n");
    const child = spawn(process.execPath, [`--inspect=127.0.0.1:${port}`, file], { stdio: "ignore" });
    children.push(child);
    const controller = new DebugController();
    const hits: string[] = [];
    const events: DebugEvent[] = [];
    controller.on((event) => {
      events.push(event);
      if (event.type === "hit") hits.push(event.text);
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    // `:attach` never connects by itself: it probes and asks (spec 9.2 p.9).
    await controller.handle({ type: "attachAddress", host: "localhost", port });
    const ask = events.find((event) => event.type === "confirm");
    expect(ask?.type).toBe("confirm");
    if (ask?.type !== "confirm") return;
    expect(ask.request.command).toEqual({ type: "attachAddress", host: "127.0.0.1", port, confirmed: true });
    expect(events.some((event) => event.type === "attached" && event.node !== null)).toBe(false);
    await controller.handle(ask.request.command);
    const attached = events.find((event) => event.type === "attached" && event.node !== null);
    expect(attached?.type).toBe("attached");
    if (attached?.type === "attached") expect(attached.node).toMatch(/^debug: node pid \d+/);
    await controller.handle({
      type: "arm",
      id: 1,
      kind: "tp",
      file,
      root: null,
      line: 1,
      names: ["item"],
      sameCase: false,
      cap: 5,
      runtime: null
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await controller.close();
    expect(hits.length).toBeGreaterThan(0);
    // Detach reports "nothing attached" rather than keeping a stale label.
    const last = [...events].reverse().find((event) => event.type === "attached");
    expect(last).toEqual({ type: "attached", node: null, browser: null });
  });

  it("refuses names that are not loopback IP literals", async () => {
    const controller = new DebugController();
    const events: DebugEvent[] = [];
    controller.on((event) => events.push(event));
    await controller.handle({ type: "attachAddress", host: "127.evil.com", port: 9229 });
    await controller.handle({ type: "attachBrowser", host: "10.0.0.5", port: 9222 });
    expect(events.map((event) => (event.type === "banner" ? event.text : event.type))).toEqual([
      "attach refused: not loopback",
      "attach-browser refused: not loopback"
    ]);
  });
});
