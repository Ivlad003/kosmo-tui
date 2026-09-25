/**
 * The TUI entry of the composition root (spec 5.2 `open-viewer`, 6.8): wires the real ports
 * for one interactive session and owns its lifecycle around `runSession`.
 *
 *  - Before the terminal is taken: an argv path must exist and not be a directory, `--root`
 *    must be a directory (exit 1), stdout must be a TTY and a keyboard must exist (exit 1,
 *    state `no-controlling-terminal` of spec 12, with the `--print` hint). Nothing has been
 *    drawn when these fail.
 *  - `kosmo-tui -`: stdin carries the data and keys come from the controlling terminal
 *    (terminal-input.ts); the data pipe is never put into raw mode.
 *  - A producer on the other end of the pipe usually shares this terminal; when it exits,
 *    Node restores the termios it started with (cooked + echo) behind our back. Raw mode is
 *    therefore reclaimed at data EOF and once more `RECLAIM_AFTER_EOF_MS` later.
 *  - `q` quits before the dataset is open and Ctrl+C exits 130 (session.ts).
 *  - On the way out the keyboard handle is closed and data stdin destroyed, so a producer
 *    that still writes gets EPIPE instead of blocking on a full pipe. A throw that escapes
 *    the session closes the terminal before it propagates to run() (exit 2).
 *  - The home directory is read once, before the terminal is taken; if `os.homedir()` throws
 *    or answers "" the session runs with `home: null` (see `resolveHome`).
 */
import os from "node:os";
import path from "node:path";
import { StdoutFallback, copyToClipboard } from "../clipboard.js";
import type { RootFs } from "../code/root.js";
import type { SnippetFs } from "../code/snippet.js";
import { detectColorLevel, linksEnabled } from "../color.js";
import { EXIT_SOURCE, EXIT_USAGE, describeError, type Proc } from "../proc.js";
import { nodeReaderFs } from "../readers/node-fs.js";
import { loadSqliteModule } from "../readers/sqlite-loader.js";
import type { ReaderDeps } from "../readers/types.js";
import type { TuiArgs } from "../args.js";
import { escapeTerminalControls } from "../sanitize.js";
import type { StartFs } from "../start.js";
import {
  createTerminal,
  type Terminal,
  type TerminalInput,
  type TerminalOptions,
  type TerminalOutput
} from "../terminal.js";
import { PRINT_HINT, openKeyboardInput, type KeyboardDeps, type KeyboardResult } from "../terminal-input.js";
import { nodeRootFs, nodeSnippetFs, nodeStartFs } from "./node-ports.js";
import { paintGuardFromEnv } from "./paint-guard.js";
import { runSession, type SessionClipboard, type SessionDeps, type SessionTimers } from "./session.js";

/** Second raw-mode reclaim after data EOF, for a producer whose exit trails its EOF. */
export const RECLAIM_AFTER_EOF_MS = 300;

export type OpenTuiInput = { readonly args: TuiArgs; readonly proc: Proc; readonly signal: AbortSignal };

export type OpenTuiDeps = {
  readonly keyboard?: (deps: KeyboardDeps) => KeyboardResult;
  readonly createTerminal?: (input: TerminalInput, output: TerminalOutput, options?: TerminalOptions) => Terminal;
  /** fs and loadSqlite; stdin is `proc.stdin` for `-`. */
  readonly reader?: Omit<ReaderDeps, "stdin" | "onProgress">;
  readonly snippetFs?: SnippetFs;
  readonly rootFs?: RootFs;
  readonly startFs?: StartFs;
  readonly clipboard?: SessionClipboard;
  readonly timers?: SessionTimers;
  /** `os.homedir` in production; a throw, an empty or a relative answer means "no home" (null). */
  readonly homedir?: () => string;
};

/**
 * The home directory, or null when it cannot be known. Never throws: without a home the TUI
 * still runs (recent.json only under `$XDG_CONFIG_HOME`, no home check for dataset.root).
 */
export function resolveHome(homedir: () => string): string | null {
  let home: unknown;
  try {
    home = homedir();
  } catch {
    return null;
  }
  return typeof home === "string" && home !== "" && path.isAbsolute(home) ? home : null;
}

/** Data stdin of `kosmo-tui -`: a byte stream that also says when it ended. */
type DataStdin = AsyncIterable<Uint8Array> & {
  once?(event: "end", listener: () => void): unknown;
  destroy?(): unknown;
};

