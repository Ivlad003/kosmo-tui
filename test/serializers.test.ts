/**
 * Task 5b.2: typed serializers. The result kind decides the formats (projection →
 * lisp/tab/json via the protocol codecs; table → json or kosmo.query-table/v1; value →
 * json); unsupported combinations are usage errors; every output stays within 51,200
 * UTF-8 bytes and stays valid — whole rows/items are dropped, never half a UTF-8
 * sequence, a JSON token or a Tab row.
 */
import { describe, expect, it } from "vitest";
import {
  parseTraceText,
  parseTraceTextV2,
  projectTraceTextDocument,
  projectTraceTextDocumentV2,
  type CanonicalPageEnvelope
} from "@kosmo-callflow/protocol";
import { projectCanonicalPage } from "@kosmo-callflow/query/snapshot";
import { readSqliteDatasetSnapshot } from "@kosmo-callflow/query/sqlite";
import { afterEach } from "vitest";
import {
  OUTPUT_MAX_BYTES,
  QUERY_TABLE_SCHEMA,
  serializeResult,
  tabCell,
  type ProjectionResult,
  type TableResult
} from "../src/serializers.js";
import { cleanupDirs, copyStore } from "./sqlite-fixtures.js";

afterEach(cleanupDirs);

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function table(rows: unknown[][], columns = ["value"]): TableResult {
  return {
    kind: "table",
    schema: "kosmo.trace-sql/v1",
    scope: { projectId: "p", snapshotId: "snap-1", traceId: null },
    coverage: { exhaustive: true, retention: false, loss: false },
    columns,
    rows,
    truncated: false
  };
}

function projections(): { v1: ProjectionResult; v2: ProjectionResult } {
  const snapshot = readSqliteDatasetSnapshot(copyStore());
  const v2 = projectCanonicalPage(snapshot, { projectionVersion: 2, traceId: "t-checkout", maxSpans: 1000 });
  const v1 = projectCanonicalPage(snapshot, { traceId: "t-checkout", maxSpans: 1000, maxEvents: 1000 });
  return {
    v1: {
      kind: "projection",
      version: 1,
      document: projectTraceTextDocument(v1 as CanonicalPageEnvelope, { detail: 2, values: true })
    },
    v2: { kind: "projection", version: 2, document: projectTraceTextDocumentV2(v2, { detail: 2, values: true }) }
  };
}

describe("result kind decides the format (task 5b.2)", () => {
  it("tables default to JSON, accept Tab, and refuse Lisp without inventing spans", () => {
    const result = table([[42]], ["n"]);
    const json = serializeResult(result);
    expect(json).toMatchObject({ ok: true, format: "json", truncated: false });
    expect(JSON.parse(json.ok ? json.text : "")).toMatchObject({ kind: "table", columns: ["n"], rows: [[42]] });

    const tab = serializeResult(result, "tab");
    expect(tab.ok && tab.text.split("\n")[0]).toBe(QUERY_TABLE_SCHEMA);
    expect(tab.ok && tab.text).not.toContain("kosmo.trace-text");

    const lisp = serializeResult(result, "lisp");
    expect(lisp).toMatchObject({ ok: false, code: "unsupported-format" });
    expect(!lisp.ok && lisp.message).toContain("use json or tab");
  });

  it("values are JSON only", () => {
    const value = { kind: "value" as const, provenance: "computed-local", value: { a: 1 }, truncated: false };
    expect(serializeResult(value)).toMatchObject({ ok: true, format: "json" });
    expect(serializeResult(value, "tab")).toMatchObject({ ok: false, code: "unsupported-format" });
    expect(serializeResult(value, "lisp")).toMatchObject({ ok: false, code: "unsupported-format" });
  });

  it("projections render through the protocol codecs in lisp, tab and json", () => {
    const { v1, v2 } = projections();
    for (const dialect of ["lisp", "tab"] as const) {
      const one = serializeResult(v1, dialect);
      expect(one.ok).toBe(true);
      if (one.ok) expect(parseTraceText(one.text, { dialect }).ok).toBe(true);
      const two = serializeResult(v2, dialect);
      expect(two.ok).toBe(true);
      if (two.ok) {
        const parsed = parseTraceTextV2(two.text, { dialect });
        expect(parsed.ok ? "ok" : `${dialect}: ${JSON.stringify(parsed)}`).toBe("ok");
      }
    }
    const json = serializeResult(v2, "json");
    expect(json.ok && JSON.parse(json.text)).toEqual(JSON.parse(JSON.stringify(v2.document)));
    expect(serializeResult(v2)).toMatchObject({ ok: true, format: "lisp" });
  });
});

