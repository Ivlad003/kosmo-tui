import { describe, expect, it } from "vitest";
import { COLOR_16, COLOR_NONE, COLOR_TRUECOLOR } from "../src/color.js";
import { createPaintGuard, guardRow, paintGuardFromEnv, type PaintGuardOptions } from "../src/paint-guard.js";

const ESC = "\u001b";
const ROOT = "/repo";
const ON: PaintGuardOptions = { root: ROOT, links: true, color: COLOR_TRUECOLOR };
const OFF: PaintGuardOptions = { root: ROOT, links: false, color: COLOR_TRUECOLOR };
const link = (uri: string, text: string, end = `${ESC}\\`) => `${ESC}]8;;${uri}${end}${text}${ESC}]8;;${end}`;
const RAW_CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

describe("guardRow: what passes (spec 8.2)", () => {
  it("leaves plain text and SGR alone", () => {
    expect(guardRow("plain row · ✓ 中文", ON)).toBe("plain row · ✓ 中文");
    const styled = `${ESC}[1;38;2;97;175;239mGET /cart${ESC}[0m`;
    expect(guardRow(styled, ON)).toBe(styled);
  });

  it("keeps an OSC 8 link inside the root when links are on", () => {
    const row = `at ${link("file:///repo/src/cart.ts", "src/cart.ts:12")} here`;
    expect(guardRow(row, ON)).toBe(row);
  });

  it("normalises a BEL-terminated OSC 8 to ST", () => {
    expect(guardRow(link("file:///repo/a.ts", "a.ts", "\u0007"), ON)).toBe(link("file:///repo/a.ts", "a.ts"));
  });
});

describe("guardRow: everything else is escaped (Фокус рецензії 2)", () => {
  it("escapes CSI, OSC title/clipboard, two-byte ESC, C1, bidi, stray C0 and DEL in a data row", () => {
    const row =
      `name ${ESC}[2J ${ESC}]0;pwned\u0007 ${ESC}]52;c;ZXZpbA==${ESC}\\ ${ESC}c ${ESC}[?1049l` +
      ` \u009b31m \u202eevil\u202c \r\b\u007f`;
    const out = guardRow(row, ON);
    expect(out).toBe(
      "name \\u001b[2J \\u001b]0;pwned\\u0007 \\u001b]52;c;ZXZpbA==\\u001b\\ \\u001bc \\u001b[?1049l" +
        " \\u009b31m \\u202eevil\\u202c \\u000d\\u0008\\u007f"
    );
    expect(out).not.toMatch(RAW_CONTROL);
  });

  it("escapes OSC 8 when links are off, outside the root, not file://, or without a root", () => {
    const inside = link("file:///repo/src/cart.ts", "cart");
    for (const [row, options] of [
      [inside, OFF],
      [link("file:///etc/passwd", "cart"), ON],
      [link("file:///repo/../etc/passwd", "cart"), ON],
      [link("https://evil.example/x", "cart"), ON],
      [link("file:///repo/a\u202e.ts", "cart"), ON],
      [inside, { ...ON, root: null }]
    ] as const) {
      const out = guardRow(row, options);
      expect(out).not.toMatch(RAW_CONTROL);
      expect(out).toContain("\\u001b]8;;");
      expect(out).toContain("cart");
    }
  });

  it("escapes an unterminated OSC and an SGR with sub-parameters", () => {
    expect(guardRow(`a${ESC}]8;;file:///repo/x`, ON)).toBe("a\\u001b]8;;file:///repo/x");
    expect(guardRow(`${ESC}[38:2::1:2:3mx`, ON)).toBe("\\u001b[38:2::1:2:3mx");
  });

  it("escapes a close without an opener and closes a link or style left open", () => {
    expect(guardRow(`x${ESC}]8;;${ESC}\\`, ON)).toBe("x\\u001b]8;;\\u001b\\");
    expect(guardRow(`${ESC}]8;;file:///repo/a.ts${ESC}\\a.ts`, ON)).toBe(link("file:///repo/a.ts", "a.ts"));
    expect(guardRow(`${ESC}[1mbold`, ON)).toBe(`${ESC}[1mbold${ESC}[0m`);
    expect(guardRow(`${ESC}[1mbold${ESC}[0m`, ON)).toBe(`${ESC}[1mbold${ESC}[0m`);
  });
});

describe("guardRow: colors through adaptSgr", () => {
  const row = `${ESC}[1;38;2;224;108;117merror${ESC}[0m`;

  it("removes colors but keeps attributes at level 0 (NO_COLOR)", () => {
    expect(guardRow(row, { ...ON, color: COLOR_NONE })).toBe(`${ESC}[1merror${ESC}[0m`);
  });

  it("lowers truecolor to 16 colors", () => {
    expect(guardRow(row, { ...ON, color: COLOR_16 })).toBe(`${ESC}[1;91merror${ESC}[0m`);
  });
});

describe("createPaintGuard / paintGuardFromEnv", () => {
  it("reads the options on every row when given a function (the root can change)", () => {
    let root: string | null = null;
    const guard = createPaintGuard(() => ({ root, links: true, color: COLOR_TRUECOLOR }));
    const row = link("file:///repo/a.ts", "a.ts");
    expect(guard(row)).not.toBe(row);
    root = ROOT;
    expect(guard(row)).toBe(row);
  });

  it("takes links from KOSMO_TUI_LINKS=1 and colors from detectColorLevel", () => {
    const row = `${ESC}[38;2;224;108;117m${link("file:///repo/a.ts", "a.ts")}${ESC}[0m`;
    const linked = paintGuardFromEnv({
      env: { KOSMO_TUI_LINKS: "1", COLORTERM: "truecolor", TERM: "xterm" },
      isTTY: true,
      root: () => ROOT
    });
    expect(linked(row)).toBe(row);
    const plain = paintGuardFromEnv({ env: { NO_COLOR: "1", TERM: "xterm" }, isTTY: true, root: () => ROOT });
    expect(plain(row)).toBe(`\\u001b]8;;file:///repo/a.ts\\u001b\\a.ts\\u001b]8;;\\u001b\\${ESC}[0m`);
  });
});
