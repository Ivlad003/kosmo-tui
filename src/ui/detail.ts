/**
 * Detail pane of the selected span (spec 6.4): header, location and area, the code window from
 * disk, recorded values, attrs and links.
 *
 * Rules this module keeps:
 *  - every string from data (trace, code file, reader) is escaped before it is wrapped or fitted;
 *  - the `▶` line is always on screen: the code window gets the rows the lower blocks (values,
 *    attrs, links) leave, but at least ▶ ± 2; past that the lower blocks go first (from their end),
 *    then the code context, then the box, never the line itself (review focus 3);
 *  - a value that is not there says why (`not-recorded (threw)`, `masked`, `invalid-value(…)`,
 *    `loading…`); nothing is shown as null or blank; an object with an unknown `$type` is plain
 *    JSON marked `unknown-tag`;
 *  - masking is the one of `src/format` (`maskValue`, `maskAttrs`), shared with rows and --print;
 *  - long lines (a minified bundle line of 200 KB) are cut before they are measured, so a frame
 *    costs the same whatever the file holds.
 */

import { ELLIPSIS, clipPrefix, measureLimit, truncateVisible, visibleWidth } from "../ansi.js";
import { THEME, paint, sourceLink, type ColorEnv, type ColorLevel } from "../color.js";
import { expandCodeTabs, windowLines, type Snippet } from "../code/snippet.js";
import { maskAttrs } from "../format/kinds.js";
import type { TraceModel } from "../format/model.js";
import type { Json, Location, SpanRef, SpanRow, SpanValues, Value } from "../format/types.js";
import { utf8Bytes, utf8Prefix } from "../format/bytes.js";
import { compactJson, maskValue, tagOf } from "../format/value.js";
import { escapeTerminalControls, isSafeOsc8Uri, toFileUri } from "../sanitize.js";
import { wrapVisible } from "../wrap.js";
import { areaText, statusText } from "./labels.js";

/** One value's text in the pane; longer JSON is cut at a UTF-8 boundary and ends with `…`. */
export const DETAIL_VALUE_MAX_BYTES = 4096;

export type DetailInput = {
  readonly model: TraceModel;
  readonly ref: SpanRef;
  readonly root: string;
  readonly values: SpanValues | "loading" | undefined;
  readonly snippet: Snippet | "loading" | undefined;
};

export type DetailOptions = {
  readonly width: number;
  readonly height: number;
  /** Enter gave the detail focus: it fills the body and scrolls by `scroll` lines. */
  readonly focused: boolean;
  readonly scroll: number;
  readonly color: ColorLevel;
  /** OSC 8 on `file:line` (KOSMO_TUI_LINKS=1), only for a URI that passes `isSafeOsc8Uri`. */
  readonly links: boolean;
};

const LABEL_WIDTH = 8;
/** Without focus the code window keeps at least `▶` and two lines of context on each side, when they exist. */
const CODE_MIN_ROWS = 5;

/**
 * With focus a block wraps over at most this many rows of its width: room for the header of a span with
 * a 1024 B name or a 4096 B value, while text of hostile length is cut (with `…`) before `wrapVisible`.
 */
const WRAP_MAX_ROWS = 64;

/** Cut plain, already escaped text to `width` columns without measuring more than a bounded prefix. */
export function clipText(text: string, width: number): string {
  if (width <= 0) return "";
  return truncateVisible(clipPrefix(text, measureLimit(width)), width);
}

/** Wrap plain, already escaped text to `width` columns; only a bounded prefix is wrapped (spec 4.9, 8). */
function wrapText(text: string, width: number): string[] {
  return wrapVisible(clipPrefix(text, measureLimit(width) * WRAP_MAX_ROWS), width);
}

/** `text` cut to at most `max` UTF-8 bytes, `…` included; only a bounded prefix is ever scanned. */
function capBytes(text: string, max: number): string {
  if (text.length * 3 <= max) return text;
  const head = utf8Prefix(text, max);
  if (head.length === text.length) return text;
  return utf8Prefix(head, max - utf8Bytes(ELLIPSIS)) + ELLIPSIS;
}

function jsonText(value: Json): string {
  return escapeTerminalControls(capBytes(compactJson(value), DETAIL_VALUE_MAX_BYTES));
}

