/**
 * A fake `Proc` for the CLI, `--print` and TUI entry tests (tasks 23–24): captured stdout
 * and stderr, signal listeners the test can fire, and a data stdin that is a byte stream,
 * a keyboard-capable input and an EventEmitter-like `once("end")` in one object.
 */
import type { Proc, SignalName } from "../../src/proc.js";

export type FakeStdin = AsyncIterable<Uint8Array> & {
  isTTY: boolean;
  destroyed: boolean;
  setRawMode(mode: boolean): void;
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  off(event: "data", listener: (chunk: Buffer | string) => void): void;
  once(event: "end", listener: () => void): void;
  destroy(): void;
  /** Fire the `end` listeners, as a Readable does at EOF. */
  emitEnd(): void;
};

export function fakeStdin(data: AsyncIterable<Uint8Array> = (async function* () {})(), isTTY = false): FakeStdin {
  const ends: Array<() => void> = [];
  const stdin: FakeStdin = {
    isTTY,
    destroyed: false,
    setRawMode: () => undefined,
    on: () => undefined,
    off: () => undefined,
    once: (_event, listener) => {
      ends.push(listener);
    },
    destroy() {
      stdin.destroyed = true;
    },
    emitEnd() {
      for (const listener of ends.splice(0)) listener();
    },
    [Symbol.asyncIterator]: () => data[Symbol.asyncIterator]()
  };
  return stdin;
}

export type FakeProc = Proc & {
  out: string;
  err: string;
  readonly stdin: FakeStdin;
  readonly listeners: Map<SignalName, Set<() => void>>;
  emit(signal: SignalName): void;
};

export function fakeProc(
  argv: readonly string[],
  options: { stdoutTty?: boolean; cwd?: string; env?: Record<string, string>; stdin?: FakeStdin } = {}
): FakeProc {
  const listeners = new Map<SignalName, Set<() => void>>();
  const proc: FakeProc = {
    argv: ["node", "kosmo-tui", ...argv],
    env: options.env ?? {},
    cwd: () => options.cwd ?? "/w",
    stdin: options.stdin ?? fakeStdin(undefined, true),
    stdout: {
      isTTY: options.stdoutTty ?? true,
      columns: 80,
      rows: 24,
      write(chunk: string) {
        proc.out += chunk;
        return true;
      },
      on: () => undefined,
      off: () => undefined
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
