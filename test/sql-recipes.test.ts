/**
 * Task 5b.3: every ```sql block of docs/sql-recipes.md runs VERBATIM through the shared
 * runner against the daemon-written fixture store, and its rows are snapshotted. The
 * recipes use real `kosmo.trace-sql/v1` columns, session-aware joins and cycle guards, and
 * end with ORDER BY over full keys, so two runs give identical rows.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readSqliteDatasetSnapshot } from "@kosmo-callflow/query/sqlite";
import { runTraceSql, traceSqlSchema } from "@kosmo-callflow/query/sql";
import type { TraceDatasetSnapshot } from "@kosmo-callflow/query/snapshot";
import { cleanupDirs, copyStore } from "./sqlite-fixtures.js";

const doc = readFileSync(new URL("../docs/sql-recipes.md", import.meta.url), "utf8");

/** `## heading` → the sql blocks under it, in document order. */
function recipes(): Array<{ title: string; sql: string }> {
  const found: Array<{ title: string; sql: string }> = [];
  let title = "";
  let index = 0;
  const lines = doc.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.startsWith("## ")) {
      title = line.slice(3).trim();
      index = 0;
      continue;
    }
    if (line.trim() !== "```sql") continue;
    const body: string[] = [];
    for (i += 1; i < lines.length && lines[i]!.trim() !== "```"; i += 1) body.push(lines[i]!);
    index += 1;
    found.push({ title: index === 1 ? title : `${title} #${index}`, sql: body.join("\n") });
  }
  return found;
}

let snapshot: TraceDatasetSnapshot;
beforeAll(() => {
  snapshot = readSqliteDatasetSnapshot(copyStore());
});
afterAll(cleanupDirs);

const all = recipes();

describe("SQL recipes (task 5b.3)", () => {
  it("documents the recipes the task asks for", () => {
    expect(all.map((recipe) => recipe.title)).toEqual([
      "Slowest spans",
      "Errors by kind",
      "Ancestors of a span",
      "Ancestors of a span #2",
      "Cross-session parent candidates",
      "Value-equality candidates (not lineage)",
      "Per-request timeline"
    ]);
    expect(doc).toContain("**Equal values are\nnot lineage:**");
  });

  it("uses only real kosmo.trace-sql/v1 column names in the tables it reads", () => {
    const columns = new Set<string>(Object.values(traceSqlSchema).flatMap((table) => table.map(([name]) => name)));
    for (const recipe of all) {
      for (const match of recipe.sql.matchAll(/\b(?:e|s|t|c|p|g|r|events)\.([a-z_]+)\b/g)) {
        expect(columns.has(match[1]!) || ["value", "side", "depth", "visited", "type"].includes(match[1]!)).toBe(true);
      }
      expect(recipe.sql).toMatch(/ORDER BY [^;]+;\s*$/);
      expect(recipe.sql).not.toMatch(/\bspanId\b|\btraceId\b|\bsessionId\b|\bpayload\b(?!_json)/);
    }
  });

  for (const recipe of all) {
    it(`runs verbatim: ${recipe.title}`, async () => {
      const first = await runTraceSql(snapshot, { sql: recipe.sql });
      const second = await runTraceSql(snapshot, { sql: recipe.sql });
      expect(first.truncated).toBe(false);
      expect(first.rows.length).toBeGreaterThan(0);
      expect(second.rows).toEqual(first.rows);
      expect({ columns: first.columns, rows: first.rows }).toMatchSnapshot();
    });
  }

  it("session-aware walks stop at a cross-session parent and at a recorded cycle", async () => {
    const ancestors = await runTraceSql(snapshot, { sql: all[2]!.sql });
    // query -> handle; the parent `req` is recorded by another session and is not joined.
    expect(ancestors.rows.map((row) => row[3])).toEqual(["query", "handle"]);
    const cycle = await runTraceSql(snapshot, { sql: all[3]!.sql });
    expect(cycle.rows.map((row) => row[3])).toEqual(["a", "b"]);
    const candidates = await runTraceSql(snapshot, { sql: all[4]!.sql });
    expect(candidates.rows).toContainEqual(["t-checkout", "s-api", "handle", "req", "s-web"]);
  });
});
