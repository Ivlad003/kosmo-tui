/**
 * NDJSON container (spec 4.5) for a file and for stdin alike.
 *
 *  - The first non-empty line must be the header; a second header is fatal for the stream.
 *  - Records are flat: fields sit next to "type". Any order; a span may come before its
 *    parent or its trace line.
 *  - A line with an unknown "type" is skipped and counted (notice `unknown-lines-skipped`).
 *  - Stop semantics: a line error (not UTF-8, not JSON, not an object, a fatal 4.9
 *    violation, a line over 1 MiB) stops reading. What was read before stays: the result
 *    is ok with a `stream-stopped` notice (TUI banner; `--print` turns it into exit 2).
 *    Over 64 MiB or 200 000 spans: `stream stopped: too-large` (line null).
 *    Only a problem before or in the header is fatal: there is no dataset yet.
 *  - The signal aborts at once, even while the source is silent (Review focus 5).
 *  - `onProgress(spans)` runs after every chunk and once at the end («reading… N spans»).
 */
import type { DatasetInfo } from "../format/types.js";
import {
  DatasetAccumulator,
  LIMITS,
  validateHeader,
  validateLink,
  validateSpan,
  validateTraceDecl
} from "../format/validate.js";
import {
  ABORTED,
  describeFatal,
  errorText,
  fatalAt,
  fatalError,
  memoryDataset,
  nextChunk,
  readerError,
  releaseIterator
} from "./common.js";
import { LineSplitter, type LineEvent } from "./lines.js";
import type { Notice, OpenResult, Origin, ReaderDeps, ReaderError } from "./types.js";

export type NdjsonLimits = { readonly lineBytes: number; readonly streamBytes: number; readonly streamSpans: number };

export const NDJSON_LIMITS: NdjsonLimits = {
  lineBytes: LIMITS.ndjsonLineBytes,
  streamBytes: LIMITS.streamBytes,
  streamSpans: LIMITS.streamSpans
};

export type NdjsonResult =
  | {
      readonly ok: true;
      readonly info: DatasetInfo;
      readonly acc: DatasetAccumulator;
      readonly notices: readonly Notice[];
    }
  | { readonly ok: false; readonly error: ReaderError };

type Stop = { readonly line: number | null; readonly reason: string };

class NdjsonState {
  info: DatasetInfo | null = null;
  readonly acc = new DatasetAccumulator();
  unknownLines = 0;
  stop: Stop | null = null;
  fatal: ReaderError | null = null;

  constructor(private readonly limits: NdjsonLimits) {}

  get finished(): boolean {
    return this.stop !== null || this.fatal !== null;
  }

  handle(events: readonly LineEvent[]): void {
    for (const event of events) {
      if (this.finished) return;
      this.handleOne(event);
    }
  }

  private lineError(n: number, code: "invalid" | "too-large", what: string): void {
    const position = `line ${n}`;
    if (this.info === null) {
      this.fatal = fatalAt(code === "too-large" ? "too-large" : "not-a-kosmo-trace", position, what);
      return;
    }
    this.stop = { line: n, reason: `${code}(${position}: ${what})` };
  }