/** `{name, message}` (or an Error class tag around it) reads as `Name: message`, as in spec 6.4. */
function errorText(value: Json): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { readonly [key: string]: Json };
  const inner =
    record.$type === "class" &&
    record.value !== null &&
    typeof record.value === "object" &&
    !Array.isArray(record.value)
      ? (record.value as { readonly [key: string]: Json })
      : record;
  if (typeof inner.name !== "string" || typeof inner.message !== "string") return null;
  return escapeTerminalControls(capBytes(`${inner.name}: ${inner.message}`, DETAIL_VALUE_MAX_BYTES));
}

/** Free text of a value (reason, invalid-value position and message): capped like the JSON, then escaped. */
function freeText(text: string): string {
  return escapeTerminalControls(capBytes(text, DETAIL_VALUE_MAX_BYTES));
}

function reasonSuffix(reason: string | undefined): string {
  return reason === undefined ? "" : ` (${freeText(reason)})`;
}

/**
 * ` · unknown-tag` when some node of the value is an object whose `$type` the viewer does not know
 * (spec 4.2, `tagOf`): the object is shown as it is, and marked. Explicit stack, no recursion;
 * values are at most 64 levels and 64 KiB deep (4.2, 4.9).
 */
function unknownTagMark(value: Json): string {
  const stack: Json[] = [value];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === null || typeof node !== "object") continue;
    if (tagOf(node) === "unknown-tag") return " · unknown-tag";
    const children: readonly Json[] = Array.isArray(node) ? node : Object.values(node);
    for (const child of children) stack.push(child);
  }
  return "";
}

/** One Value as pane text (masked by key and by value, capped, escaped). */
export function valueText(value: Value | "loading" | undefined, role: "args" | "return" | "error" = "args"): string {
  if (value === undefined || value === "loading") return "loading…";
  const masked = maskValue(value);
  switch (masked.state) {
    case "recorded":
      return (
        ((role === "error" ? errorText(masked.value) : null) ?? jsonText(masked.value)) + unknownTagMark(masked.value)
      );
    case "truncated":
      return `truncated${masked.reason === undefined ? "" : `(${freeText(masked.reason)})`} ${jsonText(masked.value)}${unknownTagMark(masked.value)}`;
    case "masked":
      return `masked${reasonSuffix(masked.reason)}`;
    case "not-recorded":
      return `not-recorded${reasonSuffix(masked.reason)}`;
    case "live":
      return `live ${jsonText(masked.value)}${unknownTagMark(masked.value)}`;
    case "invalid-value":
      return `invalid-value(${freeText(masked.position)}: ${freeText(masked.what)})`;
    case "unknown-state":
      return `not-recorded (${freeText(masked.raw)}) · unknown-state`;
  }
}

/** `RenderEnv.links` is already `linksEnabled(env)` of the process (task 23); sourceLink wants an env. */
const LINKS_ON: ColorEnv = Object.freeze({ KOSMO_TUI_LINKS: "1" });

/** OSC 8 through `sourceLink` (the one OSC 8 builder), only for a `file://` URI inside the root. */
function locationLink(text: string, root: string, location: Location, links: boolean): string {
  if (!links) return text;
  const uri = toFileUri(`${root.replace(/\/+$/, "")}/${location.file}`);
  return sourceLink(text, isSafeOsc8Uri(uri, root) ? uri : undefined, LINKS_ON);
}

/** `name · kind · status · runtime · session`; the name is never shortened (spec 6.4). */
function headerText(span: SpanRow): string {
  const parts = [escapeTerminalControls(span.name), escapeTerminalControls(span.kind), statusText(span)];
  if (span.runtime !== undefined) parts.push(escapeTerminalControls(span.runtime));
  parts.push(escapeTerminalControls(span.ref.session));
  return parts.join(" · ");
}

function locationLine(input: DetailInput, span: SpanRow, links: boolean): string {
  const area = `area ${areaText(input.model.areaOf(span.ref))}`;
  const location = span.location;
  if (location === undefined) {
    return `${span.marks.includes("invalid-location") ? "(invalid-location)" : "(no location)"}  ${area}`;
  }
  const where = `${escapeTerminalControls(location.file)}:${location.line}${location.column === undefined ? "" : `:${location.column}`}`;
  const marks = span.marks.includes("invalid-snippet") ? "  invalid-snippet" : "";
  return `${locationLink(where, input.root, location, links)}  ${area}${marks}`;
}

function parentLine(model: TraceModel, ref: SpanRef): string | null {
  const parent = model.parentOf(ref);
  if (parent.kind === "unknown") return `parent  unknown(${escapeTerminalControls(parent.reason)})`;
  if (parent.kind === "cycle") return "parent  cycle (edge dropped)";
  return null;
}

