/**
 * Thin SQL adapters (task 5b.2; trace-programmable-access "SQL над ізольованою read
 * model", design D12): `kosmo-tui sql "<query>"` and the TUI `:sql` command.
 *
 * Neither adapter implements SQL. The shared runner of `@kosmo-callflow/query/sql` owns
 * validation, the sanitized project-scoped read model, output escaping, the 5 s worker
 * deadline and row/byte truncation, and does all heavy work in its killable worker:
 *  - `kosmo-tui sql` passes only the database path and scope (`runTraceSqlOverSqlite`):
 *    the read-only source read happens in the worker, under the deadline;
 *  - `:sql` streams the viewer's pinned snapshot (`runTraceSql`) cooperatively, so the
 *    render loop keeps ticking while the worker sanitizes and queries.
 * kosmo-tui only chooses WHICH database to read and serializes the typed table result.
 *
 * Database choice never falls back:
 *  - `--source <path>` reads exactly that file, and only when it is a SQLite store;
 *  - without `--source`, the resolved cwd project's own data dir
 *    (`KOSMO_CALLFLOW_DATA`, else `<project root>/.kosmo-callflow`) — never a home
 *    directory store, never another project's;
 *  - `:sql` reads the snapshot the sqlite viewer already pinned; a live/export/stream
 *    viewer has no `:sql` rather than opening some other local database.
 */

import path from "node:path";
import {
  runTraceSql,
  runTraceSqlOverSqlite,
  TraceSqlError,
  type TraceSqlResult,
  type TraceSqlRunnerDeps
} from "@kosmo-callflow/query/sql";
import { SqliteSourceError } from "@kosmo-callflow/query/sqlite";
import type { TraceDatasetSnapshot } from "@kosmo-callflow/query/snapshot";
import { EXIT_OK, EXIT_SOURCE, EXIT_USAGE, type Invocation, type SqlArgs } from "./cli.js";
import { SourceError } from "./source-common.js";
import { sqliteSourceError, type SqliteSource } from "./source-sqlite.js";
import { serializeResult } from "./serializers.js";
import { detectSqliteDriver, type SqliteDriverSelection } from "./sqlite-driver.js";

export type SqlRunner = typeof runTraceSql;
export type SqlFileRunner = typeof runTraceSqlOverSqlite;

export type SqlCommandDeps = {
  driver?: SqliteDriverSelection;
  runFile?: SqlFileRunner;
  runnerDeps?: TraceSqlRunnerDeps;
};

export type SqlOutcome =
  { ok: true; result: TraceSqlResult } | { ok: false; code: string; reason?: string; message: string; exitCode: 1 | 2 };

/** A typed failure of the runner or the source, with the exit code the CLI uses. */
export function sqlFailure(error: unknown): Extract<SqlOutcome, { ok: false }> {
  if (error instanceof TraceSqlError) {
    return {
      ok: false,
      code: error.code,
      ...(error.reason === undefined ? {} : { reason: error.reason }),
      message: error.message.slice(0, 1_000),
      exitCode: error.code === "sql-rejected" ? EXIT_USAGE : EXIT_SOURCE
    };
  }
  if (error instanceof SourceError || error instanceof SqliteSourceError) {
    const source = sqliteSourceError(error);
    return { ok: false, code: source.code, message: source.message.slice(0, 1_000), exitCode: EXIT_SOURCE };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, code: "sql-error", message: message.slice(0, 1_000), exitCode: EXIT_SOURCE };
}

/** Run one query over a pinned snapshot through the shared runner. Never throws. */
export async function runSqlOverSnapshot(
  snapshot: TraceDatasetSnapshot,
  query: string,
  options: { traceId?: string; run?: SqlRunner; runnerDeps?: TraceSqlRunnerDeps } = {}
): Promise<SqlOutcome> {
  try {
    const result = await (options.run ?? runTraceSql)(
      snapshot,
      { sql: query, ...(options.traceId === undefined ? {} : { traceId: options.traceId }) },
      options.runnerDeps
    );
    return { ok: true, result };
  } catch (error) {
    return sqlFailure(error);
  }
}

