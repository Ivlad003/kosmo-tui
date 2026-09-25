/**
 * `kosmo-text/v1` (spec 7.2): the text projection printed by `--print`, `d` and `y`.
 *
 *   header      = "kosmo-text/v1 trace=" jstr " name=" (jstr / "-") " spans=" total " status=" tstatus LF
 *   span-line   = indent glyph " " jstr [ " " kind ] "  " loc "  [" area "]  " dur [ "  " http ] [ "  " mark ] LF
 *   detail-line = indent "    args=" v "  return=" v "  error=" v [ "  attrs=" a ] LF
 *   trailer     = "… truncated: output-byte-cap (shown " N " of " M " spans)" LF
 *
 * Every string from the data is either written as is (it matches a safe character set)
 * or as `jstr`: JSON.stringify plus `\uXXXX` for DEL, C1 and bidi, so no control
 * character ever reaches the output. The whole text, trailer included, is at most
 * 51 200 B of UTF-8; whole groups (span-line + detail-line) are dropped from the end.
 * The walk is an explicit stack and stops at the cap, so a 50 000-deep chain never
 * recurses and never builds more lines than it prints.
 */
import { utf8Bytes, utf8Prefix } from "../format/bytes.js";
import { maskAttrs } from "../format/kinds.js";
import { traceStatusOf, type TraceModel } from "../format/model.js";
import type { AttrValue, SpanRef, SpanRow, SpanValues, Value } from "../format/types.js";
import { compactJson, maskValue } from "../format/value.js";

export const OUTPUT_BYTE_CAP = 51_200;
/** Each `v` and `a` is at most 512 B; a longer one keeps ≤ 509 B and gets `…`. */
export const VALUE_TEXT_MAX_BYTES = 512;
const VALUE_TEXT_KEEP_BYTES = 509;

export type ValuesLookup = (ref: SpanRef) => SpanValues | undefined;