const STATE_TITLE: Readonly<Record<Snippet["state"], string>> = {
  ok: "",
  "file-missing": "file-missing",
  "outside-root": "outside-root",
  "too-large": "too-large",
  unreadable: "unreadable",
  "not-text": "not-text",
  "changed-since-trace": "changed-since-trace",
  moved: "moved"
};

type CodeBody = { readonly lines: readonly string[]; readonly target: number; readonly last: number | null };
type CodeBox = { readonly top: string; body(rows: number): CodeBody; bottom(last: number | null): string };

/**
 * The code window: `┌ file · state ──`, gutter `│▶ 12  text`, `└──`. With a readable file the
 * lines come from disk through `windowLines` (the `▶` line always included); otherwise the
 * recorded `location.snippet` is the `▶` line and the title names the state.
 */
function codeBox(input: DetailInput, location: Location, width: number, color: ColorLevel): CodeBox {
  const snippet = input.snippet === "loading" ? undefined : input.snippet;
  const loading = input.snippet === undefined || input.snippet === "loading";
  const marker = paint("▶", { fg: THEME.accent, bold: true }, color);
  const rule = (prefix: string): string => {
    const head = clipText(prefix, Math.max(1, width - 1));
    return `${head} ${"─".repeat(Math.max(0, width - visibleWidth(head) - 1))}`;
  };
  const gutter = (target: boolean, n: number, digits: number): string =>
    `│${target ? marker : " "} ${String(n).padStart(digits)}  `;
  const room = (digits: number): number => Math.max(1, width - digits - 4);
  const fromDisk = snippet !== undefined && snippet.lines.length > 0;
  const recorded = location.snippet === undefined ? null : escapeTerminalControls(expandCodeTabs(location.snippet));
  let title = loading
    ? "loading…"
    : snippet!.state === "moved"
      ? `moved to line ${snippet!.target}`
      : STATE_TITLE[snippet!.state];
  if (!fromDisk && recorded !== null) title = title === "" ? "recorded snippet" : `${title} · recorded snippet`;
  const top = rule(`┌ ${escapeTerminalControls(location.file)}${title === "" ? "" : ` · ${title}`}`);

  const body = (rows: number): CodeBody => {
    if (fromDisk) {
      const shown = windowLines(snippet!, Math.max(1, rows));
      const digits = String(Math.max(...shown.map((line) => line.n))).length;
      const lines = shown.map(
        (line) => gutter(line.target, line.n, digits) + clipText(escapeTerminalControls(line.text), room(digits))
      );
      return {
        lines,
        target: Math.max(
          0,
          shown.findIndex((line) => line.target)
        ),
        last: shown.length === 0 ? null : shown[shown.length - 1]!.n
      };
    }
    if (recorded !== null) {
      const digits = String(location.line).length;
      return { lines: [gutter(true, location.line, digits) + clipText(recorded, room(digits))], target: 0, last: null };
    }
    return {
      lines: [`│  ${loading ? "loading…" : `no code: ${STATE_TITLE[snippet!.state] || "empty file"}`}`],
      target: 0,
      last: null
    };
  };
  // `└ … ──` when the function goes on below the last line shown.
  const bottom = (last: number | null): string =>
    location.endLine !== undefined && last !== null && last < location.endLine
      ? rule(`└ ${ELLIPSIS}`)
      : `└${"─".repeat(Math.max(0, width - 1))}`;
  return { top, body, bottom };
}

function valueLines(values: SpanValues | "loading" | undefined, width: number, wrap: boolean): string[] {
  const rows: Array<[string, string]> = [
    ["args", valueText(values === "loading" || values === undefined ? values : values.args, "args")],
    ["return", valueText(values === "loading" || values === undefined ? values : values.return, "return")],
    ["error", valueText(values === "loading" || values === undefined ? values : values.error, "error")]
  ];
  return rows.flatMap(([label, text]) => labelled(label, text, width, wrap));
}

function labelled(label: string, text: string, width: number, wrap: boolean): string[] {
  const room = Math.max(1, width - LABEL_WIDTH);
  const pieces = wrap ? wrapText(text, room) : [clipText(text, room)];
  return pieces.map((piece, index) => `${index === 0 ? label.padEnd(LABEL_WIDTH) : " ".repeat(LABEL_WIDTH)}${piece}`);
}

/**
 * Spec 6.4: `key = value` per line, sorted by key, then `invalid-attrs(N)`. `maskAttrs` (task 3, the
 * same as rows and --print) turns a masked key into `masked` and passes strings through `maskString`.
 */
