/**
 * Replay on a pinned snapshot (task 5.5, design D6, spec "Replay на зафіксованому
 * записі"). Pure: no I/O, no clock.
 *
 * The records are read ONCE from one pinned `SnapshotRef` and every frame is derived
 * from them with the shared reducer (`seekReplay` from `@kosmo-callflow/replay`, reducer
 * version 2, full-ref keys). Consequences this module relies on:
 *
 *  - `seq N` is a cutoff, not an index: the state after every record with `seq <= N`.
 *    A requested seq with no record of its own is a hole; the frame is the state after
 *    the last record before it, and both numbers are reported.
 *  - Stepping moves between seqs that actually hold a record, so holes are skipped by
 *    construction and never shown as empty frames.
 *  - A seq outside the pinned range is refused with the range, never clamped.
 *  - The reducer only sees records `<= N`, so a payload supplement or error recorded
 *    after N cannot appear in the frame at N. A live read merges supplements into the
 *    runtime record's `payload.supplement` without a seq of their own; before the
 *    watermark that merged value is stripped, because its time is unknown.
 *  - Records past the pinned watermark (ingested after the pin) are not part of the
 *    snapshot: they are dropped, and the range never extends beyond the watermark.
 *  - Nothing here reads live data: live deltas cannot reach a pinned replay.
 *  - Probe records are a separate sequence domain and are never part of the timeline.
 */

import {
  seekReplay,
  type ReplayRecord,
  type ReplaySpanState,
  type ReplayState,
  type ReplayTraceState
} from "@kosmo-callflow/replay";
import { sanitizeEvidenceText } from "@kosmo-callflow/trace-artifacts";
import { valueOf } from "./detail.js";
import {
  buildReplayTimeline,
  planReplaySchedule,
  type ReplayAlignment,
  type ReplayFrameInput,
  type ReplaySchedule,
  type ReplayTimeline
} from "./replay.js";
import type { SnapshotRef } from "./source.js";
import type { DetailValue, SpanDetail, SpanRef, SpanRow, TraceRow } from "./view-state.js";

export type PinnedReplay = {
  snapshot: SnapshotRef;
  /** Records sorted by seq; the only data any frame is derived from. */
  records: ReplayRecord[];
  /** Distinct seqs that hold at least one record, ascending. */
  seqs: number[];
  /** Inclusive range a `seq N` request may name. */
  range: { first: number; last: number } | null;
  /** Frame metadata for the header (count, seq); states are derived on demand. */
  timeline: ReplayTimeline;
  /** True when the record read stopped early (cap or source limit). */
  truncated: boolean;
  truncatedReason: string | null;
};

export type ReplayRows = { traces: TraceRow[]; spans: SpanRow[] };

export type SeekOutcome =
  | {
      ok: true;
      requested: number;
      applied: number;
      index: number;
      /** Set when `requested` holds no record: the frame is the state after `applied`. */
      hole: { requested: number; applied: number; nextRecord: number | null } | null;
      /** Loss gaps the recording declares up to the cutoff. */
      knownGaps: number;
      state: ReplayState;
      rows: ReplayRows;
    }
  | { ok: false; reason: "invalid" | "out-of-range" | "empty"; notice: string };

const EMPTY_ROWS: ReplayRows = { traces: [], spans: [] };

const isRuntime = (record: ReplayRecord): record is Extract<ReplayRecord, { localSeq: number }> =>
  "localSeq" in record && "spanId" in record && "nodeId" in record && "runtime" in record;

export function pinReplay(
  records: ReplayRecord[],
  snapshot: SnapshotRef,
  options: { truncatedReason?: string | null } = {}
): PinnedReplay {
  const watermark = typeof snapshot.watermark === "number" ? snapshot.watermark : null;
  const sorted = records
    .filter((record) => watermark === null || record.seq <= watermark)
    .sort((left, right) => left.seq - right.seq);
  const seqs = [...new Set(sorted.map((record) => record.seq))];
  const maxSeq = seqs.at(-1);
  const range =
    maxSeq === undefined
      ? null
      : { first: seqs[0]!, last: options.truncatedReason || watermark === null ? maxSeq : Math.max(maxSeq, watermark) };
  // One timeline frame per recorded seq. The row state is derived on demand by `seek`,
  // so the frames only carry what the header and the clock rules need.
  const bySeq = new Map<number, ReplayFrameInput>();
  for (const record of sorted) {
    const frame: ReplayFrameInput = bySeq.get(record.seq) ?? {
      seq: record.seq,
      sessionId: record.sessionId,
      state: EMPTY_ROWS
    };
    if (frame.clock === undefined && isRuntime(record) && record.clock) frame.clock = record.clock;
    bySeq.set(record.seq, frame);
  }
  const frames = [...bySeq.values()];
  return {
    snapshot,
    records: sorted,
    seqs,
    range,
    timeline: { ...buildReplayTimeline({ frames }), alignment: runtimeAlignment(sorted) },
    truncated: Boolean(options.truncatedReason),
    truncatedReason: options.truncatedReason ?? null
  };
}

