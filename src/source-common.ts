/**
 * Pieces every concrete source shares: the typed source error, and the mapping from a
 * canonical projection-v2 page to typed span evidence (used by the export and stream-v2
 * sources, whose details come from canonical pages).
 *
 * A source error never carries a secret: messages are built from codes, statuses and
 * redacted URLs only. `status` is the HTTP status when there is one, so the session's
 * `classifyFailure` can tell auth (401/403), reset (409) and retryable failures apart.
 */

import type {
  CanonicalDurationEvidence,
  CanonicalPageEnvelopeV2,
  CanonicalSpanProjectionItemV2,
  CanonicalValueEvidence
} from "@kosmo-callflow/protocol";
import { sanitizeEvidenceText } from "@kosmo-callflow/trace-artifacts";
import type { Page, SnapshotRef, SpanEvidence } from "./source.js";
import type { DetailAnchor, DetailDuration, DetailValue, SpanRef, TraceRow } from "./view-state.js";

export class SourceError extends Error {
  override readonly name = "SourceError";
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

export function isSpanItemV2(item: CanonicalPageEnvelopeV2["items"][number]): item is CanonicalSpanProjectionItemV2 {
  return item.kind === "span";
}

function sameSpan(left: SpanRef, right: SpanRef): boolean {
  return (
    left.datasetId === right.datasetId &&
    left.projectId === right.projectId &&
    left.sessionId === right.sessionId &&
    left.traceId === right.traceId &&
    left.spanId === right.spanId
  );
}

function valueEvidence(value: CanonicalValueEvidence): DetailValue {
  switch (value.state) {
    case "recorded":
    case "truncated": {
      const text = typeof value.value === "string" ? value.value : JSON.stringify(value.value);
      const clean = sanitizeEvidenceText(text ?? "null").value;
      return { state: "recorded", text: value.state === "truncated" ? `${clean}… [truncated]` : clean };
    }
    case "masked":
      return { state: "masked" };
    case "not-recorded":
      return { state: "not-recorded" };
    case "unavailable":
      return { state: "unavailable", reason: value.reason };
  }
}

function durationEvidence(duration: CanonicalDurationEvidence): DetailDuration {
  return duration.state === "recorded"
    ? { state: "recorded", ms: duration.ms }
    : { state: "unavailable", reason: duration.reason };
}

function anchorOf(item: CanonicalSpanProjectionItemV2): DetailAnchor {
  const nodeId = item.node.nodeId;
  const hash = nodeId.lastIndexOf("#");
  const symbol = sanitizeEvidenceText(hash === -1 ? nodeId : nodeId.slice(hash + 1)).value;
  if (item.node.location !== undefined) {
    return { file: sanitizeEvidenceText(item.node.location.file).value, symbol, line: item.node.location.line };
  }
  return { file: sanitizeEvidenceText(hash === -1 ? nodeId : nodeId.slice(0, hash)).value, symbol, line: null };
}

function statusOf(item: CanonicalSpanProjectionItemV2): TraceRow["status"] {
  if (item.lifecycle === "errored") return "errored";
  if (item.lifecycle === "complete") return "complete";
  return "running";
}

/** Typed evidence of one span from a v2 page, or null when the page does not hold it. */
export function evidenceFromCanonicalV2(
  page: CanonicalPageEnvelopeV2,
  ref: SpanRef,
  snapshot: SnapshotRef
): SpanEvidence | null {
  const item = page.items.filter(isSpanItemV2).find((candidate) => sameSpan(candidate.span, ref));
  if (item === undefined) return null;
  return {
    ref: { ...item.span },
    nodeId: sanitizeEvidenceText(item.node.nodeId).value,
    status: statusOf(item),
    args: valueEvidence(item.args),
    ret: valueEvidence(item.ret),
    error: valueEvidence(item.error),
    duration: durationEvidence(item.duration),
    anchor: anchorOf(item),
    snapshot
  };
}

/** Coverage of a canonical page, in the source contract's vocabulary. */
export function canonicalPageMeta(page: {
  items: unknown[];
  truncated: boolean;
  coverage?: { partial?: boolean } | undefined;
}): Omit<Page<never>, "items"> {
  const partial = page.truncated || page.coverage?.partial === true;
  return {
    coverage: {
      scope: partial ? "partial" : "complete",
      loaded: page.items.length,
      total: partial ? null : page.items.length,
      ...(page.truncated ? { reason: "page-truncated" } : {})
    },
    truncated: page.truncated,
    cursor: null
  };
}