function attrLines(span: SpanRow, width: number, wrap: boolean): string[] {
  const attrs = span.attrs === undefined ? {} : maskAttrs(span.attrs);
  const entries = Object.entries(attrs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const texts = entries.map(
    ([key, value]) => `${escapeTerminalControls(key)} = ${escapeTerminalControls(String(value))}`
  );
  if (span.droppedAttrs > 0) texts.push(`invalid-attrs(${span.droppedAttrs})`);
  else if (span.marks.includes("invalid-attrs")) texts.push("invalid-attrs");
  return texts.flatMap((text, index) => labelled(index === 0 ? "attrs" : "", text, width, wrap));
}

/** Spec 4.12: `→ name (kind)` outgoing, `← name (kind)` incoming; an end without a span is `missing`. */
function linkLines(model: TraceModel, ref: SpanRef, width: number): string[] {
  const { out, in: incoming } = model.links(ref);
  const texts = [
    ...out.map(
      (link) => `→ ${escapeTerminalControls(link.otherName ?? "missing")} (${escapeTerminalControls(link.kind)})`
    ),
    ...incoming.map(
      (link) => `← ${escapeTerminalControls(link.otherName ?? "missing")} (${escapeTerminalControls(link.kind)})`
    )
  ];
  return texts.flatMap((text, index) => labelled(index === 0 ? "links" : "", text, width, false));
}

function fitAll(lines: readonly string[], width: number, height: number): string[] {
  const out = lines.slice(0, height).map((line) => truncateVisible(line, width));
  while (out.length < height) out.push("");
  return out;
}

function clampScroll(scroll: number, total: number, height: number): number {
  return Math.min(Math.max(0, scroll), Math.max(0, total - height));
}

/**
 * Keep the `height` most important lines in display order. Priorities: the `▶` line 0, header 1,
 * location 2, parent 3, box top 4, box bottom 5, code context 6, values/attrs/links 7 (dropped from
 * the end first).
 */
function byPriority(items: ReadonlyArray<{ line: string; priority: number }>, height: number): string[] {
  if (items.length <= height) return items.map((item) => item.line);
  const chosen = items
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, height)
    .sort((a, b) => a.index - b.index);
  return chosen.map((item) => item.line);
}

/** The pane as exactly `height` lines of at most `width` columns. */
export function detailLines(input: DetailInput, options: DetailOptions): string[] {
  const { width, height, color } = options;
  if (height <= 0 || width <= 0) return [];
  const span = input.model.get(input.ref);
  if (span === undefined) return fitAll(["span not in this trace"], width, height);
  // Focused: the whole header wraps, so a long name is shown in full; each line is painted on its own.
  const headers = (options.focused ? wrapText(headerText(span), width) : [clipText(headerText(span), width)]).map(
    (line) => paint(line, { bold: true }, color)
  );
  const header = headers[0]!;
  const parent = parentLine(input.model, span.ref);
  const location = locationLine(input, span, options.links);
  const tail = [
    ...valueLines(input.values ?? span.values, width, options.focused),
    ...attrLines(span, width, options.focused),
    ...linkLines(input.model, span.ref, width)
  ];
  const head = [...(options.focused ? headers : [header]), ...(parent === null ? [] : [parent]), location];
  if (span.location === undefined) {
    const all = [...head, ...tail];
    return fitAll(all.slice(options.focused ? clampScroll(options.scroll, all.length, height) : 0), width, height);
  }
  const box = codeBox(input, span.location, width, color);
  if (options.focused) {
    const code = box.body(Math.max(1, height - head.length - 2));
    const all = [...head, box.top, ...code.lines, box.bottom(code.last), ...tail];
    return fitAll(all.slice(clampScroll(options.scroll, all.length, height)), width, height);
  }
  // The code window takes the rows the tail (values, attrs, links) leaves, but never fewer than
  // CODE_MIN_ROWS: when rows run short, the tail goes first (from its end), then the code context.
  const room = height - head.length - 2;
  const code = box.body(Math.max(1, room - tail.length, Math.min(room, CODE_MIN_ROWS)));
  const items = [
    { line: header, priority: 1 },
    ...(parent === null ? [] : [{ line: parent, priority: 3 }]),
    { line: location, priority: 2 },
    { line: box.top, priority: 4 },
    ...code.lines.map((line, index) => ({ line, priority: index === code.target ? 0 : 6 })),
    { line: box.bottom(code.last), priority: 5 },
    ...tail.map((line) => ({ line, priority: 7 }))
  ];
  return fitAll(byPriority(items, height), width, height);
}
