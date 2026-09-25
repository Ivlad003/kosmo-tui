/**
 * SQLite container (spec 4.6) and Review focus 5 ("SQLite-файл, який саме записується
 * (WAL), або read-only FS"). Stores are written by test/trace-writers.ts, then broken on
 * purpose with plain SQL where a case needs it.
 */
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LIMITS } from "../../src/format/validate.js";
import { nodeReaderFs } from "../../src/readers/node-fs.js";
import { openTarget } from "../../src/readers/open.js";
import { SQLITE_MAGIC } from "../../src/readers/sniff.js";
import { immutableUri, openSqliteFile } from "../../src/readers/sqlite.js";
import { loadSqliteModule } from "../../src/readers/sqlite-loader.js";
import type { OpenedDataset, ReaderDeps, SqliteModule } from "../../src/readers/types.js";
import { RECIPES } from "../fixture-recipes.js";
import { dataset, recorded, type RawDocument } from "../trace-builder.js";
import {
  NODE_SQLITE_AVAILABLE,
  cleanupTempDirs,
  openWritableSqlite,
  sqliteExec,
  tempDir,
  writeSqlite
} from "../trace-writers.js";
import { signal } from "./reader-fakes.js";

afterEach(() => {
  for (const dir of readOnlyDirs.splice(0)) chmodSync(dir, 0o755);
  cleanupTempDirs();
});

const readOnlyDirs: string[] = [];
const deps: ReaderDeps = { fs: nodeReaderFs, loadSqlite: loadSqliteModule };
const canChmod = process.platform !== "win32" && process.getuid?.() !== 0;

/**
 * node:sqlite takes SQLite URI filenames only from Node 22.15: there a "file:…?mode=rwc" URI
 * creates the named file; an older node:sqlite reads the string as a plain path that cannot
 * be opened. It decides which of the two read-only-directory WAL tests below runs.
 */
const SQLITE_URI_FILENAMES: boolean = (() => {
  if (!NODE_SQLITE_AVAILABLE) return false;
  const file = path.join(tempDir(), "p.sqlite");
  try {
    openWritableSqlite(`file:${file}?mode=rwc`).close();
  } catch {
    return false;
  }
  return existsSync(file);
})();

const WAL_NEEDS_URI = "a WAL store in a read-only directory needs Node >= 22.15 (SQLite URI filenames)";

function store(
  doc: RawDocument = RECIPES["kosmo-trace/basic"]!(),
  options: { journal?: "delete" | "wal" } = {}
): string {
  const file = path.join(tempDir(), "store.kosmo-trace.sqlite");
  writeSqlite(file, doc, options);
  return file;
}

async function open(file: string): Promise<OpenedDataset> {
  const result = await openTarget({ path: file }, deps, signal());
  if (!result.ok) throw new Error(result.error.message);
  return result.dataset;
}

async function openError(file: string) {
  const result = await openTarget({ path: file }, deps, signal());
  if (result.ok) throw new Error("expected an error");
  return result.error;
}