describe("byte-valid truncation (task 5b.2)", () => {
  // Multi-byte cells: 2-, 3- and 4-byte UTF-8 sequences, so a byte cut would split one.
  const wide = Array.from({ length: 1_000 }, (_, index) => [`${index}:${"ї€😀".repeat(20)}`]);

  it("JSON drops whole rows, stays parseable and within the cap", () => {
    const serialized = serializeResult(table(wide));
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(bytes(serialized.text)).toBeLessThanOrEqual(OUTPUT_MAX_BYTES);
    expect(() => strictUtf8.decode(Buffer.from(serialized.text, "utf8"))).not.toThrow();
    const parsed = JSON.parse(serialized.text) as TableResult;
    expect(serialized.truncated).toBe(true);
    expect(parsed.truncated).toBe(true);
    expect(parsed.truncation).toMatchObject({ reason: "byte-limit", maxBytes: OUTPUT_MAX_BYTES });
    expect(parsed.truncation!.returnedRows).toBe(parsed.rows.length);
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(parsed.rows).toEqual(wide.slice(0, parsed.rows.length));
    // Maximal: one more row would not fit.
    const oneMore = JSON.stringify({ ...parsed, rows: wide.slice(0, parsed.rows.length + 1) });
    expect(bytes(`${oneMore}\n`)).toBeGreaterThan(OUTPUT_MAX_BYTES);
  });

  it("Tab keeps whole rows and marks the header", () => {
    const serialized = serializeResult(table(wide), "tab");
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(bytes(serialized.text)).toBeLessThanOrEqual(OUTPUT_MAX_BYTES);
    expect(() => strictUtf8.decode(Buffer.from(serialized.text, "utf8"))).not.toThrow();
    const lines = serialized.text.trimEnd().split("\n");
    const header = lines[1]!;
    const rows = lines.slice(3);
    expect(header).toContain("truncated=true reason=byte-limit");
    expect(header).toContain(`rows=${rows.length}`);
    expect(rows).toEqual(wide.slice(0, rows.length).map((row) => row[0]));
  });

  it("an oversized value becomes a typed marker, not a cut string", () => {
    const serialized = serializeResult({
      kind: "value",
      provenance: "computed-local",
      value: "😀".repeat(20_000),
      truncated: false
    });
    expect(serialized.ok && bytes(serialized.text)).toBeLessThanOrEqual(OUTPUT_MAX_BYTES);
    expect(serialized.ok && JSON.parse(serialized.text)).toMatchObject({
      truncated: true,
      value: { $truncated: { bytes: 80_002 } }
    });
  });

  it("projection JSON drops whole items under a small cap", () => {
    const { v2 } = projections();
    const doc = (v2 as Extract<ProjectionResult, { version: 2 }>).document;
    const many: ProjectionResult = {
      kind: "projection",
      version: 2,
      document: { ...doc, items: Array.from({ length: 200 }, () => doc.items[0]!) }
    };
    const serialized = serializeResult(many, "json", { maxBytes: 4_096 });
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(bytes(serialized.text)).toBeLessThanOrEqual(4_096);
    const parsed = JSON.parse(serialized.text) as { items: unknown[]; truncated: boolean };
    expect(parsed.truncated).toBe(true);
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(parsed.items.length).toBeLessThan(200);
    const lisp = serializeResult(many, "lisp", { maxBytes: 4_096 });
    expect(lisp.ok && bytes(lisp.text)).toBeLessThanOrEqual(4_096);
    expect(lisp.ok && lisp.truncated).toBe(true);
  });

  it("escapes control characters so no output drives the terminal", () => {
    const hostile = "a\u001b[31mred\u009b2J\ttab\nline\\\u2028";
    const json = serializeResult(table([[hostile]]));
    expect(json.ok && json.text).not.toMatch(/[\u001b\u009b\u2028]/);
    expect(json.ok && (JSON.parse(json.text) as TableResult).rows).toEqual([[hostile]]);
    expect(tabCell(hostile)).toBe("a\\x1b[31mred\\x9b2J\\ttab\\nline\\\\\\u{2028}");
    expect(tabCell(null)).toBe("\\N");
    expect(tabCell("\\N")).toBe("\\\\N");
    expect(tabCell({ $int: "9007199254740993" })).toBe('{"$int":"9007199254740993"}');
    expect(tabCell(1.5)).toBe("1.5");
  });
});

