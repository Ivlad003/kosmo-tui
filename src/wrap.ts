/**
 * Word wrap by visible width.
 *
 * Words are separated by spaces; a word wider than the line is broken at grapheme
 * boundaries. Escape sequences are carried along with the text they precede and cost
 * no columns. Tabs are expanded (relative to the start of the input) before wrapping.
 * Every returned line has visibleWidth <= width.
 */

import { clusterWidth, expandTabs, graphemes, tokenize, visibleWidth } from "./ansi.js";

type Unit = { text: string; width: number; space: boolean };

function units(input: string): Unit[] {
  const out: Unit[] = [];
  for (const token of tokenize(input)) {
    if (token.kind === "escape") {
      out.push({ text: token.text, width: 0, space: false });
      continue;
    }
    for (const cluster of graphemes(token.text)) {
      out.push({ text: cluster, width: clusterWidth(cluster), space: cluster === " " });
    }
  }
  return out;
}

export function wrapVisible(input: string, width: number): string[] {
  if (width <= 0) return [];
  const result: string[] = [];
  for (const paragraph of expandTabs(input).split("\n")) {
    result.push(...wrapParagraph(paragraph, width));
  }
  return result;
}

function wrapParagraph(paragraph: string, width: number): string[] {
  if (visibleWidth(paragraph) <= width) return [paragraph];
  // Group units into words (runs of non-space) and single spaces.
  const words: Unit[][] = [];
  let current: Unit[] = [];
  for (const unit of units(paragraph)) {
    if (unit.space) {
      if (current.length > 0) words.push(current);
      words.push([unit]);
      current = [];
    } else {
      current.push(unit);
    }
  }
  if (current.length > 0) words.push(current);

  const lines: string[] = [];
  let line = "";
  let used = 0;
  const pushLine = (): void => {
    lines.push(line.replace(/ +$/u, ""));
    line = "";
    used = 0;
  };
  for (const word of words) {
    const w = word.reduce((sum, unit) => sum + unit.width, 0);
    const isSpace = word.length === 1 && word[0]!.space;
    if (isSpace) {
      if (used === 0) continue;
      if (used + 1 > width) {
        pushLine();
        continue;
      }
      line += " ";
      used += 1;
      continue;
    }
    if (used + w <= width) {
      line += word.map((unit) => unit.text).join("");
      used += w;
      continue;
    }
    if (w <= width) {
      pushLine();
      line = word.map((unit) => unit.text).join("");
      used = w;
      continue;
    }
    // Longer than a whole line: break at cluster boundaries.
    for (const unit of word) {
      // A cluster wider than the whole line (wide char at width 1) is shown as "?".
      const fitted = unit.width > width ? { ...unit, text: "?", width: 1 } : unit;
      if (used + fitted.width > width) pushLine();
      line += fitted.text;
      used += fitted.width;
    }
  }
  if (line.length > 0 || lines.length === 0) pushLine();
  return lines;
}