describe.skipIf(!NODE_SQLITE_AVAILABLE)("sqlite reader: happy path", () => {
  it("opens read-only: info, first page, lazy values", async () => {
    const opened = await open(store());
    expect(opened.kind).toBe("sqlite");
    expect(opened.info.id).toBe("ds_basic");
    expect(opened.traces).toEqual({
      items: [
        {
          id: "t_cart",
          name: "GET /cart",
          spans: 4,
          status: "errored",
          requests: { first: { method: "GET", route: "/cart", status: 500 }, count: 1 }
        }
      ],
      hasMore: false
    });
    const loaded = await opened.loadTrace("t_cart", signal());
    if (!loaded.ok) throw new Error(loaded.error.message);
    const ref = { trace: "t_cart", session: "s1", id: "sp_3" };
    expect(loaded.model.get(ref)?.values).toBeUndefined();
    expect(loaded.model.get(ref)?.location).toEqual({
      file: "src/cart.ts",
      line: 12,
      column: 3,
      endLine: 20,
      snippet: "export async function calculateLineTotal(item, qty) {"
    });
    expect(await opened.loadValues?.(ref, signal())).toEqual({
      args: { state: "recorded", value: [{ id: 7 }, 2] },
      return: { state: "not-recorded", reason: "threw" },
      error: { state: "recorded", value: { name: "RangeError", message: "discount > 100%" } }
    });
    await opened.close();
    const closed = await opened.loadTrace("t_cart", signal());
    expect(closed.ok === false && closed.error.code).toBe("read-error");
  });

  it("pages of 200 in UTF-8 byte order of id; > loads the next page", async () => {
    const builder = dataset("ds_pages");
    const ids = [...Array.from({ length: 448 }, (_, i) => `t_${String(i).padStart(3, "0")}`), "t_É", "t_Z"];
    for (const id of ids) builder.trace(id).span("a", "x");
    const opened = await open(store(builder.build()));
    const sorted = [...ids].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const first = opened.traces;
    expect(first.items).toHaveLength(200);
    expect(first.hasMore).toBe(true);
    const second = await opened.loadMoreTraces!(signal());
    const third = await opened.loadMoreTraces!(signal());
    expect(second.items).toHaveLength(200);
    expect(third).toMatchObject({ hasMore: false });
    expect([...first.items, ...second.items, ...third.items].map((item) => item.id)).toEqual(sorted);
    expect(await opened.loadMoreTraces!(signal())).toEqual({ items: [], hasMore: false });
  });

  it("the aggregate summary counts requests and picks the first by (session, order)", async () => {
    const opened = await open(store(RECIPES["frameworks/express-chain"]!()));
    expect(opened.traces.items[0]).toEqual({
      id: "t_express",
      name: "orders API",
      spans: 9,
      status: "errored",
      requests: { first: { method: "GET", route: "/api/orders/:id", status: 500 }, count: 2 }
    });
  });

  it("extra tables and columns are ignored (spec 4.11)", async () => {
    const file = store();
    sqliteExec(file, "CREATE TABLE kosmo_future (x); ALTER TABLE kosmo_spans ADD COLUMN future_col TEXT;");
    expect((await open(file)).traces.items).toHaveLength(1);
  });
});

