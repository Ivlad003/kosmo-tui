/**
 * The pipe gate (spec 13.4, 5.2 open-viewer invariants): a real OS pipe from a `node -e`
 * NDJSON producer into the real bin.
 *
 *  - in a PTY: data on the stdin pipe, keys from the controlling terminal; `reading… N spans`
 *    while the pipe is open, the trace after EOF, keys still raw after the producer exited;
 *  - q while the producer still writes: the viewer exits 0 at once, the producer's next write
 *    fails with EPIPE and it exits on its own (no hang, no signal kill);
 *  - a stream cut in the middle of a line: `stream stopped at line N` in the viewer, nothing
 *    printed and exit 2 under --print;
 *  - headless `| kosmo-tui - --print`: exact output, exit 0, no ANSI; and no controlling
 *    terminal: exit 1 with the --print hint while the producer does not hang.
 *
 * Needs dist/ and bash; the PTY cases also need script(1).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RECIPES } from "../fixture-recipes.js";
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
} from "../pty.js";
import { cleanupTempDirs, tempDir, writeNdjson } from "../trace-writers.js";

afterAll(() => cleanupTempDirs());

const NODE = shellQuote(process.execPath);
const TUI = `${NODE} ${shellQuote(BIN)}`;
const bashReady = existsSync("/bin/bash") || existsSync("/usr/bin/bash");

/** The basic fixture as an NDJSON file (8 lines: header, trace, 4 spans … as the recipe has them). */
function ndjsonFile(): string {
  const file = path.join(tempDir("kosmo-pipe-"), "basic.kosmo-trace.ndjson");
  writeNdjson(file, RECIPES["kosmo-trace/basic"]!());
  return file;
}

/** Writes the first `head` lines, waits `pauseMs`, writes the rest and exits. */
function producer(file: string, head: number, pauseMs: number): string {
  const script = [
    'const lines = require("node:fs").readFileSync(process.argv[1], "utf8").split("\\n").filter(Boolean);',
    `for (const line of lines.slice(0, ${head})) process.stdout.write(line + "\\n");`,
    `setTimeout(() => { for (const line of lines.slice(${head})) process.stdout.write(line + "\\n"); }, ${pauseMs});`
  ].join(" ");
  return `${NODE} -e ${shellQuote(script)} ${shellQuote(file)}`;
}

/** Writes the header, then one new span every 20 ms until a write fails; records its pid first. */
function endlessProducer(file: string, pidFile: string): string {
  const script = [
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    'const [header] = require("node:fs").readFileSync(process.argv[1], "utf8").split("\\n");',
    'process.stdout.write(header + "\\n");',
    "let n = 0;",
    "setInterval(() => {",
    '  n += 1; process.stdout.write(JSON.stringify({ type: "span", trace: "t_cart", session: "s9", id: "e" + n,',
    '    parent: null, order: n, name: "tick", status: "complete" }) + "\\n");',
    "}, 20);"
  ].join(" ");
  return `${NODE} -e ${shellQuote(script)} ${shellQuote(file)}`;
}

/** bash prints PIPESTATUS only after BOTH sides exited. */
function pipeline(inner: string): string {
  return `bash -c ${shellQuote(`${inner}; echo "PIPE=\${PIPESTATUS[*]}"`)}; echo STTY_AFTER_CLOSE=$(stty -a | tr '\\n' ' ')`;
}

function expectRestored(out: string): void {
  expect(count(out, ENTER)).toBe(1);
  expect(count(out, RESTORE)).toBe(1);
  expect(out.indexOf(RESTORE)).toBeLessThan(out.indexOf("PIPE="));
  expectCookedTty(sttyAfterClose(out));
}

