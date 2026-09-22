/**
 * Color level detection and SGR adaptation.
 *
 * Three levels: 0 (no color), 16 (basic ANSI) and truecolor (24-bit). The theme is
 * written in RGB with a 16-color fallback; {@link adaptSgr} lowers or removes color
 * parameters in an already-rendered frame, so the same renderer serves every level.
 *
 * NO_COLOR removes COLOR only. Cursor movement, alternate screen, erase and non-color
 * attributes (bold, inverse, underline) stay, because an interactive TTY session cannot
 * be drawn without them and inverse is how the selection stays visible without color.
 */

import { CSI, OSC, ST, tokenize } from "./ansi.js";

export const COLOR_NONE = 0;
export const COLOR_16 = 16;
export const COLOR_TRUECOLOR = 16_777_216;
export type ColorLevel = typeof COLOR_NONE | typeof COLOR_16 | typeof COLOR_TRUECOLOR;

export type ColorEnv = Readonly<Record<string, string | undefined>>;

/**
 * Decide the color level.
 *
 * Order: NO_COLOR (non-empty) → 0; FORCE_COLOR → its level even without a TTY;
 * no TTY → 0; TERM=dumb → 0; COLORTERM truecolor/24bit or TERM *-direct/truecolor →
 * truecolor; any other TERM (or win32 console) → 16; no TERM → 0.
 * NO_COLOR wins over FORCE_COLOR: an explicit request for no color is never overridden.
 */
export function detectColorLevel(env: ColorEnv, isTty: boolean, platform: string = "linux"): ColorLevel {
  const noColor = env.NO_COLOR;
  if (noColor !== undefined && noColor !== "") return COLOR_NONE;
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    const value = force.trim().toLowerCase();
    if (value === "0" || value === "false") return COLOR_NONE;
    if (value === "3") return COLOR_TRUECOLOR;
    return COLOR_16;
  }
  if (!isTty) return COLOR_NONE;
  const term = (env.TERM ?? "").toLowerCase();
  if (term === "dumb") return COLOR_NONE;
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return COLOR_TRUECOLOR;
  if (term.includes("truecolor") || term.includes("24bit") || term.endsWith("-direct")) return COLOR_TRUECOLOR;
  if (term !== "") return COLOR_16;
  return platform === "win32" ? COLOR_16 : COLOR_NONE;
}

export type Rgb = readonly [number, number, number];
/** A theme color: RGB for truecolor, one of the 16 SGR foreground codes as fallback. */
export type ThemeColor = { rgb: Rgb; ansi16: number };

export const THEME = {
  accent: { rgb: [97, 175, 239], ansi16: 94 },
  muted: { rgb: [128, 128, 128], ansi16: 90 },
  error: { rgb: [224, 108, 117], ansi16: 91 },
  ok: { rgb: [152, 195, 121], ansi16: 92 },
  warn: { rgb: [229, 192, 123], ansi16: 93 },
  kind: { rgb: [198, 120, 221], ansi16: 95 }
} as const satisfies Record<string, ThemeColor>;

export type Style = { fg?: ThemeColor; bold?: boolean; dim?: boolean; underline?: boolean; inverse?: boolean };

/** Wrap `text` in SGR for `style` at `level`. Non-color attributes are kept at level 0. */
export function paint(text: string, style: Style, level: ColorLevel): string {
  const params: string[] = [];
  if (style.bold) params.push("1");
  if (style.dim) params.push("2");
  if (style.underline) params.push("4");
  if (style.inverse) params.push("7");
  if (style.fg && level === COLOR_TRUECOLOR) params.push(`38;2;${style.fg.rgb.join(";")}`);
  else if (style.fg && level === COLOR_16) params.push(String(style.fg.ansi16));
  if (params.length === 0) return text;
  return `${CSI}${params.join(";")}m${text}${CSI}0m`;
}

/** Nearest of the 16 basic foreground (or background, `base` 40) colors. */
function nearest16(rgb: Rgb, background: boolean): number {
  const palette: Rgb[] = [
    [0, 0, 0],
    [205, 49, 49],
    [13, 188, 121],
    [229, 229, 16],
    [36, 114, 200],
    [188, 63, 188],
    [17, 168, 205],
    [229, 229, 229],
    [102, 102, 102],
    [241, 76, 76],
    [35, 209, 139],
    [245, 245, 67],
    [59, 142, 234],
    [214, 112, 214],
    [41, 184, 219],
    [255, 255, 255]
  ];
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  palette.forEach((candidate, index) => {
    const d = (candidate[0] - rgb[0]) ** 2 + (candidate[1] - rgb[1]) ** 2 + (candidate[2] - rgb[2]) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = index;
    }
  });
  const offset = background ? 40 : 30;
  return best < 8 ? offset + best : offset + 60 + (best - 8);
}

