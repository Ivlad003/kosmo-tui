/**
 * Task 5b.1 (shared selectors): for offline sources (sqlite, export) the `:` commands ask
 * the shared selectors of `@kosmo-callflow/query/graph` over the source's pinned snapshot.
 * The shared parent resolution reaches a unique cross-session parent that the local
 * same-session walk cannot, cycles and depth caps stop every walk, `depth-cap` reads as
 * `depth-limit`, and a span the snapshot lacks is `unknown-path(not-loaded)`, never
 * `no-path`.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ancestors as sharedAncestors } from "@kosmo-callflow/query/graph";
import type { TraceDatasetSnapshot } from "@kosmo-callflow/query/snapshot";
import type { Capabilities } from "../src/capabilities.js";
import { localGraphSelectors, runCommandLine, type CommandDeps, type CommandResult } from "../src/commands.js";
import { createExportSource } from "../src/source-export.js";
import { createSqliteSource } from "../src/source-sqlite.js";
import { commandDepsForSource, snapshotGraphSelectors } from "../src/snapshot-selectors.js";
import { applyDelta, initialViewState, type SpanRow, type ViewState } from "../src/view-state.js";
import { portableExport } from "./source-fixtures.js";
import { cleanupDirs, copyStore, tempDir } from "./sqlite-fixtures.js";

afterEach(cleanupDirs);

const caps: Capabilities = {
  projectionVersions: [1, 2],
  projection: { available: true },
  follow: { available: false, reason: "static-snapshot" },
  replay: { available: true },
  values: { available: true, level: "full" },
  probes: { available: false, reason: "no-probe-records" },
  staticGraph: { available: false, reason: "no-static-graph-reader" },
  sql: { available: true },
  review: { available: true },
  localEval: { available: true },
  interactive: { available: true }
};

/** View rows as a viewer holds them: one per span of the snapshot's index. */
function rowsOf(dataset: TraceDatasetSnapshot): SpanRow[] {
  return dataset.spanIndex.spans.map((span) => ({
    datasetId: dataset.identity.datasetId,
    projectId: dataset.identity.projectId,
    sessionId: span.sessionId,
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    nodeId: span.nodeId,
    depth: 0,
    errored: span.hasError
  }));
}

function stateOf(dataset: TraceDatasetSnapshot): ViewState {
  let state = initialViewState({ caps });
  state = applyDelta(state, { kind: "spans", rows: rowsOf(dataset) });
  return state;
}

async function run(state: ViewState, line: string, deps: CommandDeps): Promise<CommandResult> {
  const outcome = await runCommandLine(state, line, deps);
  if (outcome === null) throw new Error("blank");
  return outcome.result;
}

function spanIds(result: CommandResult): string[] {
  if (result.kind === "projection" || (result.kind === "path" && result.status === "found")) {
    return result.spans.map((row) => `${row.sessionId}/${row.spanId}`);
  }
  throw new Error(`no spans in ${result.kind}`);
}

async function sqliteFixture() {
  const source = createSqliteSource({ path: copyStore() });
  await source.open(new AbortController().signal);
  const dataset = source.datasetSnapshot();
  return { source, dataset, state: stateOf(dataset), deps: commandDepsForSource(source) };
}