  private handleOne(event: LineEvent): void {
    if (event.kind === "too-long") {
      this.lineError(event.n, "too-large", `line exceeds ${this.limits.lineBytes} bytes`);
      return;
    }
    if (event.kind === "invalid-utf8") {
      this.lineError(event.n, "invalid", "not valid UTF-8");
      return;
    }
    if (/^[ \t]*$/.test(event.text)) return;
    const position = `line ${event.n}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.text);
    } catch {
      this.lineError(event.n, "invalid", "not valid JSON");
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.lineError(event.n, "invalid", "not a JSON object");
      return;
    }
    const { type, ...record } = parsed as Record<string, unknown>;
    if (this.info === null) {
      if (type !== "header") {
        this.fatal = fatalAt("not-a-kosmo-trace", position, "the first line is not a header");
        return;
      }
      const header = validateHeader(record, position);
      if (!header.ok) this.fatal = fatalError(header);
      else this.info = header.dataset;
      return;
    }
    if (typeof type !== "string") {
      this.lineError(event.n, "invalid", "missing type");
      return;
    }
    if (type === "header") {
      this.lineError(event.n, "invalid", "second header");
      return;
    }
    if (type === "trace") {
      const trace = validateTraceDecl(record, position);
      if (!trace.ok) return this.stopWith(event.n, describeFatal(trace));
      const duplicate = this.acc.addTrace(trace.trace, position);
      if (duplicate !== null) this.stopWith(event.n, describeFatal(duplicate));
      return;
    }
    if (type === "span") {
      if (this.acc.spanCount >= this.limits.streamSpans) {
        this.stop = { line: null, reason: "too-large" };
        return;
      }
      const span = validateSpan(record, position);
      if (!span.ok) return this.stopWith(event.n, describeFatal(span));
      const duplicate = this.acc.addSpan(span.span, position);
      if (duplicate !== null) this.stopWith(event.n, describeFatal(duplicate));
      return;
    }
    if (type === "link") {
      const link = validateLink(record, position);
      if (!link.ok) return this.stopWith(event.n, describeFatal(link));
      this.acc.addLink(link.link);
      return;
    }
    this.unknownLines += 1;
  }

  private stopWith(line: number, reason: string): void {
    this.stop = { line, reason };
  }
}

export async function readNdjson(
  chunks: AsyncIterable<Uint8Array>,
  options: { signal: AbortSignal; onProgress?: (spans: number) => void; limits?: NdjsonLimits }
): Promise<NdjsonResult> {
  const limits = options.limits ?? NDJSON_LIMITS;
  const state = new NdjsonState(limits);
  const splitter = new LineSplitter(limits.lineBytes);
  const iterator = chunks[Symbol.asyncIterator]();
  let total = 0;
  for (;;) {
    let next: Awaited<ReturnType<typeof nextChunk>>;
    try {
      next = await nextChunk(iterator, options.signal);
    } catch (error) {
      if (state.info === null)
        return { ok: false, error: readerError("read-error", `read-error: ${errorText(error)}`) };
      state.stop = { line: null, reason: `read-error(${errorText(error)})` };
      break;
    }
    if (next === "aborted") {
      releaseIterator(iterator);
      return { ok: false, error: ABORTED };
    }
    if (next.done === true) {
      state.handle(splitter.end());
      break;
    }
    let chunk = next.value;
    const overCap = total + chunk.length > limits.streamBytes;
    if (overCap) chunk = chunk.subarray(0, limits.streamBytes - total);
    total += chunk.length;
    state.handle(splitter.push(chunk));
    if (!state.finished && overCap) state.stop = { line: null, reason: "too-large" };
    if (state.finished) {
      releaseIterator(iterator);
      break;
    }
    options.onProgress?.(state.acc.spanCount);
  }
  if (state.fatal !== null) return { ok: false, error: state.fatal };
  if (state.info === null) return { ok: false, error: fatalAt("not-a-kosmo-trace", "line 1", "no header line") };
  options.onProgress?.(state.acc.spanCount);
  const notices: Notice[] = [];
  if (state.stop !== null) notices.push({ kind: "stream-stopped", line: state.stop.line, reason: state.stop.reason });
  if (state.unknownLines > 0) notices.push({ kind: "unknown-lines-skipped", count: state.unknownLines });
  return { ok: true, info: state.info, acc: state.acc, notices };
}

export async function openNdjson(
  origin: Origin,
  chunks: AsyncIterable<Uint8Array>,
  deps: ReaderDeps,
  signal: AbortSignal
): Promise<OpenResult> {
  const result = await readNdjson(chunks, {
    signal,
    ...(deps.onProgress !== undefined ? { onProgress: deps.onProgress } : {})
  });
  if (!result.ok) return result;
  return {
    ok: true,
    dataset: memoryDataset({ kind: "ndjson", origin, info: result.info, acc: result.acc, notices: result.notices })
  };
}
