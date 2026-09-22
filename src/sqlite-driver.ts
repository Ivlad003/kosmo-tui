/**
 * SQLite driver selection for the sqlite source and the SQL adapters (task 4.4, design
 * D11 "Better-sqlite3 — optional peer"; tui-debugger "Узгоджений offline snapshot").
 *
 * Nothing here imports a driver at module load. Selection is feature detection only:
 *
 *  1. the optional `better-sqlite3` peer, when it resolves next to kosmo-tui (resolved,
 *     not loaded: the module is required only when a database is opened);
 *  2. the built-in `node:sqlite`, when this Node has it without a flag, or with the
 *     `--experimental-sqlite` flag already in `process.execArgv` (22.5–22.12 / 23.0–23.3);
 *  3. otherwise an explicit `unavailable(sqlite-driver)` with an install hint. Nothing
 *     is ever installed implicitly.
 *
 * The same selection feeds both the in-process snapshot reader (`SqliteReadDriver`) and
 * the SQL runner's child process (`TraceSqlDriver`), so `sql` and the viewer never
 * disagree about which driver a machine has.
 */

import { createRequire } from "node:module";
import { detectSqliteReadDriver, type SqliteReadDriver } from "@kosmo-callflow/query/sqlite";
import { nodeSqliteSupport, type TraceSqlDriver } from "@kosmo-callflow/query/sql";

export type SqliteDriverName = "better-sqlite3" | "node:sqlite";
export type SqliteDriverPreference = "auto" | SqliteDriverName;

/** What detection looks at; tests inject it to simulate other Node versions and installs. */
export type SqliteDriverProbe = {
  nodeVersion: string;
  execArgv: readonly string[];
  /** Resolve (never load) the optional peer; undefined when it is not installed. */
  resolveBetterSqlite3(): string | undefined;
  /** The in-process node:sqlite read driver (only asked when detection allows it). */
  nodeSqliteReadDriver(): SqliteReadDriver | undefined;
};

export type SqliteDriverSelection =
  | { ok: true; name: SqliteDriverName; read: SqliteReadDriver; sql: TraceSqlDriver }
  | {
      ok: false;
      reason: "sqlite-driver";
      /** Why node:sqlite could not be used on this Node. */
      nodeSqlite: "absent" | "needs-flag";
      message: string;
    };

const localRequire = createRequire(import.meta.url);

export const defaultSqliteDriverProbe: SqliteDriverProbe = {
  nodeVersion: process.version,
  execArgv: process.execArgv,
  resolveBetterSqlite3() {
    try {
      return localRequire.resolve("better-sqlite3");
    } catch {
      return undefined;
    }
  },
  nodeSqliteReadDriver: () => detectSqliteReadDriver("node:sqlite")
};

type BetterSqliteDatabase = {
  prepare(sql: string): { all(...params: unknown[]): Array<Record<string, unknown>> };
  exec(sql: string): void;
  close(): void;
};

/** A read-only better-sqlite3 driver over a module path; the module loads on first open. */
export function betterSqliteReadDriver(modulePath: string): SqliteReadDriver {
  return {
    name: "better-sqlite3",
    openReadOnly(filePath, options) {
      const Database = localRequire(modulePath) as new (
        file: string,
        options: Record<string, unknown>
      ) => BetterSqliteDatabase;
      // fileMustExist: a missing path is never created; readonly: no write, no migration.
      const db = new Database(filePath, { readonly: true, fileMustExist: true, timeout: options.busyTimeoutMs });
      return {
        all: (sql, ...params) => db.prepare(sql).all(...params),
        exec: (sql) => db.exec(sql),
        close: () => db.close()
      };
    }
  };
}

function unavailable(probe: SqliteDriverProbe, nodeSqlite: "absent" | "needs-flag"): SqliteDriverSelection {
  const why =
    nodeSqlite === "needs-flag"
      ? `node:sqlite on Node ${probe.nodeVersion} needs --experimental-sqlite (run kosmo-tui with NODE_OPTIONS=--experimental-sqlite, or use Node >= 22.13)`
      : `node:sqlite is not in Node ${probe.nodeVersion} (it needs Node >= 22.13, or 22.5+ with --experimental-sqlite)`;
  return {
    ok: false,
    reason: "sqlite-driver",
    nodeSqlite,
    message:
      `kosmo-tui: unavailable(sqlite-driver): ${why}, and the optional better-sqlite3 peer is not installed. ` +
      "Install it next to kosmo-tui (npm i better-sqlite3) or open a portable export or the live daemon instead; nothing is installed automatically."
  };
}

/** Pick a driver, or explain why there is none. Pure apart from the injected probe. */
export function detectSqliteDriver(
  preference: SqliteDriverPreference = "auto",
  probe: SqliteDriverProbe = defaultSqliteDriverProbe
): SqliteDriverSelection {
  // `process.version` is "v22.22.0"; nodeSqliteSupport reads "22.22.0".
  const support = nodeSqliteSupport(probe.nodeVersion.replace(/^v/, ""));
  const flagged = support.available && support.execArgv.every((flag) => probe.execArgv.includes(flag));
  if (preference !== "node:sqlite") {
    const modulePath = probe.resolveBetterSqlite3();
    if (modulePath !== undefined) {
      return {
        ok: true,
        name: "better-sqlite3",
        read: betterSqliteReadDriver(modulePath),
        sql: { kind: "better-sqlite3", modulePath }
      };
    }
    if (preference === "better-sqlite3")
      return unavailable(probe, support.available && !flagged ? "needs-flag" : "absent");
  }
  if (!support.available) return unavailable(probe, "absent");
  if (!flagged) return unavailable(probe, "needs-flag");
  const read = probe.nodeSqliteReadDriver();
  if (read === undefined) return unavailable(probe, "absent");
  return { ok: true, name: "node:sqlite", read, sql: { kind: "node:sqlite", execArgv: [...support.execArgv] } };
}
