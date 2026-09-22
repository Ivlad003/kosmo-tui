/**
 * Interactive session lifecycle (task 7.3, design D8/D9/D15).
 *
 * Draws frames on start, key and resize; shows a "terminal too small" frame below
 * 40x10 instead of calling the renderer. Every way out — `q`, Ctrl+C, SIGINT, SIGTERM,
 * a render failure, a source failure — goes through one `finally` that closes the
 * terminal exactly once, and only then writes a bounded error to stderr so it lands
 * on the restored screen.
 */

import { EXIT_OK, EXIT_SIGINT, EXIT_SIGTERM, EXIT_SOURCE } from "./cli.js";
import { isTooSmall, tooSmallFrame, type Frame, type Terminal, type TerminalSize } from "./terminal.js";

export type SessionOptions = {
  terminal: Terminal;
  render(size: TerminalSize): Frame;
  /** Called for every key except the ones that end the session (q, Ctrl+C). */
  onKey?(key: string): void;
  /** A rejection ends the session with a source error; fulfilment just redraws. */
  source?: Promise<unknown>;
  /** Aborted by run() on SIGINT/SIGTERM; the reason names the signal. */
  signal?: AbortSignal;
  stderr: { write(chunk: string): unknown };
};

type Outcome = { code: number; error?: string };

const CTRL_C = "\u0003";
const MAX_ERROR_CHARS = 2_000;

function signalCode(reason: unknown): number {
  return reason === "SIGTERM" ? EXIT_SIGTERM : EXIT_SIGINT;
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // One bounded line: a multi-line or huge message must not flood the restored screen.
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_CHARS);
}

export async function runTerminalSession(options: SessionOptions): Promise<number> {
  const { terminal, signal } = options;
  let outcome: Outcome | undefined;
  let settle: (value: Outcome) => void = () => undefined;
  const done = new Promise<Outcome>((resolve) => {
    settle = resolve;
  });
  const finish = (value: Outcome): void => {
    if (outcome !== undefined) return;
    outcome = value;
    settle(value);
  };

  const draw = (): void => {
    if (outcome !== undefined) return;
    try {
      const size = terminal.size();
      terminal.paint(isTooSmall(size) ? tooSmallFrame(size) : options.render(size));
    } catch (error) {
      finish({ code: EXIT_SOURCE, error: `render failed: ${describe(error)}` });
    }
  };
  const onAbort = (): void => finish({ code: signalCode(signal?.reason) });

  try {
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
      terminal.onResize(draw);
      terminal.onKey((key) => {
        if (outcome !== undefined) return;
        if (key === "q") return finish({ code: EXIT_OK });
        if (key.includes(CTRL_C)) return finish({ code: EXIT_SIGINT });
        try {
          options.onKey?.(key);
        } catch (error) {
          return finish({ code: EXIT_SOURCE, error: `key handler failed: ${describe(error)}` });
        }
        draw();
      });
      options.source?.then(draw, (error: unknown) =>
        finish({ code: EXIT_SOURCE, error: `source failed: ${describe(error)}` })
      );
      draw();
    }
    return (await done).code;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    terminal.close();
    if (outcome?.error !== undefined) options.stderr.write(`kosmo-tui: ${outcome.error}\n`);
  }
}
