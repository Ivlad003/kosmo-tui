/**
 * Fakes for the TUI session (task 22): a recording Terminal, manual timers, in-memory
 * snippet/root/start file systems and a clipboard. Every port writes into one shared log,
 * so a test can check the order of "terminal restored", "fallback printed" and "stderr".
 */
import { stripAnsi } from "../../src/ansi.js";
import type { RootFs } from "../../src/code/root.js";
import type { SnippetFs } from "../../src/code/snippet.js";
import { COLOR_NONE } from "../../src/color.js";
import type { StartDirent, StartFs } from "../../src/start.js";
import type { Frame, Terminal, TerminalSize } from "../../src/terminal.js";
import type { CopyOutcome, SessionClipboard, SessionDeps, SessionTimers } from "../../src/ui/session.js";
import { memoryFs } from "../readers/reader-fakes.js";

export type FakeTerminal = Terminal & {
  readonly frames: string[][];
  readonly log: string[];
  closes: number;
  reclaims: number;
  key(chunk: string): void;
  resize(size: TerminalSize): void;
  /** The last painted frame without SGR, one line per row. */
  screen(): string;
};

/** `failPaint(n)` makes the n-th paint (1-based) throw, to test the render-failure path. */
export function fakeTerminal(size: TerminalSize = { cols: 80, rows: 24 }, failPaint?: number): FakeTerminal {
  const keys: Array<(key: string) => void> = [];
  const resizes: Array<(size: TerminalSize) => void> = [];
  let current = size;
  let paints = 0;
  const terminal: FakeTerminal = {
    frames: [],
    log: [],
    closes: 0,
    reclaims: 0,
    size: () => current,
    paint(frame: Frame) {
      paints += 1;
      if (failPaint !== undefined && paints === failPaint) throw new Error("boom\nsecond line");
      terminal.frames.push([...frame]);
    },
    onKey: (listener) => keys.push(listener),
    onResize: (listener) => resizes.push(listener),
    close() {
      terminal.closes += 1;
      terminal.log.push("terminal:close");
    },
    reclaimInput() {
      terminal.reclaims += 1;
    },
    key: (chunk) => {
      for (const listener of [...keys]) listener(chunk);
    },
    resize(next) {
      current = next;
      for (const listener of [...resizes]) listener(next);
    },
    screen: () => (terminal.frames.at(-1) ?? []).map(stripAnsi).join("\n")
  };
  return terminal;
}

export type ManualTimers = SessionTimers & { readonly pending: number; runAll(): void };

export function manualTimers(): ManualTimers {
  const queue = new Map<number, () => void>();
  let next = 0;
  return {
    setTimeout(handler) {
      next += 1;
      queue.set(next, handler);
      return next;
    },
    clearTimeout(handle) {
      queue.delete(handle as number);
    },
    get pending() {
      return queue.size;
    },
    runAll() {
      const due = [...queue.values()];
      queue.clear();
      for (const handler of due) handler();
    }
  };
}

function missing(path: string): Error {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
}

/** Absolute POSIX paths; a directory exists when some file lies under it. realpath is the identity. */
export function memorySnippetFs(files: Record<string, string>): SnippetFs & { reads: string[] } {
  const reads: string[] = [];
  const isDir = (path: string) => Object.keys(files).some((file) => file.startsWith(`${path.replace(/\/$/, "")}/`));
  return {
    reads,
    async realpath(path) {
      if (files[path] !== undefined || isDir(path)) return path;
      throw missing(path);
    },
    async stat(path) {
      const text = files[path];
      if (text !== undefined) return { size: new TextEncoder().encode(text).length, isFile: true };
      return isDir(path) ? { size: 0, isFile: false } : undefined;
    },
    async readFile(path) {
      reads.push(path);
      const text = files[path];
      if (text === undefined) throw missing(path);
      return new TextEncoder().encode(text);
    }
  };
}