describe("commands over the shared graph selectors (task 5b.1)", () => {
  it("ancestors follow the shared resolution across sessions, unlike the local walk", async () => {
    const { source, state, deps } = await sqliteFixture();
    const shared = await run(state, ":ancestors s-api:t-checkout:query", deps);
    expect(spanIds(shared)).toEqual(["s-api/query", "s-api/handle", "s-web/req"]);
    expect(shared).toMatchObject({ kind: "projection", meta: { coverage: "complete" } });

    // The same line through the local same-session walk stops at the cross-session parent.
    const local = await run(state, ":ancestors s-api:t-checkout:query", { selectors: localGraphSelectors });
    expect(spanIds(local)).toEqual(["s-api/query", "s-api/handle"]);
    expect(local).toMatchObject({ meta: { coverage: "partial" } });
    await source.close();
  });

  it("returns exactly the shared selector's chain for every span of the snapshot", async () => {
    const { source, dataset, state } = await sqliteFixture();
    const selectors = snapshotGraphSelectors(() => dataset);
    for (const row of state.spans) {
      const chain = selectors.ancestors(state.spans, row, {}, row)!;
      const expected = sharedAncestors(dataset, { ...row });
      expect(chain.frames.slice(1).map((frame) => frame.spanId)).toEqual(expected.refs.map((ref) => ref.spanId));
      expect(chain.coverage).toBe(expected.status === "complete" ? "complete" : "partial");
    }
    await source.close();
  });

  it("stops on a recorded cycle and maps depth-cap to depth-limit", async () => {
    const { source, state, deps } = await sqliteFixture();
    const cycle = await run(state, ":ancestors s-api:t-cycle:a", deps);
    expect(spanIds(cycle)).toEqual(["s-api/a", "s-api/b"]);
    expect(cycle.kind === "projection" && cycle.note).toMatch(/cycle/);

    const capped = await run(state, ":ancestors s-api:t-checkout:query", { ...deps, maxDepth: 2 });
    expect(spanIds(capped)).toEqual(["s-api/query", "s-api/handle"]);
    expect(capped).toMatchObject({ meta: { truncated: true } });
    const cappedPath = await run(state, ":path s-web:t-checkout:req s-api:t-checkout:query", { ...deps, maxDepth: 1 });
    expect(cappedPath).toMatchObject({ kind: "path", status: "unknown-path", reason: "depth-limit" });
    await source.close();
  });

  it("path: found across sessions, no-path for a complete chain, unknown-path(not-loaded) for a missing span", async () => {
    const { source, dataset, state, deps } = await sqliteFixture();
    const found = await run(state, ":path s-web:t-checkout:req s-api:t-checkout:query", deps);
    expect(spanIds(found)).toEqual(["s-web/req", "s-api/handle", "s-api/query"]);
    const none = await run(state, ":path s-web:t-checkout:validate s-api:t-checkout:query", deps);
    expect(none).toMatchObject({ kind: "path", status: "no-path", reason: "not-an-ancestor" });
    const crossTrace = await run(state, ":path s-web:t-login:login s-api:t-checkout:query", deps);
    expect(crossTrace).toMatchObject({ kind: "path", status: "no-path", reason: "different-trace" });

    // A span the view shows but the pinned snapshot does not hold: not-loaded, never no-path.
    const ghost: SpanRow = { ...state.spans[0]!, sessionId: "s-gone", spanId: "ghost", parentSpanId: null };
    const selectors = snapshotGraphSelectors(() => dataset);
    expect(selectors.path(state.spans, ghost, state.spans[0]!, {})).toMatchObject({
      status: "unknown-path",
      reason: "not-loaded"
    });
    expect(selectors.ancestors(state.spans, ghost, {}, null)).toBeNull();
    await source.close();
  });

  it("callers count recorded edges through the shared selector", async () => {
    const { source, state, deps } = await sqliteFixture();
    const handle = await run(state, ":callers src/api/orders.ts#handle", deps);
    expect(handle).toMatchObject({
      kind: "table",
      recorded: [{ nodeId: "src/web/checkout.ts#submit", calls: 1 }],
      meta: { coverage: "complete" }
    });
    await source.close();
  });

  it("export sources get the same shared selectors, and no :sql", async () => {
    const file = path.join(tempDir(), "export.json");
    await writeFile(file, JSON.stringify(portableExport()));
    const source = createExportSource({ path: file });
    await source.open(new AbortController().signal);
    const dataset = source.datasetSnapshot();
    const deps = commandDepsForSource(source);
    expect(deps.sql).toBeUndefined();
    const state = stateOf(dataset);
    const leaf = state.spans.find((row) => row.spanId === "sp-2")!;
    const chain = await run(state, `:ancestors ${leaf.sessionId}:${leaf.traceId}:sp-2`, deps);
    expect(spanIds(chain)).toEqual(
      sharedAncestors(dataset, { ...leaf }).refs.reduce(
        (ids, ref) => [...ids, `${ref.sessionId}/${ref.spanId}`],
        [`${leaf.sessionId}/sp-2`]
      )
    );
    expect(chain).toMatchObject({ meta: { coverage: "complete" } });
    await source.close();
  });
});
