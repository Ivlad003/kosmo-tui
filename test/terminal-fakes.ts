import type { TerminalInput, TerminalOutput } from "../src/terminal.js";

export type FakeTerminalIo = {
  input: TerminalInput & { isTTY: boolean };
  output: TerminalOutput;
  dataListeners: Array<(chunk: Buffer | string) => void>;
  resizeListeners: Array<() => void>;
  rawModeCalls: boolean[];
  /** Output writes only. */
  writes: string[];
  /** Ordered log shared with anything else the test wants to interleave (e.g. stderr). */
  log: string[];
  key(chunk: Buffer | string): void;
  resize(): void;
};

export function fakeTerminalIo(options: { isTTY?: boolean; cols?: number; rows?: number } = {}): FakeTerminalIo {
  const isTTY = options.isTTY ?? true;
  const dataListeners: Array<(chunk: Buffer | string) => void> = [];
  const resizeListeners: Array<() => void> = [];
  const rawModeCalls: boolean[] = [];
  const writes: string[] = [];
  const log: string[] = [];

  const input: TerminalInput & { isTTY: boolean } = {
    isTTY,
    setRawMode: (mode) => {
      rawModeCalls.push(mode);
      log.push(`raw:${mode}`);
    },
    on: (_event, listener) => dataListeners.push(listener),
    off: (_event, listener) => {
      const index = dataListeners.indexOf(listener);
      if (index >= 0) dataListeners.splice(index, 1);
    },
    resume: () => undefined,
    pause: () => undefined
  };

  const output: TerminalOutput = {
    isTTY,
    columns: options.cols ?? 80,
    rows: options.rows ?? 24,
    write: (chunk) => {
      writes.push(chunk);
      log.push(`out:${chunk}`);
    },
    on: (_event, listener) => resizeListeners.push(listener),
    off: (_event, listener) => {
      const index = resizeListeners.indexOf(listener);
      if (index >= 0) resizeListeners.splice(index, 1);
    }
  };

  return {
    input,
    output,
    dataListeners,
    resizeListeners,
    rawModeCalls,
    writes,
    log,
    key: (chunk) => {
      for (const listener of [...dataListeners]) listener(chunk);
    },
    resize: () => {
      for (const listener of [...resizeListeners]) listener();
    }
  };
}