const WORD = /^[A-Za-z0-9._/@$+~#-]+$/;
const KIND = /^[a-z][a-z0-9_.-]*$/;
const EXTRA = /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const GLYPHS: Readonly<Record<SpanRow["status"], string>> = {
  complete: "✓",
  errored: "✗",
  running: "…",
  suspended: "⏸",
  unknown: "?"
};

function hex4(char: string): string {
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

/** JSON string with DEL, C1 and bidi controls also escaped as `\uXXXX`. */
export function jstr(text: string): string {
  return JSON.stringify(text).replace(EXTRA, hex4);
}

/** As is when every character is in `[A-Za-z0-9._/@$+~#-]`, else `jstr` (the `loc` rule). */
export function word(text: string): string {
  return WORD.test(text) ? text : jstr(text);
}

/** `text` if it fits in 512 B, else its longest prefix of ≤ 509 B (whole code points) + `…`. */
export function capValueText(text: string): string {
  if (utf8Bytes(text) <= VALUE_TEXT_MAX_BYTES) return text;
  return `${utf8Prefix(text, VALUE_TEXT_KEEP_BYTES)}…`;
}

export function truncationTrailer(shown: number, total: number, unit: "spans" | "traces"): string {
  return `… truncated: output-byte-cap (shown ${shown} of ${total} ${unit})\n`;
}

/**
 * `head` + as many whole `groups` as fit in `cap` bytes. When a group does not fit,
 * groups are dropped from the end until head + groups + trailer fit. `groups` is
 * consumed lazily and never past the first group that does not fit.
 */
export function joinWithinCap(
  head: string,
  groups: Iterable<string>,
  total: number,
  unit: "spans" | "traces",
  cap: number = OUTPUT_BYTE_CAP
): string {
  const kept: string[] = [];
  const sizes: number[] = [];
  let used = utf8Bytes(head);
  let truncated = false;
  for (const group of groups) {
    const size = utf8Bytes(group);
    if (used + size > cap) {
      truncated = true;
      break;
    }
    kept.push(group);
    sizes.push(size);
    used += size;
  }
  if (!truncated) return head + kept.join("");
  let shown = kept.length;
  let trailer = truncationTrailer(shown, total, unit);
  while (shown > 0 && used + utf8Bytes(trailer) > cap) {
    shown -= 1;
    used -= sizes[shown]!;
    trailer = truncationTrailer(shown, total, unit);
  }
  return head + kept.slice(0, shown).join("") + trailer;
}

/** Depth-first walk in the order of spec 4.3 (children as the model orders them), no recursion. */
export function* walkDfs(model: TraceModel, starts: readonly SpanRef[]): Generator<{ ref: SpanRef; depth: number }> {
  const stack: Array<{ ref: SpanRef; depth: number }> = [];
  for (let i = starts.length - 1; i >= 0; i -= 1) stack.push({ ref: starts[i]!, depth: 0 });
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    yield top;
    const children = model.children(top.ref);
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push({ ref: children[i]!, depth: top.depth + 1 });
  }
}

export function renderKosmoText(
  model: TraceModel,
  options: { detail: 0 | 1; values: ValuesLookup; subtree?: SpanRef }
): string {
  const starts = options.subtree === undefined ? model.roots() : model.get(options.subtree) ? [options.subtree] : [];
  const total = options.subtree === undefined ? model.size : count(walkDfs(model, starts));
  const groups = (function* (): Generator<string> {
    for (const { ref, depth } of walkDfs(model, starts)) {
      const span = model.get(ref);
      if (span === undefined) continue;
      const indent = "  ".repeat(depth);
      let group = spanLine(model, span, indent);
      if (options.detail === 1) group += detailLine(span, options.values(ref) ?? span.values, indent);
      yield group;
    }
  })();
  return joinWithinCap(header(model), groups, total, "spans");
}

function header(model: TraceModel): string {
  const trace = model.trace;
  const status = trace.status ?? traceStatusOf(allSpans(model));
  const name = trace.name === null ? "-" : jstr(trace.name);
  return `kosmo-text/v1 trace=${jstr(trace.id)} name=${name} spans=${model.size} status=${status}\n`;
}

function spanLine(model: TraceModel, span: SpanRow, indent: string): string {
  let line = `${indent}${GLYPHS[span.status]} ${jstr(span.name)}`;
  if (span.kind !== "function") line += ` ${KIND.test(span.kind) ? span.kind : jstr(span.kind)}`;
  line += `  ${loc(span)}  [${area(model, span)}]  ${span.durationMs === undefined ? "-" : `${span.durationMs.toFixed(1)}ms`}`;
  const http = httpPart(span);
  if (http !== null) line += `  ${http}`;
  const marks = markList(model, span);
  if (marks.length > 0) line += `  ${marks.join(" ")}`;
  return `${line}\n`;
}

function loc(span: SpanRow): string {
  if (span.location !== undefined) return `${word(span.location.file)}:${span.location.line}`;
  return span.marks.includes("invalid-location") ? "(invalid-location)" : "(no location)";
}

/** `module`, `module · feature`, `~module`, `· feature` (explicit area without module) or `(unknown)`. */
function area(model: TraceModel, span: SpanRow): string {
  const key = model.areaOf(span.ref);
  if (key.module === null) return key.feature === null ? "(unknown)" : `· ${word(key.feature)}`;
  const module = `${key.derived ? "~" : ""}${word(key.module)}`;
  return key.feature === null ? module : `${module} · ${word(key.feature)}`;
}

/** `<method|-> <route|-> → <status|->` from the masked attrs (spec 8.3 applies to print too). */
function httpPart(span: SpanRow): string | null {
  if (span.kind !== "http.server" || span.attrs === undefined) return null;
  const attrs = maskAttrs(span.attrs);
  const method = attrs["http.request.method"];
  const route = attrs["http.route"];
  const status = attrs["http.response.status_code"];
  if (method === undefined && route === undefined && status === undefined) return null;
  const part = (value: AttrValue | undefined): string =>
    value === undefined ? "-" : typeof value === "number" ? String(value) : word(String(value));
  return `${part(method)} ${part(route)} → ${part(status)}`;
}

/** Fixed order (spec 7.2): parent, cycle, status, strict-duplicate, invalid-attrs. */
function markList(model: TraceModel, span: SpanRow): string[] {
  const marks: string[] = [];
  const parent = model.parentOf(span.ref);
  if (parent.kind === "unknown") marks.push(`parent=unknown(${parent.reason})`);
  if (parent.kind === "cycle") marks.push("cycle");
  if (span.status === "unknown") marks.push(`unknown(${word(span.statusReason ?? "unspecified")})`);
  if (span.attrs?.["react.strict_mode.duplicate"] === true) marks.push("strict-duplicate");
  if (span.droppedAttrs > 0) marks.push(`invalid-attrs(${span.droppedAttrs})`);
  else if (span.marks.includes("invalid-attrs")) marks.push("invalid-attrs");
  return marks;
}

function detailLine(span: SpanRow, values: SpanValues | undefined, indent: string): string {
  const v = (value: Value | undefined): string => capValueText(valueText(value ?? { state: "not-recorded" }));
  let line = `${indent}    args=${v(values?.args)}  return=${v(values?.return)}  error=${v(values?.error)}`;
  if (span.attrs !== undefined && Object.keys(span.attrs).length > 0) {
    line += `  attrs=${capValueText(compactJson(maskAttrs(span.attrs)))}`;
  }
  return `${line}\n`;
}

/** The `v` forms of spec 7.2, after key masking (8.3). */
export function valueText(value: Value): string {
  const masked = maskValue(value);
  switch (masked.state) {
    case "recorded":
      return compactJson(masked.value);
    case "truncated":
      return `truncated:${compactJson(masked.value)}`;
    case "live":
      return `live:${compactJson(masked.value)}`;
    case "masked":
      return "masked";
    case "not-recorded":
      return masked.reason === undefined ? "not-recorded" : `not-recorded(${word(masked.reason)})`;
    case "invalid-value":
      return `invalid-value(${jstr(masked.position)})`;
    case "unknown-state":
      return `unknown-state(${jstr(masked.raw)})`;
  }
}

function allSpans(model: TraceModel): SpanRow[] {
  const spans: SpanRow[] = [];
  for (const { ref } of walkDfs(model, model.roots())) {
    const span = model.get(ref);
    if (span !== undefined) spans.push(span);
  }
  return spans;
}

function count(items: Iterable<unknown>): number {
  let n = 0;
  for (const _ of items) n += 1;
  return n;
}
