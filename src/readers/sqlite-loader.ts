/**
 * Loads node:sqlite without printing its ExperimentalWarning over the TUI (spec 4.6).
 *
 * A static `import "node:sqlite"` prints the warning before any filter can exist, so no
 * module imports it: this loader first installs the filter, then asks
 * `process.getBuiltinModule("node:sqlite")`. The filter wraps `process.emitWarning`
 * (Node emits experimental warnings through it); a 'warning' listener could not help,
 * because Node's default printer runs regardless of other listeners. Only the SQLite
 * ExperimentalWarning is dropped; every other warning passes through unchanged.
 */
import type { SqliteModule } from "./types.js";

type EmitWarning = (warning: string | Error, ...rest: unknown[]) => void;

/** The part of `process` the loader touches; method syntax so `process` itself fits. */
export type WarningProcess = {
  emitWarning(warning: string | Error, ...rest: unknown[]): void;
  getBuiltinModule?(id: string): unknown;
};

const FILTERED = Symbol.for("kosmo-tui.sqlite-warning-filter");

export function isSqliteExperimentalWarning(warning: unknown, rest: readonly unknown[]): boolean {
  const first = rest[0];
  const type =
    typeof first === "string"
      ? first
      : first !== null && typeof first === "object" && typeof (first as { type?: unknown }).type === "string"
        ? (first as { type: string }).type
        : warning instanceof Error
          ? warning.name
          : undefined;
  const message = typeof warning === "string" ? warning : warning instanceof Error ? warning.message : "";
  return type === "ExperimentalWarning" && /\bSQLite\b/.test(message);
}

/** Idempotent: a second call keeps the first wrapper. */
export function installSqliteWarningFilter(proc: WarningProcess = process): void {
  const current = proc.emitWarning as EmitWarning & { [FILTERED]?: true };
  if (current[FILTERED] === true) return;
  const filtered = function (this: unknown, warning: string | Error, ...rest: unknown[]): void {
    if (isSqliteExperimentalWarning(warning, rest)) return;
    current.call(this, warning, ...rest);
  } as EmitWarning & { [FILTERED]?: true };
  filtered[FILTERED] = true;
  proc.emitWarning = filtered;
}

/** The node:sqlite module, or null when this Node has none (or it fails to load). */
export function loadSqliteModule(proc: WarningProcess = process): SqliteModule | null {
  installSqliteWarningFilter(proc);
  if (typeof proc.getBuiltinModule !== "function") return null;
  try {
    const sqlite = proc.getBuiltinModule("node:sqlite") as { DatabaseSync?: unknown } | undefined;
    if (sqlite === undefined || typeof sqlite.DatabaseSync !== "function") return null;
    return sqlite as unknown as SqliteModule;
  } catch {
    return null;
  }
}
