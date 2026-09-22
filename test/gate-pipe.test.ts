/**
 * Release gate 8.2: a real OS pipe from the real kosmo-callflow producer into the real bin
 * (tui-debugger "Окремі data stdin і terminal input", "Версійований NDJSON producer і
 * bounded reader", "One-shot і terminal lifecycle"; design D15).
 *
 * The producer is `node ../kosmo-callflow/packages/cli/dist/index.js connect --format
 * ndjson --stream-version 1|2` against a real kosmo-callflow daemon (dist) serving the
 * recorded cross-source store. A small HTTP relay between producer and daemon can hold the
 * canonical reads, which keeps the producer running while the viewer already reads stdin.
 *
 *  - interactive, in a PTY: data on the stdin pipe, keys from the controlling terminal;
 *    keys pressed while the pipe is still open never reach the data, keys work after EOF,
 *    and a stream cut before `end` shows the incomplete marker instead of a complete view;
 *  - headless `| kosmo-tui - --print json`: no TTY, exact output and exit codes;
 *  - no controlling terminal: exit 1 with the --print hint and an empty stdout;
 *  - the viewer quitting early: the producer's write fails with EPIPE, it exits on its own
 *    (the shell reaps it — no hang, no zombie).
 *
 * Skipped without the sibling kosmo-callflow build or without script(1) (PTY cases).
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BIN,
  ENTER,
  RESTORE,
  count,
  distReady,
  expectCookedTty,
  scriptAvailable,
  shellQuote,
  startPty,
  sttyAfterClose,
  type PtySession
} from "./pty.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const KC = path.resolve(here, "../../kosmo-callflow");
const KC_CLI = path.join(KC, "packages/cli/dist/index.js");
const KC_DAEMON = path.join(KC, "packages/daemon/dist/index.js");
const FIXTURE = path.join(here, "fixtures", "cross-source");
const manifest = JSON.parse(readFileSync(path.join(FIXTURE, "manifest.json"), "utf8")) as {
  projectId: string;
  traces: { ok: string; errored: string };
};
const kcReady = distReady && existsSync(KC_CLI) && existsSync(KC_DAEMON) && kcDaemonLoadable(KC);
const TOKEN = "gate-8-2-project-token-0123456789abcdef";
const SIZE = { rows: 30, cols: 120 };

let work = "";
let tokenFile = "";
let daemon: { url: string; close(): Promise<void> } | null = null;
let relay: { url: string; server: Server; holdCanonicalMs: number } | null = null;

beforeAll(async () => {
  if (!kcReady) return;
  work = mkdtempSync(path.join(os.tmpdir(), "kosmo-tui-gate-8-2-"));
  const dataDir = path.join(work, "data");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dataDir, { recursive: true });
  copyFileSync(path.join(FIXTURE, "events.sqlite"), path.join(dataDir, "events.sqlite"));
  tokenFile = path.join(work, "project.token");
  writeFileSync(tokenFile, `${TOKEN}\n`);
  const { startDaemon } = (await import(pathToFileURL(KC_DAEMON).href)) as {
    startDaemon(options: Record<string, unknown>): Promise<{ url: string; close(): Promise<void> }>;
  };
  daemon = await startDaemon({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    projectId: manifest.projectId,
    projectToken: TOKEN,
    ingestToken: "gate-8-2-ingest-token-0123456789abcdef",
    webToken: "gate-8-2-web-token-0123456789abcdef"
  });
  // A relay in front of the daemon: it can hold canonical reads so the producer is still
  // running (and has not written its snapshot yet) while the viewer reads the pipe.
  const target = daemon.url;
  const state = { holdCanonicalMs: 0 };
  const server = createServer((request, response) => {
    void (async () => {
      if (/\/canonical$/.test(new URL(request.url ?? "/", target).pathname) && state.holdCanonicalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, state.holdCanonicalMs));
      }
      const upstream = await fetch(new URL(request.url ?? "/", target), {
        headers: Object.fromEntries(
          Object.entries(request.headers).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string" && entry[0] !== "host"
          )
        )
      });
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json"
      });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    })().catch(() => {
      response.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  relay = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server,
    get holdCanonicalMs() {
      return state.holdCanonicalMs;
    },
    set holdCanonicalMs(value: number) {
      state.holdCanonicalMs = value;
    }
  };
}, 30_000);

afterAll(async () => {
  relay?.server.closeAllConnections();
  await new Promise((resolve) => relay?.server.close(resolve) ?? resolve(undefined));
  await daemon?.close();
  if (work) rmSync(work, { recursive: true, force: true });
});

/** The real producer; `$$` is its pid (the `exec` keeps it), written for the kill cases. */
function producer(version: 1 | 2, pidFile?: string): string {
  const args = [
    KC_CLI,
    "connect",
    "--format",
    "ndjson",
    "--stream-version",
    String(version),
    "--endpoint",
    relay!.url,
    "--token-file",
    tokenFile
  ];
  const exec = `exec ${[process.execPath, ...args].map(shellQuote).join(" ")}`;
  return pidFile === undefined ? `sh -c ${shellQuote(exec)}` : `sh -c ${shellQuote(`echo $$ > ${pidFile}; ${exec}`)}`;
}

