/**
 * Writers for test datasets (spec 13.1): the same RawDocument as `.kosmo-trace.json`,
 * `.kosmo-trace.ndjson` (spec 4.5) and `.kosmo-trace.sqlite` (spec 4.6, through
 * `node:sqlite` `DatabaseSync` in write mode). Test-only: nothing under src/ imports this.
 *
 * `node:sqlite` is reached through `process.getBuiltinModule` after a local filter for its
 * ExperimentalWarning, so test output stays clean; src/ never loads it statically either.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RawDocument, RawJson, RawSpan } from "./trace-builder.js";

type NodeSqlite = typeof import("node:sqlite");
export type WritableSqlite = InstanceType<NodeSqlite["DatabaseSync"]>;

/** Spec 4.6, verbatim: tables, columns, primary keys and both indexes. */
export const KOSMO_SQLITE_SCHEMA = `
CREATE TABLE kosmo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE kosmo_traces (id TEXT PRIMARY KEY, name TEXT);
CREATE TABLE kosmo_spans (
  trace TEXT NOT NULL, session TEXT NOT NULL, id TEXT NOT NULL,
  parent TEXT, parent_session TEXT, "order" INTEGER NOT NULL,
  name TEXT NOT NULL, kind TEXT, status TEXT NOT NULL, status_reason TEXT,
  duration_ms REAL, runtime TEXT,
  file TEXT, line INTEGER, col INTEGER, end_line INTEGER, snippet TEXT, snippet_cut INTEGER,
  area_module TEXT, area_feature TEXT,
  attrs TEXT,
  args TEXT, ret TEXT, error TEXT,
  PRIMARY KEY (trace, session, id)
);
CREATE INDEX kosmo_spans_parent ON kosmo_spans (trace, parent);
CREATE UNIQUE INDEX kosmo_spans_order ON kosmo_spans (trace, session, "order");
CREATE TABLE kosmo_links (
  from_trace TEXT NOT NULL, from_session TEXT NOT NULL, from_id TEXT NOT NULL,
  to_trace TEXT NOT NULL, to_session TEXT NOT NULL, to_id TEXT NOT NULL,
  kind TEXT NOT NULL
);
`;

export type NdjsonOptions = {
  /** "\r\n" line ends (spec 4.5: CRLF is accepted). */
  crlf?: boolean;
  /** A UTF-8 BOM before the header (spec 4.5: dropped by the reader). */
  bom?: boolean;
  /** false: the last line has no line end (spec 4.5 / Review focus 5). Default true. */
  trailingNewline?: boolean;
  /**
   * "reverse" (spec 4.5: records in any order): header, then the links, then spans and
   * traces in reverse document order, so spans arrive before their parents and traces.
   * Links keep their relative order: spec 4.3 fixes the order of spans, not of links.
   */
  order?: "document" | "reverse";
};

export function toJsonText(doc: RawDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** One JSON object per line, fields flat next to `type` (spec 4.5). */
export function toNdjsonLines(doc: RawDocument, order: "document" | "reverse" = "document"): string[] {
  const header = JSON.stringify({ type: "header", format: doc.format, version: doc.version, dataset: doc.dataset });
  const traces = (doc.traces ?? []).map((trace) => JSON.stringify({ type: "trace", ...trace }));
  const spans = doc.spans.map((span) => JSON.stringify({ type: "span", ...span }));
  const links = (doc.links ?? []).map((link) => JSON.stringify({ type: "link", ...link }));
  if (order === "reverse") return [header, ...links, ...[...traces, ...spans].reverse()];
  return [header, ...traces, ...spans, ...links];
}

export function toNdjsonText(doc: RawDocument, options: NdjsonOptions = {}): string {
  const eol = options.crlf === true ? "\r\n" : "\n";
  const body = toNdjsonLines(doc, options.order).join(eol);
  return `${options.bom === true ? "\ufeff" : ""}${body}${options.trailingNewline === false ? "" : eol}`;
}

export function writeJson(file: string, doc: RawDocument): void {
  writeFileSync(file, toJsonText(doc));
}

export function writeNdjson(file: string, doc: RawDocument, options: NdjsonOptions = {}): void {
  writeFileSync(file, toNdjsonText(doc, options));
}

let warningFilterInstalled = false;

function nodeSqlite(): NodeSqlite {
  if (!warningFilterInstalled) {
    warningFilterInstalled = true;
    const original = process.emitWarning;
    process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
      const message = typeof warning === "string" ? warning : warning.message;
      if (/SQLite is an experimental feature/.test(message)) return;
      return (original as (...args: unknown[]) => void).call(this, warning, ...rest);
    } as typeof process.emitWarning;
  }
  if (typeof process.getBuiltinModule !== "function") throw new Error("node:sqlite needs Node >= 22.13");
  return process.getBuiltinModule("node:sqlite");
}

