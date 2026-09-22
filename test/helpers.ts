import path from "node:path";
import type { DetectFs } from "../src/detect.js";
import type { Proc, SignalName } from "../src/cli.js";

export const SQLITE_HEADER = "SQLite format 3\u0000";

/** In-memory read-only filesystem; directories are entries whose content is null. */
export function fakeFs(files: Record<string, string | null>, calls: string[] = []): DetectFs {
  const table = new Map(Object.entries(files).map(([name, content]) => [path.resolve(name), content]));
  return {
    async stat(filePath) {
      calls.push(`stat ${filePath}`);
      if (!table.has(filePath)) return undefined;
      const content = table.get(filePath);
      return { isFile: content !== null, isDirectory: content === null, size: content?.length ?? 0 };
    },
    async readHead(filePath, bytes) {
      calls.push(`read ${filePath}`);
      return new TextEncoder().encode((table.get(filePath) ?? "").slice(0, bytes));
    }
  };
}

export type FakeProc = Proc & {
  out: string;
  err: string;
  emit(signal: SignalName): void;
  listeners: Map<SignalName, Set<() => void>>;
};

export function fakeProc(
  argv: string[],
  options: { stdoutTty?: boolean; stdinTty?: boolean; cwd?: string; env?: Record<string, string> } = {}
): FakeProc {
  const listeners = new Map<SignalName, Set<() => void>>();
  const proc: FakeProc = {
    argv: ["node", "kosmo-tui", ...argv],
    env: options.env ?? {},
    cwd: () => options.cwd ?? "/work/app",
    stdin: { isTTY: options.stdinTty ?? true },
    stdout: {
      isTTY: options.stdoutTty ?? true,
      write(chunk: string) {
        proc.out += chunk;
        return true;
      }
    },
    stderr: {
      write(chunk: string) {
        proc.err += chunk;
        return true;
      }
    },
    platform: "linux",
    out: "",
    err: "",
    listeners,
    on(signal, handler) {
      if (!listeners.has(signal)) listeners.set(signal, new Set());
      listeners.get(signal)!.add(handler);
    },
    off(signal, handler) {
      listeners.get(signal)?.delete(handler);
    },
    emit(signal) {
      for (const handler of [...(listeners.get(signal) ?? [])]) handler();
    }
  };
  return proc;
}
