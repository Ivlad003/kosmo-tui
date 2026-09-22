/**
 * `GraphSelectors` over the shared selectors of `@kosmo-callflow/query/graph` (task 5b.1,
 * design D12 "Commands викликають shared selectors над pinned snapshot").
 *
 * Offline sources (sqlite, export) hold a pinned `TraceDatasetSnapshot`; for them the
 * `:ancestors`/`:path`/`:callers` commands ask the SAME selectors kosmo-callflow's MCP and
 * CLI use, so parent resolution (same session first, else a unique cross-session match in
 * the trace, else ambiguous), cycle guards and depth caps are identical on every surface.
 * The loaded view rows are only used to present a ref the user already sees.
 *
 * Vocabulary mapping: the shared `depth-cap` is the command's `depth-limit`; a span the
 * snapshot does not hold (`span-not-found`) is `unknown-path(not-loaded)` — or no chain —
 * never `no-path`.
 */

import {
  ancestors as sharedAncestors,
  callers as sharedCallers,
  GraphSelectorError,
  path as sharedPath,
  type GraphSpanRef
} from "@kosmo-callflow/query/graph";
import type { TraceDatasetSnapshot, TraceSnapshotSpan } from "@kosmo-callflow/query/snapshot";
import type { CommandDeps, GraphSelectors } from "./commands.js";
import type { SqliteSource } from "./source-sqlite.js";
import { sqlPortForSource } from "./sql.js";
import { DEFAULT_STACK_DEPTH, type StackStop } from "./stack.js";
import { spanKey, type SpanRef, type SpanRow } from "./view-state.js";

type SnapshotGetter = () => TraceDatasetSnapshot;

function localKey(span: { sessionId: string; traceId: string; spanId: string }): string {
  return JSON.stringify([span.sessionId, span.traceId, span.spanId]);
}

