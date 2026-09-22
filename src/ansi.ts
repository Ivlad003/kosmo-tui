/**
 * Terminal text primitives: escape-sequence aware, grapheme-cluster aware width.
 *
 * Width is measured per extended grapheme cluster (Intl.Segmenter), never per code
 * unit or code point, so a family emoji, a flag, `é` written as `e` + U+0301, or a CJK
 * ideograph is always one indivisible unit. Escape sequences (CSI such as SGR/cursor
 * moves, OSC such as OSC 8 hyperlinks) have zero width and are never split.
 */

export const ESC = "\u001b";
export const CSI = `${ESC}[`;
export const OSC = `${ESC}]`;
/** String terminator used for OSC sequences we emit. */
export const ST = `${ESC}\\`;
export const SGR_RESET = `${CSI}0m`;
export const TAB_STOP = 8;

/** Cursor-control sequences. They are not color and survive NO_COLOR (see color.ts). */
export const CURSOR = {
  hide: `${CSI}?25l`,
  show: `${CSI}?25h`,
  home: `${CSI}H`,
  altScreenOn: `${CSI}?1049h`,
  altScreenOff: `${CSI}?1049l`,
  clearScreen: `${CSI}2J`,
  clearLine: `${CSI}2K`,
  moveTo: (row: number, col: number): string => `${CSI}${row};${col}H`
} as const;

export type Token = { kind: "escape"; text: string } | { kind: "text"; text: string };

/**
 * Split a string into escape sequences and plain text.
 *
 * Recognised: CSI (`ESC [` params intermediates final byte), OSC (`ESC ]` … BEL or
 * `ESC \`), and two-byte `ESC x`. An unterminated sequence is kept as one escape token
 * to the end of the string, so it is never measured as text or cut in half.
 */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let text = "";
  let i = 0;
  const flush = (): void => {
    if (text.length > 0) tokens.push({ kind: "text", text });
    text = "";
  };
  while (i < input.length) {
    const ch = input[i];
    if (ch !== ESC) {
      text += ch;
      i += 1;
      continue;
    }
    flush();
    const next = input[i + 1];
    let end: number;
    if (next === "[") {
      end = i + 2;
      while (end < input.length) {
        const code = input.charCodeAt(end);
        end += 1;
        if (code >= 0x40 && code <= 0x7e) break;
      }
    } else if (next === "]") {
      end = input.length;
      for (let j = i + 2; j < input.length; j += 1) {
        if (input[j] === "\u0007") {
          end = j + 1;
          break;
        }
        if (input[j] === ESC && input[j + 1] === "\\") {
          end = j + 2;
          break;
        }
      }
    } else {
      end = Math.min(input.length, i + 2);
    }
    tokens.push({ kind: "escape", text: input.slice(i, end) });
    i = end;
  }
  flush();
  return tokens;
}

/** Remove every escape sequence; what is left is what the terminal would show. */
export function stripAnsi(input: string): string {
  return tokenize(input)
    .filter((token) => token.kind === "text")
    .map((token) => token.text)
    .join("");
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Extended grapheme clusters of plain text. */
export function graphemes(text: string): string[] {
  const out: string[] = [];
  for (const { segment } of segmenter.segment(text)) out.push(segment);
  return out;
}

// East Asian Wide / Fullwidth ranges (UAX #11), compact and sorted.
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18cff],
  [0x1b000, 0x1b2ff],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f251],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd]
];

