/**
 * Container detection (spec 6.8), the same for a file and for stdin:
 *  1. SQLite magic "SQLite format 3\0" → sqlite;
 *  2. otherwise the first non-empty line (at most 1 MiB, BOM dropped): a complete JSON
 *     object with "type":"header" → ndjson, otherwise a JSON document;
 *  3. the extension decides only the ambiguous cases: no non-empty line at all, or a
 *     first line that is a complete object with a string "type" other than "header"
 *     (an NDJSON record without its header, or a document with a stray field).
 * Pure: `head` is the first SNIFF_HEAD_BYTES of the input (fewer at EOF).
 */
import { LIMITS } from "../format/validate.js";
import type { ContainerKind } from "./types.js";

export const SQLITE_MAGIC = new Uint8Array([
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00
]);

/** Room for a 1 MiB first line plus a BOM, CRLF and a few blank lines before it. */
export const SNIFF_HEAD_BYTES = LIMITS.ndjsonLineBytes + 4096;

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

function hasSqliteMagic(head: Uint8Array): boolean {
  if (head.length < SQLITE_MAGIC.length) return false;
  return SQLITE_MAGIC.every((byte, index) => head[index] === byte);
}

function extensionKind(path: string | undefined): ContainerKind | null {
  const lower = path?.toLowerCase() ?? "";
  if (lower.endsWith(".ndjson")) return "ndjson";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".sqlite") || lower.endsWith(".sqlite3")) return "sqlite";
  return null;
}

/** The first line that is not blank (CR and BOM dropped) and whether its line end is in `head`. */
function firstNonEmptyLine(head: Uint8Array): { line: Uint8Array; complete: boolean } | null {
  let start = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
  while (start < head.length) {
    const newline = head.indexOf(0x0a, start);
    const end = newline === -1 ? head.length : newline;
    let line = head.subarray(start, end);
    if (line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
    if (line.some((byte) => byte !== 0x20 && byte !== 0x09 && byte !== 0x0d)) return { line, complete: newline !== -1 };
    if (newline === -1) return null;
    start = newline + 1;
  }
  return null;
}

/** A stream head is enough to sniff once its first non-empty line has ended. */
export function firstLineComplete(head: Uint8Array): boolean {
  return firstNonEmptyLine(head)?.complete === true;
}

/**
 * Whether an accumulated stream head already decides the sniff: it holds the SQLite magic, or its
 * first non-empty line has ended. A head that is only a SQLite-magic prefix has no newline, so the
 * line rule never fires early on it.
 */
export function sniffReady(head: Uint8Array): boolean {
  return hasSqliteMagic(head) || firstLineComplete(head);
}

function parseObject(line: Uint8Array): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(decoder.decode(line));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function sniffContainer(head: Uint8Array, path?: string): ContainerKind | null {
  if (hasSqliteMagic(head)) return "sqlite";
  const first = firstNonEmptyLine(head);
  if (first === null) return extensionKind(path);
  const line = first.line;
  if (line.length > LIMITS.ndjsonLineBytes) return "json";
  const object = parseObject(line);
  if (object === undefined) return "json";
  if (object.type === "header") return "ndjson";
  if (typeof object.type === "string" && !("format" in object))
    return extensionKind(path) === "ndjson" ? "ndjson" : "json";
  return "json";
}