/**
 * node:sqlite needs Node >= 22.13 (unflagged). Until task 25 raises `engines` and the CI
 * matrix, CI still runs Node 18.19, where SQLite-backed tests skip on this flag.
 */
export const NODE_SQLITE_AVAILABLE: boolean = (() => {
  try {
    return typeof nodeSqlite()?.DatabaseSync === "function";
  } catch {
    return false;
  }
})();

export function openWritableSqlite(file: string): WritableSqlite {
  return new (nodeSqlite().DatabaseSync)(file);
}

function jsonColumn(value: RawJson | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function spanColumns(span: RawSpan): Array<string | number | null> {
  const location = span.location;
  const snippetCut = location?.snippetCut;
  return [
    span.trace,
    span.session,
    span.id,
    span.parent,
    span.parentSession ?? null,
    span.order,
    span.name,
    span.kind ?? null,
    span.status,
    span.statusReason ?? null,
    span.durationMs ?? null,
    span.runtime ?? null,
    location?.file ?? null,
    location?.line ?? null,
    location?.column ?? null,
    location?.endLine ?? null,
    location?.snippet ?? null,
    snippetCut === undefined ? null : snippetCut ? 1 : 0,
    span.area?.module ?? null,
    span.area?.feature ?? null,
    jsonColumn(span.attrs),
    jsonColumn(span.args),
    jsonColumn(span.return),
    jsonColumn(span.error)
  ];
}

/**
 * Write `doc` as a kosmo-trace SQLite store (spec 4.6). A trace that exists only through
 * `span.trace` gets a `kosmo_traces` row with NULL name, so every span has its trace row.
 * `journal: "wal"` leaves the store in WAL mode (Review focus 5).
 */
export function writeSqlite(file: string, doc: RawDocument, options: { journal?: "delete" | "wal" } = {}): void {
  const db = openWritableSqlite(file);
  try {
    if (options.journal === "wal") db.exec("PRAGMA journal_mode = WAL");
    db.exec(KOSMO_SQLITE_SCHEMA);
    db.exec("BEGIN");
    const meta = db.prepare("INSERT INTO kosmo_meta (key, value) VALUES (?, ?)");
    meta.run("format", doc.format);
    meta.run("version", String(doc.version));
    meta.run("dataset", JSON.stringify(doc.dataset));
    const traceNames = new Map<string, string | null>();
    for (const trace of doc.traces ?? []) traceNames.set(trace.id, trace.name ?? null);
    for (const span of doc.spans) if (!traceNames.has(span.trace)) traceNames.set(span.trace, null);
    const trace = db.prepare("INSERT INTO kosmo_traces (id, name) VALUES (?, ?)");
    for (const [id, name] of traceNames) trace.run(id, name);
    const span = db.prepare(`INSERT INTO kosmo_spans VALUES (${Array.from({ length: 24 }, () => "?").join(", ")})`);
    for (const row of doc.spans) span.run(...spanColumns(row));
    const link = db.prepare("INSERT INTO kosmo_links VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const row of doc.links ?? [])
      link.run(row.from.trace, row.from.session, row.from.id, row.to.trace, row.to.session, row.to.id, row.kind);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

/** Run SQL against an existing store: tests use it to break a valid store on purpose. */
export function sqliteExec(file: string, sql: string): void {
  const db = openWritableSqlite(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

const dirs: string[] = [];

export function tempDir(prefix = "kosmo-trace-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** All three containers of one document in a fresh temp dir. */
export function writeAllContainers(
  doc: RawDocument,
  name = "dataset"
): { dir: string; json: string; ndjson: string; sqlite: string } {
  const dir = tempDir();
  const json = path.join(dir, `${name}.kosmo-trace.json`);
  const ndjson = path.join(dir, `${name}.kosmo-trace.ndjson`);
  const sqlite = path.join(dir, `${name}.kosmo-trace.sqlite`);
  writeJson(json, doc);
  writeNdjson(ndjson, doc);
  writeSqlite(sqlite, doc);
  return { dir, json, ndjson, sqlite };
}
