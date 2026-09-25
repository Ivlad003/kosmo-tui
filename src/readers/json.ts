/**
 * The JSON document container (spec 4.1). The size is checked before anything is read
 * (4.9: > 64 MiB → too-large), the bytes must be UTF-8 (a leading BOM is dropped), the
 * document goes through `validateDocument`, and the dataset stays in memory with its
 * values: `get(ref).values` is filled, there is no `loadValues`.
 *
 * Error messages never quote the input: JSON.parse messages differ between V8 versions
 * and cite source text, so a parse failure is reported as "not valid JSON" at "$".
 */
import { LIMITS, validateDocument } from "../format/validate.js";
import { FileTooLargeError, errorText, fatalAt, fatalError, memoryDataset, readerError } from "./common.js";
import type { Notice, OpenResult, Origin, ReaderFs } from "./types.js";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function parseJsonDocument(bytes: Uint8Array, origin: Origin): OpenResult {
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  let text: string;
  try {
    text = strictUtf8.decode(body);
  } catch {
    return { ok: false, error: fatalAt("invalid", "$", "not valid UTF-8") };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: fatalAt("not-a-kosmo-trace", "$", "not valid JSON") };
  }
  const result = validateDocument(raw);
  if (!result.ok) return { ok: false, error: fatalError(result) };
  const notices: Notice[] =
    result.unknownFields > 0 ? [{ kind: "unknown-fields-ignored", count: result.unknownFields }] : [];
  return {
    ok: true,
    dataset: memoryDataset({ kind: "json", origin, info: result.dataset, acc: result.acc, notices })
  };
}

export async function openJsonFile(path: string, size: number, fs: ReaderFs): Promise<OpenResult> {
  if (size > LIMITS.fileBytes) return { ok: false, error: tooLarge(path) };
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(path, LIMITS.fileBytes);
  } catch (error) {
    if (error instanceof FileTooLargeError) return { ok: false, error: tooLarge(path) };
    return { ok: false, error: readerError("read-error", `read-error: ${path}: ${errorText(error)}`) };
  }
  return parseJsonDocument(bytes, { path });
}

function tooLarge(path: string) {
  return readerError("too-large", `too-large: ${path} is larger than ${LIMITS.fileBytes} bytes`);
}
