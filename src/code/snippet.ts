/**
 * Code snippets from disk for the detail pane (spec 6.4, 4.8).
 *
 * - The window: with `endLine` — `line..endLine`, at most 40 lines (then `more`); without
 *   it — 8 lines on each side of `line`.
 * - CR is stripped from line ends; tabs become spaces with a tab stop of 4 ("крок 4").
 *   The text is NOT terminal-escaped here: the renderer escapes it (spec 8.1) after this
 *   expansion, so the order "tabs first, then escaping" holds.
 * - The recorded `snippet` is compared with the file line after removing CR and trimming
 *   both sides; with `snippetCut` it is a prefix. A mismatch (or `line` past the end of
 *   the file) is `changed-since-trace`, unless the same text is found within 40 lines:
 *   then `moved` (nearest match, a tie goes to the lower line).
 * - Every failure degrades to a named state; this module never throws for file content.
 *
 * Pure: every file access goes through SnippetFs. `root` must be a realpath (the session stores
 * roots that way, spec 4.8). When its realpath is no longer the root itself (the directory was
 * swapped for a symlink), nothing is read: `root-changed`. `realpath` of the file must stay under
 * the stored root, and a file outside the root, or one larger than 2 MiB, is never read.
 */
import path from "node:path";
import { clusterWidth, graphemes } from "../ansi.js";
import type { Location } from "../format/types.js";

export { resolveRoot, type RootFs } from "./root.js";

export type SnippetState =
  | "ok"
  | "file-missing"
  | "outside-root"
  | "root-changed"
  | "too-large"
  | "unreadable"
  | "not-text"
  | "changed-since-trace"
  | "moved";

/** `text`: tabs expanded to spaces (step 4), no CR, NOT escaped. */
export type SnippetLine = { readonly n: number; readonly text: string };

export type Snippet = {
  readonly state: SnippetState;
  readonly file: string;
  /** The whole candidate range (`line..endLine` capped at 40, or ±8); empty when unreadable. */
  readonly lines: readonly SnippetLine[];
  /** The ▶ line (after `moved` — the new one). */
  readonly target: number;
  readonly movedFrom?: number;
  /** True when `line..endLine` is longer than 40 lines: the renderer draws `…` after the last line. */
  readonly more?: boolean;
};

export type SnippetFs = {
  /** Rejects with an error whose `code` is `ENOENT` when the path (or a symlink target) does not exist. */
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ size: number; isFile: boolean } | undefined>;
  readFile(path: string): Promise<Uint8Array>;
};

export const SNIPPET_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const SNIPPET_CONTEXT_LINES = 8;
export const SNIPPET_RANGE_MAX_LINES = 40;
export const SNIPPET_SEARCH_RADIUS = 40;
export const CODE_TAB_STOP = 4;

/** Tabs → spaces up to the next multiple of 4 columns; wide clusters count as 2 columns. */
export function expandCodeTabs(text: string): string {
  if (!text.includes("\t")) return text;
  let column = 0;
  let out = "";
  for (const cluster of graphemes(text)) {
    if (cluster === "\t") {
      const width = CODE_TAB_STOP - (column % CODE_TAB_STOP);
      out += " ".repeat(width);
      column += width;
    } else {
      out += cluster;
      column += clusterWidth(cluster);
    }
  }
  return out;
}

/** Spec 6.4: "з обох боків прибрати CR, обрізати пробіли на краях; якщо snippetCut — префікс". */
export function snippetMatches(fileLine: string, snippet: string, snippetCut: boolean): boolean {
  const actual = fileLine.replace(/\r/g, "").trim();
  const expected = snippet.replace(/\r/g, "").trim();
  return snippetCut ? actual.startsWith(expected) : actual === expected;
}

