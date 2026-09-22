/**
 * `=`: explicit pair comparison of two marked spans (task 5.7; spec tui-debugger
 * "Стек, закладки, порівняння та evidence", design D6).
 *
 * The user marks A, then B, with `=`; the pair is compared through the shared
 * `diffTraces({ scope: "spans" })` of `@kosmo-callflow/trace-diff` (there is no
 * `diffSpans`). Rules this module adds on top of the shared diff:
 *
 *  - A pair of different nodeIds or different source (graph) revisions is not a
 *    like-for-like comparison: the verdict is `inconclusive` with an explicit
 *    "different source revision/node" note, never `changed`.
 *  - Masked, truncated, sampled, gapped, count-only, not-recorded or still-running
 *    evidence on either side makes the verdict `inconclusive`: missing data cannot be
 *    told apart from a behaviour change. The shared diff treats `masked` as complete, so
 *    the gate is applied here before its verdict is accepted.
 *  - Duration is reported on its own line and never feeds the verdict: two spans with
 *    identical behaviour and different durations are `equivalent`.
 */

import type { CanonicalSpanProjectionItemV2, CanonicalValueEvidence } from "@kosmo-callflow/protocol";
import { escapeTerminalControls } from "@kosmo-callflow/trace-artifacts";
import { diffTraces, type EvidenceStatus, type SpanInput, type TraceDiffResult } from "@kosmo-callflow/trace-diff";
import { sameSpan, spanRefOf, type SpanRef } from "./view-state.js";

export type CompareVerdict = "equivalent" | "changed" | "inconclusive";

export type DurationComparison = {
  a: number | null;
  b: number | null;
  /** `b - a` in ms when both were recorded in the same clock domain; null otherwise. */
  deltaMs: number | null;
  reason: string | null;
};

export type PairComparison = {
  a: SpanRef;
  b: SpanRef;
  nodeIds: { a: string; b: string };
  revisions: { a: string; b: string };
  verdict: CompareVerdict;
  /** Why the verdict is what it is, beyond the shared diff's own findings. */
  notes: string[];
  /** The shared diff result; null when the pair was refused before diffing. */
  diff: TraceDiffResult | null;
  /** Reported separately; never part of the behaviour verdict. */
  duration: DurationComparison;
};

/** Compare two canonical v2 span items. A is the base, B the head. */
export function compareSpanPair(a: CanonicalSpanProjectionItemV2, b: CanonicalSpanProjectionItemV2): PairComparison {
  const base = {
    a: spanRefOf(a.span),
    b: spanRefOf(b.span),
    nodeIds: { a: a.node.nodeId, b: b.node.nodeId },
    revisions: { a: a.node.graphRevision, b: b.node.graphRevision },
    duration: compareDuration(a, b)
  };
  if (sameSpan(a.span, b.span)) {
    return {
      ...base,
      verdict: "inconclusive",
      notes: ["A and B are the same span; mark two different spans"],
      diff: null
    };
  }
  const mismatch: string[] = [];
  if (a.node.nodeId !== b.node.nodeId) mismatch.push(`node ${a.node.nodeId} vs ${b.node.nodeId}`);
  if (a.node.graphRevision !== b.node.graphRevision) {
    mismatch.push(`revision ${a.node.graphRevision} vs ${b.node.graphRevision}`);
  }
  if (mismatch.length > 0) {
    return {
      ...base,
      verdict: "inconclusive",
      notes: [`different source revision/node (${mismatch.join(", ")}); not a like-for-like comparison`],
      diff: null
    };
  }

  const gaps = [...evidenceGaps("A", a), ...evidenceGaps("B", b)];
  const diff = diffTraces({
    scope: "spans",
    base: [toSpanInput(a, gaps.length > 0)],
    head: [toSpanInput(b, gaps.length > 0)]
  });
  if (gaps.length > 0) {
    return {
      ...base,
      verdict: "inconclusive",
      notes: [`evidence incomplete: ${gaps.join("; ")}; neither "same" nor "different" can be claimed`],
      diff
    };
  }
  return { ...base, verdict: diff.verdict, notes: [], diff };
}

/** Plain-text lines for the result pane; recorded strings are control-escaped. */
export function comparisonLines(result: PairComparison): string[] {
  const e = escapeTerminalControls;
  const lines = [
    `compare A ${e(result.a.traceId)}/${e(result.a.spanId)} vs B ${e(result.b.traceId)}/${e(result.b.spanId)}  (esc closes)`,
    `  node ${e(result.nodeIds.a)}${result.nodeIds.a === result.nodeIds.b ? "" : ` / ${e(result.nodeIds.b)}`}  revision ${e(
      result.revisions.a
    )}${result.revisions.a === result.revisions.b ? "" : ` / ${e(result.revisions.b)}`}`,
    `  behavior: ${result.verdict} (shared diffTraces, scope spans)`
  ];
  for (const note of result.notes) lines.push(`  ${e(note)}`);
  if (result.diff !== null && result.verdict !== "inconclusive") {
    for (const finding of result.diff.findings) lines.push(`  - ${finding.code}: ${e(finding.detail)}`);
  }
  lines.push(`  ${durationText(result.duration)}`);
  return lines;
}