describe.skipIf(!NODE_SQLITE_AVAILABLE)("sqlite reader: refusals", () => {
  it("a missing table or column is not-a-kosmo-trace-store (this covers a callflow store)", async () => {
    const noLinks = store();
    sqliteExec(noLinks, "DROP TABLE kosmo_links");
    expect(await openError(noLinks)).toEqual({
      code: "not-a-kosmo-trace-store",
      message: "not-a-kosmo-trace-store(kosmo_links: missing table)",
      position: "kosmo_links"
    });
    const noColumn = store();
    sqliteExec(noColumn, "ALTER TABLE kosmo_spans DROP COLUMN snippet_cut");
    expect((await openError(noColumn)).message).toBe(
      "not-a-kosmo-trace-store(kosmo_spans: missing column snippet_cut)"
    );
    const callflow = path.join(tempDir(), "events.sqlite");
    sqliteExec(callflow, "CREATE TABLE events (project_id TEXT, session_id TEXT, payload_json TEXT)");
    expect((await openError(callflow)).code).toBe("not-a-kosmo-trace-store");
  });

  it("kosmo_meta decides format and version", async () => {
    const wrongFormat = store();
    sqliteExec(wrongFormat, "UPDATE kosmo_meta SET value = 'other-trace-format' WHERE key = 'format'");
    expect((await openError(wrongFormat)).message).toBe(
      "not-a-kosmo-trace(kosmo_meta(format): format is not kosmo-trace)"
    );
    const v2 = store();
    sqliteExec(v2, "UPDATE kosmo_meta SET value = '2' WHERE key = 'version'");
    expect((await openError(v2)).code).toBe("unsupported-version");
    const badDataset = store();
    sqliteExec(badDataset, "UPDATE kosmo_meta SET value = '{oops' WHERE key = 'dataset'");
    expect((await openError(badDataset)).message).toBe("invalid(kosmo_meta(dataset): not valid JSON)");
  });

  it("a span whose trace has no kosmo_traces row fails at open (one EXCEPT query)", async () => {
    const file = store();
    sqliteExec(file, "DELETE FROM kosmo_traces WHERE id = 't_cart'");
    expect(await openError(file)).toEqual({
      code: "invalid",
      message: "invalid(kosmo_spans(t_cart): trace has no row in kosmo_traces)",
      position: "kosmo_spans(t_cart)"
    });
  });

  it("magic bytes without a database, and an empty .sqlite file", async () => {
    const dir = tempDir();
    const garbage = path.join(dir, "garbage.kosmo-trace.sqlite");
    writeFileSync(garbage, new Uint8Array([...SQLITE_MAGIC, ...new Uint8Array(200).fill(7)]));
    expect((await openError(garbage)).code).toBe("not-a-kosmo-trace-store");
    const empty = path.join(dir, "empty.kosmo-trace.sqlite");
    writeFileSync(empty, "");
    expect((await openError(empty)).code).toBe("not-a-kosmo-trace-store");
  });

  it("size is checked before opening; no node:sqlite is read-error", async () => {
    const file = store();
    expect(await openSqliteFile(file, LIMITS.fileBytes + 1, deps, signal())).toEqual({
      ok: false,
      error: { code: "too-large", message: `too-large: ${file} is larger than 67108864 bytes` }
    });
    expect(await openSqliteFile(file, 10, { fs: nodeReaderFs, loadSqlite: () => null }, signal())).toEqual({
      ok: false,
      error: {
        code: "read-error",
        message: "read-error: node:sqlite is not available in this Node (kosmo-tui needs >= 22.13)"
      }
    });
    expect((await openSqliteFile(file, 10, { fs: nodeReaderFs }, signal())).ok).toBe(false);
  });

  it("a trace over 200 000 spans is trace-too-large(N) and the rest of the store stays usable", async () => {
    const file = store();
    sqliteExec(
      file,
      `INSERT INTO kosmo_traces (id, name) VALUES ('t_big', 'big');
       WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${LIMITS.traceSpans + 1})
       INSERT INTO kosmo_spans (trace, session, id, "order", name, status)
       SELECT 't_big', 's1', 'x' || i, i, 'x', 'complete' FROM n;`
    );
    const opened = await open(file);
    expect(opened.traces.items.find((item) => item.id === "t_big")?.spans).toBe(200_001);
    expect(await opened.loadTrace("t_big", signal())).toEqual({
      ok: false,
      error: { code: "trace-too-large", message: "trace-too-large(200001)", position: "kosmo_traces(t_big)" }
    });
    expect((await opened.loadTrace("t_cart", signal())).ok).toBe(true);
  }, 30_000);
});

/**
 * A node:sqlite whose errors carry only a message (no errcode). "file:" URIs open cleanly,
 * unless `uriError` is given: then the constructor throws it, as a node:sqlite without URI
 * filenames does.
 */
function messageOnlySqlite(probeError: string, tried: string[], uriError?: string): SqliteModule {
  class FakeDatabase {
    constructor(private readonly target: string) {
      tried.push(target);
      if (uriError !== undefined && target.startsWith("file:")) throw new Error(uriError);
    }
    prepare(sql: string) {
      const fails = !this.target.startsWith("file:") && !sql.startsWith("PRAGMA");
      return {
        all: (): unknown[] => [],
        get: (): unknown => {
          if (fails) throw new Error(probeError);
          return { n: 0 };
        }
      };
    }
    close(): void {}
  }
  return { DatabaseSync: FakeDatabase };
}

