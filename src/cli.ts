/**
 * Composition root: `run(proc, deps)` (bin/kosmo-tui.js passes the real `process`).
 *
 *   argv ── parseArgv (pure, every combination checked before any side effect)
 *        ├─ --help / --version
 *        ├─ --print ──► output/print.ts   (one-shot, no terminal)
 *        └─ viewer ───► ui/open.ts        (start screen, a trace file or stdin)
 *
 * SIGINT, SIGTERM and SIGHUP abort the command through one AbortSignal whose reason is the
 * signal name; the command restores the terminal and `run` returns 130, 143 or 129. A throw
 * that escapes a command becomes exit 2 with one bounded, escaped line on stderr.
 *
 * Exit codes (spec 6.8): see src/proc.ts.
 */
import { readFileSync } from "node:fs";
import { USAGE, parseArgv } from "./args.js";
import { runPrint, type PrintInput } from "./output/print.js";
import {
  EXIT_OK,
  EXIT_SOURCE,
  EXIT_USAGE,
  absorbStreamErrors,
  describeError,
  exitCodeForSignal,
  type Proc,
  type SignalName
} from "./proc.js";
import { escapeTerminalControls } from "./sanitize.js";
import { openTui, type OpenTuiInput } from "./ui/open.js";

export {
  EXIT_OK,
  EXIT_SIGHUP,
  EXIT_SIGINT,
  EXIT_SIGTERM,
  EXIT_SOURCE,
  EXIT_USAGE,
  type Proc,
  type Readable,
  type SignalName,
  type Writable
} from "./proc.js";
export { FORMATS, USAGE, parseArgv, type OutputFormat, type ParseResult, type ParsedArgs } from "./args.js";

export type RunDeps = {
  readVersion?: () => string;
  openTui?: (input: OpenTuiInput) => Promise<number>;
  runPrint?: (input: PrintInput) => Promise<number>;
};

const SIGNALS: readonly SignalName[] = ["SIGINT", "SIGTERM", "SIGHUP"];

function defaultReadVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function run(proc: Proc, deps: RunDeps = {}): Promise<number> {
  // `kosmo-tui … 2>&1 | true`: an EPIPE on stderr must not turn an error message into a crash.
  absorbStreamErrors(proc.stderr);
  const parsed = parseArgv(proc.argv.slice(2));
  if (!parsed.ok) {
    proc.stderr.write(`kosmo-tui: ${escapeTerminalControls(parsed.message)}\nRun kosmo-tui --help for usage.\n`);
    return EXIT_USAGE;
  }
  const args = parsed.args;
  // `kosmo-tui --help | true`: the reader may be gone, and the EPIPE must not crash the exit 0.
  if (args.command === "help" || args.command === "version") absorbStreamErrors(proc.stdout);
  if (args.command === "help") {
    proc.stdout.write(USAGE);
    return EXIT_OK;
  }
  if (args.command === "version") {
    proc.stdout.write(`${(deps.readVersion ?? defaultReadVersion)()}\n`);
    return EXIT_OK;
  }

  // Validation is complete: from here on side effects are allowed.
  const controller = new AbortController();
  let signalled: number | undefined;
  const handlers = SIGNALS.map((name) => {
    const handler = (): void => {
      signalled ??= exitCodeForSignal(name);
      controller.abort(name);
    };
    proc.on?.(name, handler);
    return [name, handler] as const;
  });
  try {
    const code =
      args.command === "print"
        ? await (deps.runPrint ?? runPrint)({ args, proc, signal: controller.signal })
        : await (deps.openTui ?? openTui)({ args, proc, signal: controller.signal });
    return signalled ?? code;
  } catch (error) {
    if (signalled !== undefined) return signalled;
    proc.stderr.write(`kosmo-tui: ${escapeTerminalControls(describeError(error))}\n`);
    return EXIT_SOURCE;
  } finally {
    for (const [name, handler] of handlers) proc.off?.(name, handler);
  }
}
