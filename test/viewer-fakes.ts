import type { Terminal } from "../src/terminal.js";
import type { ViewerTimers } from "../src/viewer.js";

/** In-memory Terminal for the viewer loop: records frames, lets tests press keys and resize. */
export function fakeViewerTerminal(rows = 24, cols = 80) {
  const painted: string[][] = [];
  const keyListeners: Array<(key: string) => void> = [];
  const resizeListeners: Array<(size: { cols: number; rows: number }) => void> = [];
  let size = { cols, rows };
  let closed = 0;
  const terminal: Terminal = {
    size: () => size,
    paint: (frame) => {
      painted.push([...frame]);
    },
    onKey: (listener) => {
      keyListeners.push(listener);
    },
    onResize: (listener) => {
      resizeListeners.push(listener);
    },
    close: () => {
      closed += 1;
    }
  };
  return {
    terminal,
    painted,
    last: () => (painted.at(-1) ?? []).join("\n"),
    press: (key: string) => {
      for (const listener of keyListeners) listener(key);
    },
    resize: (next: { cols: number; rows: number }) => {
      size = next;
      for (const listener of resizeListeners) listener(next);
    },
    closeCount: () => closed
  };
}

export function fakeTimers() {
  let handler: (() => void) | undefined;
  let interval: number | undefined;
  let cleared = 0;
  const timers: ViewerTimers = {
    setInterval: (fn, ms) => {
      handler = fn;
      interval = ms;
      return "h";
    },
    clearInterval: () => {
      cleared += 1;
    }
  };
  return { timers, fire: () => handler?.(), interval: () => interval, cleared: () => cleared };
}