export function memoryRootFs(entries: { dirs?: readonly string[]; files?: readonly string[] } = {}): RootFs {
  const dirs = new Set(entries.dirs ?? []);
  const files = new Set(entries.files ?? []);
  return {
    isDirectory: async (path) => dirs.has(path),
    exists: async (path) => dirs.has(path) || files.has(path)
  };
}

/** In-memory StartFs; `calls` logs every call so tests can prove `-r` writes nothing. */
export function memoryStartFs(
  initial: Record<string, { text: string; mtimeMs: number }> = {}
): StartFs & { calls: string[]; files: Map<string, { text: string; mtimeMs: number }> } {
  const files = new Map(Object.entries(initial));
  const calls: string[] = [];
  const isDir = (dir: string) => [...files.keys()].some((file) => file.startsWith(`${dir.replace(/\/$/, "")}/`));
  return {
    calls,
    files,
    async readdir(dir) {
      calls.push(`readdir ${dir}`);
      if (!isDir(dir)) throw missing(dir);
      const prefix = `${dir.replace(/\/$/, "")}/`;
      const names = new Map<string, StartDirent["kind"]>();
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const [name, ...rest] = file.slice(prefix.length).split("/");
        names.set(name!, rest.length > 0 ? "dir" : "file");
      }
      return [...names].map(([name, kind]) => ({ name, kind }));
    },
    async stat(path) {
      calls.push(`stat ${path}`);
      const file = files.get(path);
      if (file !== undefined)
        return { size: new TextEncoder().encode(file.text).length, mtimeMs: file.mtimeMs, isFile: true };
      return isDir(path) ? { size: 0, mtimeMs: 0, isFile: false } : undefined;
    },
    async readFile(path) {
      calls.push(`readFile ${path}`);
      const file = files.get(path);
      if (file === undefined) throw missing(path);
      return file.text;
    },
    async writeFile(path, text) {
      calls.push(`writeFile ${path}`);
      files.set(path, { text, mtimeMs: 1 });
    },
    async rename(from, to) {
      calls.push(`rename ${from} -> ${to}`);
      const file = files.get(from);
      if (file === undefined) throw missing(from);
      files.delete(from);
      files.set(to, file);
    },
    async mkdir(dir) {
      calls.push(`mkdir ${dir}`);
    },
    async rm(path) {
      calls.push(`rm ${path}`);
      files.delete(path);
    }
  };
}

export type FakeClipboard = SessionClipboard & { readonly copied: string[]; readonly queued: string[] };

export function fakeClipboard(outcome: CopyOutcome, log: string[]): FakeClipboard {
  const copied: string[] = [];
  const queued: string[] = [];
  return {
    copied,
    queued,
    async copy(text) {
      copied.push(text);
      return outcome;
    },
    fallback: {
      queue: (text) => queued.push(text),
      flush: () => log.push(`fallback:flush ${queued.length}`)
    }
  };
}

export type TestDeps = SessionDeps & { readonly timers: ManualTimers; stderrText(): string };

/** Defaults: cwd /w, home /home/me, nothing on disk, no clipboard adapter, manual timers, no color. */
export function sessionDeps(terminal: FakeTerminal, overrides: Partial<SessionDeps> = {}): TestDeps {
  let stderr = "";
  const timers = manualTimers();
  return {
    terminal,
    reader: { fs: memoryFs() },
    snippetFs: memorySnippetFs({}),
    rootFs: memoryRootFs(),
    startFs: memoryStartFs(),
    clipboard: fakeClipboard({ copied: false, reason: "no clipboard adapter for this platform/display" }, terminal.log),
    render: { color: COLOR_NONE, links: false },
    cwd: "/w",
    home: "/home/me",
    env: {},
    readOnly: false,
    stderr: {
      write(chunk: string) {
        stderr += chunk;
        terminal.log.push(`stderr:${chunk}`);
      }
    },
    timers,
    stderrText: () => stderr,
    ...overrides
  } as TestDeps;
}

/** Let promises and I/O callbacks run until `check` holds (at most 500 event-loop turns). */
export async function until(check: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 500; turn += 1) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}
