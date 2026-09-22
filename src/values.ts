/**
 * `w`: equal-value candidates for the selected span's recorded values (task 5.4; spec
 * tui-debugger "Пошук однакових значень не є lineage", design D6).
 *
 * For each recorded `args[i]` and `ret` of the selected span this lists other recorded
 * values of the same trace and snapshot that are STRUCTURALLY equal to the full
 * recorded value, and were recorded at or before the selected value's seq. The rules:
 *
 *  - Equality is structural over the whole recorded value: object key order does not
 *    matter, array order does. Nothing is compared through a hash or a preview.
 *  - Only `recorded` evidence takes part. `masked`, `truncated`, `not-recorded`,
 *    `unavailable` and partially masked values are unavailable — on the selected side
 *    the slot says so, on the candidate side they are counted and never matched. A
 *    truncated payload's retained part proves nothing about the full value.
 *  - No future: a candidate recorded after the selected value's seq is never listed.
 *  - The result is labelled as candidates, not lineage. Two unrelated functions that
 *    both returned `0` are both listed, and neither is called the source of the other;
 *    the list is ordered by seq only because that is the recording order.
 *  - Coverage is stated: how many of the loaded spans of the trace were searched and
 *    whether the loaded page itself is partial.
 *
 * Seq of a value: `args` are recorded on the enter record (`sequence.firstSeq`) and
 * `ret` on the terminal record (`sequence.lastSeq`). For sessions with different clocks
 * seq is the order records were written, not a guaranteed program order.
 */

import type { CanonicalSpanProjectionItemV2, CanonicalValueEvidence } from "@kosmo-callflow/protocol";
import { escapeTerminalControls } from "@kosmo-callflow/trace-artifacts";
import { spanKey, spanRefOf, type SpanRef } from "./view-state.js";

export const VALUE_MATCH_LABEL = "candidates (equal values), not lineage";
/** Candidates listed per slot at most; beyond this the slot says it is truncated. */
export const VALUE_MATCH_MAX = 200;
/** Nesting beyond this is not compared; such a value never matches. */
const MAX_DEPTH = 64;
const MASK_MARKER = "[masked]";

export type ValueSlot = { kind: "args"; index: number | null } | { kind: "ret" };

export type ValueCandidate = { ref: SpanRef; nodeId: string; slot: ValueSlot; seq: number };

export type SlotMatches =
  | {
      slot: ValueSlot;
      state: "searched";
      /** Seq of the selected value: the cutoff every candidate is at or before. */
      seq: number;
      candidates: ValueCandidate[];
      truncated: boolean;
    }
  | { slot: ValueSlot; state: "unavailable"; reason: string };

export type ValueMatchCoverage = {
  /** Loaded spans of the trace that were searched (recorded at or before the latest cutoff). */
  searched: number;
  /** Loaded spans of the trace in the page. */
  loaded: number;
  /** The page itself is partial (truncated, not every record loaded). */
  partial: boolean;
  reason: string | null;
  /** Candidate-side values that could not take part (masked/truncated/not-recorded/...). */
  unavailableValues: number;
};

export type ValueMatchResult =
  | { state: "unavailable"; ref: SpanRef; reason: string }
  | {
      state: "searched";
      ref: SpanRef;
      nodeId: string;
      label: typeof VALUE_MATCH_LABEL;
      slots: SlotMatches[];
      coverage: ValueMatchCoverage;
      /** Candidates come from more than one session: seq is record order, not program order. */
      mixedSessions: boolean;
    };

export type ValueMatchScope = {
  /** The loaded page is partial; coverage says so. */
  truncated?: boolean;
  reason?: string | null;
};

type Recorded = { slot: ValueSlot; seq: number; value: unknown };
type Offered = { recorded: Recorded[]; unavailable: Array<{ slot: ValueSlot; reason: string }> };

/**
 * Find equal-value candidates for every recorded value of `target` among `items`
 * (a canonical v2 page of the target's trace).
 */
