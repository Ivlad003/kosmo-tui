/**
 * Spec 13.1: "Тест рівності читачів замінює cross-source-parity.test.ts". The same
 * dataset written as JSON, NDJSON (document order, reversed order, BOM + CRLF) and SQLite
 * must read back identically: dataset info, trace summaries (4.3: ordered by id in all
 * readers), DFS order, parents, depths, children, roots, areas, links, rows and values.
 * For SQLite the values come from the lazy loadValues, for the others from get(ref).
 */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TraceModel } from "../../src/format/model.js";
import type { SpanValues } from "../../src/format/types.js";
import { nodeReaderFs } from "../../src/readers/node-fs.js";
import { openTarget } from "../../src/readers/open.js";
import { loadSqliteModule } from "../../src/readers/sqlite-loader.js";
import type { OpenedDataset, ReaderDeps } from "../../src/readers/types.js";
import { FIXTURE_NAMES, RECIPES } from "../fixture-recipes.js";
import type { RawDocument } from "../trace-builder.js";
import {
  NODE_SQLITE_AVAILABLE,
  cleanupTempDirs,
  tempDir,
  writeJson,
  writeNdjson,
  writeSqlite
} from "../trace-writers.js";
import { signal } from "./reader-fakes.js";

afterEach(cleanupTempDirs);

const deps: ReaderDeps = { fs: nodeReaderFs, loadSqlite: loadSqliteModule };

async function valuesOf(opened: OpenedDataset, model: TraceModel, ref: Parameters<TraceModel["get"]>[0]) {
  const row = model.get(ref);
  if (opened.loadValues !== undefined) return opened.loadValues(ref, signal());
  return row?.values;
}

async function snapshot(opened: OpenedDataset) {
  const traces = [];
  for (const summary of opened.traces.items) {
    const loaded = await opened.loadTrace(summary.id, signal());
    if (!loaded.ok) throw new Error(`${opened.kind} ${summary.id}: ${loaded.error.message}`);
    const model = loaded.model;
    const spans: Array<{
      row: unknown;
      parent: unknown;
      depth: number;
      children: unknown;
      links: unknown;
      values: SpanValues | undefined;
    }> = [];
    for (const ref of model.dfs()) {
      const row = model.get(ref);
      if (row === undefined) throw new Error("dfs returned an unknown ref");
      const { values: _values, ...rest } = row;
      spans.push({
        row: rest,
        parent: model.parentOf(ref),
        depth: model.depthOf(ref),
        children: model.children(ref),
        links: model.links(ref),
        values: await valuesOf(opened, model, ref)
      });
    }
    traces.push({ summary, trace: model.trace, size: model.size, roots: model.roots(), areas: model.areas(), spans });
  }
  return { info: opened.info, hasMore: opened.traces.hasMore, notices: opened.notices, traces };
}

async function readAll(doc: RawDocument) {
  const dir = tempDir();
  const files = {
    json: path.join(dir, "d.kosmo-trace.json"),
    ndjson: path.join(dir, "d.kosmo-trace.ndjson"),
    reversed: path.join(dir, "reversed.kosmo-trace.ndjson"),
    crlf: path.join(dir, "crlf.kosmo-trace.ndjson"),
    sqlite: path.join(dir, "d.kosmo-trace.sqlite")
  };
  writeJson(files.json, doc);
  writeNdjson(files.ndjson, doc);
  writeNdjson(files.reversed, doc, { order: "reverse", trailingNewline: false });
  writeNdjson(files.crlf, doc, { bom: true, crlf: true });
  writeSqlite(files.sqlite, doc);
  const out: Record<string, Awaited<ReturnType<typeof snapshot>>> = {};
  for (const [name, file] of Object.entries(files)) {
    const result = await openTarget({ path: file }, deps, signal());
    if (!result.ok) throw new Error(`${name}: ${result.error.message}`);
    expect(result.dataset.kind).toBe(name === "json" ? "json" : name === "sqlite" ? "sqlite" : "ndjson");
    out[name] = await snapshot(result.dataset);
    await result.dataset.close();
  }
  return out;
}

describe.skipIf(!NODE_SQLITE_AVAILABLE)("cross-reader equality (spec 13.1)", () => {
  it.each(FIXTURE_NAMES)("%s reads the same through json, ndjson and sqlite", async (name) => {
    const doc = RECIPES[name]!();
    const all = await readAll(doc);
    const reference = all.json!;
    expect(reference.traces.length).toBeGreaterThan(0);
    for (const [reader, view] of Object.entries(all)) expect(view, reader).toEqual(reference);
  });

  it("a trace list of 250 traces agrees across readers once sqlite pages are loaded", async () => {
    const doc = RECIPES["kosmo-trace/basic"]!();
    const traces = Array.from({ length: 250 }, (_, i) => ({ id: `t_${String(i).padStart(3, "0")}`, name: `n${i}` }));
    const big: RawDocument = { ...doc, traces, spans: doc.spans.map((span) => ({ ...span, trace: "t_000" })) };
    const dir = tempDir();
    writeJson(path.join(dir, "a.kosmo-trace.json"), big);
    writeSqlite(path.join(dir, "a.kosmo-trace.sqlite"), big);
    const json = await openTarget({ path: path.join(dir, "a.kosmo-trace.json") }, deps, signal());
    const sqlite = await openTarget({ path: path.join(dir, "a.kosmo-trace.sqlite") }, deps, signal());
    if (!json.ok || !sqlite.ok) throw new Error("open failed");
    const pages = [...sqlite.dataset.traces.items];
    let more = sqlite.dataset.traces.hasMore;
    while (more) {
      const page = await sqlite.dataset.loadMoreTraces!(signal());
      pages.push(...page.items);
      more = page.hasMore;
    }
    expect(pages).toEqual(json.dataset.traces.items);
    await sqlite.dataset.close();
  });
});