/**
 * Clock alignment over runtime records only: supplements carry no clock of their own and
 * do not make an otherwise single-domain recording unaligned. Records from sessions
 * without a shared source clock stay unaligned (replay-clock.md §1, §4).
 */
function runtimeAlignment(records: ReplayRecord[]): ReplayAlignment {
  const frames: ReplayFrameInput[] = records.filter(isRuntime).map((record) => ({
    seq: record.seq,
    sessionId: record.sessionId,
    ...(record.clock ? { clock: record.clock } : {}),
    state: { traces: [], spans: [] }
  }));
  return buildReplayTimeline({ frames }).alignment;
}

/** Cadence for autoplay; speed needs an aligned clock and otherwise falls back and says why. */
export function pinnedSchedule(
  pin: PinnedReplay,
  options: { speed?: number; stepIntervalMs?: number }
): ReplaySchedule {
  return planReplaySchedule(pin.timeline, options);
}

/** Viewer-time delay before the frame after `index`, or null when nothing is due. */
export function delayAfter(pin: PinnedReplay, schedule: ReplaySchedule, index: number): number | null {
  if (index < 0 || index >= pin.seqs.length - 1) return null;
  switch (schedule.mode) {
    case "manual":
      return null;
    case "step-interval":
    case "speed-fallback":
      return schedule.intervalMs;
    case "speed": {
      const current = pin.timeline.frames[index]?.clock?.value ?? null;
      const next = pin.timeline.frames[index + 1]?.clock?.value ?? null;
      // A supplement-only seq has no clock reading of its own: no invented interval.
      if (current === null || next === null) return 0;
      const elapsed = next - current;
      return elapsed <= 0 ? 0 : elapsed / schedule.speed;
    }
  }
}

/** The state after every record with `seq <= requested`, or an explicit refusal. */
export function seekPinned(pin: PinnedReplay, requested: number): SeekOutcome {
  if (!Number.isSafeInteger(requested) || requested < 0) {
    return { ok: false, reason: "invalid", notice: `seq ${String(requested)}: not a valid record seq` };
  }
  if (pin.range === null) {
    return { ok: false, reason: "empty", notice: "replay: the pinned snapshot holds no records" };
  }
  if (requested < pin.range.first || requested > pin.range.last) {
    return {
      ok: false,
      reason: "out-of-range",
      notice: `seq ${requested} out of range: pinned snapshot ${pin.snapshot.snapshotId} holds ${pin.range.first}..${pin.range.last}${pin.truncated ? ` (records truncated: ${pin.truncatedReason})` : ""}`
    };
  }
  const index = lastIndexAtOrBelow(pin.seqs, requested);
  const applied = pin.seqs[index]!;
  const watermark = typeof pin.snapshot.watermark === "number" ? pin.snapshot.watermark : null;
  const input = watermark !== null && requested < watermark ? pin.records.map(withoutMergedSupplement) : pin.records;
  const { state } = seekReplay(input, requested, [], {
    retentionEpoch: pin.snapshot.retentionEpoch,
    datasetId: pin.snapshot.datasetId
  });
  return {
    ok: true,
    requested,
    applied,
    index,
    hole: applied === requested ? null : { requested, applied, nextRecord: pin.seqs[index + 1] ?? null },
    knownGaps: Object.values(state.traces).reduce((sum, trace) => sum + trace.gaps.length, 0),
    state,
    rows: rowsFromReplayState(state, pin.snapshot)
  };
}

/** A runtime record without the live read's merged `payload.supplement` (it carries no seq). */
function withoutMergedSupplement(record: ReplayRecord): ReplayRecord {
  if (!isRuntime(record)) return record;
  const payload = (record as { payload?: unknown }).payload;
  if (payload === null || typeof payload !== "object" || !("supplement" in payload)) return record;
  const { supplement: _merged, ...rest } = payload as Record<string, unknown>;
  return { ...record, payload: rest } as ReplayRecord;
}

/** The seq one record step away from `index`, or null at either end. */
export function stepSeq(pin: PinnedReplay, index: number, delta: number): number | null {
  if (pin.seqs.length === 0) return null;
  if (index < 0) return delta > 0 ? pin.seqs[0]! : null;
  const next = index + Math.sign(delta);
  return next < 0 || next >= pin.seqs.length ? null : pin.seqs[next]!;
}

