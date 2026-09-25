/**
 * Spec 4.6: node:sqlite is loaded only through process.getBuiltinModule AFTER a filter for
 * its ExperimentalWarning, and no module under src/ imports it statically ("статичний
 * імпорт друкує попередження раніше за будь-який фільтр і псує екран").
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  installSqliteWarningFilter,
  isSqliteExperimentalWarning,
  loadSqliteModule,
  type WarningProcess
} from "../../src/readers/sqlite-loader.js";
import { NODE_SQLITE_AVAILABLE } from "../trace-writers.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|mts|cts|js|mjs)$/.test(entry.name) ? [full] : [];
  });
}

function fakeProcess(): WarningProcess & { printed: string[]; loaded: string[] } {
  const printed: string[] = [];
  const loaded: string[] = [];
  return {
    printed,
    loaded,
    emitWarning(warning: string | Error, ...rest: unknown[]) {
      const type = typeof rest[0] === "string" ? rest[0] : "Warning";
      printed.push(`${type}: ${typeof warning === "string" ? warning : warning.message}`);
    },
    getBuiltinModule(id: string) {
      loaded.push(id);
      this.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
      return { DatabaseSync: class {} };
    }
  };
}

describe("sqlite loader", () => {
  it("no file under src/ imports node:sqlite statically or dynamically", () => {
    const offenders = sourceFiles(path.join(root, "src")).filter((file) => {
      const text = readFileSync(file, "utf8");
      return (
        /^\s*(import|export)\b[^;]*?\bfrom\s*["']node:sqlite["']/m.test(text) ||
        /^\s*import\s*["']node:sqlite["']/m.test(text) ||
        /\bimport\(\s*["']node:sqlite["']\s*\)/.test(text) ||
        /\brequire\(\s*["'](node:)?sqlite["']\s*\)/.test(text)
      );
    });
    expect(offenders).toEqual([]);
    const loader = readFileSync(path.join(root, "src/readers/sqlite-loader.ts"), "utf8");
    expect(loader).toContain('getBuiltinModule("node:sqlite")');
  });

  it("recognises only the SQLite ExperimentalWarning, in every emitWarning form", () => {
    const message = "SQLite is an experimental feature and might change at any time";
    expect(isSqliteExperimentalWarning(message, ["ExperimentalWarning"])).toBe(true);
    expect(isSqliteExperimentalWarning(message, [{ type: "ExperimentalWarning" }])).toBe(true);
    const error = Object.assign(new Error(message), { name: "ExperimentalWarning" });
    expect(isSqliteExperimentalWarning(error, [])).toBe(true);
    expect(isSqliteExperimentalWarning("VM Modules is an experimental feature", ["ExperimentalWarning"])).toBe(false);
    expect(isSqliteExperimentalWarning(message, ["DeprecationWarning"])).toBe(false);
  });

  it("installs the filter before loading and lets other warnings through", () => {
    const proc = fakeProcess();
    const sqlite = loadSqliteModule(proc);
    expect(sqlite).not.toBeNull();
    expect(proc.loaded).toEqual(["node:sqlite"]);
    proc.emitWarning("something else", "DeprecationWarning");
    expect(proc.printed).toEqual(["DeprecationWarning: something else"]);
  });

  it("installing twice keeps one wrapper", () => {
    const proc = fakeProcess();
    installSqliteWarningFilter(proc);
    const first = proc.emitWarning;
    installSqliteWarningFilter(proc);
    expect(proc.emitWarning).toBe(first);
  });

  it("null when this Node has no node:sqlite or getBuiltinModule", () => {
    expect(loadSqliteModule({ emitWarning: () => undefined })).toBeNull();
    expect(loadSqliteModule({ emitWarning: () => undefined, getBuiltinModule: () => undefined })).toBeNull();
    expect(
      loadSqliteModule({
        emitWarning: () => undefined,
        getBuiltinModule: () => {
          throw new Error("No such built-in module: node:sqlite");
        }
      })
    ).toBeNull();
  });

  it.skipIf(!NODE_SQLITE_AVAILABLE)(
    "a real Node process prints no ExperimentalWarning when the loader opens a database",
    () => {
      const built = path.join(root, "dist/readers/sqlite-loader.js");
      expect(existsSync(built), "run `npm run build` first (npm test does it in pretest)").toBe(true);
      const script = [
        `const { loadSqliteModule } = await import(${JSON.stringify(pathToFileURL(built).href)});`,
        "const sqlite = loadSqliteModule();",
        'const db = new sqlite.DatabaseSync(":memory:");',
        'process.stdout.write(String(db.prepare("SELECT 41 + 1 AS n").get().n));',
        "db.close();"
      ].join("\n");
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout).toBe("42");
      expect(child.stderr).not.toMatch(/ExperimentalWarning/);
    }
  );
});
