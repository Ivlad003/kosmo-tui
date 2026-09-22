/**
 * The request selector (task 5.1, spec tui-debugger "Request-centric view без хибних
 * діагнозів", design D13).
 *
 * A request row is an inbound request span, keyed by its FULL canonical span ref, never
 * by traceId: one distributed trace may hold several inbound requests (two fetches from
 * one browser click) and each gets its own row with its own status and duration. The
 * browser (or any other recorded) ancestors of a request are kept as causal context.
 *
 * A trace that carries no request metadata (a v1 source, or a v2 page without an inbound
 * request span) gets a trace-summary row instead: that is not a claim that the trace was
 * one HTTP request.
 *
 * States are the projector's, told apart: `pending` (open enter while recording is
 * active), `unknown(retention|incomplete|loss)` (the record is incomplete), and an
 * observed `aborted` (completion `aborted` or a `response-aborted` lifecycle issue).
 * Diagnostics come only from producer lifecycle issues: a missing filter ancestor is not
 * evidence of `error-unhandled` and an unknown parent is not evidence of
 * `async-context-lost`, so neither is ever inferred here.
 */

import type {
  CanonicalDurationEvidence,
  CanonicalPageEnvelopeV2,
  CanonicalSpanProjectionItemV2,
  LifecycleIssueCode
} from "@kosmo-callflow/protocol";
import { escapeTerminalControls } from "@kosmo-callflow/trace-artifacts";
import { fieldText, frameworkField, spanLabelV2, type FieldText, type SpanLabel } from "./labels.js";
import { spanKey, spanRefOf, traceKey, type SpanRef, type TraceRef, type TraceRow } from "./view-state.js";

export type RequestState =
  | { kind: "pending" }
  | { kind: "suspended" }
  | { kind: "unknown"; reason: "retention" | "incomplete" | "loss" }
  | { kind: "aborted"; evidence: Array<"completion-aborted" | "response-aborted"> }
  | { kind: "errored" }
  | { kind: "complete" };

export type CausalAncestor = { ref: SpanRef; runtime: string | null; label: string; nodeId: string };

export type RequestRow = {
  mode: "request";
  /** `spanKey` of the full request ref: the row identity. */
  key: string;
  ref: SpanRef;
  /** Recorded order of the request's first event; `seq` is order, not wall time. */
  seq: number;
  method: FieldText;
  route: FieldText;
  status: FieldText;
  /** Next `requestType` (action/prefetch/rsc/document); without it an action and a
   *  prefetch of the same route are indistinguishable in the selector. */
  requestType: FieldText;
  duration: CanonicalDurationEvidence;
  runtime: string | null;
  state: RequestState;
  /** Producer lifecycle issues on the request or its recorded descendants, deduplicated. */
  diagnostics: LifecycleIssueCode[];
  /** Recorded ancestors, nearest first (for example the browser span that caused it). */
  causalContext: CausalAncestor[];
  label: SpanLabel;
};

export type TraceSummaryRow = {
  mode: "trace-summary";
  key: string;
  ref: TraceRef;
  status: TraceRow["status"];
  spanCount: number;
  reason: "no-request-metadata" | "no-projection-v2";
};

export type SelectorRow = RequestRow | TraceSummaryRow;

function isSpan(item: CanonicalPageEnvelopeV2["items"][number]): item is CanonicalSpanProjectionItemV2 {
  return item.kind === "span";
}

/**
 * An inbound request span: `framework.role: request`, or a recorded `http` span that is
 * not a framework step and has no same-session parent (an outbound client call inside a
 * server always has one).
 */
export function isInboundRequest(item: CanonicalSpanProjectionItemV2): boolean {
  const framework = item.framework.state === "recorded" ? item.framework.value : null;
  if (framework?.role === "request") return true;
  if (item.spanKind !== "http" || framework?.role === "step") return false;
  return !(item.parent.state === "known" && item.parent.relation === "same-session");
}

function stateOf(item: CanonicalSpanProjectionItemV2): RequestState {
  const framework = item.framework.state === "recorded" ? item.framework.value : null;
  const evidence: Array<"completion-aborted" | "response-aborted"> = [];
  if (framework?.completion === "aborted") evidence.push("completion-aborted");
  if (item.lifecycleIssues.some((issue) => issue.code === "response-aborted")) evidence.push("response-aborted");
  if (evidence.length > 0) return { kind: "aborted", evidence };
  switch (item.lifecycle) {
    case "running":
      return { kind: "pending" };
    case "suspended":
      return { kind: "suspended" };
    case "unknown":
      return { kind: "unknown", reason: item.lifecycleReason ?? "incomplete" };
    case "errored":
      return { kind: "errored" };
    case "complete":
      return { kind: "complete" };
  }
}

export function stateText(state: RequestState): string {
  switch (state.kind) {
    case "unknown":
      return `unknown(${state.reason})`;
    case "aborted":
      return `aborted(${state.evidence.join("+")})`;
    default:
      return state.kind;
  }
}

/** A status that was not recorded says why: pending, retention, or simply not recorded. */
function statusOf(item: CanonicalSpanProjectionItemV2, state: RequestState): FieldText {
  const field = frameworkField(item.framework, "status");
  if (field.state !== "unavailable" || field.reason !== "not-recorded-field") return field;
  if (state.kind === "pending" || state.kind === "suspended") return { state: "unavailable", reason: "pending" };
  if (state.kind === "unknown") return { state: "unavailable", reason: state.reason };
  return field;
}

function routeOf(item: CanonicalSpanProjectionItemV2): FieldText {
  const route = frameworkField(item.framework, "route");
  if (route.state === "unavailable" && route.reason === "not-recorded-field") {
    const path = frameworkField(item.framework, "routePath");
    if (path.state !== "unavailable") return path;
  }
  return route;
}

