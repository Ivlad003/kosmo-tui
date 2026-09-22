/**
 * Row builders for the ported viewer tests. Every row carries a full identity; the
 * defaults stand for "one local dataset, one project, one session", which is what the
 * kosmo-callflow tests implicitly assumed with bare ids.
 */
import type { TraceEventView } from "../src/detail.js";
import type { Delta, SpanRef, SpanRow, TraceRow } from "../src/view-state.js";

export const SCOPE = { datasetId: "local", projectId: "p" } as const;
export const SESSION = "s-1";

export function ref(traceId: string, spanId: string, sessionId: string = SESSION): SpanRef {
  return { ...SCOPE, sessionId, traceId, spanId };
}

export function trace(
  traceId: string,
  startedAt: number,
  status: TraceRow["status"] = "complete",
  sessionId: string = SESSION
): TraceRow {
  return { ...SCOPE, sessionId, traceId, status, startedAt, spanCount: 1 };
}

export function span(traceId: string, spanId: string, overrides: Partial<SpanRow> = {}): SpanRow {
  return {
    ...SCOPE,
    sessionId: SESSION,
    traceId,
    spanId,
    parentSpanId: null,
    nodeId: `src/${spanId}.ts#run`,
    depth: 0,
    errored: false,
    ...overrides
  };
}

export function connected(): Delta {
  return { kind: "connection", connection: { kind: "connected", sdk: "present", events: "flowing" } };
}

export function event(
  overrides: Partial<TraceEventView> & Pick<TraceEventView, "seq" | "spanId" | "type">
): TraceEventView {
  return {
    sessionId: SESSION,
    traceId: "t-1",
    parentSpanId: null,
    nodeId: "src/a.ts#run",
    ts: overrides.seq,
    payload: {},
    ...overrides
  };
}
