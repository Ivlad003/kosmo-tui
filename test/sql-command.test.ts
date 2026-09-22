/**
 * Task 5b.2: `kosmo-tui sql` and `:sql` are thin adapters over the shared runner of
 * `@kosmo-callflow/query/sql`. Default output is JSON; unsupported formats are usage
 * errors; `--source` reads exactly that SQLite file and nothing else; without it only
 * the resolved cwd project's own data dir is read — never a home-directory store.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TraceSqlResult } from "@kosmo-callflow/query/sql";
import type { Capabilities } from "../src/capabilities.js";
import { EXIT_OK, EXIT_SOURCE, EXIT_USAGE, parseArgv, run } from "../src/cli.js";
import { runCommandLine } from "../src/commands.js";
import { commandResultLines } from "../src/panes.js";
import { createSqliteSource } from "../src/source-sqlite.js";
import { runSqlCommand, sqlPortForSource } from "../src/sql.js";
import { detectSqliteDriver } from "../src/sqlite-driver.js";
import { initialViewState } from "../src/view-state.js";
import { fakeProc } from "./helpers.js";
import { appendEvent, cleanupDirs, copyStore, Database, FIXTURE_PROJECT, tempDir } from "./sqlite-fixtures.js";

afterEach(cleanupDirs);

/** A cwd project with its own `.kosmo-callflow/events.sqlite`, and a home dir with ANOTHER store. */
function workspace(options: { projectStore?: boolean } = {}) {
  const home = tempDir("kosmo-tui-home-");
  mkdirSync(path.join(home, ".kosmo-callflow"));
  const homeStore = copyStore({ dir: path.join(home, ".kosmo-callflow") });
  const db = new Database(homeStore);
  appendEvent(db, { sessionId: "s-home", localSeq: 1, traceId: "t-home", spanId: "h", nodeId: "src/home.ts#h" });
  db.close();
  const root = tempDir("kosmo-tui-project-");
  mkdirSync(path.join(root, ".kosmo-callflow"));
  writeFileSync(path.join(root, ".kosmo-callflow", "project.json"), JSON.stringify({ projectId: FIXTURE_PROJECT }));
  if (options.projectStore !== false) copyStore({ dir: path.join(root, ".kosmo-callflow") });
  const cwd = path.join(root, "src");
  mkdirSync(cwd);
  return { home, root, cwd };
}

async function sql(argv: string[], options: { cwd?: string; home?: string; env?: Record<string, string> } = {}) {
  const proc = fakeProc(["sql", ...argv], {
    stdoutTty: false,
    cwd: options.cwd ?? tempDir(),
    ...(options.env ? { env: options.env } : {})
  });
  const code = await run(proc, { homedir: () => options.home ?? tempDir("kosmo-tui-home-") });
  return { code, out: proc.out, err: proc.err };
}

function table(out: string): TraceSqlResult {
  return JSON.parse(out) as TraceSqlResult;
}

