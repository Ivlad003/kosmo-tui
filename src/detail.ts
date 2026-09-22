/**
 * Span details for the viewer, ported from kosmo-callflow
 * `packages/cli/src/connect/detail.ts`.
 *
 * Turns the trace's recorded events and its canonical projection into the small,
 * explicit shapes the details pane renders. The one rule this module enforces: a value
 * that was not recorded, was masked before it left the process, or has no evidence
 * behind it is reported as such. Nothing here substitutes a default or derives a number
 * it was not given.
 *
 * Every recorded string that reaches the pane goes through the shared
 * `sanitizeEvidenceText` from `@kosmo-callflow/trace-artifacts`: secrets masked,
 * absolute host paths relativised, terminal controls escaped — the same pass every
 * kosmo-callflow surface uses.
 */

import {
  projectTraceTextDocument,
  type CanonicalPageEnvelope,
  type TraceEventView,
  type TraceTextDocumentV1
} from "@kosmo-callflow/protocol";
import { sanitizeEvidenceText } from "@kosmo-callflow/trace-artifacts";
import type {
  DetailAnchor,
  DetailDuration,
  DetailValue,
  SpanDetail,
  SpanRef,
  SpanRow,
  TraceRow
} from "./view-state.js";

/** One row of `GET /api/v1/traces/{traceId}`; the wire type is owned by the protocol. */
export type { TraceEventView };

/**
 * The dataset the events were read from. An event row names its session but not its
 * dataset or project; those come from the source that produced the rows and complete
 * the full span identity.
 */
export type DatasetScope = { datasetId: string; projectId: string };

const maskedMarker = "[masked]";

function localKey(sessionId: string, traceId: string, spanId: string): string {
  return JSON.stringify([sessionId, traceId, spanId]);
}

/**
 * Build the span tree from recorded events.
 *
 * Depth is derived from the recorded parent chain rather than from arrival order; a
 * parent is looked up inside the same session and trace only, so two sessions that
 * reuse ids never adopt each other's children. A span whose parent is missing
 * (retention, loss) is re-rooted instead of hidden under a parent that is not there.
 */
export function spanRowsFromEvents(events: TraceEventView[], scope: DatasetScope): SpanRow[] {
  const byKey = new Map<string, SpanRow>();
  const parents = new Map<string, string | null>();
  for (const event of events) {
    const key = localKey(event.sessionId, event.traceId, event.spanId);
    parents.set(key, event.parentSpanId === null ? null : localKey(event.sessionId, event.traceId, event.parentSpanId));
  }
  for (const event of events) {
    const key = localKey(event.sessionId, event.traceId, event.spanId);
    const existing = byKey.get(key);
    const errored = existing?.errored === true || event.type === "error";
    const parent = parents.get(key) ?? null;
    byKey.set(key, {
      datasetId: scope.datasetId,
      projectId: scope.projectId,
      sessionId: event.sessionId,
      traceId: event.traceId,
      spanId: event.spanId,
      parentSpanId: parent !== null && parents.has(parent) ? event.parentSpanId : null,
      nodeId: existing?.nodeId ?? event.nodeId,
      depth: 0,
      errored
    });
  }
  for (const [key, row] of byKey) {
    row.depth = depthOf(key, parents);
  }
  return [...byKey.values()];
}

function depthOf(key: string, parents: Map<string, string | null>): number {
  let depth = 0;
  let current = parents.get(key) ?? null;
  const seen = new Set<string>([key]);
  while (current !== null && parents.has(current) && !seen.has(current)) {
    seen.add(current);
    depth += 1;
    current = parents.get(current) ?? null;
  }
  return depth;
}

/** Lifecycle of one span, in the projection's own vocabulary. */
function statusOf(events: TraceEventView[]): TraceRow["status"] {
  if (events.some((event) => event.type === "error")) return "errored";
  if (events.some((event) => event.type === "exit")) return "complete";
  return "running";
}

/**
 * Detail for one span, selected by full ref. Events from another session that reuse the
 * same traceId/spanId are not this span and are ignored.
 */