export function findValueCandidates(
  items: readonly unknown[],
  target: SpanRef,
  scope: ValueMatchScope = {}
): ValueMatchResult {
  const ref = spanRefOf(target);
  const spans = items.filter(isSpanItem).filter((item) => sameTraceScope(item.span, ref));
  const targetKey = spanKey(ref);
  const selected = spans.find((item) => spanKey(item.span) === targetKey);
  if (!selected) return { state: "unavailable", ref, reason: "selected span is not in the loaded projection" };

  const own = offeredValues(selected);
  const searchedSlots = own.recorded;
  const cutoff = searchedSlots.reduce((max, entry) => Math.max(max, entry.seq), -Infinity);

  const pool: Array<{ item: CanonicalSpanProjectionItemV2; entry: Recorded }> = [];
  let unavailableValues = 0;
  let searched = 0;
  for (const item of spans) {
    if (item.sequence.firstSeq > cutoff) continue;
    searched += 1;
    const offered = item === selected ? { recorded: own.recorded, unavailable: [] } : offeredValues(item);
    unavailableValues += offered.unavailable.length;
    for (const entry of offered.recorded) pool.push({ item, entry });
  }

  const sessions = new Set<string>();
  const slots: SlotMatches[] = own.unavailable.map(({ slot, reason }) => ({ slot, state: "unavailable", reason }));
  for (const mine of searchedSlots) {
    const candidates: ValueCandidate[] = [];
    let truncated = false;
    const ordered = pool
      .filter(({ item, entry }) => entry.seq <= mine.seq && !(item === selected && sameSlot(entry.slot, mine.slot)))
      .sort(
        (left, right) =>
          left.entry.seq - right.entry.seq || spanKey(left.item.span).localeCompare(spanKey(right.item.span))
      );
    for (const { item, entry } of ordered) {
      if (!structurallyEqual(mine.value, entry.value)) continue;
      if (candidates.length >= VALUE_MATCH_MAX) {
        truncated = true;
        break;
      }
      sessions.add(item.span.sessionId);
      candidates.push({ ref: spanRefOf(item.span), nodeId: item.node.nodeId, slot: entry.slot, seq: entry.seq });
    }
    slots.push({ slot: mine.slot, state: "searched", seq: mine.seq, candidates, truncated });
  }
  slots.sort((left, right) => slotOrder(left.slot) - slotOrder(right.slot));
  sessions.add(ref.sessionId);

  return {
    state: "searched",
    ref,
    nodeId: selected.node.nodeId,
    label: VALUE_MATCH_LABEL,
    slots,
    coverage: {
      searched,
      loaded: spans.length,
      partial: scope.truncated === true,
      reason: scope.reason ?? (scope.truncated === true ? "loaded page is truncated" : null),
      unavailableValues
    },
    mixedSessions: sessions.size > 1
  };
}

/** Structural equality of two recorded JSON values; key order ignored, array order kept. */
export function structurallyEqual(left: unknown, right: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    const other = right as unknown[];
    return (
      left.length === other.length && left.every((item, index) => structurallyEqual(item, other[index], depth + 1))
    );
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every((key) =>
    structurallyEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], depth + 1)
  );
}

export function slotText(slot: ValueSlot): string {
  if (slot.kind === "ret") return "ret";
  return slot.index === null ? "args" : `args[${slot.index}]`;
}

