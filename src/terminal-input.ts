/**
 * Keyboard port, kept separate from data stdin (design D2/D8, spec "Окремі data stdin
 * і terminal input").
 *
 * For ordinary targets the keyboard is stdin. For `kosmo-tui -` stdin belongs to the
 * NDJSON reader alone, so keys come from the controlling terminal: `/dev/tty` on POSIX,
 * the `CONIN$` console handle on Windows. The data pipe is never put into raw mode and
 * its EOF does not end keyboard input. When no controlling terminal can be opened the
 * caller gets an explicit "interactive terminal required" failure (exit 1, hint --print).
 */

import { closeSync, openSync } from "node:fs";
import { ReadStream, isatty } from "node:tty";
import type { TerminalInput } from "./terminal.js";

export type KeyboardPort = {
  input: TerminalInput;
  /** `stdin` for ordinary targets, `controlling-tty` when stdin carries data. */
  source: "stdin" | "controlling-tty";
  /** Release the controlling-terminal handle. Idempotent; a no-op for stdin. */
  close(): void;
};

export type KeyboardResult = { ok: true; port: KeyboardPort } | { ok: false; exitCode: 1; message: string };

export type TtyStream = TerminalInput & { destroy(): unknown };

export type KeyboardDeps = {
  platform: string;
  stdin: TerminalInput;
  /** Whether stdin is the data source (`-` target) and so must not be the keyboard. */
  stdinCarriesData: boolean;
  openFd?: (path: string) => number;
  closeFd?: (fd: number) => void;
  isTty?: (fd: number) => boolean;
  createTtyStream?: (fd: number) => TtyStream;
};

export const PRINT_HINT = "Use --print [lisp|tab|json] for non-interactive output.";

export function controllingTerminalPath(platform: string): string {
  return platform === "win32" ? "CONIN$" : "/dev/tty";
}

function describePath(platform: string): string {
  return platform === "win32" ? "console input (CONIN$)" : "controlling terminal (/dev/tty)";
}

function refuse(reason: string): KeyboardResult {
  return {
    ok: false,
    exitCode: 1,
    message: `kosmo-tui: no-controlling-terminal: interactive terminal required: ${reason}. ${PRINT_HINT}`
  };
}

/** Cheap check used during argument validation: can a controlling terminal be opened? */
export function controllingTerminalAvailable(
  platform: string,
  deps: Pick<KeyboardDeps, "openFd" | "closeFd" | "isTty"> = {}
): boolean {
  const openFd = deps.openFd ?? ((file: string) => openSync(file, "r"));
  const closeFd = deps.closeFd ?? closeSync;
  const isTty = deps.isTty ?? isatty;
  let fd: number;
  try {
    fd = openFd(controllingTerminalPath(platform));
  } catch {
    return false;
  }
  try {
    return isTty(fd);
  } finally {
    closeFd(fd);
  }
}

export function openKeyboardInput(deps: KeyboardDeps): KeyboardResult {
  if (!deps.stdinCarriesData) {
    if (deps.stdin.isTTY !== true) return refuse("keyboard input (stdin) is not a TTY");
    return { ok: true, port: { input: deps.stdin, source: "stdin", close() {} } };
  }

  const where = describePath(deps.platform);
  const openFd = deps.openFd ?? ((file: string) => openSync(file, "r"));
  const closeFd = deps.closeFd ?? closeSync;
  const isTty = deps.isTty ?? isatty;
  const createTtyStream = deps.createTtyStream ?? ((fd: number) => new ReadStream(fd));

  let fd: number;
  try {
    fd = openFd(controllingTerminalPath(deps.platform));
  } catch {
    return refuse(`stdin carries data and no ${where} is available for keyboard input`);
  }
  let stream: TtyStream;
  try {
    if (!isTty(fd)) throw new Error("not a terminal");
    stream = createTtyStream(fd);
  } catch {
    closeFd(fd);
    return refuse(`stdin carries data and the ${where} cannot be used for keyboard input`);
  }
  // The stream owns the descriptor from here on: destroy() closes it.
  let closed = false;
  return {
    ok: true,
    port: {
      input: stream,
      source: "controlling-tty",
      close() {
        if (closed) return;
        closed = true;
        stream.destroy();
      }
    }
  };
}
