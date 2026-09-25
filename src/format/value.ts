/**
 * Values of `args` / `return` / `error` (spec 4.2), the viewer cap (4.9) and key masking (8.3).
 *
 * `parseValue` never throws. A value that breaks a rule becomes `invalid-value` with the JSON path of the
 * first problem appended to `position`; a file never yields `live` (that state is the debugger's, stage 2).
 * An unknown `state` string becomes `unknown-state` (4.11).
 *
 * Tag rules (4.2). A tagged object must have exactly the listed keys (`object` may add `more`):
 *   - `$type` that is not a known tag, or a known tag with other keys → `unknown-tag`. The object is kept
 *     as is inside the value (its property values are checked like any plain object's) and `tagOf`
 *     returns "unknown-tag", so detail can show it as an ordinary object marked `unknown-tag`.
 *   - known tag with a wrong field type → `invalid-value`.
 *   - `deeper`, `more`, `string-cut` and `object.more` only in `truncated`/`live`; `unavailable` only in
 *     `live`; `more` only as the last element of an array, `map.entries` or `set.values`.
 * Depth (≤ 64): every array, plain object, unknown-tag object, `map`, `set`, `class` and `object` tag is one
 * level; leaf tags and the internal arrays of `map`/`set` are not. 64 nested arrays pass, 65 do not.
 *
 * `capValue` cuts structurally (string-cut / more / deeper) until `compactJson` of the value fits in
 * `maxBytes`: `recorded`/`truncated` → `truncated` with `reason: "viewer-cap"`, `live` stays `live`.
 * `compactJson` is the one serialisation used for sizes and for printing: keys sorted byte-wise, no
 * whitespace, and DEL, C1 and bidi controls escaped as `\uXXXX` on top of JSON's own C0 escapes.
 */
import { compareBytes, utf8Bytes, utf8Prefix } from "./bytes.js";
import { NOT_RECORDED, type Json, type Position, type Value } from "./types.js";

export const VALUE_MAX_DEPTH = 64;
export const VALUE_MAX_BYTES = 64 * 1024;
/** What `maskString` returns for a string masked whole, and what a masked `attrs` value shows. */
export const MASKED_TEXT = "masked";

export type ValueTag =
  | "undefined"
  | "number"
  | "bigint"
  | "function"
  | "symbol"
  | "date"
  | "map"
  | "set"
  | "class"
  | "accessor"
  | "hole"
  | "cycle"
  | "masked"
  | "deeper"
  | "more"
  | "string-cut"
  | "object"
  | "unavailable";

type JsonObject = { readonly [key: string]: Json };
type TagShape = { readonly required: readonly string[]; readonly optional: readonly string[] };

const TAG_SHAPES: Readonly<Record<ValueTag, TagShape>> = {
  undefined: { required: [], optional: [] },
  number: { required: ["value"], optional: [] },
  bigint: { required: ["value"], optional: [] },
  function: { required: ["name"], optional: [] },
  symbol: { required: ["description"], optional: [] },
  date: { required: ["value"], optional: [] },
  map: { required: ["entries"], optional: [] },
  set: { required: ["values"], optional: [] },
  class: { required: ["name", "value"], optional: [] },
  accessor: { required: ["get", "set"], optional: [] },
  hole: { required: [], optional: [] },
  cycle: { required: ["path"], optional: [] },
  masked: { required: [], optional: [] },
  deeper: { required: [], optional: [] },
  more: { required: ["count"], optional: [] },
  "string-cut": { required: ["value", "length"], optional: [] },
  object: { required: ["entries"], optional: ["more"] },
  unavailable: { required: ["reason"], optional: [] }
};

