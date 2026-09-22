import { describe, expect, it } from "vitest";
import {
  CSI,
  CURSOR,
  ELLIPSIS,
  clusterWidth,
  expandTabs,
  graphemes,
  padVisible,
  stripAnsi,
  tokenize,
  truncateVisible,
  visibleWidth
} from "../src/ansi.js";
import { COLOR_NONE, COLOR_TRUECOLOR, THEME, adaptSgr, paint } from "../src/color.js";

const cp = (...points: number[]): string => String.fromCodePoint(...points);
const E_ACUTE = cp(0x65, 0x301); // e + combining acute
const FAMILY = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466);
const FLAG_UA = cp(0x1f1fa, 0x1f1e6);
const HEART_VS16 = cp(0x2764, 0xfe0f);
const THUMBS_TONE = cp(0x1f44d, 0x1f3fd);
const CJK = "日本語";

describe("clusterWidth", () => {
  it("measures one grapheme cluster", () => {
    expect(clusterWidth("a")).toBe(1);
    expect(clusterWidth("日")).toBe(2);
    expect(clusterWidth("한")).toBe(2);
    expect(clusterWidth("Ａ")).toBe(2); // fullwidth A
    expect(clusterWidth(E_ACUTE)).toBe(1);
    expect(clusterWidth(cp(0x301))).toBe(0); // lone combining mark
    expect(clusterWidth(cp(0x200b))).toBe(0); // zero width space
    expect(clusterWidth(FAMILY)).toBe(2);
    expect(clusterWidth(FLAG_UA)).toBe(2);
    expect(clusterWidth(HEART_VS16)).toBe(2);
    expect(clusterWidth(THUMBS_TONE)).toBe(2);
    expect(clusterWidth(cp(0x1f600))).toBe(2);
    expect(clusterWidth(cp(0x2764))).toBe(1); // text-presentation heart
  });

  it("keeps ZWJ sequences, flags and combining marks as single clusters", () => {
    expect(graphemes(`${FAMILY}${FLAG_UA}${E_ACUTE}`)).toEqual([FAMILY, FLAG_UA, E_ACUTE]);
  });
});

describe("visibleWidth", () => {
  it("ignores SGR, cursor and OSC sequences", () => {
    const colored = paint(CJK, { fg: THEME.error, bold: true }, COLOR_TRUECOLOR);
    expect(colored).not.toBe(CJK);
    expect(visibleWidth(colored)).toBe(6);
    expect(visibleWidth(`${CURSOR.moveTo(3, 4)}${CURSOR.hide}ab`)).toBe(2);
    expect(visibleWidth("\u001b]8;;file:///x\u001b\\rel/x.ts\u001b]8;;\u001b\\")).toBe(8);
  });

  it("expands tabs to the next stop of 8", () => {
    expect(visibleWidth("\t")).toBe(8);
    expect(visibleWidth("ab\tc")).toBe(9);
    expect(visibleWidth("\t", 3)).toBe(5);
    expect(visibleWidth("日\tx")).toBe(9);
    expect(expandTabs("ab\tc")).toBe("ab      c");
  });

  it("counts mixed content", () => {
    expect(visibleWidth(`${CJK} ${E_ACUTE} ${FAMILY}`)).toBe(6 + 1 + 1 + 1 + 2);
  });
});

describe("truncateVisible", () => {
  it("returns short text unchanged (tabs expanded)", () => {
    expect(truncateVisible("abc", 10)).toBe("abc");
    expect(truncateVisible("a\tb", 20)).toBe("a       b");
  });

  it("drops a wide cluster whole instead of splitting it", () => {
    expect(truncateVisible(CJK, 5)).toBe(`日本${ELLIPSIS}`);
    expect(truncateVisible(CJK, 4)).toBe(`日${ELLIPSIS}`);
    expect(truncateVisible(CJK, 1)).toBe(ELLIPSIS);
    expect(truncateVisible(CJK, 0)).toBe("");
  });

  it("never splits ZWJ/flag/combining clusters and never exceeds the width", () => {
    const text = `${FAMILY}${E_ACUTE}${FLAG_UA}${CJK}${THUMBS_TONE}x${E_ACUTE}${FAMILY}`;
    const allowed = new Set([...graphemes(text), ELLIPSIS]);
    for (let width = 0; width <= visibleWidth(text) + 2; width += 1) {
      const out = truncateVisible(text, width);
      expect(visibleWidth(out)).toBeLessThanOrEqual(width);
      for (const cluster of graphemes(stripAnsi(out))) expect(allowed.has(cluster)).toBe(true);
    }
  });

  it("keeps escape sequences whole and resets style after a cut", () => {
    const line = `${paint("error:", { fg: THEME.error }, COLOR_TRUECOLOR)} ${paint("日本語のテキスト", { bold: true }, COLOR_TRUECOLOR)}`;
    for (let width = 1; width < visibleWidth(line); width += 1) {
      const out = truncateVisible(line, width);
      expect(visibleWidth(out)).toBeLessThanOrEqual(width);
      for (const token of tokenize(out)) {
        if (token.kind === "escape") expect(token.text).toMatch(/^\u001b\[[\d;]*m$/);
      }
      expect(out.endsWith(`${CSI}0m`)).toBe(true);
    }
  });

  it("closes an OSC 8 hyperlink that was cut open", () => {
    const link = "\u001b]8;;file:///repo/src/cart.ts\u001b\\src/cart.ts\u001b]8;;\u001b\\";
    const out = truncateVisible(link, 6);
    expect(stripAnsi(out)).toBe(`src/c${ELLIPSIS}`);
    expect(out.endsWith("\u001b]8;;\u001b\\")).toBe(true);
  });

  it("padVisible fills to the exact width", () => {
    expect(visibleWidth(padVisible(CJK, 9))).toBe(9);
    expect(visibleWidth(padVisible(CJK, 5))).toBe(5);
  });
});

describe("scenario: width parity at 60 columns", () => {
  it("does not break graphemes, stays in the viewport and NO_COLOR keeps the layout", () => {
    const cells = [CJK, E_ACUTE, FAMILY, "request GET /cart", HEART_VS16, "\tseq=20"];
    const colored = Array.from({ length: 6 }, (_, i) =>
      cells
        .map((cell, j) =>
          paint(cell, { fg: j % 2 === 0 ? THEME.accent : THEME.warn, inverse: i === 2 }, COLOR_TRUECOLOR)
        )
        .join(" ")
    );
    const allowed = new Set([...cells.flatMap((cell) => graphemes(expandTabs(cell))), " ", ELLIPSIS]);
    for (const line of colored) {
      const out = truncateVisible(line, 60);
      const plain = truncateVisible(adaptSgr(line, COLOR_NONE), 60);
      expect(visibleWidth(out)).toBeLessThanOrEqual(60);
      expect(visibleWidth(plain)).toBeLessThanOrEqual(60);
      expect(stripAnsi(plain)).toBe(stripAnsi(out));
      for (const cluster of graphemes(stripAnsi(out))) expect(allowed.has(cluster)).toBe(true);
    }
  });
});
