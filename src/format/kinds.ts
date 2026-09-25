/**
 * Framework vocabulary (spec 4.13): known `kind` names, `attrs` validation and kind globs.
 *
 * `kind` is an open dotted string; only the exact names in KNOWN_KINDS get special display, any other kind
 * is shown as is (after sanitize). `attrs` entries are checked in document order: invalid entries are
 * dropped first, then valid ones are accepted until the object would exceed 32 keys or 8 KiB of
 * `JSON.stringify`, and every later entry is dropped too. All dropped entries are counted.
 */
import { utf8Bytes } from "./bytes.js";
import type { AttrValue, Attrs } from "./types.js";
import { MASKED_TEXT, isMaskedKey, maskString } from "./value.js";

export const KNOWN_KINDS: readonly string[] = Object.freeze([
  "function",
  "http.server",
  "http.client",
  "express.router",
  "express.middleware",
  "express.handler",
  "express.error-handler",
  "nest.middleware",
  "nest.guard",
  "nest.interceptor",
  "nest.pipe",
  "nest.handler",
  "nest.filter",
  "react.render",
  "react.effect",
  "next.middleware",
  "next.route-handler",
  "next.server-action",
  "next.render"
]);

const KNOWN_KIND_SET: ReadonlySet<string> = new Set(KNOWN_KINDS);

export function isKnownKind(kind: string): boolean {
  return KNOWN_KIND_SET.has(kind);
}

export const ATTR_KEY_RE: RegExp = /^[a-z][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$/;
export const ATTRS_MAX_KEYS = 32;
export const ATTR_KEY_MAX_BYTES = 128;
export const ATTR_STRING_MAX_BYTES = 512;
export const ATTRS_MAX_BYTES = 8 * 1024;

export type AttrsResult = { readonly attrs?: Attrs; readonly dropped: number; readonly invalidWhole: boolean };

function validEntry(key: string, value: unknown): value is AttrValue {
  if (utf8Bytes(key) > ATTR_KEY_MAX_BYTES || !ATTR_KEY_RE.test(key)) return false;
  if (typeof value === "string") return utf8Bytes(value) <= ATTR_STRING_MAX_BYTES;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "boolean";
}

/**
 * Validate `attrs` (spec 4.13, 4.9). `undefined` → no attrs. Not a plain object (null, array, scalar) →
 * `invalidWhole` (the caller marks `invalid-attrs`). An object with no accepted entry gives `attrs: undefined`.
 */
export function validateAttrs(raw: unknown): AttrsResult {
  if (raw === undefined) return { dropped: 0, invalidWhole: false };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { dropped: 0, invalidWhole: true };
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  const valid = keys.filter((key) => validEntry(key, record[key]));
  let dropped = keys.length - valid.length;
  const accepted: [string, AttrValue][] = [];
  let bytes = 2;
  for (let index = 0; index < valid.length; index += 1) {
    const key = valid[index] as string;
    const value = record[key] as AttrValue;
    const entryBytes =
      utf8Bytes(JSON.stringify(key)) + 1 + utf8Bytes(JSON.stringify(value)) + (accepted.length > 0 ? 1 : 0);
    if (accepted.length + 1 > ATTRS_MAX_KEYS || bytes + entryBytes > ATTRS_MAX_BYTES) {
      dropped += valid.length - index;
      break;
    }
    accepted.push([key, value]);
    bytes += entryBytes;
  }
  if (accepted.length === 0) return { dropped, invalidWhole: false };
  return { attrs: Object.freeze(Object.fromEntries(accepted)), dropped, invalidWhole: false };
}

/** Attrs for display and print (spec 4.13, 8.3): a masked key shows MASKED_TEXT, strings pass `maskString`. */
export function maskAttrs(attrs: Attrs): Attrs {
  const out: [string, AttrValue][] = [];
  for (const [key, value] of Object.entries(attrs)) {
    out.push([key, isMaskedKey(key) ? MASKED_TEXT : typeof value === "string" ? maskString(value) : value]);
  }
  return Object.freeze(Object.fromEntries(out));
}

/**
 * Kind glob (`:filter kind nest.*`, spec 6.6): `*` matches any run of characters, dots included, possibly
 * empty; every other character matches itself, case-sensitively. No regex is built from the glob.
 */
export function kindMatchesGlob(kind: string, glob: string): boolean {
  let k = 0;
  let g = 0;
  let starAt = -1;
  let resumeAt = 0;
  while (k < kind.length) {
    if (g < glob.length && glob[g] !== "*" && glob[g] === kind[k]) {
      k += 1;
      g += 1;
    } else if (g < glob.length && glob[g] === "*") {
      starAt = g;
      resumeAt = k;
      g += 1;
    } else if (starAt !== -1) {
      g = starAt + 1;
      resumeAt += 1;
      k = resumeAt;
    } else {
      return false;
    }
  }
  while (g < glob.length && glob[g] === "*") g += 1;
  return g === glob.length;
}