function subtree(root: CanonicalSpanProjectionItemV2, spans: CanonicalSpanProjectionItemV2[]) {
  const children = new Map<string, CanonicalSpanProjectionItemV2[]>();
  for (const item of spans) {
    if (item.parent.state !== "known") continue;
    const parent = spanKey(item.parent.span);
    children.set(parent, [...(children.get(parent) ?? []), item]);
  }
  const seen = new Set<string>();
  const out: CanonicalSpanProjectionItemV2[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const next = stack.pop()!;
    const key = spanKey(next.span);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(next);
    // A nested inbound request is its own row; its diagnostics stay with it.
    for (const child of children.get(key) ?? []) if (!isInboundRequest(child)) stack.push(child);
  }
  return out;
}

function ancestorsOf(
  item: CanonicalSpanProjectionItemV2,
  byKey: Map<string, CanonicalSpanProjectionItemV2>
): CausalAncestor[] {
  const out: CausalAncestor[] = [];
  const seen = new Set<string>([spanKey(item.span)]);
  let current = item;
  while (current.parent.state === "known") {
    const key = spanKey(current.parent.span);
    const parent = byKey.get(key);
    if (parent === undefined || seen.has(key)) break;
    seen.add(key);
    const grand = parent.parent.state === "known" ? byKey.get(spanKey(parent.parent.span)) : undefined;
    out.push({
      ref: spanRefOf(parent.span),
      runtime: parent.runtime,
      label: spanLabelV2(parent, grand).text,
      nodeId: escapeTerminalControls(parent.node.nodeId)
    });
    current = parent;
  }
  return out;
}

/** Request rows of one v2 page, in recorded order. */
export function requestRowsFromPage(page: CanonicalPageEnvelopeV2): RequestRow[] {
  const spans = page.items.filter(isSpan);
  const byKey = new Map(spans.map((item) => [spanKey(item.span), item]));
  return spans
    .filter(isInboundRequest)
    .map((item): RequestRow => {
      const state = stateOf(item);
      const diagnostics = [
        ...new Set(subtree(item, spans).flatMap((span) => span.lifecycleIssues.map((issue) => issue.code)))
      ];
      const parent = item.parent.state === "known" ? byKey.get(spanKey(item.parent.span)) : undefined;
      return {
        mode: "request",
        key: spanKey(item.span),
        ref: spanRefOf(item.span),
        seq: item.sequence.firstSeq,
        method: frameworkField(item.framework, "method"),
        route: routeOf(item),
        status: statusOf(item, state),
        requestType: frameworkField(item.framework, "requestType"),
        duration: item.duration,
        runtime: item.runtime,
        state,
        diagnostics,
        causalContext: ancestorsOf(item, byKey),
        label: spanLabelV2(item, parent)
      };
    })
    .sort((left, right) => left.seq - right.seq || left.key.localeCompare(right.key));
}

/**
 * The selector's rows: request rows from the loaded v2 pages, and a trace-summary row for
 * every loaded trace that has no request metadata (or no v2 page at all).
 */
export function selectorRows(pages: readonly CanonicalPageEnvelopeV2[], traces: readonly TraceRow[]): SelectorRow[] {
  const requests: RequestRow[] = [];
  const covered = new Set<string>();
  for (const page of pages) {
    const rows = requestRowsFromPage(page);
    requests.push(...rows);
    // A trace ref whose spans are a request's causal context (the browser session of a
    // distributed trace) is shown through that request, not as a separate summary.
    for (const row of rows)
      [row.ref, ...row.causalContext.map((ancestor) => ancestor.ref)].forEach((ref) => covered.add(traceKey(ref)));
  }
  const paged = new Set(pages.flatMap((page) => page.items.filter(isSpan).map((item) => traceKey(item.span))));
  const summaries = traces
    .filter((trace) => !covered.has(traceKey(trace)))
    .map((trace): TraceSummaryRow => ({
      mode: "trace-summary",
      key: traceKey(trace),
      ref: {
        datasetId: trace.datasetId,
        projectId: trace.projectId,
        sessionId: trace.sessionId,
        traceId: trace.traceId
      },
      status: trace.status,
      spanCount: trace.spanCount,
      reason: paged.has(traceKey(trace)) ? "no-request-metadata" : "no-projection-v2"
    }));
  return [...requests.sort((left, right) => left.seq - right.seq || left.key.localeCompare(right.key)), ...summaries];
}

export function durationText(duration: CanonicalDurationEvidence): string {
  if (duration.state === "unavailable") return `unavailable(${duration.reason})`;
  return `${Math.round(duration.ms * 1000) / 1000}ms`;
}

/** `time method route status duration runtime state`, plus diagnostics and causal context. */
export function formatSelectorRow(row: SelectorRow): string {
  if (row.mode === "trace-summary") {
    return `trace ${escapeTerminalControls(row.ref.traceId)} ${row.status} (${row.spanCount} spans) [trace summary: ${row.reason}]`;
  }
  const parts = [
    `#${row.seq}`,
    fieldText(row.method),
    fieldText(row.route),
    fieldText(row.status),
    durationText(row.duration),
    row.runtime ?? "unavailable(runtime)",
    stateText(row.state)
  ];
  if (row.requestType.state === "recorded") parts.push(`requestType=${row.requestType.text}`);
  if (row.diagnostics.length > 0) parts.push(`issues=${row.diagnostics.join(",")}`);
  const cause = row.causalContext.find((ancestor) => ancestor.runtime === "browser") ?? row.causalContext[0];
  if (cause !== undefined) parts.push(`via ${cause.runtime ?? "unknown"}:${cause.label} ${cause.nodeId}`);
  return parts.join(" ");
}
