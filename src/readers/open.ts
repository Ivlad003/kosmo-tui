/**
 * The single entry point for reading a kosmo-trace (spec 5.4, 6.8): stat the path, sniff
 * the container from its head, hand it to the json / ndjson / sqlite reader. stdin and
 * other non-regular files (a FIFO, `<(producer)`) are sniffed from the stream itself.
 *
 * Error codes map to exit codes in the CLI (spec 6.8): file-not-found and is-directory
 * give 1, the format errors give 2.
 */
import { LIMITS } from "../format/validate.js";
import { ABORTED, concatBytes, errorText, fatalAt, nextChunk, readerError, releaseIterator } from "./common.js";
import { openJsonFile, parseJsonDocument } from "./json.js";
import { openNdjson } from "./ndjson.js";
import { SNIFF_HEAD_BYTES, SQLITE_MAGIC, firstLineComplete, sniffContainer } from "./sniff.js";
import { openSqliteFile } from "./sqlite.js";
import type { OpenResult, OpenedDataset, Origin, ReaderDeps } from "./types.js";

export async function openTarget(origin: Origin, deps: ReaderDeps, signal: AbortSignal): Promise<OpenResult> {
  if (signal.aborted) return { ok: false, error: ABORTED };
  if (origin === "stdin") {
    if (deps.stdin === undefined)
      return { ok: false, error: readerError("read-error", "read-error: stdin is not available") };
    return openStream(origin, deps.stdin, deps, signal);
  }
  const path = origin.path;
  let stat: Awaited<ReturnType<ReaderDeps["fs"]["stat"]>>;
  try {
    stat = await deps.fs.stat(path);
  } catch (error) {
    return { ok: false, error: readerError("read-error", `read-error: ${path}: ${errorText(error)}`) };
  }
  if (stat === undefined) return { ok: false, error: readerError("file-not-found", `file-not-found: ${path}`) };
  if (stat.isDirectory) return { ok: false, error: readerError("is-directory", `is-directory: ${path}`) };
  if (!stat.isFile) return openStream(origin, deps.fs.createReadStream(path), deps, signal);
  let head: Uint8Array;
  try {
    head = await deps.fs.readHead(path, SNIFF_HEAD_BYTES);
  } catch (error) {
    return { ok: false, error: readerError("read-error", `read-error: ${path}: ${errorText(error)}`) };
  }
  const kind = sniffContainer(head, path);
  if (kind === null) return { ok: false, error: fatalAt("not-a-kosmo-trace", "$", "empty input") };
  if (kind === "json") return openJsonFile(path, stat.size, deps.fs);
  if (kind === "ndjson") return openNdjson(origin, deps.fs.createReadStream(path), deps, signal);
  return openSqliteFile(path, stat.size, deps, signal);
}

/** Read the same origin again (`r`, spec 6.7); null for stdin: `reload: unavailable(stdin-stream)`. */
export function reopen(dataset: OpenedDataset, deps: ReaderDeps, signal: AbortSignal): Promise<OpenResult> | null {
  return dataset.origin === "stdin" ? null : openTarget(dataset.origin, deps, signal);
}

/** Yields `head` first, then whatever is left of `iterator`; `return()` releases the source. */
function prepend(head: Uint8Array, iterator: AsyncIterator<Uint8Array>, done: boolean): AsyncIterable<Uint8Array> {
  let pending: Uint8Array | null = head.length > 0 ? head : null;
  let finished = done;
  const replay: AsyncIterator<Uint8Array> = {
    async next(): Promise<IteratorResult<Uint8Array>> {
      if (pending !== null) {
        const value = pending;
        pending = null;
        return { done: false, value };
      }
      if (finished) return { done: true, value: undefined };
      return iterator.next();
    },
    async return(): Promise<IteratorResult<Uint8Array>> {
      finished = true;
      pending = null;
      releaseIterator(iterator);
      return { done: true, value: undefined };
    }
  };
  return { [Symbol.asyncIterator]: () => replay };
}

async function openStream(
  origin: Origin,
  chunks: AsyncIterable<Uint8Array>,
  deps: ReaderDeps,
  signal: AbortSignal
): Promise<OpenResult> {
  const iterator = chunks[Symbol.asyncIterator]();
  const parts: Uint8Array[] = [];
  let total = 0;
  let done = false;
  let ready = false;
  while (!done && !ready && total < SNIFF_HEAD_BYTES) {
    let next: Awaited<ReturnType<typeof nextChunk>>;
    try {
      next = await nextChunk(iterator, signal);
    } catch (error) {
      return { ok: false, error: readerError("read-error", `read-error: ${errorText(error)}`) };
    }
    if (next === "aborted") {
      releaseIterator(iterator);
      return { ok: false, error: ABORTED };
    }
    if (next.done === true) {
      done = true;
      break;
    }
    parts.push(next.value);
    total += next.value.length;
    if (total >= SQLITE_MAGIC.length && next.value.includes(0x0a)) ready = firstLineComplete(concatBytes(parts, total));
  }
  const head = concatBytes(parts, total);
  const kind = sniffContainer(head, origin === "stdin" ? undefined : origin.path);
  if (kind === null || kind === "sqlite") {
    releaseIterator(iterator);
    if (kind === null) return { ok: false, error: fatalAt("not-a-kosmo-trace", "$", "empty input") };
    return {
      ok: false,
      error: readerError("read-error", "read-error: a SQLite store cannot be read from a stream; pass its path")
    };
  }
  const rest = prepend(head, iterator, done);
  if (kind === "ndjson") return openNdjson(origin, rest, deps, signal);
  const collected = await collect(rest, LIMITS.fileBytes, signal);
  if (!collected.ok) return collected;
  return parseJsonDocument(collected.bytes, origin);
}

async function collect(
  chunks: AsyncIterable<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: ReturnType<typeof readerError> }> {
  const iterator = chunks[Symbol.asyncIterator]();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let next: Awaited<ReturnType<typeof nextChunk>>;
    try {
      next = await nextChunk(iterator, signal);
    } catch (error) {
      return { ok: false, error: readerError("read-error", `read-error: ${errorText(error)}`) };
    }
    if (next === "aborted") {
      releaseIterator(iterator);
      return { ok: false, error: ABORTED };
    }
    if (next.done === true) return { ok: true, bytes: concatBytes(parts, total) };
    total += next.value.length;
    if (total > maxBytes) {
      releaseIterator(iterator);
      return { ok: false, error: readerError("too-large", `too-large: input is larger than ${maxBytes} bytes`) };
    }
    parts.push(next.value);
  }
}