const NUMBER_WORDS: readonly unknown[] = ["NaN", "Infinity", "-Infinity", "-0"];
const BIGINT_TEXT = /^(?:0|-?[1-9][0-9]*)$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MASKED_TAG: Json = Object.freeze({ $type: "masked" });
const DEEPER_TAG: Json = Object.freeze({ $type: "deeper" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArray(value: unknown): value is readonly Json[] {
  return Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A key longer than this many UTF-8 bytes is clipped in a position (the id limit of spec 4.9). */
const POSITION_KEY_BYTES = 256;

/**
 * One JSON-path segment; a non-identifier key is quoted with `quote`, so a position never carries a control
 * character. A key over POSITION_KEY_BYTES keeps only its prefix, quoted, then `…`: `["aaa"…]` is
 * never mistaken for a real key, and a hostile key never puts megabytes into a position.
 */
function segment(key: string): string {
  if (key.length * 3 > POSITION_KEY_BYTES && utf8Bytes(key) > POSITION_KEY_BYTES) {
    return `[${quote(utf8Prefix(key, POSITION_KEY_BYTES))}…]`;
  }
  return IDENTIFIER.test(key) ? `.${key}` : `[${quote(key)}]`;
}

function tagOfRecord(record: Record<string, unknown>): ValueTag | "unknown-tag" | null {
  if (!Object.hasOwn(record, "$type")) return null;
  const tag = record.$type;
  if (typeof tag !== "string" || !Object.hasOwn(TAG_SHAPES, tag)) return "unknown-tag";
  const shape = TAG_SHAPES[tag as ValueTag];
  for (const key of Object.keys(record)) {
    if (key !== "$type" && !shape.required.includes(key) && !shape.optional.includes(key)) return "unknown-tag";
  }
  for (const key of shape.required) if (!Object.hasOwn(record, key)) return "unknown-tag";
  return tag as ValueTag;
}

/** The tag of a node: a known tag name, "unknown-tag" for an object with an unknown `$type`/shape, null otherwise. */
export function tagOf(node: Json): ValueTag | "unknown-tag" | null {
  return isRecord(node) ? tagOfRecord(node) : null;
}

type Mode = "recorded" | "truncated" | "live";
type Problem = { readonly path: string; readonly what: string };

const TOO_DEEP = `nesting deeper than ${VALUE_MAX_DEPTH}`;

function checkList(items: readonly unknown[], mode: Mode, path: string, depth: number): Problem | null {
  for (let index = 0; index < items.length; index += 1) {
    const problem = checkNode(items[index], mode, `${path}[${index}]`, depth, index === items.length - 1);
    if (problem !== null) return problem;
  }
  return null;
}

function checkEntries(entries: Record<string, unknown>, mode: Mode, path: string, depth: number): Problem | null {
  for (const key of Object.keys(entries)) {
    const problem = checkNode(entries[key], mode, `${path}${segment(key)}`, depth, false);
    if (problem !== null) return problem;
  }
  return null;
}

function checkString(record: Record<string, unknown>, key: string, path: string): Problem | null {
  return typeof record[key] === "string" ? null : { path: `${path}.${key}`, what: "must be a string" };
}

function checkTag(
  tag: ValueTag,
  record: Record<string, unknown>,
  mode: Mode,
  path: string,
  depth: number,
  moreAllowed: boolean
): Problem | null {
  switch (tag) {
    case "undefined":
    case "hole":
    case "masked":
      return null;
    case "deeper":
      return mode === "recorded" ? { path, what: "tag deeper is not allowed in a recorded value" } : null;
    case "number":
      return NUMBER_WORDS.includes(record.value)
        ? null
        : { path: `${path}.value`, what: 'must be "NaN", "Infinity", "-Infinity" or "-0"' };
    case "bigint":
      return typeof record.value === "string" && BIGINT_TEXT.test(record.value)
        ? null
        : { path: `${path}.value`, what: "must be a decimal integer string" };
    case "function":
      return checkString(record, "name", path);
    case "symbol":
      return checkString(record, "description", path);
    case "date":
      return checkString(record, "value", path);
    case "cycle":
      return checkString(record, "path", path);
    case "accessor":
      if (typeof record.get !== "boolean") return { path: `${path}.get`, what: "must be a boolean" };
      return typeof record.set === "boolean" ? null : { path: `${path}.set`, what: "must be a boolean" };
    case "unavailable":
      if (mode !== "live") return { path, what: "tag unavailable is only allowed in live values" };
      return checkString(record, "reason", path);
    case "more":
      if (mode === "recorded") return { path, what: "tag more is not allowed in a recorded value" };
      if (!moreAllowed) return { path, what: "tag more must be the last element of an array, map or set" };
      return isCount(record.count) ? null : { path: `${path}.count`, what: "must be a non-negative integer" };
    case "string-cut": {
      if (mode === "recorded") return { path, what: "tag string-cut is not allowed in a recorded value" };
      const problem = checkString(record, "value", path);
      if (problem !== null) return problem;
      const length = record.length;
      return isCount(length) && length >= (record.value as string).length
        ? null
        : { path: `${path}.length`, what: "must be an integer >= the prefix length" };
    }
    case "class": {
      const problem = checkString(record, "name", path);
      if (problem !== null) return problem;
      if (depth + 1 > VALUE_MAX_DEPTH) return { path, what: TOO_DEEP };
      return checkNode(record.value, mode, `${path}.value`, depth + 1, false);
    }
    case "set": {
      if (depth + 1 > VALUE_MAX_DEPTH) return { path, what: TOO_DEEP };
      if (!Array.isArray(record.values)) return { path: `${path}.values`, what: "must be an array" };
      return checkList(record.values, mode, `${path}.values`, depth + 1);
    }
    case "map": {
      if (depth + 1 > VALUE_MAX_DEPTH) return { path, what: TOO_DEEP };
      const entries = record.entries;
      if (!Array.isArray(entries)) return { path: `${path}.entries`, what: "must be an array" };
      for (let index = 0; index < entries.length; index += 1) {
        const entry: unknown = entries[index];
        const entryPath = `${path}.entries[${index}]`;
        const last = index === entries.length - 1;
        if (Array.isArray(entry) && entry.length === 2) {
          const problem =
            checkNode(entry[0], mode, `${entryPath}[0]`, depth + 1, false) ??
            checkNode(entry[1], mode, `${entryPath}[1]`, depth + 1, false);
          if (problem !== null) return problem;
        } else if (last && isRecord(entry) && tagOfRecord(entry) === "more") {
          const problem = checkNode(entry, mode, entryPath, depth + 1, true);
          if (problem !== null) return problem;
        } else {
          return { path: entryPath, what: "must be a [key, value] pair" };
        }
      }
      return null;
    }
    case "object": {
      if (depth + 1 > VALUE_MAX_DEPTH) return { path, what: TOO_DEEP };
      if (!isRecord(record.entries)) return { path: `${path}.entries`, what: "must be an object" };
      if (Object.hasOwn(record, "more")) {
        if (mode === "recorded") return { path: `${path}.more`, what: "more is not allowed in a recorded value" };
        if (!isCount(record.more)) return { path: `${path}.more`, what: "must be a non-negative integer" };
      }
      return checkEntries(record.entries, mode, `${path}.entries`, depth + 1);
    }
  }
}

function checkNode(node: unknown, mode: Mode, path: string, depth: number, moreAllowed: boolean): Problem | null {
  if (node === null || typeof node === "string" || typeof node === "boolean") return null;
  if (typeof node === "number") {
    return Number.isFinite(node) ? null : { path, what: "must be a finite number (use the number tag)" };
  }
  if (typeof node !== "object") return { path, what: "is not a JSON value" };
  if (Array.isArray(node)) {
    if (depth + 1 > VALUE_MAX_DEPTH) return { path, what: TOO_DEEP };
    return checkList(node, mode, path, depth + 1);
  }
  const record = node as Record<string, unknown>;
  const tag = tagOfRecord(record);
  if (tag === null || tag === "unknown-tag") {
    if (depth + 1 > VALUE_MAX_DEPTH) return { path, what: TOO_DEEP };
    return checkEntries(record, mode, path, depth + 1);
  }
  return checkTag(tag, record, mode, path, depth, moreAllowed);
}

function invalid(position: Position, path: string, what: string): Value {
  return { state: "invalid-value", position: `${position}${path}`, what };
}

/**
 * Parse one `args`/`return`/`error` field of a file. `raw === undefined` (field absent) → NOT_RECORDED.
 * `position` is where the field sits (`$.spans[3].args`); problems append their inner path to it.
 */
export function parseValue(raw: unknown, position: Position): Value {
  if (raw === undefined) return NOT_RECORDED;
  if (!isRecord(raw)) return invalid(position, "", "must be an object with a state");
  const state = raw.state;
  if (typeof state !== "string") return invalid(position, ".state", "must be a string");
  const hasReason = Object.hasOwn(raw, "reason");
  const reason = raw.reason;
  if (state === "live") return invalid(position, ".state", "live values never come from a file");
  if (state !== "recorded" && state !== "truncated" && state !== "masked" && state !== "not-recorded") {
    return { state: "unknown-state", raw: state };
  }
  if (state !== "recorded" && hasReason && typeof reason !== "string") {
    return invalid(position, ".reason", "must be a string");
  }
  if (state === "masked" || state === "not-recorded") {
    return typeof reason === "string" ? { state, reason } : { state };
  }
  if (!Object.hasOwn(raw, "value")) return invalid(position, ".value", "is required");
  const problem = checkNode(raw.value, state, ".value", 0, false);
  if (problem !== null) return invalid(position, problem.path, problem.what);
  const value = raw.value as Json;
  if (state === "recorded") return { state, value };
  return typeof reason === "string" ? { state, value, reason } : { state, value };
}

const EXTRA_ESCAPES = /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

function hex4(char: string): string {
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

function quote(text: string): string {
  return JSON.stringify(text).replace(EXTRA_ESCAPES, hex4);
}

/** Deterministic compact JSON: keys sorted byte-wise, no whitespace, DEL/C1/bidi escaped as `\uXXXX`. */
export function compactJson(value: Json): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "string") return quote(value);
  if (isArray(value)) return `[${value.map((item) => compactJson(item)).join(",")}]`;
  const object = value as JsonObject;
  const keys = Object.keys(object).sort(compareBytes);
  return `{${keys.map((key) => `${quote(key)}:${compactJson(object[key] ?? null)}`).join(",")}}`;
}

/** UTF-8 size of one code point inside a `compactJson` string literal. */
function escapedBytes(codePoint: number, loneSurrogate: boolean): number {
  if (loneSurrogate) return 6;
  if (codePoint === 0x22 || codePoint === 0x5c) return 2;
  if (codePoint === 0x08 || codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0c || codePoint === 0x0d) {
    return 2;
  }
  if (codePoint < 0x20) return 6;
  if (codePoint < 0x7f) return 1;
  if (codePoint <= 0x9f) return 6;
  if ((codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069)) return 6;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** Longest prefix of `text` whose escaped form (without quotes) fits in `maxBytes`; pairs never split. */
function jsonPrefix(text: string, maxBytes: number): string {
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const unit = text.charCodeAt(index);
    let width = 1;
    let codePoint = unit;
    let lone = false;
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        width = 2;
        codePoint = (unit - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
      } else lone = true;
    } else if (unit >= 0xd800 && unit <= 0xdfff) lone = true;
    const size = escapedBytes(codePoint, lone);
    if (bytes + size > maxBytes) break;
    bytes += size;
    index += width;
  }
  return text.slice(0, index);
}

type Budget = { left: number };
/** Room always kept free in a list or object for its closing `more` marker. */
const RESERVE = 48;
const STRING_CUT_OVERHEAD = 64;

function sizeOf(node: Json): number {
  return utf8Bytes(compactJson(node));
}

function cutString(text: string, budget: Budget): Json | undefined {
  const full = sizeOf(text);
  if (full <= budget.left) {
    budget.left -= full;
    return text;
  }
  const room = budget.left - STRING_CUT_OVERHEAD;
  if (room < 0) return undefined;
  const cut: Json = { $type: "string-cut", value: jsonPrefix(text, room), length: text.length };
  budget.left -= sizeOf(cut);
  return cut;
}

function cutList(items: readonly Json[], budget: Budget, cutItem: (item: Json) => Json | undefined): Json[] {
  let count = items.length;
  let rest = 0;
  const last = items[count - 1];
  if (last !== undefined && tagOf(last) === "more") {
    rest = (last as JsonObject).count as number;
    count -= 1;
  }
  budget.left -= 2;
  const out: Json[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = budget.left > RESERVE ? cutItem(items[index] as Json) : undefined;
    if (item === undefined) {
      rest += count - index;
      break;
    }
    out.push(item);
    budget.left -= 1;
  }
  if (rest > 0) {
    const more: Json = { $type: "more", count: rest };
    budget.left -= sizeOf(more);
    out.push(more);
  }
  return out;
}

function cutEntries(entries: JsonObject, carried: number, asTag: boolean, budget: Budget): Json {
  const keys = Object.keys(entries).sort(compareBytes);
  budget.left -= asTag ? 40 : 2;
  const kept: [string, Json][] = [];
  let more = carried;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] as string;
    const keyBytes = sizeOf(key) + 2;
    let item: Json | undefined;
    if (budget.left > RESERVE + keyBytes) {
      budget.left -= keyBytes;
      item = cutNode(entries[key] ?? null, budget);
    }
    if (item === undefined) {
      more += keys.length - index;
      break;
    }
    kept.push([key, item]);
  }
  const object: Json = Object.fromEntries(kept);
  if (!asTag && more === 0) return object;
  return more > 0 ? { $type: "object", entries: object, more } : { $type: "object", entries: object };
}