describe("sqlite reader: errors without errcode (an older node:sqlite)", () => {
  it("are classified by the SQLite message: readonly → immutable retry, not a database → refusal", async () => {
    const readonlyTried: string[] = [];
    const retried = await openSqliteFile(
      "/data/x.kosmo-trace.sqlite",
      10,
      { fs: nodeReaderFs, loadSqlite: () => messageOnlySqlite("attempt to write a readonly database", readonlyTried) },
      signal()
    );
    expect(readonlyTried).toEqual(["/data/x.kosmo-trace.sqlite", immutableUri("/data/x.kosmo-trace.sqlite")]);
    expect(retried.ok === false && retried.error.message).toBe("not-a-kosmo-trace-store(kosmo_meta: missing table)");
    const notDatabaseTried: string[] = [];
    const refused = await openSqliteFile(
      "/data/y.kosmo-trace.sqlite",
      10,
      { fs: nodeReaderFs, loadSqlite: () => messageOnlySqlite("file is not a database", notDatabaseTried) },
      signal()
    );
    expect(notDatabaseTried).toEqual(["/data/y.kosmo-trace.sqlite"]);
    expect(refused.ok === false && refused.error.code).toBe("not-a-kosmo-trace-store");
  });

  it("readonly, then a URI that cannot be opened, names the missing URI filenames (Node < 22.15)", async () => {
    const tried: string[] = [];
    const named = await openSqliteFile(
      "/data/w.kosmo-trace.sqlite",
      10,
      {
        fs: nodeReaderFs,
        loadSqlite: () =>
          messageOnlySqlite("attempt to write a readonly database", tried, "unable to open database file")
      },
      signal()
    );
    expect(tried).toEqual(["/data/w.kosmo-trace.sqlite", immutableUri("/data/w.kosmo-trace.sqlite")]);
    expect(named).toEqual({
      ok: false,
      error: { code: "read-error", message: `read-error: /data/w.kosmo-trace.sqlite: ${WAL_NEEDS_URI}` }
    });
    const cantOpen = await openSqliteFile(
      "/data/v.kosmo-trace.sqlite",
      10,
      {
        fs: nodeReaderFs,
        loadSqlite: () => messageOnlySqlite("unable to open database file", [], "unable to open database file")
      },
      signal()
    );
    expect(cantOpen).toEqual({
      ok: false,
      error: { code: "read-error", message: "read-error: /data/v.kosmo-trace.sqlite: unable to open database file" }
    });
  });
});

describe.skipIf(!NODE_SQLITE_AVAILABLE)("sqlite reader: degraded rows", () => {
  it("bad attrs text degrades to invalid-attrs; bad values degrade lazily to invalid-value", async () => {
    const file = store();
    sqliteExec(
      file,
      `UPDATE kosmo_spans SET attrs = '{broken' WHERE id = 'sp_1';
       UPDATE kosmo_spans SET args = 'not json', ret = '{"state":"live","value":1}' WHERE id = 'sp_2';`
    );
    const opened = await open(file);
    const loaded = await opened.loadTrace("t_cart", signal());
    if (!loaded.ok) throw new Error(loaded.error.message);
    const sp1 = loaded.model.get({ trace: "t_cart", session: "s1", id: "sp_1" });
    expect(sp1?.attrs).toBeUndefined();
    expect(sp1?.marks).toContain("invalid-attrs");
    const values = await opened.loadValues!({ trace: "t_cart", session: "s1", id: "sp_2" }, signal());
    expect(values.args).toEqual({
      state: "invalid-value",
      position: "kosmo_spans(t_cart,s1,sp_2).args",
      what: "not valid JSON"
    });
    expect(values.return.state).toBe("invalid-value");
    expect(values.error).toEqual({ state: "not-recorded" });
    const gone = await opened.loadValues!({ trace: "t_cart", session: "s1", id: "nope" }, signal());
    expect(gone.args).toEqual({
      state: "invalid-value",
      position: "kosmo_spans(t_cart,s1,nope)",
      what: "span not found"
    });
  });

  it("a fatal row fails loadTrace with the table/primary-key position", async () => {
    const file = store();
    sqliteExec(file, `UPDATE kosmo_spans SET "order" = -1 WHERE id = 'sp_4'`);
    const loaded = await (await open(file)).loadTrace("t_cart", signal());
    expect(loaded.ok === false && loaded.error.code).toBe("invalid");
    expect(loaded.ok === false && loaded.error.message.startsWith("invalid(kosmo_spans(t_cart,s1,sp_4)")).toBe(true);
  });
});