/** RGB of an xterm 256-palette index (16 system colors approximated by the cube). */
function xterm256ToRgb(index: number): Rgb {
  if (index >= 232) {
    const v = 8 + (index - 232) * 10;
    return [v, v, v];
  }
  if (index >= 16) {
    const n = index - 16;
    const level = (c: number): number => (c === 0 ? 0 : 55 + c * 40);
    return [level(Math.floor(n / 36)), level(Math.floor(n / 6) % 6), level(n % 6)];
  }
  const basic: Rgb[] = [
    [0, 0, 0],
    [205, 0, 0],
    [0, 205, 0],
    [205, 205, 0],
    [0, 0, 238],
    [205, 0, 205],
    [0, 205, 205],
    [229, 229, 229],
    [127, 127, 127],
    [255, 0, 0],
    [0, 255, 0],
    [255, 255, 0],
    [92, 92, 255],
    [255, 0, 255],
    [0, 255, 255],
    [255, 255, 255]
  ];
  return basic[index] ?? [0, 0, 0];
}

function adaptSgrParams(params: number[], level: ColorLevel): number[] {
  const out: number[] = [];
  for (let i = 0; i < params.length; i += 1) {
    const p = params[i]!;
    if (p === 38 || p === 48) {
      const mode = params[i + 1];
      const background = p === 48;
      if (mode === 2) {
        const rgb: Rgb = [params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0];
        if (level === COLOR_TRUECOLOR) out.push(p, 2, ...rgb);
        else if (level === COLOR_16) out.push(nearest16(rgb, background));
        i += 4;
      } else if (mode === 5) {
        const index = params[i + 2] ?? 0;
        if (level === COLOR_TRUECOLOR) out.push(p, 5, index);
        else if (level === COLOR_16) out.push(nearest16(xterm256ToRgb(index), background));
        i += 2;
      }
      continue;
    }
    const isColor = (p >= 30 && p <= 39) || (p >= 40 && p <= 49) || (p >= 90 && p <= 97) || (p >= 100 && p <= 107);
    if (isColor && level === COLOR_NONE) continue;
    out.push(p);
  }
  return out;
}

/**
 * Lower the color depth of every SGR sequence in `frame` to `level`.
 *
 * At level 0 color parameters are removed (an SGR left without parameters is dropped
 * entirely, except an explicit reset `0`); every non-SGR sequence — cursor moves,
 * erase, alt screen, OSC 8 — is passed through untouched, so the text layout and
 * the cursor behaviour are identical at every level.
 */
export function adaptSgr(frame: string, level: ColorLevel): string {
  if (level === COLOR_TRUECOLOR) return frame;
  let out = "";
  for (const token of tokenize(frame)) {
    if (token.kind === "text" || !/^\u001b\[[\d;]*m$/.test(token.text)) {
      out += token.text;
      continue;
    }
    const body = token.text.slice(2, -1);
    const params = body === "" ? [0] : body.split(";").map((part) => (part === "" ? 0 : Number(part)));
    const adapted = adaptSgrParams(params, level);
    if (adapted.length === 0) continue;
    out += `${CSI}${adapted.join(";")}m`;
  }
  return out;
}

/** OSC 8 hyperlinks are opt-in: exactly `KOSMO_TUI_LINKS=1`. */
export function linksEnabled(env: ColorEnv): boolean {
  return env.KOSMO_TUI_LINKS === "1";
}

/**
 * A source reference as the user sees it.
 *
 * The visible text is ALWAYS the relative fallback, so copying the screen, a terminal
 * without OSC 8 support, or links being disabled all still show where the code is.
 * With links enabled and a safe URI the same text is additionally wrapped in OSC 8.
 * A URI containing control characters is never emitted (it could inject sequences).
 */
export function sourceLink(relativeText: string, uri: string | undefined, env: ColorEnv): string {
  if (!linksEnabled(env) || uri === undefined || uri === "") return relativeText;
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(uri)) return relativeText;
  return `${OSC}8;;${uri}${ST}${relativeText}${OSC}8;;${ST}`;
}
