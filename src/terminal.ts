/**
 * Terminal I/O for the interactive viewer (design D8), ported from kosmo-callflow
 * `packages/cli/src/connect/terminal.ts`.
 *
 * The only impure rendering module: it owns raw mode, the alternate screen, cursor
 * visibility, resize and frame diffing. Input and output are injected, so diffing and
 * teardown are tested against fakes; PTY tests cover the real streams.
 *
 * The keyboard input passed here is never the data stdin of `kosmo-tui -`: that case
 * gets a controlling-terminal port from terminal-input.ts, so a data pipe is never put
 * into raw mode.
 */

import { CURSOR, truncateVisible } from "./ansi.js";

/** One string per screen row, already fitted to the viewport width. */
export type Frame = readonly string[];

export type TerminalInput = {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
};

export type TerminalOutput = {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(chunk: string): unknown;
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
};

export type TerminalSize = { cols: number; rows: number };

export type Terminal = {
  size(): TerminalSize;
  /** Paint a frame, writing only the rows that changed since the last paint. */
  paint(frame: Frame): void;
  onKey(listener: (key: string) => void): void;
  onResize(listener: (size: TerminalSize) => void): void;
  /** Restore raw mode, cursor and screen. Safe to call more than once. */
  close(): void;
  /**
   * Put the keyboard back into raw mode. Another process sharing the terminal can undo
   * it: every Node process restores the termios it saw at startup when it exits, so a
   * `node … | kosmo-tui -` producer leaves the terminal cooked (line-buffered, echoing)
   * behind the viewer's back. A no-op after close or on a non-TTY input.
   */
  reclaimInput?(): void;
};

export const MIN_COLS = 40;
export const MIN_ROWS = 10;

const defaultSize: TerminalSize = { cols: 80, rows: 24 };

/** Sequence written once when a TTY output is taken over. */
export const ENTER_SEQUENCE = CURSOR.altScreenOn + CURSOR.hide;
/** Sequence written once on close: cursor back, then leave the alternate screen. */
export const RESTORE_SEQUENCE = CURSOR.show + CURSOR.altScreenOff;

export function isTooSmall(size: TerminalSize): boolean {
  return size.cols < MIN_COLS || size.rows < MIN_ROWS;
}

/** Placeholder shown instead of the viewer below 40x10; never wider than the viewport. */
export function tooSmallFrame(size: TerminalSize): Frame {
  const lines = ["terminal too small", `need ${MIN_COLS}x${MIN_ROWS}, have ${size.cols}x${size.rows}`];
  return lines.slice(0, Math.max(0, size.rows)).map((line) => truncateVisible(line, size.cols));
}

export function createTerminal(input: TerminalInput, output: TerminalOutput): Terminal {
  let previous: Frame = [];
  let closed = false;
  const keyListeners: Array<(key: string) => void> = [];
  const resizeListeners: Array<(size: TerminalSize) => void> = [];

  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const listener of keyListeners) listener(text);
  };

  const onResize = (): void => {
    // Widths changed, so every cached row is stale: the next paint is a full redraw.
    previous = [];
    if (output.isTTY) output.write(CURSOR.clearScreen);
    const next = size();
    for (const listener of resizeListeners) listener(next);
  };

  function size(): TerminalSize {
    return {
      cols: output.columns ?? defaultSize.cols,
      rows: output.rows ?? defaultSize.rows
    };
  }

  if (input.isTTY) {
    input.setRawMode?.(true);
    input.resume?.();
  }
  input.on("data", onData);
  output.on("resize", onResize);
  if (output.isTTY) output.write(ENTER_SEQUENCE);

  return {
    size,
    paint(frame) {
      if (closed) return;
      let out = "";
      const height = Math.max(frame.length, previous.length);
      for (let row = 0; row < height; row += 1) {
        const next = frame[row] ?? "";
        if (previous[row] === next) continue;
        // CUP rows are 1-based; clear the row so a shorter line leaves no tail behind.
        out += CURSOR.moveTo(row + 1, 1) + CURSOR.clearLine + next;
      }
      previous = [...frame];
      if (out.length > 0) output.write(out);
    },
    onKey(listener) {
      keyListeners.push(listener);
    },
    onResize(listener) {
      resizeListeners.push(listener);
    },
    reclaimInput() {
      if (closed || !input.isTTY) return;
      // Node skips a same-mode setRawMode(true), so toggle to make it apply again.
      input.setRawMode?.(false);
      input.setRawMode?.(true);
    },
    close() {
      if (closed) return;
      closed = true;
      input.off("data", onData);
      output.off("resize", onResize);
      if (input.isTTY) {
        input.setRawMode?.(false);
        input.pause?.();
      }
      if (output.isTTY) output.write(RESTORE_SEQUENCE);
    }
  };
}
