/**
 * Helpers over test/fixtures/sqlite/store.sqlite: a store written by the REAL
 * kosmo-callflow daemon (`scripts/sqlite-fixture-kc.mjs`). Tests only ever touch copies.
 */
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_STORE = fileURLToPath(new URL("./fixtures/sqlite/store.sqlite", import.meta.url));
export const FIXTURE_PROJECT = "fixture-project";

export type WritableDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Array<Record<string, unknown>>;
  };
  pragma(sql: string): unknown;
  close(): void;
};

export const Database = createRequire(import.meta.url)("better-sqlite3") as new (
  file: string,
  options?: Record<string, unknown>
) => WritableDb;

const dirs: string[] = [];

export function tempDir(prefix = "kosmo-tui-sqlite-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A private copy of the fixture store; `wal` switches it to WAL like a running daemon. */
export function copyStore(options: { wal?: boolean; dir?: string; name?: string } = {}): string {
  const file = path.join(options.dir ?? tempDir(), options.name ?? "events.sqlite");
  copyFileSync(FIXTURE_STORE, file);
  chmodSync(file, 0o600);
  if (options.wal) {
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    db.close();
  }
  return file;
}

/** Append one runtime event the way the daemon's table stores it. */
export function appendEvent(
  db: WritableDb,
  fields: { sessionId: string; localSeq: number; traceId: string; spanId: string; nodeId: string; type?: string }
): void {
  db.prepare(
    `INSERT INTO events(project_id, session_id, local_seq, trace_id, span_id, parent_span_id, type, node_id, kind, runtime, service_name, ts, level, payload_json, flags_json, committed_at_wall)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'function', 'node', 'api', 5000, 'shallow', '{}', '{}', 0)`
  ).run(
    FIXTURE_PROJECT,
    fields.sessionId,
    fields.localSeq,
    fields.traceId,
    fields.spanId,
    fields.type ?? "enter",
    fields.nodeId
  );
}

export function cleanupDirs(): void {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // already gone
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
