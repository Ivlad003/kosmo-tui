/**
 * The SQLite container (spec 4.6), read-only.
 *
 *  - Opened with `readOnly: true` through the injected `loadSqlite` (sqlite-loader.ts), never
 *    through a static import. A WAL store in a read-only directory cannot create its -shm
 *    file; then it is opened again as an `immutable=1` URI (nobody can be writing there).
 *    node:sqlite before Node 22.15 takes no URI filenames, so there that retry fails with
 *    SQLITE_CANTOPEN and the reader names the cause instead of the first SQLite message.
 *  - Missing table or column → not-a-kosmo-trace-store (this also covers a callflow store).
 *    Extra tables and columns are ignored (4.11).
 *  - kosmo_meta: format → not-a-kosmo-trace, version → unsupported-version, dataset JSON
 *    through validateHeader.
 *  - Every kosmo_spans.trace must have a kosmo_traces row: one `… EXCEPT …` query.
 *  - Trace list: pages of 200 by `id` (BINARY collation = UTF-8 byte order, like the other
 *    readers); spans/status/requests come from ONE aggregate query per page.
 *  - loadTrace: one query without args/ret/error; more than 200 000 spans → trace-too-large(N).
 *    Rows go through the same validateSpan as JSON, so marks, attrs and positions agree.
 *  - loadValues: lazy per span; a field that fails becomes invalid-value(<table/pk>: <what>)
 *    and the trace stays open.
 */
import { validateAttrs } from "../format/kinds.js";
import { buildTraceModel, requestSummaryOf } from "../format/model.js";
import {
  NOT_RECORDED,
  type DatasetInfo,
  type SpanRef,
  type SpanRow,
  type SpanValues,
  type TraceDecl,
  type TraceStatus,
  type TraceSummary,
  type Value
} from "../format/types.js";
import {
  DatasetAccumulator,
  LIMITS,
  validateHeader,
  validateLink,
  validateSpan,
  validateTraceDecl
} from "../format/validate.js";
import { ABORTED, errorText, fatalAt, fatalError, readerError } from "./common.js";
import type {
  OpenResult,
  OpenedDataset,
  ReaderDeps,
  ReaderError,
  SqliteDatabase,
  SqliteModule,
  TraceListPage
} from "./types.js";

export const SQLITE_TRACE_PAGE = 200;
export const SQLITE_BUSY_TIMEOUT_MS = 1000;

export const SQLITE_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  kosmo_meta: ["key", "value"],
  kosmo_traces: ["id", "name"],
  kosmo_spans: [
    "trace",
    "session",
    "id",
    "parent",
    "parent_session",
    "order",
    "name",
    "kind",
    "status",
    "status_reason",
    "duration_ms",
    "runtime",
    "file",
    "line",
    "col",
    "end_line",
    "snippet",
    "snippet_cut",
    "area_module",
    "area_feature",
    "attrs",
    "args",
    "ret",
    "error"
  ],
  kosmo_links: ["from_trace", "from_session", "from_id", "to_trace", "to_session", "to_id", "kind"]
};

type Row = Record<string, unknown>;
type Failure = { ok: false; error: ReaderError };

const SPAN_COLUMNS =
  'trace, session, id, parent, parent_session, "order", name, kind, status, status_reason, duration_ms, runtime, ' +
  "file, line, col, end_line, snippet, snippet_cut, area_module, area_feature, attrs";

const PAGE_SQL = `
WITH page AS (
  SELECT id, name FROM kosmo_traces WHERE (? IS NULL OR id > ?) ORDER BY id LIMIT ?
)
SELECT page.id AS id, page.name AS name,
  COUNT(s.id) AS spans,
  COALESCE(MAX(s.status = 'errored'), 0) AS errored,
  COALESCE(MAX(s.status NOT IN ('complete', 'errored', 'suspended')), 0) AS incomplete,
  COALESCE(SUM(s.kind = 'http.server'), 0) AS requests,
  (SELECT h.attrs FROM kosmo_spans h WHERE h.trace = page.id AND h.kind = 'http.server'
    ORDER BY h.session, h."order" LIMIT 1) AS first_attrs
FROM page LEFT JOIN kosmo_spans s ON s.trace = page.id
GROUP BY page.id, page.name
ORDER BY page.id`;