function cutNode(node: Json, budget: Budget): Json | undefined {
  if (typeof node === "string") return cutString(node, budget);
  if (node === null || typeof node !== "object") {
    const size = sizeOf(node);
    if (size > budget.left) return undefined;
    budget.left -= size;
    return node;
  }
  if (isArray(node)) return cutList(node, budget, (item) => cutNode(item, budget));
  const record = node as JsonObject;
  const tag = tagOf(record);
  switch (tag) {
    case null:
    case "unknown-tag":
      return cutEntries(record, 0, false, budget);
    case "object":
      return cutEntries(record.entries as JsonObject, (record.more as number | undefined) ?? 0, true, budget);
    case "set":
      budget.left -= 28;
      return {
        $type: "set",
        values: cutList(record.values as readonly Json[], budget, (item) => cutNode(item, budget))
      };
    case "map":
      budget.left -= 29;
      return {
        $type: "map",
        entries: cutList(record.entries as readonly Json[], budget, (pair) => {
          const [key, value] = pair as readonly [Json, Json];
          budget.left -= 3;
          const cutKey = cutNode(key, budget);
          if (cutKey === undefined) return undefined;
          const cutValue = cutNode(value, budget);
          return cutValue === undefined ? undefined : [cutKey, cutValue];
        })
      };
    case "class": {
      const head = sizeOf(record.name ?? null) + 36;
      if (head > budget.left) return undefined;
      budget.left -= head;
      return { $type: "class", name: record.name ?? null, value: cutNode(record.value ?? null, budget) ?? DEEPER_TAG };
    }
    case "string-cut": {
      const text = record.value as string;
      const room = budget.left - STRING_CUT_OVERHEAD;
      if (room < 0) return undefined;
      const cut: Json = { $type: "string-cut", value: jsonPrefix(text, room), length: record.length ?? 0 };
      budget.left -= sizeOf(cut);
      return cut;
    }
    default: {
      const size = sizeOf(record);
      if (size > budget.left) return undefined;
      budget.left -= size;
      return record;
    }
  }
}

