import { describe, expect, it } from "vitest";
import { visibleWidth } from "../../src/ansi.js";
import { COLOR_NONE, COLOR_TRUECOLOR } from "../../src/color.js";
import { DEFAULT_PAINT_GUARD, createTerminal } from "../../src/terminal.js";
import { createPaintGuard } from "../../src/paint-guard.js";
import { replayScreen } from "../pty.js";
import { fakeTerminalIo } from "../terminal-fakes.js";

const ESC = "\u001b";
const HOSTILE = `span ${ESC}[2J${ESC}]0;owned\u0007 \u009b31m \u202eevil`;
const ESCAPED = "span \\u001b[2J\\u001b]0;owned\\u0007 \\u009b31m \\u202eevil";

/** Remove the sequences paint itself writes or lets through; nothing raw may be left. */
function withoutAllowed(written: string): string {
  return written
    .replace(/\u001b\[\d+;\d+H/g, "")
    .replace(/\u001b\[2K/g, "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\u001b\]8;;(?:file:\/\/\/repo\/[^\u0007\u001b]*)?\u001b\\/g, "");
}

describe("terminal.paint second layer (spec 8.2, Фокус рецензії 2)", () => {
  it("escapes CSI/OSC in a data row even without options (legacy callers)", () => {
    const f = fakeTerminalIo();
    const term = createTerminal(f.input, f.output);
    f.writes.length = 0;

    term.paint(["title", HOSTILE]);

    expect(f.writes).toEqual([`${ESC}[1;1H${ESC}[2Ktitle${ESC}[2;1H${ESC}[2K${ESCAPED}`]);
    expect(withoutAllowed(f.writes.join(""))).not.toMatch(/[\u001b\u009b\u202e]/);
    const screen = replayScreen(f.writes.join(""), 24);
    expect(screen[0]).toBe("title");
    expect(screen[1]).toBe(ESCAPED);
    term.close();
  });

  it("passes SGR and a validated OSC 8; the screen shows only the link text", () => {
    const f = fakeTerminalIo();
    const guard = createPaintGuard({ root: "/repo", links: true, color: COLOR_TRUECOLOR });
    const term = createTerminal(f.input, f.output, { guard });
    f.writes.length = 0;
    const linked = `${ESC}]8;;file:///repo/src/cart.ts${ESC}\\src/cart.ts:12${ESC}]8;;${ESC}\\`;
    const row = `${ESC}[1mcalculateLineTotal${ESC}[0m  ${linked}`;

    term.paint([row, `evil ${ESC}]8;;file:///etc/passwd${ESC}\\x${ESC}]8;;${ESC}\\`]);

    const written = f.writes.join("");
    expect(written).toContain(row);
    expect(written).not.toContain(`${ESC}]8;;file:///etc/passwd`);
    expect(withoutAllowed(written)).not.toMatch(/[\u001b\u009b\u202e]/);
    const screen = replayScreen(written, 24);
    expect(screen[0]).toBe("calculateLineTotal  src/cart.ts:12");
    expect(screen[1]).toBe("evil \\u001b]8;;file:///etc/passwd\\u001b\\x\\u001b]8;;\\u001b\\");
    term.close();
  });

  it("lowers colors with the guard's level", () => {
    const f = fakeTerminalIo();
    const term = createTerminal(f.input, f.output, {
      guard: createPaintGuard({ root: null, links: false, color: COLOR_NONE })
    });
    f.writes.length = 0;
    term.paint([`${ESC}[38;2;224;108;117mred${ESC}[0m`]);
    expect(f.writes).toEqual([`${ESC}[1;1H${ESC}[2Kred${ESC}[0m`]);
    term.close();
  });

  it("fits an escaped row to the width again, so it cannot wrap", () => {
    const f = fakeTerminalIo({ cols: 40 });
    const term = createTerminal(f.input, f.output);
    f.writes.length = 0;
    const row = `${"x".repeat(35)}${ESC}[2J${ESC}[2J`;

    term.paint([row]);

    const painted = f.writes.join("").replace(`${ESC}[1;1H${ESC}[2K`, "");
    expect(visibleWidth(painted)).toBeLessThanOrEqual(40);
    expect(painted.endsWith("…")).toBe(true);
    term.close();
  });

  it("diffs the guarded rows: an unchanged hostile row is not written again", () => {
    const f = fakeTerminalIo();
    const term = createTerminal(f.input, f.output);
    term.paint([HOSTILE]);
    f.writes.length = 0;
    term.paint([HOSTILE]);
    expect(f.writes).toEqual([]);
    term.close();
  });

  it("the default guard is exported for callers that build their own terminal", () => {
    expect(DEFAULT_PAINT_GUARD(`${ESC}[31mx${ESC}[0m`)).toBe(`${ESC}[31mx${ESC}[0m`);
    expect(DEFAULT_PAINT_GUARD(`${ESC}]8;;file:///repo/a${ESC}\\a${ESC}]8;;${ESC}\\`)).toContain("\\u001b]8;;");
  });
});