/**
 * The `:sql` port of an open sqlite source: every call reads the snapshot the viewer has
 * pinned, and the runner's child loads the same driver the reader used.
 */
export function sqlPortForSource(
  source: SqliteSource,
  options: { traceId?: string; run?: SqlRunner; runnerDeps?: TraceSqlRunnerDeps } = {}
): (query: string) => Promise<SqlOutcome> {
  return async (query) => {
    let snapshot: TraceDatasetSnapshot;
    try {
      snapshot = source.datasetSnapshot();
    } catch (error) {
      return sqlFailure(error);
    }
    const driver = source.sqlDriver();
    return runSqlOverSnapshot(snapshot, query, {
      ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
      ...(options.run ? { run: options.run } : {}),
      runnerDeps: { ...(driver ? { resolveDriver: () => driver } : {}), ...options.runnerDeps }
    });
  };
}

export type SqlDatabase =
  { ok: true; path: string; projectId?: string } | { ok: false; message: string; exitCode: 1 | 2 };

/** Which database `kosmo-tui sql` reads. No fallback: an unusable choice is an error. */
export function resolveSqlDatabase(invocation: Invocation<SqlArgs>): SqlDatabase {
  const { args, target, project, proc } = invocation;
  if (args.source !== undefined) {
    if (target.kind !== "sqlite") {
      return {
        ok: false,
        message: `unavailable(sql-needs-sqlite-source): sql reads a kosmo-callflow events.sqlite store; --source ${args.source} is a ${target.kind} source, and no other database is opened in its place`,
        exitCode: EXIT_SOURCE
      };
    }
    return { ok: true, path: target.path, ...(args.project === undefined ? {} : { projectId: args.project }) };
  }
  if (project === null) {
    return {
      ok: false,
      message:
        "sql: no kosmo-callflow project was found from this directory upwards; pass --source <events.sqlite> (no other local database is read in its place)",
      exitCode: EXIT_USAGE
    };
  }
  const dataDir = proc.env.KOSMO_CALLFLOW_DATA ?? path.join(project.root, ".kosmo-callflow");
  return {
    ok: true,
    path: path.join(path.resolve(proc.cwd(), dataDir), "events.sqlite"),
    projectId: project.projectId
  };
}

/**
 * `deps.runSql` default: the `kosmo-tui sql` subcommand. Only the path and scope go to
 * the runner; the worker reads the file under the deadline. Stdout is written once, only
 * on success.
 */
export async function runSqlCommand(invocation: Invocation<SqlArgs>, deps: SqlCommandDeps = {}): Promise<number> {
  const { args, proc } = invocation;
  const error = (text: string): void => {
    proc.stderr.write(`kosmo-tui: ${text}\n`);
  };
  const database = resolveSqlDatabase(invocation);
  if (!database.ok) {
    error(database.message);
    return database.exitCode;
  }
  let outcome: SqlOutcome;
  const driver = deps.driver ?? detectSqliteDriver();
  if (!driver.ok) {
    outcome = sqlFailure(new SourceError("unavailable", driver.message));
  } else {
    try {
      invocation.signal.throwIfAborted();
      const result = await (deps.runFile ?? runTraceSqlOverSqlite)(
        database.path,
        {
          sql: args.query,
          ...(database.projectId === undefined ? {} : { projectId: database.projectId }),
          ...(args.trace === undefined ? {} : { traceId: args.trace })
        },
        { resolveDriver: () => driver.sql, ...deps.runnerDeps }
      );
      outcome = { ok: true, result };
    } catch (failure) {
      outcome = sqlFailure(failure);
    }
  }
  if (!outcome.ok) {
    error(
      `sql failed: ${outcome.code}${outcome.reason === undefined ? "" : `(${outcome.reason})`}: ${outcome.message}`
    );
    return outcome.exitCode;
  }
  const serialized = serializeResult(outcome.result, args.format);
  if (!serialized.ok) {
    error(serialized.message);
    return EXIT_USAGE;
  }
  proc.stdout.write(serialized.text);
  return EXIT_OK;
}