function fits(json: Json, maxBytes: number): boolean {
  // compactJson turns one UTF-16 unit of JSON.stringify into at most 6 bytes (a `\u009b` escape).
  if (JSON.stringify(json).length * 6 <= maxBytes) return true;
  return sizeOf(json) <= maxBytes;
}

function cutToFit(json: Json, maxBytes: number): Json {
  let budget = maxBytes;
  while (budget > RESERVE) {
    const cut = cutNode(json, { left: budget - RESERVE }) ?? DEEPER_TAG;
    const size = sizeOf(cut);
    if (size <= maxBytes) return cut;
    budget -= Math.max(size - maxBytes + RESERVE, Math.ceil(budget / 8));
  }
  return DEEPER_TAG;
}

/** Viewer cap (spec 4.9, last row): a value whose `compactJson` exceeds `maxBytes` is cut structurally. */
export function capValue(value: Value, maxBytes: number = VALUE_MAX_BYTES): Value {
  if (value.state !== "recorded" && value.state !== "truncated" && value.state !== "live") return value;
  if (fits(value.value, maxBytes)) return value;
  const cut = cutToFit(value.value, maxBytes);
  return value.state === "live"
    ? { state: "live", value: cut }
    : { state: "truncated", value: cut, reason: "viewer-cap" };
}