async function finish(s: PtySession, pipe: RegExp): Promise<string> {
  await s.waitFor(pipe, 15_000);
  await s.waitFor(/STTY_AFTER_CLOSE=/);
  s.child.stdin.end();
  await s.exited;
  return s.output();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const pty = scriptAvailable && distReady && bashReady ? describe : describe.skip;

pty("producer | kosmo-tui - in a real PTY", () => {
  it("reading… while the pipe is open, the trace after EOF, keys still raw after the producer exited", async () => {
    const file = ndjsonFile();
    const s = startPty(pipeline(`${producer(file, 3, 1_500)} | ${TUI} -`));
    try {
      await s.waitForScreen(/reading… 1 spans/);
      // Keys while the pipe is open go to the terminal, never into the NDJSON data.
      s.write("j");
      s.write("k");
      await s.waitForScreen(/GET \/cart · 4 spans · errored/, 15_000);
      // The producer has exited by now and restored cooked mode; the viewer reclaimed raw mode.
      await settle(500);
      s.write("j");
      await s.waitForScreen(/loadCart · function · complete/);
      s.write("q");
      expectRestored(await finish(s, /PIPE=0 0/));
    } finally {
      s.kill();
    }
  }, 40_000);

  it("q while the producer still writes: the viewer exits 0, the producer hits EPIPE and exits by itself", async () => {
    const file = ndjsonFile();
    const pidFile = path.join(path.dirname(file), "producer.pid");
    const s = startPty(pipeline(`${endlessProducer(file, pidFile)} | ${TUI} -`));
    try {
      await s.waitForScreen(/reading… \d+ spans/);
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(alive(pid)).toBe(true);
      const quitAt = Date.now();
      s.write("q");
      await s.waitFor(new RegExp(RESTORE.replace(/[[\]?]/g, "\\$&")));
      const [, producerCode, viewerCode] = (await s.waitFor(/PIPE=(\d+) (\d+)/, 15_000)).map(String);
      expect(viewerCode).toBe("0");
      // A write error, not a hang and not a kill by signal (>= 128).
      expect(Number(producerCode)).toBeLessThan(128);
      expect(Date.now() - quitAt).toBeLessThan(10_000);
      expectRestored(await finish(s, /PIPE=/));
      expect(alive(pid)).toBe(false);
    } finally {
      s.kill();
    }
  }, 40_000);

  it("a stream cut in the middle of a line shows where it stopped; the keyboard keeps working", async () => {
    const file = ndjsonFile();
    const cut = `{ ${producer(file, 5, 0)}; printf '{"type":"span","trace"'; }`;
    const s = startPty(pipeline(`${cut} | ${TUI} -`), { rows: 30, cols: 120 });
    try {
      await s.waitForScreen(/stream stopped at line \d+: /, 15_000);
      s.write("e");
      await s.waitForScreen(/errors only/);
      s.write("q");
      expectRestored(await finish(s, /PIPE=0 0/));
    } finally {
      s.kill();
    }
  }, 40_000);
});

type Run = { code: number | null; stdout: string; stderr: string };

function headless(command: string, options: { detached?: boolean } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], {
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

(distReady && bashReady ? describe : describe.skip)("producer | kosmo-tui - headless", () => {
  it("--print tab reads the pipe to EOF: exact rows, exit 0, no ANSI", async () => {
    const run = await headless(`${producer(ndjsonFile(), 3, 300)} | ${TUI} - --print tab`);
    expect(run).toEqual({ code: 0, stdout: "t_cart\tGET /cart\t4\terrored\n", stderr: "" });
  }, 30_000);

  it("--print on a stream cut mid-line prints nothing and exits 2", async () => {
    const cut = `{ ${producer(ndjsonFile(), 5, 0)}; printf '{"type":"span"'; }`;
    const run = await headless(`${cut} | ${TUI} - --print tab`);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/^kosmo-tui: stream stopped at line \d+: /);
  }, 30_000);

  it("interactive without a controlling terminal: exit 1, empty stdout, the --print hint; the producer ends", async () => {
    const run = await headless(`${producer(ndjsonFile(), 3, 300)} | ${TUI} -; echo "PIPE=\${PIPESTATUS[*]}" >&2`, {
      detached: true
    });
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("no-controlling-terminal: interactive terminal required: stdout is not a TTY. ");
    expect(run.stderr).toContain("--print");
    expect(run.stderr).toMatch(/PIPE=\d+ 1/);
  }, 30_000);
});