function isWideCodePoint(cp: number): boolean {
  let lo = 0;
  let hi = WIDE_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = WIDE_RANGES[mid]!;
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

const ZERO_WIDTH = /^[\p{Mark}\p{Default_Ignorable_Code_Point}\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]+$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const REGIONAL_INDICATOR = /\p{Regional_Indicator}/u;

/**
 * Columns one grapheme cluster occupies: 0, 1 or 2.
 *
 * - combining marks / zero-width joiners on their own: 0
 * - C0/C1 controls: 0 (callers are expected to escape them; tabs are handled by
 *   {@link visibleWidth} because their width depends on the column)
 * - emoji presentation, ZWJ sequences, VS16 emoji, flags: 2
 * - East Asian Wide/Fullwidth base (CJK, Hangul, fullwidth forms): 2
 * - everything else: 1; a base with combining marks keeps the base width
 */
export function clusterWidth(cluster: string): number {
  if (cluster.length === 0) return 0;
  if (ZERO_WIDTH.test(cluster)) return 0;
  if (CONTROL.test(cluster)) return 0;
  if (REGIONAL_INDICATOR.test(cluster)) return 2;
  if (PICTOGRAPHIC.test(cluster)) {
    if (cluster.includes("\u200d") || cluster.includes("\ufe0f") || /\p{Emoji_Presentation}/u.test(cluster)) return 2;
    if (/[\u{1f3fb}-\u{1f3ff}]/u.test(cluster)) return 2;
  }
  const base = cluster.codePointAt(0)!;
  if (/\p{Emoji_Presentation}/u.test(String.fromCodePoint(base))) return 2;
  return isWideCodePoint(base) ? 2 : 1;
}

/** Columns a tab occupies when it starts at `column`: up to the next stop of 8. */
export function tabWidth(column: number): number {
  return TAB_STOP - (column % TAB_STOP);
}

/**
 * Visible width in terminal columns, ignoring escape sequences.
 * `startColumn` matters only for tabs.
 */
export function visibleWidth(input: string, startColumn = 0): number {
  let column = startColumn;
  for (const token of tokenize(input)) {
    if (token.kind === "escape") continue;
    for (const cluster of graphemes(token.text)) {
      column += cluster === "\t" ? tabWidth(column) : clusterWidth(cluster);
    }
  }
  return column - startColumn;
}

/** Replace tabs with spaces up to the next stop of 8, keeping escapes in place. */
export function expandTabs(input: string, startColumn = 0): string {
  let column = startColumn;
  let out = "";
  for (const token of tokenize(input)) {
    if (token.kind === "escape") {
      out += token.text;
      continue;
    }
    for (const cluster of graphemes(token.text)) {
      if (cluster === "\t") {
        const w = tabWidth(column);
        out += " ".repeat(w);
        column += w;
      } else {
        out += cluster;
        column += clusterWidth(cluster);
      }
    }
  }
  return out;
}

export const ELLIPSIS = "\u2026";

/**
 * Cut `input` so its visible width is at most `width` columns.
 *
 * Never splits a grapheme cluster or an escape sequence: a wide cluster that would
 * straddle the edge is dropped whole. When text is cut, `ellipsis` (default `…`) is
 * placed within the budget, and an SGR reset is appended if any SGR was emitted so a
 * cut style cannot bleed into the next cell. Tabs are expanded to spaces, because a
 * truncated line must not depend on where the terminal puts tab stops.
 */
export function truncateVisible(input: string, width: number, ellipsis: string = ELLIPSIS): string {
  if (width <= 0) return "";
  const expanded = expandTabs(input);
  if (visibleWidth(expanded) <= width) return expanded;
  const ellipsisWidth = visibleWidth(ellipsis);
  const marker = ellipsisWidth <= width ? ellipsis : "";
  const budget = width - (marker ? ellipsisWidth : 0);
  let out = "";
  let used = 0;
  let sawSgr = false;
  let full = false;
  for (const token of tokenize(expanded)) {
    if (token.kind === "escape") {
      // Escapes after the cut point are dropped except to keep hyperlinks balanced;
      // we simply stop emitting once the budget is spent and close styles below.
      if (full) continue;
      if (token.text.startsWith(CSI) && token.text.endsWith("m")) sawSgr = true;
      out += token.text;
      continue;
    }
    if (full) continue;
    for (const cluster of graphemes(token.text)) {
      const w = clusterWidth(cluster);
      if (used + w > budget) {
        full = true;
        break;
      }
      out += cluster;
      used += w;
    }
  }
  out += marker;
  if (openHyperlink(out)) out += `${OSC}8;;${ST}`;
  if (sawSgr) out += SGR_RESET;
  return out;
}

/** True when the last OSC 8 in `text` opens a link that was never closed. */
function openHyperlink(text: string): boolean {
  let open = false;
  for (const token of tokenize(text)) {
    if (token.kind !== "escape" || !token.text.startsWith(`${OSC}8;`)) continue;
    const body = token.text.replace(/^\u001b\]8;[^;]*;/, "").replace(/(\u0007|\u001b\\)$/, "");
    open = body.length > 0;
  }
  return open;
}

/** Pad with spaces on the right to exactly `width` columns (truncating first). */
export function padVisible(input: string, width: number): string {
  const cut = truncateVisible(input, width);
  const missing = width - visibleWidth(cut);
  return missing > 0 ? cut + " ".repeat(missing) : cut;
}