const MASKED_WORDS: ReadonlySet<string> = new Set([
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "auth",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "jwt",
  "bearer",
  "otp"
]);
const MASKED_PAIRS: ReadonlySet<string> = new Set([
  "api key",
  "session id",
  "private key",
  "access key",
  "client secret"
]);
const MASKED_WHOLE_KEYS: ReadonlySet<string> = new Set(["apikey", "sessionid", "sid", "set-cookie"]);

/**
 * Words of a key (spec 8.3): split at camelCase humps (`csrfToken`, `APIKey`), at every character that is
 * not a letter or digit (`-`, `_`, `.` and any other separator) and between letters and digits
 * (`password2`), then lower-cased. The last two are a hardening of the spec wording: they only mask more.
 */
export function keyWords(key: string): string[] {
  return key
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/(\p{L})(\p{N})/gu, "$1 $2")
    .replace(/(\p{N})(\p{L})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

/** Spec 8.3: a masked word, a masked pair of consecutive words, or a masked whole key. */
export function isMaskedKey(key: string): boolean {
  if (MASKED_WHOLE_KEYS.has(key.toLowerCase())) return true;
  const words = keyWords(key);
  for (let index = 0; index < words.length; index += 1) {
    if (MASKED_WORDS.has(words[index] as string)) return true;
    if (index + 1 < words.length && MASKED_PAIRS.has(`${words[index]} ${words[index + 1]}`)) return true;
  }
  return false;
}

const CREDENTIAL = /^(?:Bearer|Basic|Digest|Negotiate)\s+\S+/i;
const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;
const QUERY_PARAM = /(^|[?&])([^=&#?\s]+)=([^&#\s]*)/g;

function isCredential(text: string): boolean {
  return CREDENTIAL.test(text) || JWT.test(text);
}

function decodeQueryKey(key: string): string {
  try {
    return decodeURIComponent(key.replace(/\+/g, " "));
  } catch {
    return key;
  }
}

/**
 * A parameter nested inside a query value (`?next=/cart?token=1`, `?r=%2Fa%3Ftoken%3D1`): led by `?`,
 * `%3F` or `%26`, a key without `=`, `?` or an encoded lead / `=`, then `=` or `%3D`. It is only looked
 * for inside the value of a parameter QUERY_PARAM already matched, so text outside a query is untouched.
 */
const NESTED_PARAM = /(\?|%3F|%26)((?:[^=?%]|%(?!3[DF]|26))+)(=|%3D)/gi;
const ENCODED_AMPERSAND = /%26/gi;

/**
 * The value of an unmasked query parameter with any nested secret-named parameter masked. A nested value
 * runs to the end of the outer value, or to the next `%26` when the pair itself is percent-encoded. One
 * left-to-right pass: an unmasked nested pair is stepped over at its `=`, so deeper nesting costs nothing.
 */
function maskNestedQuery(value: string): string {
  NESTED_PARAM.lastIndex = 0;
  let out = "";
  let last = 0;
  for (let match = NESTED_PARAM.exec(value); match !== null; match = NESTED_PARAM.exec(value)) {
    const valueStart = match.index + match[0].length;
    if (valueStart === value.length || !isMaskedKey(decodeQueryKey(match[2] as string))) continue;
    let valueEnd = value.length;
    if (match[1] !== "?" || match[3] !== "=") {
      ENCODED_AMPERSAND.lastIndex = valueStart;
      valueEnd = ENCODED_AMPERSAND.exec(value)?.index ?? value.length;
    }
    if (valueEnd === valueStart) continue;
    out += `${value.slice(last, valueStart)}${MASKED_TEXT}`;
    last = valueEnd;
    NESTED_PARAM.lastIndex = valueEnd;
  }
  return last === 0 ? value : out + value.slice(last);
}

/**
 * Spec 8.3 for one string: a credential-like string (`Bearer …`, `Basic …`, `Digest …`, `Negotiate …`, a JWT)
 * becomes MASKED_TEXT; otherwise every `key=value` query parameter (at the start, after `?` or `&`) whose
 * key is masked keeps its key and gets MASKED_TEXT as value, and the value of any other parameter has its
 * nested secret-named parameters masked (`maskNestedQuery`). All other text is returned unchanged.
 */
export function maskString(text: string): string {
  if (isCredential(text)) return MASKED_TEXT;
  return text.replace(QUERY_PARAM, (match: string, lead: string, key: string, value: string) => {
    if (value === "") return match;
    if (isMaskedKey(decodeQueryKey(key))) return `${lead}${key}=${MASKED_TEXT}`;
    const nested = maskNestedQuery(value);
    return nested === value ? match : `${lead}${key}=${nested}`;
  });
}

function maskEntries(entries: JsonObject): JsonObject {
  let changed = false;
  const out: [string, Json][] = [];
  for (const key of Object.keys(entries)) {
    const original = entries[key] ?? null;
    const masked = isMaskedKey(key) ? MASKED_TAG : maskNode(original);
    if (masked !== original) changed = true;
    out.push([key, masked]);
  }
  return changed ? Object.fromEntries(out) : entries;
}

function maskList(items: readonly Json[], maskItem: (item: Json) => Json): readonly Json[] {
  let changed = false;
  const out = items.map((item) => {
    const masked = maskItem(item);
    if (masked !== item) changed = true;
    return masked;
  });
  return changed ? out : items;
}

function maskNode(node: Json): Json {
  if (typeof node === "string") return isCredential(node) ? MASKED_TAG : maskString(node);
  if (node === null || typeof node !== "object") return node;
  if (isArray(node)) return maskList(node, maskNode);
  const record = node as JsonObject;
  switch (tagOf(record)) {
    case null:
    case "unknown-tag":
      return maskEntries(record);
    case "object": {
      const entries = maskEntries(record.entries as JsonObject);
      return entries === record.entries ? record : { ...record, entries };
    }
    case "set": {
      const values = maskList(record.values as readonly Json[], maskNode);
      return values === record.values ? record : { ...record, values };
    }
    case "map": {
      const entries = maskList(record.entries as readonly Json[], (entry) => {
        if (!isArray(entry) || entry.length !== 2) return entry;
        const [key, value] = entry as readonly [Json, Json];
        if (typeof key === "string" && isMaskedKey(key)) return [key, MASKED_TAG];
        const maskedKey = maskNode(key);
        const maskedValue = maskNode(value);
        return maskedKey === key && maskedValue === value ? entry : [maskedKey, maskedValue];
      });
      return entries === record.entries ? record : { ...record, entries };
    }
    case "class": {
      const inner = maskNode(record.value ?? null);
      return inner === record.value ? record : { ...record, value: inner };
    }
    case "string-cut": {
      const text = record.value as string;
      if (isCredential(text)) return MASKED_TAG;
      const masked = maskString(text);
      return masked === text ? record : { ...record, value: masked };
    }
    default:
      return record;
  }
}

/** Mask a value for display/print (spec 8.3): keys, credential strings and URL queries. The state never changes. */
export function maskValue(value: Value): Value {
  if (value.state !== "recorded" && value.state !== "truncated" && value.state !== "live") return value;
  const masked = maskNode(value.value);
  return masked === value.value ? value : { ...value, value: masked };
}
