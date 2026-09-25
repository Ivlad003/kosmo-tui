/**
 * Helpers shared by the json, ndjson and sqlite readers: error shapes, byte buffers,
 * abortable iteration over a chunk stream, and the in-memory dataset that json and
 * ndjson both produce. Pure: no Node imports.
 */
import { buildTraceModel, type TraceModel } from "../format/model.js";
import type { DatasetInfo, Fatal, Position } from "../format/types.js";
import type { DatasetAccumulator } from "../format/validate.js";
import type { ContainerKind, Notice, OpenedDataset, Origin, ReaderError, ReaderErrorCode } from "./types.js";

/** Thrown by `ReaderFs.readFile` when the file is larger than its `maxBytes`. */
export class FileTooLargeError extends Error {
  constructor(
    readonly path: string,
    readonly maxBytes: number
  ) {
    super(`file is larger than ${maxBytes} bytes`);
    this.name = "FileTooLargeError";
  }
}

/** Spec 12: `invalid(<позиція>: <що>)`, and the same shape for every other fatal code. */
export function describeFatal(fatal: Fatal): string {
  return `${fatal.code}(${fatal.position}: ${fatal.what})`;
}

export function fatalError(fatal: Fatal): ReaderError {
  return { code: fatal.code, message: describeFatal(fatal), position: fatal.position };
}

export function readerError(code: ReaderErrorCode, message: string, position?: Position): ReaderError {
  return position === undefined ? { code, message } : { code, message, position };
}

/** A fatal-shaped error built here (not by the validator): same message format. */
export function fatalAt(code: Fatal["code"], position: Position, what: string): ReaderError {
  return fatalError({ ok: false, code, position, what });
}

export const ABORTED: ReaderError = { code: "stream-stopped", message: "stream-stopped: reading was cancelled" };

export function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

export function concatBytes(parts: readonly Uint8Array[], total?: number): Uint8Array {
  const length = total ?? parts.reduce((sum, part) => sum + part.length, 0);
  if (parts.length === 1 && parts[0]!.length === length) return parts[0]!;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * The next chunk, or "aborted" as soon as the signal fires, even if the source never
 * yields again (a stdin that never ends must not block `q`, Review focus 5).
 */
export async function nextChunk(
  iterator: AsyncIterator<Uint8Array>,
  signal: AbortSignal
): Promise<IteratorResult<Uint8Array> | "aborted"> {
  if (signal.aborted) return "aborted";
  const next = iterator.next();
  next.catch(() => undefined);
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<"aborted">((resolve) => {
    onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([next, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Ask the source to stop (a Node stream is destroyed); never waits for it. */
export function releaseIterator(iterator: AsyncIterator<Uint8Array>): void {
  try {
    const done = iterator.return?.();
    if (done !== undefined) done.catch(() => undefined);
  } catch {
    // the source is already gone
  }
}

/** json and ndjson: everything is in memory once the dataset is open; models are built once. */
export function memoryDataset(input: {
  kind: ContainerKind;
  origin: Origin;
  info: DatasetInfo;
  acc: DatasetAccumulator;
  notices: readonly Notice[];
}): OpenedDataset {
  const items = input.acc.traceSummaries();
  const models = new Map<string, TraceModel>();
  return {
    kind: input.kind,
    origin: input.origin,
    info: input.info,
    traces: { items, hasMore: false },
    notices: input.notices,
    async loadTrace(id) {
      const cached = models.get(id);
      if (cached !== undefined) return { ok: true, model: cached };
      const summary = items.find((item) => item.id === id);
      if (summary === undefined)
        return {
          ok: false,
          error: readerError("invalid", `invalid(trace: no trace ${JSON.stringify(id)} in this dataset)`)
        };
      const model = buildTraceModel(
        { id: summary.id, name: summary.name },
        input.acc.spansOf(id),
        input.acc.linksOf(id)
      );
      models.set(id, model);
      return { ok: true, model };
    },
    async close() {
      models.clear();
    }
  };
}
