/**
 * The second safety layer in `terminal.paint` (spec 8.2).
 *
 * Every row is split into tokens (src/ansi.ts `tokenize`). Only two kinds of escape
 * sequence survive:
 *  - SGR (`ESC [ <digits;…> m`);
 *  - OSC 8 whose URI this guard checks itself with `isSafeOsc8Uri(uri, root)` (`file://`,
 *    inside the root, no control or bidi characters), and only when links are enabled
 *    (`KOSMO_TUI_LINKS=1`). The closing `ESC ] 8 ; ; ESC \` passes only after an opener
 *    that passed.
 * Everything else — raw ESC of any other sequence, C1 (U+009B), stray C0, DEL, bidi — is
 * escaped as visible `\uXXXX` by `escapeTerminalControls`. A link left open or an SGR
 * left set at the end of the row is closed there, because each row is painted on its own.
 * Colors are lowered last with `adaptSgr` to the level from `detectColorLevel`.
 */
import { CSI, OSC, ST, SGR_RESET, tokenize } from "../ansi.js";
import { adaptSgr, detectColorLevel, linksEnabled, type ColorEnv, type ColorLevel } from "../color.js";
import { escapeTerminalControls, isSafeOsc8Uri } from "../sanitize.js";

export type PaintGuardOptions = {
  /** Project root that OSC 8 URIs must stay inside; null → no link passes. */
  readonly root: string | null;
  /** `linksEnabled(env)`: without it every OSC 8 is escaped. */
  readonly links: boolean;
  /** `detectColorLevel(env, isTTY)`. */
  readonly color: ColorLevel;
};

export type PaintGuard = (row: string) => string;

const SGR = /^\u001b\[[0-9;]*m$/;
const OSC8 = /^\u001b\]8;[^;\u0007\u001b]*;([^\u0007\u001b]*)(?:\u0007|\u001b\\)$/;
const OSC8_CLOSE = `${OSC}8;;${ST}`;

export function guardRow(row: string, options: PaintGuardOptions): string {
  let out = "";
  let linkOpen = false;
  let sgrSet = false;
  for (const token of tokenize(row)) {
    if (token.kind === "text") {
      out += escapeTerminalControls(token.text);
      continue;
    }
    if (SGR.test(token.text)) {
      out += token.text;
      sgrSet = token.text !== SGR_RESET && token.text !== `${CSI}m`;
      continue;
    }
    const link = OSC8.exec(token.text);
    if (link !== null) {
      const uri = link[1]!;
      if (uri === "" && linkOpen) {
        out += OSC8_CLOSE;
        linkOpen = false;
        continue;
      }
      if (uri !== "" && options.links && options.root !== null && isSafeOsc8Uri(uri, options.root)) {
        if (linkOpen) out += OSC8_CLOSE;
        out += `${OSC}8;;${uri}${ST}`;
        linkOpen = true;
        continue;
      }
    }
    out += escapeTerminalControls(token.text);
  }
  if (linkOpen) out += OSC8_CLOSE;
  if (sgrSet) out += SGR_RESET;
  return adaptSgr(out, options.color);
}

/** A guard for `createTerminal`; pass a function when the root can change (`:root`). */
export function createPaintGuard(options: PaintGuardOptions | (() => PaintGuardOptions)): PaintGuard {
  return typeof options === "function" ? (row) => guardRow(row, options()) : (row) => guardRow(row, options);
}

/** The guard the session uses: color level and links from the environment, root from state. */
export function paintGuardFromEnv(input: {
  readonly env: ColorEnv;
  readonly isTTY: boolean;
  readonly platform?: string;
  readonly root: () => string | null;
}): PaintGuard {
  const color = detectColorLevel(input.env, input.isTTY, input.platform);
  const links = linksEnabled(input.env);
  return createPaintGuard(() => ({ root: input.root(), links, color }));
}