/* ---------------------------------------------------------------- helpers */

function durationText(duration: DurationComparison): string {
  const side = (ms: number | null): string => (ms === null ? "unavailable" : `${ms}ms`);
  const delta =
    duration.deltaMs === null
      ? `delta unavailable${duration.reason === null ? "" : `(${duration.reason})`}`
      : `delta ${duration.deltaMs >= 0 ? "+" : ""}${duration.deltaMs}ms`;
  return `duration (separate from behavior; not a regression verdict): A ${side(duration.a)}, B ${side(duration.b)}, ${delta}`;
}

function compareDuration(a: CanonicalSpanProjectionItemV2, b: CanonicalSpanProjectionItemV2): DurationComparison {
  const left = a.duration.state === "recorded" ? a.duration : null;
  const right = b.duration.state === "recorded" ? b.duration : null;
  const result = { a: left?.ms ?? null, b: right?.ms ?? null };
  if (left === null || right === null) return { ...result, deltaMs: null, reason: "not recorded on both sides" };
  if (left.domain !== right.domain || left.domain === "unknown") {
    return { ...result, deltaMs: null, reason: "clock domains not comparable" };
  }
  return { ...result, deltaMs: right.ms - left.ms, reason: null };
}

/** Everything on one side that keeps a behavioural verdict from being made. */
function evidenceGaps(side: "A" | "B", item: CanonicalSpanProjectionItemV2): string[] {
  const gaps: string[] = [];
  const states = item.coverage.states.filter((state) => state !== "full");
  if (states.length > 0) gaps.push(`${side} coverage ${[...new Set(states)].sort().join(",")}`);
  if (item.coverage.partial === true) gaps.push(`${side} coverage partial`);
  if (item.lifecycle === "running" || item.lifecycle === "suspended" || item.lifecycle === "unknown") {
    gaps.push(`${side} lifecycle ${item.lifecycle}`);
  }
  for (const [name, evidence] of [
    ["args", item.args],
    ["ret", item.ret],
    ["error", item.error]
  ] as const) {
    // A span that threw has no return value: that is the recorded outcome, not a gap.
    if (name === "ret" && item.error.state === "recorded" && evidence.state === "not-recorded") continue;
    const gap = valueGap(name, evidence);
    if (gap !== null) gaps.push(`${side} ${gap}`);
  }
  return gaps;
}

function valueGap(name: "args" | "ret" | "error", evidence: CanonicalValueEvidence): string | null {
  switch (evidence.state) {
    case "recorded":
      return evidence.partiallyMasked === true ? `${name} partially masked` : null;
    case "not-recorded":
      // No error event is a recorded fact (the span did not throw), not missing data.
      return name === "error" && evidence.reason === "no-error-event"
        ? null
        : `${name} not-recorded(${evidence.reason})`;
    case "unavailable":
      return `${name} unavailable(${evidence.reason})`;
    case "masked":
    case "truncated":
      return `${name} ${evidence.state}`;
  }
}

/** Map the item's worst evidence onto the shared diff's status vocabulary. */
function statusOf(item: CanonicalSpanProjectionItemV2, incomplete: boolean): EvidenceStatus {
  const states = new Set<string>(item.coverage.states);
  for (const evidence of [item.args, item.ret, item.error]) states.add(evidence.state);
  if (states.has("sampled")) return "sampled";
  if (states.has("truncated")) return "truncated";
  if (states.has("aggregate-gap") || states.has("loss") || states.has("retention")) return "gap";
  if (states.has("count")) return "aggregate";
  if (states.has("masked")) return "masked";
  if (states.has("unavailable") || states.has("unknown")) return "not-recorded";
  return incomplete ? "not-recorded" : "recorded";
}

function toSpanInput(item: CanonicalSpanProjectionItemV2, incomplete: boolean): SpanInput {
  const input: SpanInput = {
    traceId: item.span.traceId,
    spanId: item.span.spanId,
    // The pair is compared as two single spans: their own recorded behaviour, rooted at
    // the node itself so two call sites of the same function line up.
    parentSpanId: null,
    nodeId: item.node.nodeId,
    kind: item.spanKind ?? "unknown",
    ordinal: 0,
    depth: 0,
    seq: item.sequence.firstSeq,
    args: valueOf(item.args),
    ret: valueOf(item.ret),
    error: errorOf(item.error),
    status: statusOf(item, incomplete)
  };
  if (item.duration.state === "recorded") input.durationMs = item.duration.ms;
  return input;
}

function valueOf(evidence: CanonicalValueEvidence): unknown {
  return evidence.state === "recorded" ? evidence.value : null;
}

function errorOf(evidence: CanonicalValueEvidence): { name: string; message: string } | null {
  if (evidence.state !== "recorded") return null;
  const value = evidence.value as { name?: unknown; message?: unknown } | null;
  if (value !== null && typeof value === "object") {
    return {
      name: typeof value.name === "string" ? value.name : "Error",
      message: typeof value.message === "string" ? value.message : JSON.stringify(value)
    };
  }
  return { name: "Error", message: typeof value === "string" ? value : JSON.stringify(value) };
}