function lastIndexAtOrBelow(seqs: number[], seq: number): number {
  let low = 0;
  let high = seqs.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (seqs[mid]! <= seq) {
      found = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  return found;
}

/** View rows for a reduced state, keyed by full refs within the pinned dataset. */
export function rowsFromReplayState(state: ReplayState, scope: Pick<SnapshotRef, "datasetId">): ReplayRows {
  const traces: TraceRow[] = [];
  const spans: SpanRow[] = [];
  for (const trace of Object.values(state.traces)) {
    const recorded = Object.values(trace.spans).filter((span) => span.nodeId !== undefined);
    // Loss bookkeeping traces and supplement-only spans have no runtime record yet.
    if (recorded.length === 0) continue;
    const base = { datasetId: scope.datasetId, projectId: trace.projectId, sessionId: trace.sessionId };
    const errored = new Set(trace.errors.map((error) => error.spanId));
    traces.push({
      ...base,
      traceId: trace.traceId,
      status: errored.size > 0 ? "errored" : recorded.every(isCompleted) ? "complete" : "running",
      startedAt: trace.firstSeq,
      spanCount: recorded.length
    });
    const byId = new Map(recorded.map((span) => [span.spanId, span]));
    for (const span of recorded) {
      const parent = span.parentSpanId ?? null;
      spans.push({
        ...base,
        traceId: trace.traceId,
        spanId: span.spanId,
        parentSpanId: parent !== null && byId.has(parent) ? parent : null,
        nodeId: span.nodeId!,
        depth: depthOf(span, byId),
        errored: errored.has(span.spanId)
      });
    }
  }
  traces.sort((left, right) => right.startedAt - left.startedAt || left.traceId.localeCompare(right.traceId));
  return { traces, spans };
}

function isCompleted(span: ReplaySpanState): boolean {
  return span.lifecycle === "completed";
}

function depthOf(span: ReplaySpanState, byId: Map<string, ReplaySpanState>): number {
  let depth = 0;
  const seen = new Set([span.spanId]);
  let parent = span.parentSpanId ?? null;
  while (parent !== null && byId.has(parent) && !seen.has(parent)) {
    seen.add(parent);
    depth += 1;
    parent = byId.get(parent)!.parentSpanId ?? null;
  }
  return depth;
}

function findSpan(state: ReplayState, ref: SpanRef): { trace: ReplayTraceState; span: ReplaySpanState } | null {
  for (const trace of Object.values(state.traces)) {
    if (trace.projectId !== ref.projectId || trace.sessionId !== ref.sessionId || trace.traceId !== ref.traceId)
      continue;
    const span = Object.values(trace.spans).find((candidate) => candidate.spanId === ref.spanId);
    if (span && span.nodeId !== undefined) return { trace, span };
  }
  return null;
}

/**
 * Detail of one span as of the cutoff. Values come only from records `<= N`: a return
 * value recorded later is `not-recorded` here, an error recorded later is absent.
 */
export function detailAtCutoff(state: ReplayState, ref: SpanRef): SpanDetail | null {
  if (ref.datasetId !== state.datasetId) return null;
  const found = findSpan(state, ref);
  if (found === null) return null;
  const { trace, span } = found;
  const payload: Record<string, unknown> = { ...(span.payload ?? {}) };
  for (const supplement of span.supplements) Object.assign(payload, supplement.payload);
  const error = trace.errors.find((candidate) => candidate.spanId === span.spanId);
  const nodeId = span.nodeId!;
  const hash = nodeId.lastIndexOf("#");
  const errorValue: DetailValue = error === undefined ? { state: "not-recorded" } : valueOf(error.message);
  return {
    datasetId: ref.datasetId,
    projectId: ref.projectId,
    sessionId: ref.sessionId,
    traceId: ref.traceId,
    spanId: ref.spanId,
    nodeId: sanitizeEvidenceText(nodeId).value,
    status: error !== undefined ? "errored" : isCompleted(span) ? "complete" : "running",
    args: valueOf(payload.args),
    ret: isCompleted(span) ? valueOf(payload.ret) : { state: "not-recorded" },
    error: errorValue,
    duration: { state: "unavailable", reason: "replay frame: no duration derived from a cutoff" },
    anchor: {
      file: sanitizeEvidenceText(hash === -1 ? nodeId : nodeId.slice(0, hash)).value,
      symbol: sanitizeEvidenceText(hash === -1 ? nodeId : nodeId.slice(hash + 1)).value,
      line: null
    },
    document: null
  };
}
