/**
 * Trace-level derivations shared by every reader (spec 4.4, 6.2).
 *
 * This file must never import `validate.ts`: the validator imports these two functions for its trace
 * summaries. Task 5 replaces this file with the full `TraceModel` and keeps both functions unchanged.
 */
import { compareBytes } from "./bytes.js";
import type { RequestSummary, SpanRow, TraceStatus } from "./types.js";

/** Spec 4.4: `errored` if any span is errored; `incomplete` if any is running/unknown; otherwise `complete`. */
export function traceStatusOf(spans: readonly SpanRow[]): TraceStatus {
  let incomplete = false;
  for (const span of spans) {
    if (span.status === "errored") return "errored";
    if (span.status === "running" || span.status === "unknown") incomplete = true;
  }
  return incomplete ? "incomplete" : "complete";
}

/** (session byte-wise, order): the one ordering of spans inside a trace (spec 4.3). */
function compareSessionOrder(a: SpanRow, b: SpanRow): number {
  return compareBytes(a.ref.session, b.ref.session) || a.order - b.order;
}

/**
 * Spec 6.2: `http.server` spans of a trace. `count` counts all of them; `first` reads the attrs of the one
 * with the smallest (session, order). A non-string method/route and a boolean status read as null;
 * `first` is null when that span has none of the three attributes. No `http.server` span → null.
 */
export function requestSummaryOf(spans: readonly SpanRow[]): RequestSummary | null {
  let first: SpanRow | undefined;
  let count = 0;
  for (const span of spans) {
    if (span.kind !== "http.server") continue;
    count += 1;
    if (first === undefined || compareSessionOrder(span, first) < 0) first = span;
  }
  if (first === undefined) return null;
  const attrs = first.attrs ?? {};
  const method = attrs["http.request.method"];
  const route = attrs["http.route"];
  const status = attrs["http.response.status_code"];
  const summary = {
    method: typeof method === "string" ? method : null,
    route: typeof route === "string" ? route : null,
    status: typeof status === "number" || typeof status === "string" ? status : null
  };
  const empty = summary.method === null && summary.route === null && summary.status === null;
  return { first: empty ? null : summary, count };
}
