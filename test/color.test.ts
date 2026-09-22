import { describe, expect, it } from "vitest";
import { CURSOR, stripAnsi, tokenize, visibleWidth } from "../src/ansi.js";
import {
  COLOR_16,
  COLOR_NONE,
  COLOR_TRUECOLOR,
  THEME,
  adaptSgr,
  detectColorLevel,
  linksEnabled,
  paint,
  sourceLink
} from "../src/color.js";

const COLOR_PARAM = /\u001b\[[\d;]*(?:(?:^|;)(?:3\d|4\d|9[0-7]|10[0-7]|38;[25]|48;[25]))[\d;]*m/;

function sgrParams(text: string): number[][] {
  return tokenize(text)
    .filter((t) => t.kind === "escape" && /^\u001b\[[\d;]*m$/.test(t.text))
    .map((t) => t.text.slice(2, -1).split(";").map(Number));
}

describe("detectColorLevel", () => {
  const tty = true;
  it("follows NO_COLOR, FORCE_COLOR, TTY, TERM and COLORTERM", () => {
    expect(detectColorLevel({ NO_COLOR: "1", COLORTERM: "truecolor", TERM: "xterm" }, tty)).toBe(COLOR_NONE);
    expect(detectColorLevel({ NO_COLOR: "", TERM: "xterm-256color" }, tty)).toBe(COLOR_16); // empty NO_COLOR ignored
    expect(detectColorLevel({ NO_COLOR: "1", FORCE_COLOR: "3" }, tty)).toBe(COLOR_NONE);
    expect(detectColorLevel({ FORCE_COLOR: "0", COLORTERM: "truecolor" }, tty)).toBe(COLOR_NONE);
    expect(detectColorLevel({ FORCE_COLOR: "1" }, false)).toBe(COLOR_16);
    expect(detectColorLevel({ FORCE_COLOR: "3" }, false)).toBe(COLOR_TRUECOLOR);
    expect(detectColorLevel({ TERM: "xterm-256color", COLORTERM: "truecolor" }, false)).toBe(COLOR_NONE);
    expect(detectColorLevel({ TERM: "dumb", COLORTERM: "truecolor" }, tty)).toBe(COLOR_NONE);
    expect(detectColorLevel({ TERM: "xterm-256color", COLORTERM: "24bit" }, tty)).toBe(COLOR_TRUECOLOR);
    expect(detectColorLevel({ TERM: "xterm-direct" }, tty)).toBe(COLOR_TRUECOLOR);
    expect(detectColorLevel({ TERM: "xterm-256color" }, tty)).toBe(COLOR_16);
    expect(detectColorLevel({}, tty)).toBe(COLOR_NONE);
    expect(detectColorLevel({}, tty, "win32")).toBe(COLOR_16);
  });
});

describe("paint", () => {
  it("emits truecolor, 16-color or attribute-only SGR", () => {
    expect(paint("x", { fg: THEME.error }, COLOR_TRUECOLOR)).toBe("\u001b[38;2;224;108;117mx\u001b[0m");
    expect(paint("x", { fg: THEME.error }, COLOR_16)).toBe("\u001b[91mx\u001b[0m");
    expect(paint("x", { fg: THEME.error }, COLOR_NONE)).toBe("x");
    expect(paint("x", { fg: THEME.error, inverse: true }, COLOR_NONE)).toBe("\u001b[7mx\u001b[0m");
  });
});

describe("adaptSgr / NO_COLOR", () => {
  const frame =
    CURSOR.altScreenOn +
    CURSOR.hide +
    CURSOR.moveTo(1, 1) +
    CURSOR.clearLine +
    paint("GET /cart", { fg: THEME.accent, bold: true }, COLOR_TRUECOLOR) +
    " " +
    "\u001b[48;5;236m\u001b[31mred on grey\u001b[0m" +
    CURSOR.moveTo(2, 1) +
    paint("selected", { fg: THEME.ok, inverse: true }, COLOR_TRUECOLOR) +
    "\u001b]8;;file:///repo/a.ts\u001b\\a.ts\u001b]8;;\u001b\\" +
    CURSOR.show;

  it("removes every color parameter at level 0", () => {
    const out = adaptSgr(frame, COLOR_NONE);
    expect(out).not.toMatch(COLOR_PARAM);
    for (const params of sgrParams(out)) {
      for (const p of params) expect([0, 1, 2, 4, 7]).toContain(p);
    }
  });

  it("keeps cursor control, alt screen, attributes and OSC 8 at level 0", () => {
    const out = adaptSgr(frame, COLOR_NONE);
    for (const seq of [
      CURSOR.altScreenOn,
      CURSOR.hide,
      CURSOR.moveTo(1, 1),
      CURSOR.clearLine,
      CURSOR.moveTo(2, 1),
      CURSOR.show
    ]) {
      expect(out).toContain(seq);
    }
    expect(out).toContain("\u001b[1m");
    expect(out).toContain("\u001b[7m");
    expect(out).toContain("\u001b]8;;file:///repo/a.ts\u001b\\");
    expect(stripAnsi(out)).toBe(stripAnsi(frame));
    expect(visibleWidth(out)).toBe(visibleWidth(frame));
  });

  it("downgrades truecolor to the nearest basic color at level 16", () => {
    const out = adaptSgr(frame, COLOR_16);
    expect(out).not.toMatch(/38;2;|48;5;/);
    const colors = sgrParams(out)
      .flat()
      .filter((p) => (p >= 30 && p <= 49) || (p >= 90 && p <= 107));
    expect(colors.length).toBeGreaterThan(0);
    expect(adaptSgr(frame, COLOR_TRUECOLOR)).toBe(frame);
  });
});

describe("OSC 8 links", () => {
  it("are opt-in through KOSMO_TUI_LINKS=1 only", () => {
    expect(linksEnabled({})).toBe(false);
    expect(linksEnabled({ KOSMO_TUI_LINKS: "true" })).toBe(false);
    expect(linksEnabled({ KOSMO_TUI_LINKS: "0" })).toBe(false);
    expect(linksEnabled({ KOSMO_TUI_LINKS: "1" })).toBe(true);
  });

  it("always shows the relative fallback text", () => {
    const uri = "file:///home/me/repo/src/cart.ts";
    expect(sourceLink("src/cart.ts", uri, {})).toBe("src/cart.ts");
    const linked = sourceLink("src/cart.ts", uri, { KOSMO_TUI_LINKS: "1" });
    expect(linked).toBe(`\u001b]8;;${uri}\u001b\\src/cart.ts\u001b]8;;\u001b\\`);
    expect(stripAnsi(linked)).toBe("src/cart.ts");
    expect(visibleWidth(linked)).toBe("src/cart.ts".length);
    expect(sourceLink("src/cart.ts", undefined, { KOSMO_TUI_LINKS: "1" })).toBe("src/cart.ts");
    expect(stripAnsi(adaptSgr(linked, COLOR_NONE))).toBe("src/cart.ts");
  });

  it("never emits a URI carrying control characters", () => {
    expect(sourceLink("a.ts", "file:///a\u001b]0;pwn\u0007", { KOSMO_TUI_LINKS: "1" })).toBe("a.ts");
  });
});