const VALUE_FIELDS = [
  ["args", "args"],
  ["ret", "return"],
  ["error", "error"]
] as const;

function allRows(db: SqliteDatabase, sql: string, ...params: unknown[]): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

function oneRow(db: SqliteDatabase, sql: string, ...params: unknown[]): Row | undefined {
  const row = db.prepare(sql).get(...params);
  return row === undefined || row === null ? undefined : (row as Row);
}

function safeClose(db: SqliteDatabase): void {
  try {
    db.close();
  } catch {
    // already closed
  }
}

/**
 * Primary result codes by the text of sqlite3_errstr: an older node:sqlite may throw
 * without `errcode`, and the reader must still tell "read-only directory" (retry as
 * immutable) and "not a database" (refusal) from other failures.
 */
const SQLITE_MESSAGES: ReadonlyArray<readonly [RegExp, number]> = [
  [/attempt to write a readonly database/i, 8],
  [/database disk image is malformed/i, 11],
  [/unable to open database file/i, 14],
  [/file is not a database/i, 26]
];

function sqliteErrcode(error: unknown): number | undefined {
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  if (typeof errcode === "number") return errcode & 0xff;
  const text = error instanceof Error ? error.message : String(error);
  return SQLITE_MESSAGES.find(([pattern]) => pattern.test(text))?.[1];
}

/** Spec 4.9 position for SQLite: table and primary key. */
export function sqlitePosition(trace: unknown, session: unknown, id: unknown): string {
  return `kosmo_spans(${String(trace)},${String(session)},${String(id)})`;
}

/** `file:` URI with immutable=1: read without -shm/-wal (a read-only directory, Review focus 5). */
export function immutableUri(path: string): string {
  return `file:${path.split("/").map(encodeURIComponent).join("/")}?immutable=1`;
}

function parseJsonText(text: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof text !== "string") return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * A kosmo_spans row as the raw span object of spec 4.1, so that validateSpan applies the
 * very same rules as for JSON and NDJSON. NULL means "field absent"; snippet_cut 1/0 is
 * true/false; attrs text that is not JSON stays a string, which validateSpan reports as
 * invalid-attrs (4.9: attrs that are not an object).
 */
export function spanFromRow(row: Row): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    trace: row.trace,
    session: row.session,
    id: row.id,
    parent: row.parent ?? null,
    order: row.order,
    name: row.name,
    status: row.status
  };
  if (row.parent_session != null) raw.parentSession = row.parent_session;
  if (row.kind != null) raw.kind = row.kind;
  if (row.status_reason != null) raw.statusReason = row.status_reason;
  if (row.duration_ms != null) raw.durationMs = row.duration_ms;
  if (row.runtime != null) raw.runtime = row.runtime;
  if (row.file != null || row.line != null) {
    const location: Record<string, unknown> = {};
    if (row.file != null) location.file = row.file;
    if (row.line != null) location.line = row.line;
    if (row.col != null) location.column = row.col;
    if (row.end_line != null) location.endLine = row.end_line;
    if (row.snippet != null) location.snippet = row.snippet;
    if (row.snippet_cut != null)
      location.snippetCut = row.snippet_cut === 1 ? true : row.snippet_cut === 0 ? false : row.snippet_cut;
    raw.location = location;
  }
  if (row.area_module != null || row.area_feature != null) {
    const area: Record<string, unknown> = {};
    if (row.area_module != null) area.module = row.area_module;
    if (row.area_feature != null) area.feature = row.area_feature;
    raw.area = area;
  }
  if (row.attrs != null) {
    const attrs = parseJsonText(row.attrs);
    raw.attrs = attrs.ok ? attrs.value : row.attrs;
  }
  return raw;
}

function openReadOnly(sqlite: SqliteModule, path: string): { ok: true; db: SqliteDatabase } | Failure {
  const first = tryOpen(sqlite, path, path);
  if (first.ok || !first.retry) return first;
  const second = tryOpen(sqlite, immutableUri(path), path);
  if (second.ok) return second;
  // SQLITE_READONLY (8), then SQLITE_CANTOPEN (14) for the URI: this node:sqlite reads
  // "file:…?immutable=1" as a plain path that does not exist (no URI filenames before 22.15).
  if (first.code === 8 && second.code === 14)
    return {
      ok: false,
      error: readerError(
        "read-error",
        `read-error: ${path}: a WAL store in a read-only directory needs Node >= 22.15 (SQLite URI filenames)`
      )
    };
  return { ok: false, error: first.error };
}

