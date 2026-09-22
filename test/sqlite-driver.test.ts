/**
 * Task 4.4: driver selection is feature detection only. better-sqlite3 is an optional
 * peer resolved (not loaded) next to kosmo-tui; node:sqlite is used when this Node has it
 * unflagged or with the flag already given; otherwise an explicit unavailable with an
 * install hint. No module imports a driver at load time.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectSqliteDriver, type SqliteDriverProbe } from "../src/sqlite-driver.js";

const fakeRead = { name: "node:sqlite", openReadOnly: () => ({ all: () => [], exec: () => {}, close: () => {} }) };

function probe(overrides: Partial<SqliteDriverProbe>): SqliteDriverProbe {
  return {
    nodeVersion: "v22.22.0",
    execArgv: [],
    resolveBetterSqlite3: () => undefined,
    nodeSqliteReadDriver: () => fakeRead,
    ...overrides
  };
}

describe("sqlite driver detection (task 4.4)", () => {
  it("prefers the installed optional peer, resolved next to kosmo-tui", () => {
    const selection = detectSqliteDriver("auto", probe({ resolveBetterSqlite3: () => "/x/better-sqlite3/index.js" }));
    expect(selection).toMatchObject({
      ok: true,
      name: "better-sqlite3",
      sql: { kind: "better-sqlite3", modulePath: "/x/better-sqlite3/index.js" }
    });
  });

  it("uses unflagged node:sqlite when the peer is absent", () => {
    expect(detectSqliteDriver("auto", probe({}))).toMatchObject({
      ok: true,
      name: "node:sqlite",
      sql: { kind: "node:sqlite", execArgv: [] }
    });
  });

  it("detects a Node that needs --experimental-sqlite and reports it instead of failing obscurely", () => {
    const flagless = detectSqliteDriver("auto", probe({ nodeVersion: "v22.5.0" }));
    expect(flagless).toMatchObject({ ok: false, reason: "sqlite-driver", nodeSqlite: "needs-flag" });
    expect(!flagless.ok && flagless.message).toContain("--experimental-sqlite");
    const flagged = detectSqliteDriver("auto", probe({ nodeVersion: "v22.5.0", execArgv: ["--experimental-sqlite"] }));
    expect(flagged).toMatchObject({
      ok: true,
      name: "node:sqlite",
      sql: { kind: "node:sqlite", execArgv: ["--experimental-sqlite"] }
    });
  });

  it("has no driver on Node 18 without the peer, with an install hint and no implicit install", () => {
    const selection = detectSqliteDriver("auto", probe({ nodeVersion: "v18.19.0" }));
    expect(selection).toMatchObject({ ok: false, reason: "sqlite-driver", nodeSqlite: "absent" });
    if (selection.ok) return;
    expect(selection.message).toContain("unavailable(sqlite-driver)");
    expect(selection.message).toContain("npm i better-sqlite3");
    expect(selection.message).toContain("nothing is installed automatically");
  });

  it("honours an explicit preference", () => {
    expect(detectSqliteDriver("better-sqlite3", probe({})).ok).toBe(false);
    expect(
      detectSqliteDriver("node:sqlite", probe({ resolveBetterSqlite3: () => "/x/better-sqlite3/index.js" }))
    ).toMatchObject({ ok: true, name: "node:sqlite" });
  });

  it("resolves the real drivers in this checkout", () => {
    expect(detectSqliteDriver("better-sqlite3")).toMatchObject({ ok: true, name: "better-sqlite3" });
    expect(detectSqliteDriver()).toMatchObject({ ok: true });
  });

  it("imports no driver at module load", () => {
    for (const file of ["../src/sqlite-driver.ts", "../src/source-sqlite.ts", "../src/sql.ts"]) {
      const text = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(text).not.toMatch(/^import[^;]*["'](better-sqlite3|node:sqlite)["']/m);
      expect(text).not.toMatch(/await import\(["'](better-sqlite3|node:sqlite)["']\)/);
    }
  });
});
