/**
 * Task 4.4 (KT half): the SQLite source over a store written by the real kosmo-callflow
 * daemon. It reads through the shared `readSqliteDatasetSnapshot` with a driver chosen
 * by feature detection, pins ONE snapshot (no polling), refuses to mix it with a newer
 * read unless `reload()` is asked for, and makes every failure explicit: future schema,
 * busy, read-only WAL location, concurrent writer, missing driver.
 */
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectCanonicalPage } from "@kosmo-callflow/query/snapshot";
import { nodeSqliteSupport } from "@kosmo-callflow/query/sql";
import { readSqliteDatasetSnapshot, SqliteSourceError } from "@kosmo-callflow/query/sqlite";
import { effectiveCapabilities } from "../src/capabilities.js";
import { openTargetSource } from "../src/source-open.js";
import { createSqliteSource, sqliteSourceError } from "../src/source-sqlite.js";
import { SourceError } from "../src/source-common.js";
import { detectSqliteDriver, type SqliteDriverProbe, type SqliteDriverSelection } from "../src/sqlite-driver.js";
import { appendEvent, cleanupDirs, copyStore, Database, FIXTURE_PROJECT, tempDir } from "./sqlite-fixtures.js";

afterEach(cleanupDirs);

const signal = (): AbortSignal => new AbortController().signal;

const drivers = (["better-sqlite3", "node:sqlite"] as const)
  .map((name) => ({ name, selection: detectSqliteDriver(name) }))
  .filter(
    (entry): entry is { name: typeof entry.name; selection: Extract<SqliteDriverSelection, { ok: true }> } =>
      entry.selection.ok
  );

const betterSqlite = drivers.find((entry) => entry.name === "better-sqlite3")?.selection;

const noDriverProbe: SqliteDriverProbe = {
  nodeVersion: "v18.19.0",
  execArgv: [],
  resolveBetterSqlite3: () => undefined,
  nodeSqliteReadDriver: () => undefined
};

async function rejection(promise: Promise<unknown>): Promise<SourceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SourceError);
    return error as SourceError;
  }
  throw new Error("expected a rejection");
}