function tryOpen(
  sqlite: SqliteModule,
  target: string,
  path: string
): { ok: true; db: SqliteDatabase } | { ok: false; retry: boolean; code: number | undefined; error: ReaderError } {
  let db: SqliteDatabase;
  try {
    db = new sqlite.DatabaseSync(target, { readOnly: true });
  } catch (error) {
    return { ok: false, retry: false, code: sqliteErrcode(error), error: classify(error, path) };
  }
  try {
    db.prepare(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`).get();
    db.prepare("SELECT count(*) AS n FROM sqlite_master").get();
    return { ok: true, db };
  } catch (error) {
    safeClose(db);
    const code = sqliteErrcode(error);
    // SQLITE_READONLY (8) / SQLITE_CANTOPEN (14): WAL without a writable directory.
    return { ok: false, retry: code === 8 || code === 14, code, error: classify(error, path) };
  }
}

function classify(error: unknown, path: string): ReaderError {
  const code = sqliteErrcode(error);
  // SQLITE_NOTADB (26) / SQLITE_CORRUPT (11): magic bytes, but not a usable database.
  if (code === 26 || code === 11) return fatalAt("not-a-kosmo-trace-store", "sqlite", "not a SQLite database");
  return readerError("read-error", `read-error: ${path}: ${errorText(error)}`);
}

function checkStore(db: SqliteDatabase): { ok: true; info: DatasetInfo } | Failure {
  for (const [table, columns] of Object.entries(SQLITE_REQUIRED_COLUMNS)) {
    const present = new Set(allRows(db, "SELECT name FROM pragma_table_info(?)", table).map((row) => String(row.name)));
    if (present.size === 0) return { ok: false, error: fatalAt("not-a-kosmo-trace-store", table, "missing table") };
    const missing = columns.find((column) => !present.has(column));
    if (missing !== undefined)
      return { ok: false, error: fatalAt("not-a-kosmo-trace-store", table, `missing column ${missing}`) };
  }
  const meta = new Map(
    allRows(db, "SELECT key, value FROM kosmo_meta WHERE key IN ('format', 'version', 'dataset')").map((row) => [
      String(row.key),
      row.value
    ])
  );
  const format = meta.get("format");
  if (format === undefined)
    return { ok: false, error: fatalAt("not-a-kosmo-trace-store", "kosmo_meta(format)", "missing row") };
  if (format !== "kosmo-trace")
    return { ok: false, error: fatalAt("not-a-kosmo-trace", "kosmo_meta(format)", "format is not kosmo-trace") };
  const version = meta.get("version");
  if (version === undefined)
    return { ok: false, error: fatalAt("not-a-kosmo-trace-store", "kosmo_meta(version)", "missing row") };
  if (version !== "1")
    return { ok: false, error: fatalAt("unsupported-version", "kosmo_meta(version)", "version is not 1") };
  const datasetText = meta.get("dataset");
  if (datasetText === undefined) return { ok: false, error: fatalAt("invalid", "kosmo_meta(dataset)", "missing row") };
  const dataset = parseJsonText(datasetText);
  if (!dataset.ok) return { ok: false, error: fatalAt("invalid", "kosmo_meta(dataset)", "not valid JSON") };
  const header = validateHeader({ format: "kosmo-trace", version: 1, dataset: dataset.value }, "kosmo_meta");
  if (!header.ok) return { ok: false, error: fatalError(header) };
  const orphan = oneRow(db, "SELECT trace FROM kosmo_spans EXCEPT SELECT id FROM kosmo_traces LIMIT 1");
  if (orphan !== undefined)
    return {
      ok: false,
      error: fatalAt("invalid", `kosmo_spans(${String(orphan.trace)})`, "trace has no row in kosmo_traces")
    };
  return { ok: true, info: header.dataset };
}

function traceDeclFromRow(row: Row): { ok: true; trace: TraceDecl } | Failure {
  const raw = row.name == null ? { id: row.id } : { id: row.id, name: row.name };
  const decl = validateTraceDecl(raw, `kosmo_traces(${String(row.id)})`);
  return decl.ok ? decl : { ok: false, error: fatalError(decl) };
}

/** The `first` http.server request exactly as requestSummaryOf reads it from attrs. */
function firstRequest(traceId: string, attrsText: unknown): NonNullable<TraceSummary["requests"]>["first"] {
  let rawAttrs: unknown;
  if (attrsText != null) {
    const parsed = parseJsonText(attrsText);
    rawAttrs = parsed.ok ? parsed.value : attrsText;
  }
  const attrs = validateAttrs(rawAttrs).attrs;
  const probe: SpanRow = {
    ref: { trace: traceId, session: "", id: "" },
    parent: null,
    order: 0,
    name: "",
    kind: "http.server",
    status: "complete",
    droppedAttrs: 0,
    marks: [],
    ...(attrs !== undefined ? { attrs } : {})
  };
  return requestSummaryOf([probe])?.first ?? null;
}

function summaryFromRow(trace: TraceDecl, row: Row): TraceSummary {
  const requests = Number(row.requests);
  const status: TraceStatus =
    Number(row.errored) > 0 ? "errored" : Number(row.incomplete) > 0 ? "incomplete" : "complete";
  return {
    id: trace.id,
    name: trace.name,
    spans: Number(row.spans),
    status,
    requests: requests > 0 ? { first: firstRequest(trace.id, row.first_attrs), count: requests } : null
  };
}

function loadPage(
  db: SqliteDatabase,
  after: string | null
): { ok: true; page: TraceListPage; last: string | null } | Failure {
  try {
    const rows = allRows(db, PAGE_SQL, after, after, SQLITE_TRACE_PAGE + 1);
    const items: TraceSummary[] = [];
    for (const row of rows.slice(0, SQLITE_TRACE_PAGE)) {
      const decl = traceDeclFromRow(row);
      if (!decl.ok) return decl;
      items.push(summaryFromRow(decl.trace, row));
    }
    return { ok: true, page: { items, hasMore: rows.length > SQLITE_TRACE_PAGE }, last: items.at(-1)?.id ?? after };
  } catch (error) {
    return { ok: false, error: readerError("read-error", `read-error: ${errorText(error)}`) };
  }
}

function allInvalid(position: string, what: string): SpanValues {
  const value: Value = { state: "invalid-value", position, what };
  return { args: value, return: value, error: value };
}

function loadTraceFrom(db: SqliteDatabase, id: string): Awaited<ReturnType<OpenedDataset["loadTrace"]>> {
  try {
    const traceRow = oneRow(db, "SELECT id, name FROM kosmo_traces WHERE id = ?", id);
    if (traceRow === undefined)
      return {
        ok: false,
        error: readerError("invalid", `invalid(trace: no trace ${JSON.stringify(id)} in this dataset)`)
      };
    const decl = traceDeclFromRow(traceRow);
    if (!decl.ok) return decl;
    const count = Number(oneRow(db, "SELECT COUNT(*) AS n FROM kosmo_spans WHERE trace = ?", id)?.n ?? 0);
    if (count > LIMITS.traceSpans)
      return { ok: false, error: readerError("trace-too-large", `trace-too-large(${count})`, `kosmo_traces(${id})`) };
    const acc = new DatasetAccumulator();
    acc.addTrace(decl.trace, `kosmo_traces(${id})`);
    const spans = allRows(db, `SELECT ${SPAN_COLUMNS} FROM kosmo_spans WHERE trace = ? ORDER BY session, "order"`, id);
    for (const row of spans) {
      const position = sqlitePosition(row.trace, row.session, row.id);
      const span = validateSpan(spanFromRow(row), position, { values: false });
      if (!span.ok) return { ok: false, error: fatalError(span) };
      const duplicate = acc.addSpan(span.span, position);
      if (duplicate !== null) return { ok: false, error: fatalError(duplicate) };
    }
    const links = allRows(
      db,
      "SELECT from_trace, from_session, from_id, to_trace, to_session, to_id, kind FROM kosmo_links " +
        "WHERE from_trace = ? OR to_trace = ? ORDER BY rowid",
      id,
      id
    );
    for (const row of links) {
      const position = `kosmo_links(${String(row.from_trace)},${String(row.from_session)},${String(row.from_id)})`;
      const link = validateLink(
        {
          from: { trace: row.from_trace, session: row.from_session, id: row.from_id },
          to: { trace: row.to_trace, session: row.to_session, id: row.to_id },
          kind: row.kind
        },
        position
      );
      if (!link.ok) return { ok: false, error: fatalError(link) };
      acc.addLink(link.link);
    }
    return { ok: true, model: buildTraceModel(decl.trace, acc.spansOf(id), acc.linksOf(id)) };
  } catch (error) {
    return { ok: false, error: readerError("read-error", `read-error: ${errorText(error)}`) };
  }
}

function loadValuesFrom(db: SqliteDatabase, ref: SpanRef): SpanValues {
  const position = sqlitePosition(ref.trace, ref.session, ref.id);
  try {
    const row = oneRow(
      db,
      `SELECT ${SPAN_COLUMNS}, args, ret, error FROM kosmo_spans WHERE trace = ? AND session = ? AND id = ?`,
      ref.trace,
      ref.session,
      ref.id
    );
    if (row === undefined) return allInvalid(position, "span not found");
    const raw = spanFromRow(row);
    const broken: { args?: Value; return?: Value; error?: Value } = {};
    for (const [column, field] of VALUE_FIELDS) {
      const text = row[column];
      if (text == null) continue;
      const parsed = parseJsonText(text);
      if (parsed.ok) raw[field] = parsed.value;
      else broken[field] = { state: "invalid-value", position: `${position}.${field}`, what: "not valid JSON" };
    }
    const span = validateSpan(raw, position, { values: true });
    if (!span.ok) return allInvalid(span.position, span.what);
    const values = span.span.values ?? { args: NOT_RECORDED, return: NOT_RECORDED, error: NOT_RECORDED };
    return {
      args: broken.args ?? values.args,
      return: broken.return ?? values.return,
      error: broken.error ?? values.error
    };
  } catch (error) {
    return allInvalid(position, `read-error: ${errorText(error)}`);
  }
}

export async function openSqliteFile(
  path: string,
  size: number,
  deps: ReaderDeps,
  signal: AbortSignal
): Promise<OpenResult> {
  if (signal.aborted) return { ok: false, error: ABORTED };
  if (size > LIMITS.fileBytes)
    return {
      ok: false,
      error: readerError("too-large", `too-large: ${path} is larger than ${LIMITS.fileBytes} bytes`)
    };
  const sqlite = deps.loadSqlite?.() ?? null;
  if (sqlite === null)
    return {
      ok: false,
      error: readerError(
        "read-error",
        "read-error: node:sqlite is not available in this Node (kosmo-tui needs >= 22.13)"
      )
    };
  const opened = openReadOnly(sqlite, path);
  if (!opened.ok) return opened;
  const db = opened.db;
  let checked: ReturnType<typeof checkStore>;
  try {
    checked = checkStore(db);
  } catch (error) {
    safeClose(db);
    return { ok: false, error: classify(error, path) };
  }
  if (!checked.ok) {
    safeClose(db);
    return checked;
  }
  const first = loadPage(db, null);
  if (!first.ok) {
    safeClose(db);
    return first;
  }
  let last = first.last;
  let hasMore = first.page.hasMore;
  let closed = false;
  const dataset: OpenedDataset = {
    kind: "sqlite",
    origin: { path },
    info: checked.info,
    traces: first.page,
    notices: [],
    async loadMoreTraces(moreSignal) {
      if (closed || !hasMore || moreSignal.aborted) return { items: [], hasMore: hasMore && !closed };
      const next = loadPage(db, last);
      if (!next.ok) throw new Error(next.error.message);
      last = next.last;
      hasMore = next.page.hasMore;
      return next.page;
    },
    async loadTrace(id, traceSignal) {
      if (traceSignal.aborted) return { ok: false, error: ABORTED };
      if (closed) return { ok: false, error: readerError("read-error", "read-error: the store is closed") };
      return loadTraceFrom(db, id);
    },
    async loadValues(ref) {
      if (closed) return allInvalid(sqlitePosition(ref.trace, ref.session, ref.id), "the store is closed");
      return loadValuesFrom(db, ref);
    },
    async close() {
      if (closed) return;
      closed = true;
      safeClose(db);
    }
  };
  return { ok: true, dataset };
}
