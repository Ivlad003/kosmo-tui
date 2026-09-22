import { describe, expect, it } from "vitest";
import { graphemes, stripAnsi, visibleWidth } from "../src/ansi.js";
import { COLOR_TRUECOLOR, THEME, paint } from "../src/color.js";
import { wrapVisible } from "../src/wrap.js";

const FAMILY = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);

describe("wrapVisible", () => {
  it("wraps words by visible width", () => {
    expect(wrapVisible("alpha beta gamma delta", 11)).toEqual(["alpha beta", "gamma delta"]);
    expect(wrapVisible("short", 10)).toEqual(["short"]);
    expect(wrapVisible("a\nb", 10)).toEqual(["a", "b"]);
  });

  it("breaks long words at grapheme boundaries and never exceeds the width", () => {
    const text = `日本語日本語日本語 ${FAMILY}${FAMILY}${FAMILY}${FAMILY} ${paint("colored-word-that-is-long", { fg: THEME.accent }, COLOR_TRUECOLOR)}\tend`;
    const source = new Set(graphemes(stripAnsi(text)));
    source.add(" ");
    for (const width of [2, 3, 5, 7, 10, 40]) {
      const lines = wrapVisible(text, width);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        for (const cluster of graphemes(stripAnsi(line))) expect(source.has(cluster)).toBe(true);
      }
      expect(lines.map(stripAnsi).join("").replace(/ /g, "")).toBe(stripAnsi(text).replace(/[\t ]/g, ""));
    }
  });

  it("keeps every line within width 1 even for wide clusters", () => {
    for (const line of wrapVisible("日x", 1)) expect(visibleWidth(line)).toBeLessThanOrEqual(1);
  });
});
