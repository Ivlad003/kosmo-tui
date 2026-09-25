/**
 * Real-PTY harness shared by the PTY tests (tasks 2.4, 7.3, gates 8.1/8.2).
 *
 * A pseudo-terminal comes from `script(1)`: its stdin (our pipe) feeds the PTY master, so
 * what we write arrives as keystrokes on the child's controlling terminal, while a shell
 * pipeline inside it (`producer | kosmo-tui -`) gives the viewer a separate data pipe on
 * stdin. `screen()` replays the viewer's row-diff paints (CUP + EL + text) into the rows a
 * terminal would show, so assertions read the current frame rather than the byte log.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const BIN = path.join(here, "..", "bin", "kosmo-tui.js");
export const distReady = existsSync(path.join(here, "..", "dist", "terminal-session.js"));
export const scriptAvailable =
  (process.platform === "darwin" || process.platform === "linux") && existsSync("/usr/bin/script");

export const ENTER = "\u001b[?1049h\u001b[?25l";
export const RESTORE = "\u001b[?25h\u001b[?1049l";

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function spawnInPty(command: string, size: { rows: number; cols: number } = { rows: 24, cols: 80 }) {
  // script(1) takes the window size from its own stdin, which is a pipe here: 0x0.
  const sized = `stty rows ${size.rows} cols ${size.cols}; ${command}`;
  const script =
    process.platform === "darwin"
      ? `script -q /dev/null sh -c ${shellQuote(sized)}`
      : `script -qfec ${shellQuote(sized)} /dev/null`;
  // Node's stdio pipes are sockets and BSD script(1) refuses a socket stdin
  // (tcgetattr → ENOTSUP), so `cat` hands it a plain pipe. Detached: the whole group can
  // be killed in `finally`, so a failing test never leaves a viewer behind.
  return spawn("sh", ["-c", `cat | ${script}`], {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, TERM: "xterm-256color" }
  });
}

export type PtySession = {
  child: ChildProcessWithoutNullStreams;
  output(): string;
  /** The rows the terminal currently shows (alt screen), ANSI SGR stripped. */
  screen(): string[];
  write(keys: string): void;
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<RegExpMatchArray>;
  /** Wait until the current screen (not the log) matches. */
  waitForScreen(pattern: RegExp, timeoutMs?: number): Promise<string>;
  exited: Promise<number | null>;
  kill(): void;
};

/**
 * Replay CUP/EL row paints into a row model; other control sequences are ignored.
 * An OSC (OSC 8 links) ends at BEL or at `ESC \` and has no width; an ESC of any other
 * sequence also ends it, as in xterm.
 */
export function replayScreen(log: string, rows = 60): string[] {
  const screen: string[] = Array.from({ length: rows }, () => "");
  let row = 0;
  const token =
    // eslint-disable-next-line no-control-regex
    /\u001b\[([0-9;?]*)([A-Za-z])|\u001b[()][0-9A-Za-z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|([^\u001b]+)/g;
  for (const match of log.matchAll(token)) {
    if (match[3] !== undefined) {
      screen[row] = (screen[row] ?? "") + match[3].replace(/\r?\n/g, "");
      continue;
    }
    const [params, final] = [match[1] ?? "", match[2]];
    if (final === "H") row = Math.max(0, Number(params.split(";")[0] || "1") - 1);
    else if (final === "K") screen[row] = "";
    else if (final === "J" || (final === "h" && params === "?1049")) screen.fill("");
  }
  return screen;
}

export function startPty(command: string, size?: { rows: number; cols: number }): PtySession {
  const child = spawnInPty(command, size);
  let buffer = "";
  const waiters: Array<() => void> = [];
  const onChunk = (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (const waiter of [...waiters]) waiter();
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const screen = () => {
    // Only the viewer's alt-screen frames count; after RESTORE the shell prints below.
    const start = buffer.lastIndexOf(ENTER);
    const end = buffer.indexOf(RESTORE, start);
    return replayScreen(start === -1 ? "" : buffer.slice(start, end === -1 ? undefined : end), size?.rows ?? 24);
  };
  const wait = <T>(check: () => T | null, describe: () => string, timeoutMs: number): Promise<T> =>
    new Promise((resolve, reject) => {
      const tick = () => {
        const result = check();
        if (result === null) return;
        waiters.splice(waiters.indexOf(tick), 1);
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(tick), 1);
        reject(new Error(describe()));
      }, timeoutMs);
      waiters.push(tick);
      tick();
    });
  return {
    child,
    output: () => buffer,
    screen,
    write: (keys) => child.stdin.write(keys),
    exited,
    waitFor(pattern, timeoutMs = 10_000) {
      return wait(
        () => buffer.match(pattern),
        () => `timed out waiting for ${pattern}; output so far: ${JSON.stringify(buffer.slice(-4000))}`,
        timeoutMs
      );
    },
    waitForScreen(pattern, timeoutMs = 10_000) {
      return wait(
        () => {
          const text = screen().join("\n");
          return pattern.test(text) ? text : null;
        },
        () => `timed out waiting for screen ${pattern}; screen:\n${screen().join("\n")}`,
        timeoutMs
      );
    },
    kill() {
      child.stdin.destroy();
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // already gone
      }
    }
  };
}

export function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** `stty -a` captured after the viewer exited, before the shell returned. */
export function sttyAfterClose(output: string): string {
  const match = /STTY_AFTER_CLOSE=([^\r\n]*)/.exec(output);
  if (!match) throw new Error(`no STTY_AFTER_CLOSE in ${JSON.stringify(output.slice(-2000))}`);
  return match[1]!;
}

/** The line discipline is back to cooked mode with echo (raw mode was undone). */
export function expectCookedTty(stty: string): void {
  if (!/(^|\s)icanon\b/.test(stty) || /-icanon\b/.test(stty) || /-echo\b/.test(stty)) {
    throw new Error(`terminal not restored: ${stty}`);
  }
}