/** Selectors bound to whatever snapshot the source has pinned at call time. */
export function snapshotGraphSelectors(snapshot: SnapshotGetter): GraphSelectors {
  function inDataset(dataset: TraceDatasetSnapshot, ref: SpanRef): boolean {
    return ref.datasetId === dataset.identity.datasetId && ref.projectId === dataset.identity.projectId;
  }

  function indexOf(dataset: TraceDatasetSnapshot): Map<string, TraceSnapshotSpan> {
    return new Map(dataset.spanIndex.spans.map((span) => [localKey(span), span]));
  }

  /** The loaded view row for a ref, else one built from the snapshot's span index. */
  function rowOf(
    ref: GraphSpanRef,
    loaded: readonly SpanRow[],
    index: Map<string, TraceSnapshotSpan>,
    depth: number
  ): SpanRow {
    const key = spanKey(ref);
    const row = loaded.find((candidate) => spanKey(candidate) === key);
    if (row) return row;
    const entry = index.get(localKey(ref));
    return {
      datasetId: ref.datasetId,
      projectId: ref.projectId,
      sessionId: ref.sessionId,
      traceId: ref.traceId,
      spanId: ref.spanId,
      parentSpanId: entry?.parentSpanId ?? null,
      nodeId: entry?.nodeId ?? ref.spanId,
      depth,
      errored: entry?.hasError ?? false
    };
  }

  function parentRef(frame: SpanRow, index: Map<string, TraceSnapshotSpan>): SpanRef | null {
    const parentSpanId = index.get(localKey(frame))?.parentSpanId ?? frame.parentSpanId;
    return parentSpanId === null ? null : { ...frame, spanId: parentSpanId };
  }

  return {
    ancestors(spans, target, options, targetRow) {
      const dataset = snapshot();
      if (!inDataset(dataset, target)) return null;
      const maxDepth = Math.max(1, options.maxDepth ?? DEFAULT_STACK_DEPTH);
      let result;
      try {
        // The chain includes the target, so the shared walk may take maxDepth - 1 hops.
        result = sharedAncestors(dataset, { ...target }, { maxDepth: maxDepth - 1 });
      } catch (error) {
        if (error instanceof GraphSelectorError && error.code === "span-not-found") return null;
        throw error;
      }
      const index = indexOf(dataset);
      const first = targetRow ?? rowOf({ ...target }, spans, index, 0);
      const frames = [first, ...result.refs.map((ref, position) => rowOf(ref, spans, index, position + 1))];
      const last = frames[frames.length - 1]!;
      const parent = parentRef(last, index);
      let stop: StackStop;
      if (result.status === "complete" || parent === null) {
        stop = { kind: "root" };
      } else {
        switch (result.reason) {
          case "cycle":
            stop = { kind: "cycle", at: parent };
            break;
          case "depth-cap":
            stop = { kind: "depth-limit", limit: maxDepth };
            break;
          case "ambiguous":
            stop = {
              kind: "ambiguous",
              parent,
              candidates: dataset.spanIndex.spans.filter(
                (span) => span.traceId === parent.traceId && span.spanId === parent.spanId
              ).length
            };
            break;
          default:
            stop = {
              kind: "unknown",
              parent,
              reason: result.reason === "retention" || options.retentionGap ? "retention" : "not-loaded"
            };
        }
      }
      return { target, frames, stop, coverage: stop.kind === "root" ? "complete" : "partial" };
    },

    path(spans, from, to, options) {
      const dataset = snapshot();
      if (from.traceId !== to.traceId || from.projectId !== to.projectId || from.datasetId !== to.datasetId) {
        return { status: "no-path", reason: "different-trace" };
      }
      if (!inDataset(dataset, from)) return { status: "unknown-path", reason: "not-loaded", at: null };
      const maxDepth = Math.max(1, options.maxDepth ?? DEFAULT_STACK_DEPTH);
      let result;
      try {
        result = sharedPath(dataset, { ...from }, { ...to }, { maxDepth });
      } catch (error) {
        if (error instanceof GraphSelectorError && error.code === "span-not-found") {
          const index = indexOf(dataset);
          const missing = index.has(localKey(from)) ? to : from;
          return {
            status: "unknown-path",
            reason: "not-loaded",
            at: { ...missing, datasetId: dataset.identity.datasetId }
          };
        }
        throw error;
      }
      switch (result.status) {
        case "found": {
          const index = indexOf(dataset);
          return { status: "found", spans: result.refs.map((ref, position) => rowOf(ref, spans, index, position)) };
        }
        case "no-path":
          return { status: "no-path", reason: "not-an-ancestor" };
        case "unknown-path":
          return {
            status: "unknown-path",
            reason: result.reason === "depth-cap" ? "depth-limit" : result.reason,
            at: null
          };
      }
    },

    recordedCallers(_spans, nodeId) {
      const dataset = snapshot();
      const result = sharedCallers(dataset, nodeId);
      const withParent = dataset.spanIndex.spans.filter(
        (span) => span.nodeId === nodeId && span.parentSpanId !== null
      ).length;
      const resolved = result.recorded.reduce((sum, row) => sum + row.runtimeCount, 0);
      return {
        callers: result.recorded.map((row) => ({ nodeId: row.nodeId, calls: row.runtimeCount })),
        // One parent per span: every span of the node with a parent id that the shared
        // resolution could not place is unknown, and counted nowhere else.
        unknownParents: withParent - resolved
      };
    },

    staticCallers(nodeId) {
      const dataset = snapshot();
      if (dataset.graph.staticEdges.length === 0) return { available: false, reason: "no-static-graph-in-snapshot" };
      const rows = sharedCallers(dataset, nodeId, { static: true }).static ?? [];
      return { available: true, callers: rows.map((row) => ({ nodeId: row.nodeId, provenance: row.provenance })) };
    }
  };
}

/** A source that holds a pinned dataset snapshot (sqlite, export). */
export type SnapshotSource = { datasetSnapshot(): TraceDatasetSnapshot };

/**
 * Command deps for an offline source: shared graph selectors over its pinned snapshot,
 * and `:sql` only when it is a sqlite source.
 */
export function commandDepsForSource(source: SnapshotSource & { kind: string }, base: CommandDeps = {}): CommandDeps {
  return {
    ...base,
    selectors: snapshotGraphSelectors(() => source.datasetSnapshot()),
    ...(source.kind === "sqlite" ? { sql: sqlPortForSource(source as SqliteSource) } : {})
  };
}
