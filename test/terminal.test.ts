import { describe, expect, it } from "vitest";
import { visibleWidth } from "../src/ansi.js";
import {
  ENTER_SEQUENCE,
  MIN_COLS,
  MIN_ROWS,
  RESTORE_SEQUENCE,
  createTerminal,
  isTooSmall,
  tooSmallFrame
} from "../src/terminal.js";
import { fakeTerminalIo } from "./terminal-fakes.js";

describe("terminal", () => {
  it("repaints only the rows that changed", () => {
    const f = fakeTerminalIo();
    const term = createTerminal(f.input, f.output);
    term.paint(["alpha", "beta", "gamma"]);
    f.writes.length = 0;

    term.paint(["alpha", "BETA", "gamma"]);

    expect(f.writes).toEqual(["\u001b[2;1H\u001b[2KBETA"]);
    term.close();
  });

  it("writes nothing when the frame is unchanged", () => {
    const f = fakeTerminalIo();
    const term = createTerminal(f.input, f.output);
    term.paint(["one", "two"]);
    f.writes.length = 0;

    term.paint(["one", "two"]);

    expect(f.writes).toHaveLength(0);
    term.close();
  });

  it("clears each repainted row so a shorter line leaves no tail behind", () => {
    const f = fakeTerminalIo();
    const term = createTerminal(f.input, f.output);
    term.paint(["a-very-long-line"]);
    f.writes.length = 0;

    term.paint(["short"]);

    expect(f.writes).toEqual(["\u001b[1;1H\u001b[2Kshort"]);
    term.close();
  });

  it("clears rows that disappear when the frame gets shorter", () => {
    const f = fakeTerminalIo();
    const term = createTerminal(f.input, f.output);
    term.paint(["one", "two", "three"]);
    f.writes.length = 0;

    term.paint(["one"]);

    expect(f.writes).toEqual(["\u001b[2;1H\u001b[2K\u001b[3;1H\u001b[2K"]);
    term.close();
  });

  it("resize invalidates the cache: clear screen, then the next paint redraws every row", () => {
    const f = fakeTerminalIo();
    const term = createTerminal(f.input, f.output);
    const sizes: Array<{ cols: number; rows: number }> = [];
    term.onResize((size) => sizes.push(size));
    term.paint(["one", "two"]);
    f.writes.length = 0;

    f.output.columns = 100;
    f.resize();
    term.paint(["one", "two"]);

    expect(sizes).toEqual([{ cols: 100, rows: 24 }]);
    expect(f.writes).toEqual(["\u001b[2J", "\u001b[1;1H\u001b[2Kone\u001b[2;1H\u001b[2Ktwo"]);
    term.close();
  });

  it("delivers decoded key data to listeners", () => {
    const f = fakeTerminalIo();
    const term = createTerminal(f.input, f.output);
    const keys: string[] = [];
    term.onKey((key) => keys.push(key));

    f.key(Buffer.from("\u001b[A", "utf8"));
    f.key("q");

    expect(keys).toEqual(["\u001b[A", "q"]);
    term.close();
  });

  it("enters raw mode, alt screen and hides the cursor, and restores all of it once on close", () => {
    const f = fakeTerminalIo();
    const term = createTerminal(f.input, f.output);
    expect(f.rawModeCalls).toEqual([true]);
    expect(f.writes).toEqual([ENTER_SEQUENCE]);
    expect(ENTER_SEQUENCE).toBe("\u001b[?1049h\u001b[?25l");

    term.close();
    term.close();

    expect(f.rawModeCalls).toEqual([true, false]);
    expect(f.dataListeners).toHaveLength(0);
    expect(f.resizeListeners).toHaveLength(0);
    expect(f.writes).toEqual([ENTER_SEQUENCE, RESTORE_SEQUENCE]);
    expect(RESTORE_SEQUENCE).toBe("\u001b[?25h\u001b[?1049l");
  });

  it("does not paint after close", () => {
    const f = fakeTerminalIo();
    const term = createTerminal(f.input, f.output);
    term.close();
    f.writes.length = 0;

    term.paint(["anything"]);

    expect(f.writes).toHaveLength(0);
  });

  it("leaves raw mode and the alt screen alone when not a TTY", () => {
    const f = fakeTerminalIo({ isTTY: false });
    const term = createTerminal(f.input, f.output);
    term.close();

    expect(f.rawModeCalls).toEqual([]);
    expect(f.writes).toEqual([]);
  });

  it("falls back to a default size when the stream reports none", () => {
    const f = fakeTerminalIo();
    f.output.columns = undefined;
    f.output.rows = undefined;
    const term = createTerminal(f.input, f.output);

    expect(term.size()).toEqual({ cols: 80, rows: 24 });
    term.close();
  });
});

describe("minimum terminal size", () => {
  it("is 40x10", () => {
    expect([MIN_COLS, MIN_ROWS]).toEqual([40, 10]);
    expect(isTooSmall({ cols: 40, rows: 10 })).toBe(false);
    expect(isTooSmall({ cols: 39, rows: 10 })).toBe(true);
    expect(isTooSmall({ cols: 40, rows: 9 })).toBe(true);
  });

  it("the too-small frame never exceeds the viewport", () => {
    for (const size of [
      { cols: 30, rows: 8 },
      { cols: 12, rows: 1 },
      { cols: 1, rows: 3 },
      { cols: 0, rows: 0 }
    ]) {
      const frame = tooSmallFrame(size);
      expect(frame.length).toBeLessThanOrEqual(size.rows);
      for (const line of frame) expect(visibleWidth(line)).toBeLessThanOrEqual(size.cols);
    }
    expect(tooSmallFrame({ cols: 30, rows: 8 })).toEqual(["terminal too small", "need 40x10, have 30x8"]);
  });
});
