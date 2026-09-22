/**
 * Real-PTY tests (tasks 2.4 and 7.3). A pseudo-terminal comes from `script(1)`: its
 * stdin (our pipe) feeds the PTY master, so what we write arrives as keystrokes on the
 * child's controlling terminal, while `sh -c "printf … | node fixture -"` gives the
 * fixture a separate data pipe on stdin. The fixture runs `stty -a` on its tty right
 * after the session closes, proving the line discipline was restored (icanon/echo on).
 *
 * Needs the built dist/ (`npm test` runs `pretest` → build). Skipped where `script` is
 * unavailable; Windows console input is not exercised here.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "pty-viewer.mjs");
const distReady = existsSync(path.join(here, "..", "dist", "terminal-session.js"));
const scriptAvailable =
  (process.platform === "darwin" || process.platform === "linux") && existsSync("/usr/bin/script");

const ENTER = "\u001b[?1049h\u001b[?25l";
const RESTORE = "\u001b[?25h\u001b[?1049l";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function spawnInPty(command: string): ChildProcessWithoutNullStreams {
  // script(1) takes the window size from its own stdin, which is a pipe here: 0x0.
  const sized = `stty rows 24 cols 80; ${command}`;
  const script =
    process.platform === "darwin"
      ? `script -q /dev/null sh -c ${shellQuote(sized)}`
      : `script -qfec ${shellQuote(sized)} /dev/null`;
  // Node's stdio pipes are sockets and BSD script(1) refuses a socket stdin
  // (tcgetattr → ENOTSUP), so `cat` hands it a plain pipe.
  return spawn("sh", ["-c", `cat | ${script}`], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TERM: "xterm-256color" }
  });
}

type Session = {
  child: ChildProcessWithoutNullStreams;
  output(): string;
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<RegExpMatchArray>;
  exited: Promise<number | null>;
};

function startSession(command: string): Session {
  const child = spawnInPty(command);
  let buffer = "";
  const waiters: Array<() => void> = [];
  const onChunk = (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (const waiter of [...waiters]) waiter();
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return {
    child,
    output: () => buffer,
    exited,
    waitFor(pattern, timeoutMs = 10_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const match = buffer.match(pattern);
          if (!match) return;
          waiters.splice(waiters.indexOf(check), 1);
          clearTimeout(timer);
          resolve(match);
        };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(check), 1);
          reject(new Error(`timed out waiting for ${pattern}; output so far: ${JSON.stringify(buffer)}`));
        }, timeoutMs);
        waiters.push(check);
        check();
      });
    }
  };
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** `stty -a` captured by the fixture after the session closed, before process exit. */
function sttyAfterClose(output: string): string {
  const match = /STTY_AFTER_CLOSE=([^\r\n]*)/.exec(output);
  if (!match) throw new Error(`no STTY_AFTER_CLOSE in ${JSON.stringify(output)}`);
  return match[1]!;
}

const ptyDescribe = scriptAvailable && distReady ? describe : describe.skip;

ptyDescribe("real PTY", () => {
  it("stdin carries data while keys arrive on the controlling terminal; data EOF does not swallow keys", async () => {
    const command = `printf '%s\\n%s\\n' '{"frame":1}' '{"frame":2}' | ${shellQuote(process.execPath)} ${shellQuote(fixture)} -`;
    const s = startSession(command);
    try {
      // Data stdin reached EOF before any key was sent.
      await s.waitFor(/READY/);
      expect(s.output()).toContain('DATA=["{\\"frame\\":1}","{\\"frame\\":2}"]');
      expect(s.output()).toContain("EOF=true");

      s.child.stdin.write("j");
      await s.waitFor(/KEYS=\["j"\]/);
      s.child.stdin.write("k");
      await s.waitFor(/KEYS=\["j","k"\]/);
      s.child.stdin.write("q");
      await s.waitFor(/EXIT=0/);
      s.child.stdin.end();
      await s.exited;

      const out = s.output();
      // The keys never showed up as data.
      expect(out).not.toMatch(/DATA=\[[^\]]*"j"/);
      expect(count(out, ENTER)).toBe(1);
      expect(count(out, RESTORE)).toBe(1);
      expect(out.indexOf(ENTER)).toBeLessThan(out.indexOf(RESTORE));
      expect(out.indexOf(RESTORE)).toBeLessThan(out.indexOf("STTY_AFTER_CLOSE="));
      expect(out.indexOf(RESTORE)).toBeLessThan(out.indexOf("EXIT=0"));
      const stty = sttyAfterClose(out);
      expect(stty).toMatch(/(^|\s)icanon\b/);
      expect(stty).toMatch(/(^|\s)echo\b/);
      expect(stty).not.toMatch(/-icanon\b/);
    } finally {
      s.child.stdin.destroy();
      s.child.kill("SIGKILL");
    }
  }, 20_000);

  it("SIGTERM restores cursor/alt screen/raw mode exactly once and exits 143", async () => {
    const command = `printf 'x\\n' | ${shellQuote(process.execPath)} ${shellQuote(fixture)} -`;
    const s = startSession(command);
    try {
      await s.waitFor(/READY/);
      const pid = Number((await s.waitFor(/PID=(\d+)/))[1]);
      process.kill(pid, "SIGTERM");
      await s.waitFor(/EXIT=143/);
      s.child.stdin.end();
      await s.exited;

      const out = s.output();
      expect(count(out, ENTER)).toBe(1);
      expect(count(out, RESTORE)).toBe(1);
      expect(out.indexOf(RESTORE)).toBeLessThan(out.indexOf("EXIT=143"));
      const stty = sttyAfterClose(out);
      expect(stty).toMatch(/(^|\s)icanon\b/);
      expect(stty).not.toMatch(/-icanon\b/);
      expect(stty).not.toMatch(/-echo\b/);
    } finally {
      s.child.stdin.destroy();
      s.child.kill("SIGKILL");
    }
  }, 20_000);
});

(distReady && process.platform !== "win32" ? describe : describe.skip)("no controlling terminal", () => {
  it("a session leader without a TTY gets the explicit refusal with exit 1 and the --print hint", async () => {
    // detached → setsid(): the child has no controlling terminal, so /dev/tty fails.
    const child = spawn(process.execPath, [fixture, "--probe"], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end();
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    await new Promise((resolve) => child.on("exit", resolve));
    expect(out).toContain("KEYBOARD=refused exit=1");
    expect(out).toContain("interactive terminal required");
    expect(out).toContain("no controlling terminal (/dev/tty)");
    expect(out).toContain("--print");
  });
});