describe.skipIf(!NODE_SQLITE_AVAILABLE)(
  "sqlite reader: a store being written, a read-only file system (Review focus 5)",
  () => {
    it("reads committed data while a WAL writer holds an open transaction", async () => {
      const file = store(RECIPES["kosmo-trace/basic"]!(), { journal: "wal" });
      const writer = openWritableSqlite(file);
      try {
        writer.exec("BEGIN IMMEDIATE; INSERT INTO kosmo_traces (id, name) VALUES ('t_pending', 'uncommitted');");
        const opened = await open(file);
        expect(opened.traces.items.map((item) => item.id)).toEqual(["t_cart"]);
        expect((await opened.loadTrace("t_cart", signal())).ok).toBe(true);
        await opened.close();
        writer.exec("COMMIT");
        const again = await open(file);
        expect(again.traces.items.map((item) => item.id)).toEqual(["t_cart", "t_pending"]);
        await again.close();
      } finally {
        writer.close();
      }
    });

    it.skipIf(!canChmod || !SQLITE_URI_FILENAMES)(
      "opens a WAL store in a read-only directory as immutable (no -shm can be created; Node >= 22.15)",
      async () => {
        const file = store(RECIPES["kosmo-trace/basic"]!(), { journal: "wal" });
        const dir = path.dirname(file);
        chmodSync(file, 0o444);
        chmodSync(dir, 0o555);
        readOnlyDirs.push(dir);
        const opened = await open(file);
        expect(opened.traces.items.map((item) => item.id)).toEqual(["t_cart"]);
        const loaded = await opened.loadTrace("t_cart", signal());
        expect(loaded.ok && loaded.model.size).toBe(4);
        await opened.close();
      }
    );

    it.skipIf(!canChmod || SQLITE_URI_FILENAMES)(
      "a WAL store in a read-only directory is a named read-error without SQLite URI filenames (Node < 22.15)",
      async () => {
        const file = store(RECIPES["kosmo-trace/basic"]!(), { journal: "wal" });
        const dir = path.dirname(file);
        chmodSync(file, 0o444);
        chmodSync(dir, 0o555);
        readOnlyDirs.push(dir);
        expect(await openError(file)).toEqual({ code: "read-error", message: `read-error: ${file}: ${WAL_NEEDS_URI}` });
      }
    );

    it.skipIf(!canChmod)("opens a read-only rollback-journal store in a read-only directory", async () => {
      const file = store();
      const dir = path.dirname(file);
      chmodSync(file, 0o444);
      chmodSync(dir, 0o555);
      readOnlyDirs.push(dir);
      const opened = await open(file);
      expect(opened.traces.items).toHaveLength(1);
      expect(await opened.loadValues!({ trace: "t_cart", session: "s1", id: "sp_4" }, signal())).toMatchObject({
        args: { state: "recorded", value: [7] }
      });
      await opened.close();
    });

    it("never writes to the store", async () => {
      const file = store(
        dataset("ds")
          .trace("t")
          .span("a", "x", { args: recorded(1) })
          .build()
      );
      const before = readFileSync(file);
      const opened = await open(file);
      await opened.loadTrace("t", signal());
      await opened.loadValues!({ trace: "t", session: "s1", id: "a" }, signal());
      await opened.close();
      expect(readFileSync(file).equals(before)).toBe(true);
      expect(readdirSync(path.dirname(file))).toEqual(["store.kosmo-trace.sqlite"]);
    });
  }
);