export function spanDetailFromEvents(
  events: TraceEventView[],
  selection: SpanRef,
  document: TraceTextDocumentV1 | null
): SpanDetail | null {
  const spanEvents = events
    .filter(
      (event) =>
        event.sessionId === selection.sessionId &&
        event.traceId === selection.traceId &&
        event.spanId === selection.spanId
    )
    .sort((left, right) => left.seq - right.seq);
  if (spanEvents.length === 0) return null;

  const enter = spanEvents.find((event) => event.type === "enter");
  const exit = spanEvents.find((event) => event.type === "exit");
  const error = spanEvents.find((event) => event.type === "error");

  return {
    datasetId: selection.datasetId,
    projectId: selection.projectId,
    sessionId: selection.sessionId,
    traceId: selection.traceId,
    spanId: selection.spanId,
    nodeId: sanitizeEvidenceText(spanEvents[0]!.nodeId).value,
    status: statusOf(spanEvents),
    args: enter === undefined ? { state: "unavailable", reason: "no enter record" } : valueOf(enter.payload?.args),
    ret: exit === undefined ? { state: "unavailable", reason: "no exit record" } : valueOf(exit.payload?.ret),
    error: error === undefined ? { state: "not-recorded" } : valueOf(error.payload?.message ?? error.payload),
    duration: durationOf(enter, exit),
    anchor: anchorOf(spanEvents),
    document
  };
}

/**
 * A duration is reported only when both ends were recorded on the same span. Anything
 * else is `unavailable` with the reason; estimating would produce a number that looks
 * measured and is not.
 */
function durationOf(enter: TraceEventView | undefined, exit: TraceEventView | undefined): DetailDuration {
  if (enter === undefined) return { state: "unavailable", reason: "no enter record" };
  if (exit === undefined) return { state: "unavailable", reason: "no exit recorded yet" };
  const ms = exit.ts - enter.ts;
  if (!Number.isFinite(ms) || ms < 0) return { state: "unavailable", reason: "clock readings not comparable" };
  return { state: "recorded", ms };
}

export function valueOf(value: unknown): DetailValue {
  if (value === undefined) return { state: "not-recorded" };
  if (containsMask(value)) return { state: "masked" };
  const text = stringify(value);
  return text === undefined
    ? { state: "unavailable", reason: "value not representable" }
    : { state: "recorded", text: sanitizeEvidenceText(text).value };
}

function containsMask(value: unknown): boolean {
  if (value === maskedMarker) return true;
  if (Array.isArray(value)) return value.some(containsMask);
  if (value !== null && typeof value === "object") return Object.values(value).some(containsMask);
  return false;
}

function stringify(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : json;
  } catch {
    return undefined;
  }
}

/**
 * The code anchor, from recorded evidence only. `payload.filePath`/`payload.location` is
 * the instrumented anchor; the node id is the fallback, and it carries a file and a
 * symbol but no line — then the line is null and the pane says "line unavailable".
 */
function anchorOf(spanEvents: TraceEventView[]): DetailAnchor {
  const nodeId = spanEvents[0]!.nodeId;
  const hash = nodeId.lastIndexOf("#");
  const fallbackFile = hash === -1 ? nodeId : nodeId.slice(0, hash);
  const symbol = hash === -1 ? nodeId : nodeId.slice(hash + 1);
  for (const event of spanEvents) {
    const payload = event.payload as { filePath?: unknown; location?: { line?: unknown } } | undefined;
    if (typeof payload?.filePath === "string" && payload.filePath.length > 0) {
      const line = typeof payload.location?.line === "number" ? payload.location.line : null;
      return { file: sanitizeEvidenceText(payload.filePath).value, symbol: sanitizeEvidenceText(symbol).value, line };
    }
  }
  return { file: sanitizeEvidenceText(fallbackFile).value, symbol: sanitizeEvidenceText(symbol).value, line: null };
}

/**
 * Project the canonical page down to the selected span, as a trace-text document.
 *
 * Trace-text v1 refs carry traceId and spanId only, so the page must be the one read
 * for the selected session; items are matched on both ids. Returns null when the page
 * cannot be projected, so the pane says the projection is unavailable.
 */
export function spanDocumentFor(
  envelope: unknown,
  ref: Pick<SpanRef, "traceId" | "spanId">
): TraceTextDocumentV1 | null {
  try {
    const document = projectTraceTextDocument(envelope as CanonicalPageEnvelope, { detail: 2, values: true });
    const items = document.items.filter(
      (item) => item.kind === "span" && item.ref.traceId === ref.traceId && item.ref.spanId === ref.spanId
    );
    return items.length === 0 ? null : { ...document, items };
  } catch {
    return null;
  }
}