describe("sqlite source (task 4.4)", () => {
  it("has the better-sqlite3 dev peer, and node:sqlite exactly where this Node supports it", () => {
    const support = nodeSqliteSupport();
    const nodeSqlite = support.available && support.execArgv.every((flag) => process.execArgv.includes(flag));
    expect(drivers.map((entry) => entry.name)).toEqual(
      nodeSqlite ? ["better-sqlite3", "node:sqlite"] : ["better-sqlite3"]
    );
    if (!nodeSqlite) {
      // e.g. Node 18.19: an explicit unavailable with the reason, never a silent fallback.
      expect(detectSqliteDriver("node:sqlite")).toMatchObject({
        ok: false,
        reason: "sqlite-driver",
        nodeSqlite: support.available ? "needs-flag" : "absent"
      });
    }
  });

  for (const { name, selection } of drivers) {
    it(`reads the daemon store through the shared reader and projector (${name})`, async () => {
      const file = copyStore();
      const source = createSqliteSource({ path: file, driver: selection });
      const open = await source.open(signal());
      expect(source.kind).toBe("sqlite");
      expect(open.snapshot).toMatchObject({
        datasetId: `live:${FIXTURE_PROJECT}`,
        projectId: FIXTURE_PROJECT,
        revision: "sqlite-schema-8",
        watermark: 14
      });
      expect(open.stableDataset).toBe(true);
      expect(open.firstPage.items.map((row) => `${row.sessionId}/${row.traceId}:${row.status}`).sort()).toEqual([
        "s-api/t-checkout:errored",
        "s-api/t-cycle:running",
        "s-web/t-checkout:complete",
        "s-web/t-login:errored"
      ]);
      // Static snapshot: no follow; SQL is offered because this IS a sqlite source.
      expect(open.offers.follow).toEqual({ available: false, reason: "static-snapshot" });
      expect(open.offers.sql).toEqual({ available: true });
      expect(open.offers.probes).toEqual({ available: false, reason: "no-probe-records" });
      const caps = effectiveCapabilities(open, source, { readOnly: false, noEval: false, print: false });
      expect(caps.follow.available).toBe(false);
      expect(caps.replay.available).toBe(true);
      expect(caps.projectionVersions).toEqual([1, 2]);

      // Canonical pages are the shared projector's bytes over the same snapshot.
      const ref = { ...open.firstPage.items.find((row) => row.traceId === "t-checkout")! };
      const page = await source.canonical!(open.snapshot, { kind: "trace", ref }, { version: 2 }, signal());
      const direct = projectCanonicalPage(readSqliteDatasetSnapshot(file, { driver: selection.read }), {
        projectionVersion: 2,
        traceId: "t-checkout",
        maxSpans: 1000
      });
      expect(JSON.stringify(page.envelope)).toBe(JSON.stringify(direct));

      const details = await source.details!(
        open.snapshot,
        { ...ref, sessionId: "s-web", spanId: "validate" },
        signal()
      );
      expect(details).toMatchObject({ nodeId: "src/web/validate.ts#validate", ret: { state: "recorded" } });

      // Replay records: independent events.seq domain, only the selected trace.
      const records = await source.records!(
        open.snapshot,
        { kind: "trace", ref: { ...ref, sessionId: "s-web" } },
        { limit: 100 },
        signal()
      );
      expect(records.items.map((record) => (record as unknown as { seq: number }).seq)).toEqual([1, 2, 3, 4]);
      await source.close();
    });
  }

  it("never creates, migrates or rewrites the store and holds no lock after open", async () => {
    const file = copyStore({ wal: true });
    const before = { bytes: readFileSync(file), mtime: statSync(file).mtimeMs };
    const source = createSqliteSource({ path: file });
    await source.open(signal());
    // The read transaction is closed: an exclusive writer can start right away.
    const writer = new Database(file);
    writer.exec("BEGIN EXCLUSIVE");
    writer.exec("ROLLBACK");
    writer.close();
    expect(statSync(file).mtimeMs).toBe(before.mtime);
    const version = new Database(file, { readonly: true });
    expect(version.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()).toEqual({ value: "8" });
    version.close();
    await source.close();

    const missing = path.join(tempDir(), "events.sqlite");
    const error = await rejection(createSqliteSource({ path: missing }).open(signal()));
    expect(error.code).toBe("not-found");
    expect(existsSync(missing)).toBe(false);
  });

  it("stays on its snapshot while a concurrent writer appends; reload is explicit and changes identity", async () => {
    const file = copyStore({ wal: true });
    const source = createSqliteSource({ path: file, pageSize: 1 });
    const first = await source.open(signal());
    expect(first.firstPage.cursor).not.toBeNull();

    // A concurrent daemon-style writer, open for the whole test.
    const writer = new Database(file);
    writer.exec("BEGIN IMMEDIATE");
    appendEvent(writer, {
      sessionId: "s-api",
      localSeq: 7,
      traceId: "t-late",
      spanId: "late",
      nodeId: "src/api/late.ts#late"
    });
    writer.exec("COMMIT");

    // No polling, no silent refresh: the pinned snapshot still answers.
    const page = await source.traces(first.snapshot, { limit: 100 }, signal());
    expect(page.items.some((row) => row.traceId === "t-late")).toBe(false);
    expect(source.datasetSnapshot(first.snapshot).identity.watermarkSeq).toBe(14);

    // A writer holding a write transaction does not block the short read of reload.
    writer.exec("BEGIN IMMEDIATE");
    appendEvent(writer, {
      sessionId: "s-api",
      localSeq: 8,
      traceId: "t-pending",
      spanId: "p",
      nodeId: "src/api/p.ts#p"
    });
    const reloaded = await source.reload(signal());
    writer.exec("ROLLBACK");
    writer.close();
    expect(reloaded.snapshot.snapshotId).not.toBe(first.snapshot.snapshotId);
    expect(reloaded.snapshot.watermark).toBe(15);
    const after = await source.traces(reloaded.snapshot, { limit: 100 }, signal());
    expect(after.items.map((row) => row.traceId)).toContain("t-late");
    expect(after.items.map((row) => row.traceId)).not.toContain("t-pending");

    // Load-more beyond the old snapshot is refused instead of mixing revisions.
    expect((await rejection(source.traces(first.snapshot, { limit: 1 }, signal()))).code).toBe("snapshot-changed");
    const stale = await rejection(
      source.traces(reloaded.snapshot, { limit: 1, cursor: first.firstPage.cursor }, signal())
    );
    expect(stale.code).toBe("cursor-rejected");
    expect(stale.message).toContain("snapshot-changed");
    expect(() => source.datasetSnapshot(first.snapshot)).toThrow(/snapshot/);
    await source.close();
  });

  it("rejects a future schema without touching the file", async () => {
    const file = copyStore();
    const db = new Database(file);
    db.prepare("UPDATE schema_meta SET value = '9' WHERE key = 'schema_version'").run();
    db.close();
    const mtime = statSync(file).mtimeMs;
    const error = await rejection(createSqliteSource({ path: file }).open(signal()));
    expect(error.code).toBe("future-schema");
    expect(error.message).toContain("future-schema(9)");
    expect(statSync(file).mtimeMs).toBe(mtime);
    const check = new Database(file, { readonly: true });
    expect(check.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()).toEqual({ value: "9" });
    check.close();
  });

  it("reports a busy store when a writer holds an exclusive lock", async () => {
    expect(betterSqlite).toBeDefined();
    const file = copyStore({ wal: true });
    const writer = new Database(file);
    writer.pragma("locking_mode = EXCLUSIVE");
    writer.exec("BEGIN EXCLUSIVE");
    appendEvent(writer, { sessionId: "s-api", localSeq: 9, traceId: "t-x", spanId: "x", nodeId: "src/x.ts#x" });
    try {
      const error = await rejection(
        createSqliteSource({ path: file, driver: betterSqlite!, busyTimeoutMs: 50 }).open(signal())
      );
      expect(error.code).toBe("busy");
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });

  it("makes WAL failures explicit: a WAL store in a read-only directory, and cantopen", async () => {
    if (process.getuid?.() !== 0) {
      const dir = tempDir();
      const file = copyStore({ wal: true, dir });
      chmodSync(dir, 0o500);
      try {
        for (const { selection } of drivers) {
          const error = await rejection(createSqliteSource({ path: file, driver: selection }).open(signal()));
          expect(error.code).toBe("read-only-filesystem");
        }
      } finally {
        chmodSync(dir, 0o700);
      }
    }
    // The reader's wal-unavailable classification survives the source mapping.
    const cantOpen = createSqliteSource({
      path: "/unused.sqlite",
      driver: betterSqlite!,
      read: () => {
        throw new SqliteSourceError("wal-unavailable", "unable to open database file", "cantopen");
      }
    });
    const error = await rejection(cantOpen.open(signal()));
    expect(error.code).toBe("wal-unavailable");
    expect(error.message).toContain("wal-unavailable(cantopen)");
  });

  it("reports a missing driver as unavailable(sqlite-driver) with an install hint", async () => {
    const selection = detectSqliteDriver("auto", noDriverProbe);
    expect(selection).toMatchObject({ ok: false, reason: "sqlite-driver", nodeSqlite: "absent" });
    const file = copyStore();
    const error = await rejection(createSqliteSource({ path: file, driver: selection }).open(signal()));
    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("unavailable(sqlite-driver)");
    expect(error.message).toContain("npm i better-sqlite3");

    // Through the target switch: the sqlite target opens a source, which fails explicitly;
    // an export or stdin target is unaffected.
    const opened = await openTargetSource(
      { target: { kind: "sqlite", path: file }, project: null, env: {}, cwd: tempDir() },
      { sqliteDriver: selection }
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.source.kind).toBe("sqlite");
    expect((await rejection(opened.source.open(signal()))).code).toBe("unavailable");
  });

  it("keeps project isolation and the input budget of the shared reader", async () => {
    const file = copyStore();
    const db = new Database(file);
    db.exec("INSERT INTO projects(project_id, created_at_wall) VALUES ('other-project', 0)");
    db.close();
    expect((await rejection(createSqliteSource({ path: file }).open(signal()))).code).toBe("project-ambiguous");
    const scoped = await createSqliteSource({ path: file, projectId: FIXTURE_PROJECT }).open(signal());
    expect(scoped.snapshot.projectId).toBe(FIXTURE_PROJECT);
    expect((await rejection(createSqliteSource({ path: copyStore(), maxRows: 3 }).open(signal()))).code).toBe(
      "dataset-too-large"
    );
    const oneTrace = await createSqliteSource({ path: copyStore(), traceId: "t-login" }).open(signal());
    expect(oneTrace.firstPage.items.map((row) => row.traceId)).toEqual(["t-login"]);
  });

  it("maps unknown reader failures without leaking a stack", () => {
    const mapped = sqliteSourceError(new Error("disk I/O error"));
    expect(mapped).toMatchObject({ code: "read-failed" });
    expect(mapped.message).toBe("kosmo-tui: sqlite source read-failed: disk I/O error");
  });
});
