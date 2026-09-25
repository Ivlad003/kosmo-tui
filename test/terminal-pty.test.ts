/**
 * Real-PTY tests through the real bin (spec 13.2, 13.4). A pseudo-terminal comes from
 * `script(1)` (test/pty.ts): what we write arrives as keystrokes on the viewer's controlling
 * terminal, `screen()` replays the painted rows.
 *
 *  - json, ndjson and sqlite files open and the keyboard works; q exits 0;
 *  - SIGINT, SIGTERM and SIGHUP restore the cursor, the main screen and cooked mode exactly
 *    once and exit 130, 143 and 129;
 *  - `-` without a controlling terminal is refused before anything is drawn: exit 1 with the
 *    --print hint, both with a TTY stdout (the keyboard check) and with a pipe stdout.
 *
 * Needs the built dist/ (`npm test` runs `pretest` → build). The PTY cases are skipped where
 * `script` is unavailable; Windows console input is not exercised here.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RECIPES } from "./fixture-recipes.js";
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
  sttyAfterClose
} from "./pty.js";
import {
  NODE_SQLITE_AVAILABLE,
  cleanupTempDirs,
  tempDir,
  writeJson,
  writeNdjson,
  writeSqlite
} from "./trace-writers.js";

afterAll(() => cleanupTempDirs());

const NODE = shellQuote(process.execPath);
const TUI = shellQuote(BIN);
const AFTER = `echo EXIT=$?; echo STTY_AFTER_CLOSE=$(stty -a | tr '\\n' ' ')`;

function basicFile(kind: "json" | "ndjson" | "sqlite"): string {
  const file = path.join(tempDir("kosmo-pty-"), `basic.kosmo-trace.${kind}`);
  const doc = RECIPES["kosmo-trace/basic"]!();
  if (kind === "json") writeJson(file, doc);
  else if (kind === "ndjson") writeNdjson(file, doc);
  else writeSqlite(file, doc);
  return file;
}

function expectRestoredOnce(out: string, marker: string): void {
  expect(count(out, ENTER)).toBe(1);
  expect(count(out, RESTORE)).toBe(1);
  expect(out.indexOf(RESTORE)).toBeLessThan(out.indexOf(marker));
  expectCookedTty(sttyAfterClose(out));
}

const ptyDescribe = scriptAvailable && distReady ? describe : describe.skip;

ptyDescribe("real bin in a PTY", () => {
  for (const kind of ["json", "ndjson", "sqlite"] as const) {
    it.skipIf(kind === "sqlite" && !NODE_SQLITE_AVAILABLE)(
      `opens a ${kind} file, the keyboard moves the selection, q exits 0 and restores the terminal`,
      async () => {
        const file = basicFile(kind);
        const s = startPty(`cd ${shellQuote(path.dirname(file))} && ${NODE} ${TUI} ${shellQuote(file)}; ${AFTER}`);
        try {
          await s.waitForScreen(/GET \/cart · 4 spans · errored/);
          s.write("j");
          await s.waitForScreen(/loadCart · function · complete/);
          s.write("j");
          await s.waitForScreen(/calculateLineTotal · function · errored/);
          s.write("q");
          await s.waitFor(/EXIT=0/);
          await s.waitFor(/STTY_AFTER_CLOSE=/);
          s.child.stdin.end();
          await s.exited;
          expectRestoredOnce(s.output(), "EXIT=0");
        } finally {
          s.kill();
        }
      },
      30_000
    );
  }

  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129]
  ] as const) {
    it(`${signal} restores the terminal exactly once and exits ${code}`, async () => {
      const file = basicFile("json");
      // `exec` keeps the pid, so the echoed pid is the viewer's own.
      const viewer = `echo PID=$$; exec ${NODE} ${TUI} ${shellQuote(file)}`;
      const s = startPty(`sh -c ${shellQuote(viewer)}; ${AFTER}`);
      try {
        await s.waitForScreen(/GET \/cart · 4 spans/);
        const pid = Number((await s.waitFor(/PID=(\d+)/))[1]);
        process.kill(pid, signal);
        await s.waitFor(new RegExp(`EXIT=${code}`));
        await s.waitFor(/STTY_AFTER_CLOSE=/);
        s.child.stdin.end();
        await s.exited;
        expectRestoredOnce(s.output(), `EXIT=${code}`);
      } finally {
        s.kill();
      }
    }, 30_000);
  }

  it("`-` with a TTY stdout but no controlling terminal: exit 1 before anything is drawn, the --print hint", async () => {
    // A detached child calls setsid(): its stdout is still the PTY, but /dev/tty no longer opens.
    const launcher = [
      'const { spawn } = require("node:child_process");',
      `const child = spawn(process.execPath, [${JSON.stringify(BIN)}, "-"], { detached: true, stdio: ["pipe", "inherit", "inherit"] });`,
      'child.stdin.end("");',
      'child.on("exit", (code) => console.log("CHILD_EXIT=" + code));'
    ].join(" ");
    const s = startPty(`${NODE} -e ${shellQuote(launcher)}`);
    try {
      await s.waitFor(/CHILD_EXIT=\d+/);
      s.child.stdin.end();
      await s.exited;
      const out = s.output();
      expect(out).toContain("CHILD_EXIT=1");
      expect(out).toContain(
        "kosmo-tui: no-controlling-terminal: interactive terminal required: stdin carries data and no controlling terminal"
      );
      expect(out).toContain("--print");
      expect(count(out, ENTER)).toBe(0);
    } finally {
      s.kill();
    }
  }, 30_000);
});

(distReady && process.platform !== "win32" ? describe : describe.skip)("no controlling terminal", () => {
  it("`-` in a session without a TTY: exit 1, empty stdout, the --print hint", async () => {
    // detached → setsid(): no controlling terminal, stdout is a pipe.
    const child = spawn(process.execPath, [BIN, "-"], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end('{"type":"header","format":"kosmo-trace","version":1,"dataset":{"id":"d"}}\n');
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("kosmo-tui: no-controlling-terminal: interactive terminal required: stdout is not a TTY. ");
    expect(err).toContain("--print");
  });
});
