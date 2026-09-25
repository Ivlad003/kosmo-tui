/**
 * The process port and exit codes of kosmo-tui (spec 6.8).
 *
 * `run(proc, deps)` in cli.ts receives the real `process` as a `Proc`; tests pass fakes. The
 * codes are the only ones the binary returns:
 *
 *   0 success; 1 usage, a path that does not exist or is a directory, no controlling terminal;
 *   2 a format or read failure (`too-large`, `not-a-kosmo-trace`, `not-a-kosmo-trace-store`,
 *   `unsupported-version`, `invalid(…)`, a stopped stream under `--print`, …);
 *   129 SIGHUP, 130 SIGINT (also Ctrl+C in raw mode), 143 SIGTERM.
 */
import type { ReaderError } from "./readers/types.js";

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_SOURCE = 2;
export const EXIT_SIGHUP = 129;
export const EXIT_SIGINT = 130;
export const EXIT_SIGTERM = 143;

export type SignalName = "SIGINT" | "SIGTERM" | "SIGHUP";

export type Writable = {
  write(chunk: string, callback?: (error?: Error | null) => void): unknown;
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  /** A real stream has it: `print` waits for the write callback only then. */
  writable?: unknown;
  on?(event: string, listener: (...args: never[]) => void): unknown;
  off?(event: string, listener: (...args: never[]) => void): unknown;
};

export type Readable = { isTTY?: boolean };

export type Proc = {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  cwd(): string;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  platform?: string;
  on?(signal: SignalName, handler: () => void): unknown;
  off?(signal: SignalName, handler: () => void): unknown;
};

/**
 * A no-op `error` listener that stays on the stream for the rest of the process: Node emits EPIPE
 * (a closed pipe: `kosmo-tui … | head`) as an `error` event, possibly after the write callback,
 * and an `error` event without a listener is an uncaught exception. Callers that care about the
 * failure still see it through the write callback or their own listener.
 */
export function absorbStreamErrors(stream: Writable): void {
  stream.on?.("error", ignoreStreamError);
}

const ignoreStreamError = (() => undefined) as (...args: never[]) => void;

/** Spec 6.8: a path that does not exist or is a directory is 1, every other reader failure is 2. */
export function exitCodeForReaderError(error: ReaderError): 1 | 2 {
  return error.code === "file-not-found" || error.code === "is-directory" ? EXIT_USAGE : EXIT_SOURCE;
}

/** The exit code for an AbortSignal reason set by `run()` (the signal name). */
export function exitCodeForSignal(reason: unknown): number {
  if (reason === "SIGTERM") return EXIT_SIGTERM;
  if (reason === "SIGHUP") return EXIT_SIGHUP;
  return EXIT_SIGINT;
}

/** One line of at most 2 000 characters for stderr, without a doubled `kosmo-tui: ` prefix. */
export function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^kosmo-tui: /, "")
    .slice(0, 2_000);
}