const defaultTimers: SessionTimers = {
  setTimeout: (handler, ms) => {
    const handle = setTimeout(handler, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export async function openTui(input: OpenTuiInput, deps: OpenTuiDeps = {}): Promise<number> {
  const { args, proc, signal } = input;
  const platform = proc.platform ?? process.platform;
  const cwd = proc.cwd();
  const reader = deps.reader ?? { fs: nodeReaderFs, loadSqlite: () => loadSqliteModule() };
  const rootFs = deps.rootFs ?? nodeRootFs;
  const fail = (code: number, text: string): number => {
    proc.stderr.write(`kosmo-tui: ${escapeTerminalControls(text)}\n`);
    return code;
  };
  const fromStdin = args.target === "-";

  // Spec 6.8: a missing path or a directory is exit 1, decided before the terminal is taken.
  if (args.target !== undefined && !fromStdin) {
    let info: Awaited<ReturnType<typeof reader.fs.stat>>;
    try {
      info = await reader.fs.stat(args.target);
    } catch (error) {
      return fail(EXIT_SOURCE, `read-error: ${args.target}: ${describeError(error)}`);
    }
    if (info === undefined) return fail(EXIT_USAGE, `file-not-found: ${args.target}`);
    if (info.isDirectory) return fail(EXIT_USAGE, `is-directory: ${args.target}`);
  }
  if (args.root !== undefined && !(await rootFs.isDirectory(path.resolve(cwd, args.root)).catch(() => false))) {
    return fail(EXIT_USAGE, `--root is not a directory: ${args.root}`);
  }
  if (proc.stdout.isTTY !== true) {
    return fail(
      EXIT_USAGE,
      `no-controlling-terminal: interactive terminal required: stdout is not a TTY. ${PRINT_HINT}`
    );
  }
  const home = resolveHome(deps.homedir ?? os.homedir);
  const keyboard = (deps.keyboard ?? openKeyboardInput)({
    platform,
    stdin: proc.stdin as unknown as TerminalInput,
    stdinCarriesData: fromStdin
  });
  if (!keyboard.ok) {
    proc.stderr.write(`${keyboard.message}\n`);
    return keyboard.exitCode;
  }

  let root: string | null = null;
  const guard = paintGuardFromEnv({ env: proc.env, isTTY: true, platform, root: () => root });
  const terminal = (deps.createTerminal ?? createTerminal)(
    keyboard.port.input,
    proc.stdout as unknown as TerminalOutput,
    { guard }
  );
  const timers = deps.timers ?? defaultTimers;
  const data = proc.stdin as unknown as DataStdin;
  let reclaimTimer: unknown = null;
  if (fromStdin) {
    data.once?.("end", () => {
      terminal.reclaimInput?.();
      reclaimTimer = timers.setTimeout(() => terminal.reclaimInput?.(), RECLAIM_AFTER_EOF_MS);
    });
  }
  const session: SessionDeps = {
    terminal,
    reader: fromStdin ? { ...reader, stdin: data } : reader,
    snippetFs: deps.snippetFs ?? nodeSnippetFs,
    rootFs,
    startFs: deps.startFs ?? nodeStartFs,
    clipboard: deps.clipboard ?? {
      copy: (text) => copyToClipboard(text, { platform: platform as NodeJS.Platform, env: { ...proc.env } }),
      fallback: new StdoutFallback(proc.stdout)
    },
    render: { color: detectColorLevel(proc.env, true, platform), links: linksEnabled(proc.env) },
    cwd,
    home,
    env: proc.env,
    readOnly: args.readOnly,
    ...(args.root === undefined ? {} : { rootFlag: args.root }),
    ...(args.target === undefined ? {} : { origin: fromStdin ? ("stdin" as const) : { path: args.target } }),
    signal,
    stderr: proc.stderr,
    timers,
    tmpToken: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    onRootChange: (next) => {
      root = next;
    }
  };
  try {
    return await runSession(session);
  } catch (error) {
    // runSession restores the terminal on every way out it knows; a throw that escaped it must
    // not leave raw mode and the alternate screen behind (spec 13.2). close() is safe to repeat.
    terminal.close();
    throw error;
  } finally {
    if (reclaimTimer !== null) timers.clearTimeout(reclaimTimer);
    keyboard.port.close();
    // The producer on the other end gets EPIPE on its next write instead of a full pipe.
    if (fromStdin) data.destroy?.();
  }
}