const tui = (args = "-") => `${shellQuote(process.execPath)} ${shellQuote(BIN)} ${args}`;

/** bash: PIPESTATUS names each side's exit code once BOTH have exited. */
function pipeline(inner: string): string {
  return (
    `cd ${shellQuote(work)} && bash -c ${shellQuote(`${inner}; echo "PIPE=\${PIPESTATUS[*]}"`)}; ` +
    `echo STTY_AFTER_CLOSE=$(stty -a | tr '\\n' ' ')`
  );
}

const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

async function press(s: PtySession, key: string, expected?: RegExp): Promise<string> {
  s.write(key);
  const screen = expected ? await s.waitForScreen(expected) : null;
  await settle();
  return screen ?? s.screen().join("\n");
}

function expectRestored(out: string): void {
  expect(count(out, ENTER)).toBe(1);
  expect(count(out, RESTORE)).toBe(1);
  expect(out.indexOf(RESTORE)).toBeLessThan(out.indexOf("PIPE="));
  expectCookedTty(sttyAfterClose(out));
}

type Run = { code: number | null; stdout: string; stderr: string };

/** Headless: plain pipes, no PTY; `detached` also drops the controlling terminal. */
function headless(command: string, options: { detached?: boolean } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], {
      cwd: work,
      stdio: ["ignore", "pipe", "pipe"],
      detached: options.detached ?? false
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const pty = kcReady && scriptAvailable ? describe : describe.skip;

pty("gate 8.2: producer | kosmo-tui - in a real PTY", () => {
  it("v2: data from the pipe, keys from the terminal — while the pipe is open and after EOF", async () => {
    relay!.holdCanonicalMs = 1_500;
    const s = startPty(pipeline(`${producer(2)} | ${tui()}`), SIZE);
    try {
      // The viewer is up and reading stdin while the producer is still waiting on the daemon.
      await s.waitFor(new RegExp(ENTER.replace(/[[\]?]/g, "\\$&")));
      // Keys typed while the pipe is open go to the terminal, never into the NDJSON data:
      // a stray `j` in the pipe would be a malformed frame and fail the source.
      for (const key of ["j", "k", "j"]) await press(s, key);
      const opened = await s.waitForScreen(/^stream v2 \(ended\) \| /m, 15_000);
      expect(opened).not.toMatch(/malformed|source failed/);
      // Keys work after EOF: select, expand, detail from the v2 canonical snapshot.
      await press(s, "g");
      // (The detail pane's sanitizer renders the route part of an http node id as
      // `[external-path]`; the row itself keeps the recorded id.)
      await press(s, "\r", /^detail: http#POST .*\[complete\]$/m);
      await press(s, "\t");
      await press(s, "l");
      // Roots come first in the tree order; walk down to the first expanded child.
      let expanded = s.screen().join("\n");
      for (let step = 0; step < 6 && !/^>.*express:/m.test(expanded); step += 1) expanded = await press(s, "j");
      expect(expanded).toMatch(/express:(middleware|handler|filter):/);
      s.write("q");
      await s.waitFor(/PIPE=0 0/);
      await s.waitFor(/STTY_AFTER_CLOSE=/);
      s.child.stdin.end();
      await s.exited;
      expectRestored(s.output());
    } finally {
      relay!.holdCanonicalMs = 0;
      s.kill();
    }
  }, 40_000);

  it("v1: a summary-only list; span actions answer unavailable, nothing is reconstructed", async () => {
    const s = startPty(pipeline(`${producer(1)} | ${tui()}`), SIZE);
    try {
      const screen = await s.waitForScreen(/^stream v1 \(ended\) \| /m, 15_000);
      // The two traces, as summaries (the errored one flagged) — and no span rows at all.
      expect(screen).toMatch(new RegExp(`^ ! ${manifest.traces.errored} +\\(7\\)$`, "m"));
      expect(screen).toMatch(new RegExp(`^ {3}${manifest.traces.ok} +\\(6\\)$`, "m"));
      expect(screen).toMatch(/^ {2}no rows$/m);
      // Span actions answer instead of doing nothing, and nothing is reconstructed.
      const yank = await press(s, "y", /unavailable|nothing selected|no selection/i);
      expect(yank).not.toMatch(/copied/);
      expect(yank).toMatch(/^ {2}no rows$/m);
      s.write("q");
      await s.waitFor(/PIPE=0 0/);
      await s.waitFor(/STTY_AFTER_CLOSE=/);
      s.child.stdin.end();
      await s.exited;
      expectRestored(s.output());
    } finally {
      s.kill();
    }
  }, 40_000);

  it("a stream cut before `end` shows the incomplete marker and keeps the keyboard working", async () => {
    // The pipe into the viewer carries the producer's first 6 frames (header … the first
    // canonical snapshot), stays open for a moment, then hits EOF with no `end` frame.
    const s = startPty(pipeline(`${producer(2)} | { head -n 6; sleep 1; } | ${tui()}`), SIZE);
    try {
      const screen = await s.waitForScreen(/^stream v2 \(incomplete\) \| /m, 15_000);
      expect(screen).toMatch(/coverage: incomplete\(/);
      expect(screen).not.toContain("connected; live");
      // Keys after EOF.
      const filtered = await press(s, "e", /errors-only/);
      expect(filtered).toMatch(/errors-only/);
      await press(s, "e");
      s.write("q");
      await s.waitFor(/PIPE=0 0 0/);
      await s.waitFor(/STTY_AFTER_CLOSE=/);
      s.child.stdin.end();
      await s.exited;
      expectRestored(s.output());
    } finally {
      s.kill();
    }
  }, 40_000);

  it("the producer killed before it wrote anything: explicit source error (exit 2), terminal restored", async () => {
    relay!.holdCanonicalMs = 20_000;
    const pidFile = path.join(work, "producer-killed.pid");
    const s = startPty(pipeline(`${producer(2, pidFile)} | ${tui()}`), SIZE);
    try {
      await s.waitFor(new RegExp(ENTER.replace(/[[\]?]/g, "\\$&")));
      await waitForFile(pidFile);
      await settle(300);
      process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL");
      await s.waitFor(/PIPE=137 2/, 15_000);
      await s.waitFor(/STTY_AFTER_CLOSE=/);
      s.child.stdin.end();
      await s.exited;
      const out = s.output();
      expect(out).toMatch(/kosmo-tui: source failed: .*stdin ended before a connect header frame arrived/);
      expectRestored(out);
    } finally {
      relay!.holdCanonicalMs = 0;
      s.kill();
    }
  }, 40_000);

  it("q while the producer still runs: the viewer exits 0, the producer's write hits EPIPE and it exits on its own", async () => {
    relay!.holdCanonicalMs = 2_000;
    const pidFile = path.join(work, "producer-epipe.pid");
    const s = startPty(pipeline(`${producer(2, pidFile)} | ${tui()}`), SIZE);
    try {
      await s.waitFor(new RegExp(ENTER.replace(/[[\]?]/g, "\\$&")));
      await waitForFile(pidFile);
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      await settle(300);
      expect(alive(pid)).toBe(true);
      const quitAt = Date.now();
      s.write("q");
      // The viewer is gone (terminal restored) before the producer has even written.
      await s.waitFor(new RegExp(RESTORE.replace(/[[\]?]/g, "\\$&")));
      // bash prints PIPESTATUS only after BOTH sides exited: the producer did not hang.
      const [, producerCode, viewerCode] = (await s.waitFor(/PIPE=(\d+) (\d+)/, 15_000)).map(String);
      expect(viewerCode).toBe("0");
      expect(Date.now() - quitAt).toBeLessThan(12_000);
      // EPIPE, not a hang and not a signal kill; the producer's own exit code is non-zero
      // or zero depending on how it reports a vanished consumer — it exited either way.
      expect(Number(producerCode)).toBeLessThan(128);
      await s.waitFor(/STTY_AFTER_CLOSE=/);
      s.child.stdin.end();
      await s.exited;
      expectRestored(s.output());
      // Reaped: no process (and no zombie) with that pid remains.
      expect(alive(pid)).toBe(false);
    } finally {
      relay!.holdCanonicalMs = 0;
      s.kill();
    }
  }, 40_000);
});

(kcReady ? describe : describe.skip)("gate 8.2: producer | kosmo-tui - headless", () => {
  it("--print json lists the stream's traces (kosmo.trace-list/v1), exit 0, no ANSI", async () => {
    const run = await headless(`${producer(2)} | ${tui("- --print json")}`);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).not.toMatch(/\u001b/);
    const body = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(JSON.stringify(body)).toContain("kosmo.trace-list/v1");
    for (const traceId of [manifest.traces.ok, manifest.traces.errored]) expect(run.stdout).toContain(traceId);
  }, 30_000);

  it("--print json --trace on v2 is the trace's projection; on v1 Lisp is unavailable (exit 2, empty stdout)", async () => {
    const v2 = await headless(`${producer(2)} | ${tui(`- --print json --trace ${manifest.traces.errored}`)}`);
    expect(v2.code).toBe(0);
    const document = JSON.parse(v2.stdout) as {
      dialect: string;
      projectionVersion: number;
      dataset: { traceId: string };
      items: Array<{ node: string; state: string }>;
    };
    expect(document).toMatchObject({ dialect: "kosmo.trace-text/v2", projectionVersion: 2 });
    expect(document.dataset.traceId).toBe(manifest.traces.errored);
    expect(document.items.find((item) => item.node === "lib/cart.cjs#checkout")?.state).toBe("errored");
    expect(v2.stdout).not.toContain("hunter2-secret");
    const v1 = await headless(`${producer(1)} | ${tui(`- --print lisp --trace ${manifest.traces.errored}`)}`);
    expect(v1.code).toBe(2);
    expect(v1.stdout).toBe("");
    expect(v1.stderr).toMatch(/unavailable/);
  }, 30_000);

  it("--print on a stream cut before `end` is a source error with an empty stdout", async () => {
    const run = await headless(`${producer(2)} | head -n 6 | ${tui("- --print json")}`);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/incomplete/);
  }, 30_000);

  it("interactive without a controlling terminal: exit 1, empty stdout, --print hint", async () => {
    const run = await headless(`${producer(2)} | ${tui()}; echo "PIPE=\${PIPESTATUS[*]}" >&2`, { detached: true });
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("interactive terminal required");
    expect(run.stderr).toContain("--print");
    // The viewer refused (1); the producer finished or hit EPIPE — it did not hang.
    expect(run.stderr).toMatch(/PIPE=\d+ 1/);
  }, 30_000);
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(file) && readFileSync(file, "utf8").trim() !== "") return;
    await settle(50);
  }
  throw new Error(`no ${file}`);
}

/**
 * The kosmo-callflow daemon runs in this process and loads kosmo-callflow's own native
 * better-sqlite3; built for another Node ABI it cannot load here (a cross-version matrix
 * run), which is an environment limit of this gate, not a kosmo-tui failure.
 */
function kcDaemonLoadable(kcRoot: string): boolean {
  try {
    const Database = createRequire(path.join(kcRoot, "packages/daemon/package.json"))("better-sqlite3") as new (
      file: string
    ) => { close(): void };
    new Database(":memory:").close();
    return true;
  } catch {
    return false;
  }
}