describe("byte-cut coverage and cursors stay honest (review M4/M5/L3)", () => {
  const wide = Array.from({ length: 1_000 }, (_, index) => [`${index}:${"ї€😀".repeat(20)}`]);
  const paged = (): TableResult => ({
    ...table(wide),
    coverage: { scope: "complete", loaded: 1_000, total: 1_000, cursor: "cursor-after-1000" }
  });

  it("a byte-cut table reports the kept rows as loaded and resumes at the first dropped row", () => {
    const serialized = serializeResult(paged(), "json", { resumeCursor: (kept) => `cursor-after-${kept}` });
    if (!serialized.ok) throw new Error(serialized.message);
    const parsed = JSON.parse(serialized.text) as TableResult & { coverage: Record<string, unknown> };
    const kept = parsed.rows.length;
    expect(kept).toBeLessThan(1_000);
    expect(serialized.keptItems).toBe(kept);
    expect(parsed.coverage).toMatchObject({
      scope: "partial",
      loaded: kept,
      total: 1_000,
      cursor: `cursor-after-${kept}`,
      truncatedBy: "output-byte-cap"
    });
    // Without a way to re-derive it, the cursor is dropped rather than skipping rows.
    const plain = serializeResult(paged());
    expect(plain.ok && (JSON.parse(plain.text) as { coverage: unknown }).coverage).toMatchObject({
      loaded: kept,
      cursor: null
    });
    const tab = serializeResult(paged(), "tab");
    expect(tab.ok && tab.keptItems).toBe(tab.ok ? tab.text.trimEnd().split("\n").length - 3 : -1);
  });

  it("a byte-cut projection is coverage truncated with the output-byte-cap gap and no stale cursor", () => {
    const { v2 } = projections();
    const doc = (v2 as Extract<ProjectionResult, { version: 2 }>).document;
    const many: ProjectionResult = {
      kind: "projection",
      version: 2,
      document: { ...doc, cursor: "page-2", items: Array.from({ length: 200 }, () => doc.items[0]!) }
    };
    const json = serializeResult(many, "json", { maxBytes: 4_096 });
    if (!json.ok) throw new Error(json.message);
    const parsed = JSON.parse(json.text) as { coverage: { state: string; gaps: string[] }; cursor: unknown };
    expect(parsed.coverage.state).toBe("truncated");
    expect(parsed.coverage.gaps).toContain("output-byte-cap");
    expect(parsed.cursor).toBeNull();
    const lisp = serializeResult(many, "lisp", { maxBytes: 4_096 });
    if (!lisp.ok) throw new Error(lisp.message);
    const back = parseTraceTextV2(lisp.text, { dialect: "lisp" });
    expect(back.ok && back.data.cursor).toBeNull();
    expect(back.ok && back.data.coverage.state).toBe("truncated");
    // Untruncated output keeps its cursor.
    const whole = serializeResult(
      { ...many, document: { ...many.document, items: [doc.items[0]!] } } as ProjectionResult,
      "json"
    );
    expect(whole.ok && (JSON.parse(whole.text) as { cursor: unknown }).cursor).toBe("page-2");
  });

  it("an envelope that cannot fit even empty is a typed error, never an over-cap output", () => {
    for (const outcome of [
      serializeResult(paged(), "json", { maxBytes: 40 }),
      serializeResult(paged(), "tab", { maxBytes: 40 }),
      serializeResult(
        { kind: "value", provenance: "computed-local", value: "x".repeat(500), truncated: false },
        "json",
        {
          maxBytes: 40
        }
      ),
      serializeResult(projections().v2, "json", { maxBytes: 40 })
    ]) {
      expect(outcome).toMatchObject({ ok: false, code: "output-too-large" });
    }
  });
});
