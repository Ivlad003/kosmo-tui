/**
 * Reader contracts (plan "Контракти", spec 5.3). Types only: no I/O, no Node imports.
 *
 * A reader turns an origin (a path or stdin) into an OpenedDataset. Everything a source
 * cannot do is simply absent: only sqlite has `loadMoreTraces` and `loadValues`.
 * `ReaderError.message` may quote the path the user gave; callers escape it with
 * `escapeTerminalControls` before it reaches a terminal (spec 8.1).
 */
import type { TraceModel } from "../format/model.js";
import type { DatasetInfo, Position, SpanRef, SpanValues, TraceSummary } from "../format/types.js";

export type ContainerKind = "json" | "ndjson" | "sqlite";
export type ReaderErrorCode =
  | "file-not-found"
  | "is-directory"
  | "too-large"
  | "not-a-kosmo-trace"
  | "not-a-kosmo-trace-store"
  | "unsupported-version"
  | "invalid"
  | "stream-stopped"
  | "trace-too-large"
  | "read-error";
export type ReaderError = { readonly code: ReaderErrorCode; readonly message: string; readonly position?: Position };
export type Notice =
  | { readonly kind: "stream-stopped"; readonly line: number | null; readonly reason: string }
  | { readonly kind: "unknown-lines-skipped"; readonly count: number }
  | { readonly kind: "unknown-fields-ignored"; readonly count: number };
export type TraceListPage = { readonly items: readonly TraceSummary[]; readonly hasMore: boolean };
export type Origin = { readonly path: string } | "stdin";
export type OpenedDataset = {
  readonly kind: ContainerKind;
  readonly origin: Origin;
  readonly info: DatasetInfo;
  readonly traces: TraceListPage;
  readonly notices: readonly Notice[];
  loadMoreTraces?(signal: AbortSignal): Promise<TraceListPage>;
  loadTrace(
    id: string,
    signal: AbortSignal
  ): Promise<{ ok: true; model: TraceModel } | { ok: false; error: ReaderError }>;
  loadValues?(ref: SpanRef, signal: AbortSignal): Promise<SpanValues>;
  close(): Promise<void>;
};
export type OpenResult =
  { readonly ok: true; readonly dataset: OpenedDataset } | { readonly ok: false; readonly error: ReaderError };
export type ReaderFs = {
  stat(path: string): Promise<{ size: number; isFile: boolean; isDirectory: boolean } | undefined>;
  readHead(path: string, bytes: number): Promise<Uint8Array>;
  /** Throws (FileTooLargeError from ./common.js) when the file is larger than maxBytes. */
  readFile(path: string, maxBytes: number): Promise<Uint8Array>;
  createReadStream(path: string): AsyncIterable<Uint8Array>;
};
export type SqliteModule = { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase };
export type SqliteDatabase = {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
  close(): void;
};
export type ReaderDeps = {
  fs: ReaderFs;
  stdin?: AsyncIterable<Uint8Array>;
  /** Task 10; null → sqlite is unavailable on this Node. */
  loadSqlite?: () => SqliteModule | null;
  /** «reading… N spans» while an NDJSON stream is read. */
  onProgress?: (spans: number) => void;
};