describe("kosmo-tui sql (task 5b.2)", () => {
  it("parses --trace and --print json|tab, and refuses lisp for a table", () => {
    expect(parseArgv(["sql", "select 1", "--trace", "t-1", "--print", "tab"])).toEqual({
      ok: true,
      args: { command: "sql", query: "select 1", trace: "t-1", format: "tab" }
    });
    expect(parseArgv(["sql", "select 1", "--print", "lisp"])).toMatchObject({ ok: false });
    expect(parseArgv(["sql", "select 1", "--format", "lisp"])).toMatchObject({ ok: false });
    expect(parseArgv(["sql", "select 1", "--print", "json", "--format", "tab"])).toMatchObject({ ok: false });
  });

  it("defaults to the JSON table envelope from the shared runner", async () => {
    const file = copyStore();
    const result = await sql(["SELECT count(*) AS n FROM events", "--source", file]);
    expect(result.err).toBe("");
    expect(result.code).toBe(EXIT_OK);
    expect(table(result.out)).toMatchObject({
      kind: "table",
      schema: "kosmo.trace-sql/v1",
      scope: { projectId: FIXTURE_PROJECT, datasetId: `live:${FIXTURE_PROJECT}`, traceId: null },
      columns: ["n"],
      rows: [[14]],
      truncated: false
    });
  });

  it("renders --print tab as kosmo.query-table/v1 and --trace narrows the scope", async () => {
    const file = copyStore();
    const result = await sql(
      [
        "SELECT DISTINCT trace_id FROM events ORDER BY trace_id",
        "--source",
        file,
        "--trace",
        "t-login",
        "--print",
        "tab"
      ],
      {}
    );
    expect(result.code).toBe(EXIT_OK);
    const lines = result.out.trimEnd().split("\n");
    expect(lines[0]).toBe("kosmo.query-table/v1");
    expect(lines[1]).toContain("trace=t-login");
    expect(lines.slice(2)).toEqual(["trace_id", "t-login"]);
  });

  it("refuses a lisp format with a usage error and an empty stdout", async () => {
    const result = await sql(["SELECT count(*) AS n FROM events", "--source", copyStore(), "--print", "lisp"]);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.out).toBe("");
    expect(result.err).toMatch(/table/);
  });

  it("rejects a write statement before anything is printed and leaves the store alone", async () => {
    const file = copyStore();
    const before = readFileSync(file);
    const result = await sql(["SELECT 1; DELETE FROM events", "--source", file]);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.out).toBe("");
    expect(result.err).toContain("sql-rejected(multiple-statements)");
    expect(readFileSync(file).equals(before)).toBe(true);
    const literal = await sql(["SELECT ';' AS value", "--source", file]);
    expect(table(literal.out).rows).toEqual([[";"]]);
  });

  it("never opens another database: an export --source is unavailable, not a fallback", async () => {
    const dir = tempDir();
    const exportFile = path.join(dir, "export.json");
    writeFileSync(exportFile, "{}");
    const { home, cwd } = workspace();
    const result = await sql(["SELECT 1", "--source", exportFile], { cwd, home });
    expect(result.code).toBe(EXIT_SOURCE);
    expect(result.out).toBe("");
    expect(result.err).toContain("unavailable(sql-needs-sqlite-source)");
  });

  it("without --source reads the cwd project's own store only, never ~/.kosmo-callflow", async () => {
    const withStore = workspace();
    const found = await sql(["SELECT count(*) AS n, count(DISTINCT session_id) AS sessions FROM events"], {
      cwd: withStore.cwd,
      home: withStore.home
    });
    expect(found.err).toBe("");
    expect(table(found.out).rows).toEqual([[14, 2]]);

    // The project has no store: a source error, not the home store (which has 15 rows).
    const empty = workspace({ projectStore: false });
    const missing = await sql(["SELECT count(*) AS n FROM events"], { cwd: empty.cwd, home: empty.home });
    expect(missing.code).toBe(EXIT_SOURCE);
    expect(missing.out).toBe("");
    expect(missing.err).toContain("not-found");
    expect(missing.err).toContain(path.join(empty.root, ".kosmo-callflow", "events.sqlite"));

    // No project at all: a usage error naming --source.
    const nowhere = await sql(["SELECT 1"], { cwd: tempDir(), home: empty.home });
    expect(nowhere.code).toBe(EXIT_USAGE);
    expect(nowhere.err).toContain("--source");

    // KOSMO_CALLFLOW_DATA names the project's data dir, exactly like kosmo-callflow's CLI.
    const dataDir = tempDir();
    copyStore({ dir: dataDir });
    const viaEnv = await sql(["SELECT count(*) FROM events"], {
      cwd: empty.cwd,
      home: empty.home,
      env: { KOSMO_CALLFLOW_DATA: dataDir }
    });
    expect(table(viaEnv.out).rows).toEqual([[14]]);
  });

  it("reports a missing driver as a source error with an install hint", async () => {
    const driver = detectSqliteDriver("auto", {
      nodeVersion: "v18.19.0",
      execArgv: [],
      resolveBetterSqlite3: () => undefined,
      nodeSqliteReadDriver: () => undefined
    });
    const proc = fakeProc(["sql", "SELECT 1", "--source", copyStore()], { stdoutTty: false, cwd: tempDir() });
    const code = await run(proc, { runSql: (invocation) => runSqlCommand(invocation, { driver }) });
    expect(code).toBe(EXIT_SOURCE);
    expect(proc.out).toBe("");
    expect(proc.err).toContain("unavailable(sqlite-driver)");
    expect(proc.err).toContain("npm i better-sqlite3");
  });
});