/** Plain-text lines for the result pane; recorded strings are control-escaped. */
export function valueMatchLines(result: ValueMatchResult): string[] {
  if (result.state === "unavailable") return [`values: unavailable(${escapeTerminalControls(result.reason)})`];
  const lines = [`${VALUE_MATCH_LABEL}: ${escapeTerminalControls(result.nodeId)}  (esc closes)`];
  for (const slot of result.slots) {
    if (slot.state === "unavailable") {
      lines.push(`  ${slotText(slot.slot)}: unavailable(${escapeTerminalControls(slot.reason)}); not matched`);
      continue;
    }
    const count = slot.candidates.length === 0 ? "no equal recorded value" : `${slot.candidates.length} candidate(s)`;
    lines.push(
      `  ${slotText(slot.slot)} @seq ${slot.seq}: ${count} at or before seq ${slot.seq}${slot.truncated ? " (truncated)" : ""}`
    );
    for (const candidate of slot.candidates) {
      lines.push(
        `    seq ${candidate.seq}  ${slotText(candidate.slot)}  ${escapeTerminalControls(candidate.nodeId)}  ${escapeTerminalControls(
          candidate.ref.traceId
        )}/${escapeTerminalControls(candidate.ref.spanId)}`
      );
    }
  }
  const coverage = result.coverage;
  const parts = [
    `${coverage.searched} of ${coverage.loaded} loaded spans searched`,
    `coverage ${coverage.partial ? "partial" : "complete"}`
  ];
  if (coverage.reason !== null) parts.push(escapeTerminalControls(coverage.reason));
  if (coverage.unavailableValues > 0) parts.push(`${coverage.unavailableValues} value(s) unavailable, not matched`);
  lines.push(`  ${parts.join("; ")}`);
  lines.push(
    result.mixedSessions
      ? "  equal values are not proof of origin; seq is record order across sessions, not program order"
      : "  equal values are not proof of origin or object identity"
  );
  return lines;
}

/* ---------------------------------------------------------------- helpers */

function isSpanItem(item: unknown): item is CanonicalSpanProjectionItemV2 {
  return (
    typeof item === "object" &&
    item !== null &&
    (item as { kind?: unknown }).kind === "span" &&
    typeof (item as { span?: unknown }).span === "object" &&
    typeof (item as { sequence?: unknown }).sequence === "object"
  );
}

/** Same dataset, project and trace id: one distributed trace may span sessions. */
function sameTraceScope(span: SpanRef, ref: SpanRef): boolean {
  return span.datasetId === ref.datasetId && span.projectId === ref.projectId && span.traceId === ref.traceId;
}

function offeredValues(item: CanonicalSpanProjectionItemV2): Offered {
  const offered: Offered = { recorded: [], unavailable: [] };
  const args = usable(item.args);
  if (!args.ok) offered.unavailable.push({ slot: { kind: "args", index: null }, reason: args.reason });
  else if (Array.isArray(args.value)) {
    args.value.forEach((value, index) =>
      offered.recorded.push({ slot: { kind: "args", index }, seq: item.sequence.firstSeq, value })
    );
  } else offered.recorded.push({ slot: { kind: "args", index: null }, seq: item.sequence.firstSeq, value: args.value });
  const ret = usable(item.ret);
  if (!ret.ok) offered.unavailable.push({ slot: { kind: "ret" }, reason: ret.reason });
  else offered.recorded.push({ slot: { kind: "ret" }, seq: item.sequence.lastSeq, value: ret.value });
  return offered;
}

function usable(evidence: CanonicalValueEvidence): { ok: true; value: unknown } | { ok: false; reason: string } {
  switch (evidence.state) {
    case "recorded":
      if (evidence.partiallyMasked === true || containsMask(evidence.value, 0)) {
        return { ok: false, reason: "partially masked" };
      }
      return { ok: true, value: evidence.value };
    case "truncated":
      return { ok: false, reason: "truncated: the retained part does not prove equality" };
    case "masked":
      return { ok: false, reason: "masked" };
    case "not-recorded":
      return { ok: false, reason: `not-recorded(${evidence.reason})` };
    case "unavailable":
      return { ok: false, reason: `unavailable(${evidence.reason})` };
  }
}

function containsMask(value: unknown, depth: number): boolean {
  if (value === MASK_MARKER) return true;
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return false;
  return (Array.isArray(value) ? value : Object.values(value)).some((entry) => containsMask(entry, depth + 1));
}

function sameSlot(left: ValueSlot, right: ValueSlot): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "ret" || left.index === (right as { index: number | null }).index;
}

function slotOrder(slot: ValueSlot): number {
  if (slot.kind === "ret") return Number.MAX_SAFE_INTEGER;
  return slot.index ?? -1;
}