export async function loadSnippet(root: string, location: Location, fs: SnippetFs): Promise<Snippet> {
  const file = location.file;
  const empty = (state: SnippetState): Snippet => ({ state, file, lines: [], target: location.line });

  // The caller stores the root as a realpath (spec 4.8). It is checked, never re-resolved: a
  // project directory swapped for a symlink to `~` after it was chosen must not widen the root.
  const stored = path.resolve(root);
  let currentRoot: string;
  let realFile: string;
  try {
    currentRoot = await fs.realpath(stored);
  } catch (error) {
    return empty(isMissing(error) ? "file-missing" : "unreadable");
  }
  if (path.resolve(currentRoot) !== stored) return empty("root-changed");
  try {
    realFile = await fs.realpath(path.join(stored, file));
  } catch (error) {
    return empty(isMissing(error) ? "file-missing" : "unreadable");
  }
  // Compared with the stored string itself, so a swap between the two realpath calls is caught too.
  if (!isInside(stored, realFile)) return empty("outside-root");

  let info: { size: number; isFile: boolean } | undefined;
  try {
    info = await fs.stat(realFile);
  } catch (error) {
    return empty(isMissing(error) ? "file-missing" : "unreadable");
  }
  if (info === undefined) return empty("file-missing");
  if (!info.isFile) return empty("unreadable");
  if (info.size > SNIPPET_MAX_FILE_BYTES) return empty("too-large");

  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(realFile);
  } catch (error) {
    return empty(isMissing(error) ? "file-missing" : "unreadable");
  }
  // The file may have grown between stat and read.
  if (bytes.length > SNIPPET_MAX_FILE_BYTES) return empty("too-large");
  if (bytes.includes(0)) return empty("not-text");
  let text: string;
  try {
    // fatal: invalid UTF-8 throws; a leading BOM is dropped by the decoder.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return empty("not-text");
  }

  const raw = splitLines(text);
  const line = location.line;
  const inFile = line >= 1 && line <= raw.length;
  const window = (state: SnippetState, target: number, movedFrom?: number): Snippet =>
    buildWindow(state, file, raw, location, target, movedFrom);

  if (location.snippet === undefined) return inFile ? window("ok", line) : empty("changed-since-trace");
  const cut = location.snippetCut === true;
  if (inFile && snippetMatches(raw[line - 1]!, location.snippet, cut)) return window("ok", line);
  const found = searchNearby(raw, line, location.snippet, cut);
  if (found !== null) return window("moved", found, line);
  return inFile ? window("changed-since-trace", line) : empty("changed-since-trace");
}

/**
 * The lines to draw in `rows` rows. Always contains the ▶ line when `rows >= 1`; the
 * context around it shrinks symmetrically (an odd spare row goes below).
 */
export function windowLines(snippet: Snippet, rows: number): readonly (SnippetLine & { readonly target: boolean })[] {
  const lines = snippet.lines;
  const count = Math.min(Number.isFinite(rows) ? Math.floor(rows) : 0, lines.length);
  if (count <= 0) return [];
  const index = lines.findIndex((entry) => entry.n === snippet.target);
  if (index === -1) return lines.slice(0, count).map((entry) => ({ ...entry, target: false }));
  const budget = count - 1;
  const before = index;
  const after = lines.length - 1 - index;
  let above = Math.min(before, Math.floor(budget / 2));
  const below = Math.min(after, budget - above);
  above = Math.min(before, budget - below);
  return lines
    .slice(index - above, index + below + 1)
    .map((entry) => ({ ...entry, target: entry.n === snippet.target }));
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.map((part) => (part.endsWith("\r") ? part.slice(0, -1) : part));
}

/** Nearest line within ±40 whose text matches; on a tie the lower line wins. */
function searchNearby(raw: readonly string[], line: number, snippet: string, cut: boolean): number | null {
  for (let distance = 1; distance <= SNIPPET_SEARCH_RADIUS; distance += 1) {
    for (const candidate of [line - distance, line + distance]) {
      if (candidate < 1 || candidate > raw.length) continue;
      if (snippetMatches(raw[candidate - 1]!, snippet, cut)) return candidate;
    }
  }
  return null;
}

function buildWindow(
  state: SnippetState,
  file: string,
  raw: readonly string[],
  location: Location,
  target: number,
  movedFrom: number | undefined
): Snippet {
  let first: number;
  let last: number;
  let more = false;
  if (location.endLine === undefined) {
    first = Math.max(1, target - SNIPPET_CONTEXT_LINES);
    last = Math.min(raw.length, target + SNIPPET_CONTEXT_LINES);
  } else {
    // After `moved` the range keeps its length: endLine shifts with line.
    const end = Math.min(raw.length, target + (location.endLine - location.line));
    first = target;
    last = Math.min(end, target + SNIPPET_RANGE_MAX_LINES - 1);
    more = end > last;
  }
  const lines: SnippetLine[] = [];
  for (let n = first; n <= last; n += 1) lines.push({ n, text: expandCodeTabs(raw[n - 1]!) });
  return {
    state,
    file,
    lines,
    target,
    ...(movedFrom === undefined ? {} : { movedFrom }),
    ...(more ? { more: true } : {})
  };
}

function isInside(realRoot: string, realFile: string): boolean {
  const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  return realFile.startsWith(prefix);
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