function sqlCaps(sql: Capabilities["sql"]): Capabilities {
  return {
    projectionVersions: [1, 2],
    projection: { available: true },
    follow: { available: false, reason: "static-snapshot" },
    replay: { available: true },
    values: { available: true, level: "full" },
    probes: { available: false, reason: "no-probe-records" },
    staticGraph: { available: false, reason: "no-static-graph-reader" },
    sql,
    reload: { available: true },
    review: { available: true },
    localEval: { available: true },
    interactive: { available: true }
  };
}

describe(":sql in the TUI (task 5b.2)", () => {
  it("runs the query verbatim over the pinned sqlite snapshot and shows a table", async () => {
    const file = copyStore({ wal: true });
    const source = createSqliteSource({ path: file });
    await source.open(new AbortController().signal);
    // A write after open is not visible: :sql reads the pinned snapshot.
    const writer = new Database(file);
    appendEvent(writer, {
      sessionId: "s-api",
      localSeq: 7,
      traceId: "t-late",
      spanId: "late",
      nodeId: "src/late.ts#l"
    });
    writer.close();
    const state = initialViewState({ caps: sqlCaps({ available: true }) });
    const outcome = await runCommandLine(
      state,
      ":sql SELECT session_id, span_id FROM events WHERE span_id IN ('req', 'late') ORDER BY seq -- quotes, ; and -- stay SQL",
      { sql: sqlPortForSource(source) }
    );
    expect(outcome?.actions).toEqual([]);
    expect(outcome?.result).toMatchObject({
      kind: "sql",
      result: {
        kind: "table",
        columns: ["session_id", "span_id"],
        rows: [
          ["s-web", "req"],
          ["s-web", "req"]
        ]
      }
    });
    const lines = commandResultLines(outcome!.result);
    expect(lines[0]).toContain("kosmo.trace-sql/v1: 2 row(s)");
    expect(lines).toContain("  s-web | req");
    await source.close();
  });

  it("is unavailable without a sqlite source and reports runner errors as typed errors", async () => {
    const state = initialViewState({ caps: sqlCaps({ available: true }) });
    expect((await runCommandLine(state, ":sql SELECT 1"))?.result).toMatchObject({
      kind: "unavailable",
      reason: "sql-needs-sqlite-source"
    });
    const exported = initialViewState({ caps: sqlCaps({ available: false, reason: "sql-needs-sqlite-source" }) });
    let called = false;
    const outcome = await runCommandLine(exported, ":sql SELECT 1", {
      sql: async () => {
        called = true;
        throw new Error("must not run");
      }
    });
    expect(outcome?.result).toMatchObject({ kind: "unavailable", reason: "sql-needs-sqlite-source" });
    expect(called).toBe(false);

    const source = createSqliteSource({ path: copyStore() });
    await source.open(new AbortController().signal);
    const rejected = await runCommandLine(state, ":sql DELETE FROM events", { sql: sqlPortForSource(source) });
    expect(rejected?.result).toMatchObject({ kind: "error", code: "sql" });
    expect(rejected?.result.kind === "error" && rejected.result.notice).toContain("sql-rejected(not-select)");
    expect((await runCommandLine(state, ":sql", { sql: sqlPortForSource(source) }))?.result).toMatchObject({
      kind: "error",
      code: "usage"
    });
    await source.close();
  });
});
