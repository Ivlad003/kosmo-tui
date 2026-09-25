/**
 * Spec 13.1: fixtures without callflow. The builder recipes reproduce every committed
 * fixture exactly (same keys in the same order), and the writers put the same dataset
 * into all three containers: JSON (4.1), NDJSON (4.5) and SQLite with the 4.6 schema.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_NAMES, RECIPES, fixtureFile } from "../fixture-recipes.js";
import { dataset, recorded } from "../trace-builder.js";
import {
  NODE_SQLITE_AVAILABLE,
  cleanupTempDirs,
  openWritableSqlite,
  tempDir,
  toJsonText,
  toNdjsonLines,
  toNdjsonText,
  writeAllContainers,
  writeSqlite
} from "../trace-writers.js";

afterEach(cleanupTempDirs);

const fixturesDir = new URL("../fixtures/", import.meta.url);

function recipe(name: string) {
  const build = RECIPES[name];
  if (build === undefined) throw new Error(`no recipe ${name}`);
  return build();
}

describe("committed fixtures (spec 13.1)", () => {
  it("has a recipe for every committed kosmo-trace and frameworks fixture", () => {
    const committed = ["kosmo-trace", "frameworks"].flatMap((dir) =>
      readdirSync(new URL(`${dir}/`, fixturesDir))
        .filter((file) => file.endsWith(".kosmo-trace.json"))
        .map((file) => `${dir}/${file.replace(/\.kosmo-trace\.json$/, "")}`)
    );
    expect([...FIXTURE_NAMES].sort()).toEqual(committed.sort());
  });

  it.each(FIXTURE_NAMES)("recipe %s builds exactly the committed file (keys and key order)", (name) => {
    const committed: unknown = JSON.parse(readFileSync(fixtureFile(name), "utf8"));
    // Compact JSON compares values AND key order; attrs order is meaningful (spec 4.13).
    expect(JSON.stringify(committed)).toBe(JSON.stringify(recipe(name)));
  });

  it("keeps the hostile directory out of prettier", () => {
    const ignore = readFileSync(new URL("../../.prettierignore", import.meta.url), "utf8").split("\n");
    expect(ignore).toContain("test/fixtures/hostile");
    expect(ignore).toContain("test/fixtures/kosmo-trace");
    expect(ignore).toContain("test/fixtures/frameworks");
  });
});

describe("trace builder", () => {
  it("assigns order per (trace, session), defaults status and parent, keeps key order", () => {
    const doc = dataset("ds")
      .trace("t", "T")
      .span("a", "first")
      .span("b", "second", { parent: "a", order: 7 })
      .span("c", "third")
      .session("s2")
      .span("a", "otherSession")
      .inTrace("u")
      .span("z", "undeclared", { status: "running" })
      .link("z", { trace: "t", session: "s1", id: "a" }, "caused-by")
      .field("x-extra", 1)
      .build();
    expect(doc.traces).toEqual([{ id: "t", name: "T" }]);
    expect(doc.spans.map((span) => [span.trace, span.session, span.id, span.order, span.parent, span.status])).toEqual([
      ["t", "s1", "a", 0, null, "complete"],
      ["t", "s1", "b", 7, "a", "complete"],
      ["t", "s1", "c", 8, null, "complete"],
      ["t", "s2", "a", 0, null, "complete"],
      ["u", "s1", "z", 0, null, "running"]
    ]);
    expect(doc.links).toEqual([
      { from: { trace: "u", session: "s1", id: "z" }, to: { trace: "t", session: "s1", id: "a" }, kind: "caused-by" }
    ]);
    expect(Object.keys(doc)).toEqual(["format", "version", "dataset", "traces", "spans", "links", "x-extra"]);
    expect(Object.keys(doc.spans[1]!)).toEqual(["trace", "session", "id", "parent", "order", "name", "status"]);
  });

  it("returns an independent copy on every build", () => {
    const builder = dataset("ds")
      .trace("t")
      .span("a", "x", { args: recorded([1]) });
    const first = builder.build();
    first.spans[0]!.name = "changed";
    expect(builder.build().spans[0]!.name).toBe("x");
  });
});

describe("writers", () => {
  const doc = recipe("kosmo-trace/basic");

  it("JSON text parses back to the same document", () => {
    expect(JSON.parse(toJsonText(doc))).toEqual(doc);
  });

  it("NDJSON: header first, flat records next to type, every record once", () => {
    const lines = toNdjsonLines(doc).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toEqual({ type: "header", format: "kosmo-trace", version: 1, dataset: doc.dataset });
    expect(lines.slice(1).map((line) => line.type)).toEqual(["trace", "span", "span", "span", "span"]);
    expect(lines[2]).toEqual({ type: "span", ...doc.spans[0] });
    const reversed = toNdjsonLines(doc, "reverse").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(reversed[0]?.type).toBe("header");
    expect(reversed.slice(1).map((line) => line.id)).toEqual(["sp_4", "sp_3", "sp_2", "sp_1", "t_cart"]);
  });

  it("NDJSON options: BOM, CRLF and a last line without a line end", () => {
    const text = toNdjsonText(doc, { bom: true, crlf: true, trailingNewline: false });
    expect(text.startsWith("\ufeff{")).toBe(true);
    expect(text.split("\r\n")).toHaveLength(6);
    expect(text.endsWith("}")).toBe(true);
    expect(toNdjsonText(doc).endsWith("}\n")).toBe(true);
  });

  it.skipIf(!NODE_SQLITE_AVAILABLE)("SQLite: exact spec 4.6 tables and columns, both indexes, meta rows", () => {
    const file = path.join(tempDir(), "basic.kosmo-trace.sqlite");
    writeSqlite(file, doc);
    const db = openWritableSqlite(file);
    try {
      const columns = (table: string) =>
        db
          .prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid")
          .all(table)
          .map((row) => (row as { name: string }).name);
      expect(columns("kosmo_meta")).toEqual(["key", "value"]);
      expect(columns("kosmo_traces")).toEqual(["id", "name"]);
      expect(columns("kosmo_spans")).toEqual([
        "trace", "session", "id", "parent", "parent_session", "order", "name", "kind", "status", "status_reason",
        "duration_ms", "runtime", "file", "line", "col", "end_line", "snippet", "snippet_cut", "area_module",
        "area_feature", "attrs", "args", "ret", "error"
      ]); // prettier-ignore
      expect(columns("kosmo_links")).toEqual([
        "from_trace", "from_session", "from_id", "to_trace", "to_session", "to_id", "kind"
      ]); // prettier-ignore
      const indexes = db
        .prepare(
          "SELECT name, \"unique\" AS isUnique FROM pragma_index_list('kosmo_spans') WHERE origin = 'c' ORDER BY name"
        )
        .all()
        .map((row) => ({ ...(row as { name: string; isUnique: number }) }));
      expect(indexes).toEqual([
        { name: "kosmo_spans_order", isUnique: 1 },
        { name: "kosmo_spans_parent", isUnique: 0 }
      ]);
      const meta = Object.fromEntries(
        db
          .prepare("SELECT key, value FROM kosmo_meta ORDER BY key")
          .all()
          .map((row) => [(row as { key: string }).key, (row as { value: string }).value])
      );
      expect(meta).toEqual({ dataset: JSON.stringify(doc.dataset), format: "kosmo-trace", version: "1" });
      const sp3 = { ...(db.prepare("SELECT * FROM kosmo_spans WHERE id = 'sp_3'").get() as Record<string, unknown>) };
      expect(sp3).toMatchObject({
        parent: "sp_1",
        order: 2,
        file: "src/cart.ts",
        line: 12,
        col: 3,
        end_line: 20,
        snippet_cut: null,
        area_module: "src/cart",
        attrs: '{"code.function":"calculateLineTotal"}',
        ret: '{"state":"not-recorded","reason":"threw"}'
      });
      expect(() =>
        db.exec(
          `INSERT INTO kosmo_spans (trace, session, id, "order", name, status) VALUES ('t_cart', 's1', 'dup', 2, 'x', 'complete')`
        )
      ).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }
  });

  it.skipIf(!NODE_SQLITE_AVAILABLE)(
    "SQLite: a trace known only through span.trace gets a row with NULL name; snippetCut maps to 0/1",
    () => {
      const doc2 = dataset("ds")
        .inTrace("t_only")
        .span("a", "x", { location: { file: "a.ts", line: 1, snippet: "abc", snippetCut: true } })
        .span("b", "y", { location: { file: "a.ts", line: 2, snippet: "def", snippetCut: false } })
        .build();
      const { sqlite } = writeAllContainers(doc2);
      const db = openWritableSqlite(sqlite);
      try {
        expect({ ...(db.prepare("SELECT id, name FROM kosmo_traces").get() as object) }).toEqual({
          id: "t_only",
          name: null
        });
        expect(
          db
            .prepare("SELECT snippet_cut AS cut FROM kosmo_spans ORDER BY id")
            .all()
            .map((row) => (row as { cut: number }).cut)
        ).toEqual([1, 0]);
      } finally {
        db.close();
      }
    }
  );
});
