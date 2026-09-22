/**
 * Replay of recorded projection states, ported from kosmo-callflow
 * `packages/cli/src/connect/replay.ts` (task 27.5 there). `buildReplayTimeline` stays a
 * TUI module (design D11); keys and reducer versioning come from `@kosmo-callflow/replay`.
 *
 * The clock contract this file implements is written out in `replay-clock.md` next to
 * it; the short version, which nothing here may contradict:
 *
 *  - A clock domain is `(sessionId, clock.domain)`. A monotonic reading means nothing
 *    outside its own session; a wall reading is comparable across sessions only up to
 *    unquantified skew, and we have no measurement of that skew.
 *  - `seq` is the order of OBSERVATION. It is not a duration and not causality, so a
 *    difference between two seqs is never rendered as a time.
 *  - A hole in the seq numbers is not a missing frame — other traces and sessions own
 *    those seqs. Only a seq the recording itself declares (a trace's firstSeq/lastSeq)
 *    can be "missing", and when it is, it is reported rather than skipped.
 *  - `--speed` is a source-clock multiplier and needs an aligned timeline. Unaligned or
 *    clock-free recordings fall back to fixed-interval stepping and SAY SO, instead of
 *    inventing an alignment.
 *  - Aggregate records describe a window, not an order of calls, so a timeline holding
 *    them replays window-to-window and reports per-call ordering as unavailable.
 */

import { parseDurationMs } from "./duration.js";
import { spanRowsFromEvents, type DatasetScope, type TraceEventView } from "./detail.js";
import { replayTraceKey as traceKey } from "@kosmo-callflow/replay";
import type { SpanRow, TraceRow } from "./view-state.js";

/** Inclusive, per the spec's `0.1..10`. */
export const REPLAY_SPEED_MIN = 0.1;
export const REPLAY_SPEED_MAX = 10;

/**
 * The cadence replay uses when it cannot honour the source clock, and the default for
 * `--step-interval`. Like the 250ms redraw target this is a PROPOSED default pending
 * calibration; it is not a latency guarantee and nothing may read it as one.
 */
export const REPLAY_PROPOSED_STEP_MS = 250;

export const REPLAY_STEP_MIN_MS = 16;
export const REPLAY_STEP_MAX_MS = 60_000;

export type ReplayArgError = { code: "INVALID_ARGUMENT"; message: string };
export type ReplayParse<T> = { ok: true; value: T } | { ok: false; error: ReplayArgError };

function invalid(message: string): { ok: false; error: ReplayArgError } {
  return { ok: false, error: { code: "INVALID_ARGUMENT", message } };
}

/**
 * Parse `--speed`.
 *
 * `Number("")` is 0 and `Number(" ")` is 0, so the text is screened before it is
 * converted; NaN and Infinity are rejected explicitly rather than left to fail the
 * range comparison, because `NaN < min` is false and would otherwise pass.
 */
export function parseReplaySpeed(raw: string): ReplayParse<number> {
  const text = raw.trim();
  const outOfRange = `connect --replay --speed must be a source-clock multiplier in the inclusive range ${REPLAY_SPEED_MIN}..${REPLAY_SPEED_MAX}, received ${raw}`;
  if (text.length === 0 || !/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(text)) return invalid(outOfRange);
  const speed = Number(text);
  if (!Number.isFinite(speed)) return invalid(outOfRange);
  if (speed < REPLAY_SPEED_MIN || speed > REPLAY_SPEED_MAX) return invalid(outOfRange);
  return { ok: true, value: speed };
}

/** Parse `--step-interval`; a separate mode from `--speed`, never a synonym for it. */
export function parseReplayStepInterval(raw: string): ReplayParse<number> {
  const ms = parseDurationMs(raw, REPLAY_STEP_MIN_MS, REPLAY_STEP_MAX_MS);
  if (ms === undefined) {
    return invalid(
      `connect --replay --step-interval must be a duration between ${REPLAY_STEP_MIN_MS}ms and ${REPLAY_STEP_MAX_MS / 1_000}s, received ${raw}`
    );
  }
  return { ok: true, value: ms };
}

/** `(sessionId, clock.domain)`; null when the frame carries no source-clock reading. */
export type ClockDomainId = string;

export type ClockReading = { domain: "monotonic" | "wall"; value: number };

export type ReplayGranularity = "per-call" | "aggregate-window";

export type ReplayFrameInput = {
  seq: number;
  sessionId: string;
  localSeq?: number;
  /** The SDK's source clock for this record, when it recorded one. */
  clock?: ClockReading | null;
  granularity?: ReplayGranularity;
  /** The recorded projection state AT this frame; stepping back re-shows it verbatim. */
  state: { traces: TraceRow[]; spans: SpanRow[] };
};

export type ReplayFrame = ReplayFrameInput & {
  clockDomain: ClockDomainId | null;
  granularity: ReplayGranularity;
};

export type ReplayAlignment = { kind: "aligned"; domain: ClockDomainId } | { kind: "unaligned"; reason: string };

export type ReplayTimeline = {
  frames: ReplayFrame[];
  /** Declared seqs the recording does not actually hold. Reported, never skipped. */
  missingSeqs: number[];
  alignment: ReplayAlignment;
  /** True when any frame is an aggregate window: window-level replay only. */
  windowOnly: boolean;
};

export function clockDomainOf(frame: ReplayFrameInput): ClockDomainId | null {
  return frame.clock ? `${frame.sessionId}:${frame.clock.domain}` : null;
}

/**
 * Build the timeline.
 *
 * `requestedSeqs` are seqs the RECORDING declares (a trace projection's firstSeq and
 * lastSeq). Anything declared and absent is a real hole and is reported. Seqs that are
 * merely not present between two frames are NOT holes: seq is observation order across
 * every session, so numeric gaps are the normal case.
 */
export function buildReplayTimeline(input: { frames: ReplayFrameInput[]; requestedSeqs?: number[] }): ReplayTimeline {
  const frames: ReplayFrame[] = input.frames
    .map((frame) => ({
      ...frame,
      clockDomain: clockDomainOf(frame),
      granularity: frame.granularity ?? "per-call"
    }))
    // Observation order, with a deterministic tie-break for datasets that merged two
    // sources and can therefore repeat a seq.
    .sort(
      (left, right) =>
        left.seq - right.seq ||
        left.sessionId.localeCompare(right.sessionId) ||
        (left.localSeq ?? 0) - (right.localSeq ?? 0)
    );

  const present = new Set(frames.map((frame) => frame.seq));
  const missingSeqs = [...new Set(input.requestedSeqs ?? [])].filter((seq) => !present.has(seq)).sort((a, b) => a - b);

  return {
    frames,
    missingSeqs,
    alignment: alignmentOf(frames),
    windowOnly: frames.some((frame) => frame.granularity === "aggregate-window")
  };
}

function alignmentOf(frames: ReplayFrame[]): ReplayAlignment {
  if (frames.length === 0) return { kind: "unaligned", reason: "no recorded frames" };
  const withoutClock = frames.filter((frame) => frame.clockDomain === null);
  if (withoutClock.length > 0) {
    return { kind: "unaligned", reason: "recording has no source clock readings" };
  }
  const domains = new Set(frames.map((frame) => frame.clockDomain!));
  if (domains.size > 1) {
    // Q20: cross-session speed promises nothing without clock alignment, and we hold no
    // skew measurement, so we refuse to pretend these are one clock.
    return { kind: "unaligned", reason: `unsynced clock domains: ${[...domains].sort().join(", ")}` };
  }
  return { kind: "aligned", domain: [...domains][0]! };
}

export type ReplaySchedule =
  | { mode: "manual" }
  | { mode: "step-interval"; intervalMs: number }
  | { mode: "speed"; speed: number; delaysMs: number[] }
  | { mode: "speed-fallback"; speed: number; intervalMs: number; reason: string };

/**
 * Turn the flags plus the timeline into a cadence.
 *
 * `speed` and `stepIntervalMs` never arrive together — the command rejects that pair as
 * INVALID_ARGUMENT before any of this runs — so the order of the branches below is not
 * a silent precedence rule.
 */
export function planReplaySchedule(
  timeline: ReplayTimeline,
  options: { speed?: number; stepIntervalMs?: number }
): ReplaySchedule {
  if (options.stepIntervalMs !== undefined) {
    return { mode: "step-interval", intervalMs: options.stepIntervalMs };
  }
  if (options.speed === undefined) return { mode: "manual" };
  if (timeline.alignment.kind === "unaligned") {
    return {
      mode: "speed-fallback",
      speed: options.speed,
      intervalMs: REPLAY_PROPOSED_STEP_MS,
      reason: timeline.alignment.reason
    };
  }
  const delaysMs = timeline.frames.map((frame, index) => {
    if (index === 0) return 0;
    const previous = timeline.frames[index - 1]!;
    const elapsed = frame.clock!.value - previous.clock!.value;
    // A non-increasing reading within one domain is a recording defect, not a negative
    // duration; it becomes 0 delay rather than a time-travelling schedule.
    return elapsed <= 0 ? 0 : elapsed / options.speed!;
  });
  return { mode: "speed", speed: options.speed, delaysMs };
}

/** Clamp a step to the recorded range; there is no wrap-around and no jump to live. */
export function stepIndex(timeline: ReplayTimeline, index: number, delta: number): number {
  if (timeline.frames.length === 0) return -1;
  const next = index + delta;
  if (next < 0) return 0;
  if (next > timeline.frames.length - 1) return timeline.frames.length - 1;
  return next;
}

/**
 * Fold recorded events into one cumulative projection state per event.
 *
 * Each frame holds the WHOLE state as of that seq rather than a delta, because stepping
 * back has to show exactly what was recorded and a delta stream is not invertible.
 */
export function framesFromEvents(events: TraceEventView[], scope: DatasetScope): ReplayFrameInput[] {
  // Same tie-break as buildReplayTimeline: session before span, so a merged dataset that
  // repeats a seq across sessions folds in one deterministic order.
  const ordered = [...events].sort(
    (left, right) =>
      left.seq - right.seq || left.sessionId.localeCompare(right.sessionId) || left.spanId.localeCompare(right.spanId)
  );
  const seen: TraceEventView[] = [];
  const frames: ReplayFrameInput[] = [];
  for (const event of ordered) {
    seen.push(event);
    frames.push({
      seq: event.seq,
      sessionId: event.sessionId,
      ...(event.clock ? { clock: event.clock } : {}),
      granularity: event.capture?.mode === "aggregate" ? "aggregate-window" : "per-call",
      state: { traces: traceRowsFromEvents(seen, scope), spans: spanRowsFromEvents(seen, scope) }
    });
  }
  return frames;
}

/**
 * The trace list as of the events seen so far, one row per full trace ref: the same
 * traceId recorded by two sessions is two rows.
 *
 * `startedAt` carries the trace's first observed seq, matching how the live path orders
 * the list. It is an observation ordinal, not a timestamp, and nothing renders it as one.
 */
export function traceRowsFromEvents(events: TraceEventView[], scope: DatasetScope): TraceRow[] {
  const byTrace = new Map<
    string,
    { sessionId: string; traceId: string; firstSeq: number; spans: Set<string>; errored: boolean; exited: boolean }
  >();
  for (const event of events) {
    const key = traceKey({ ...scope, sessionId: event.sessionId, traceId: event.traceId });
    const entry = byTrace.get(key) ?? {
      sessionId: event.sessionId,
      traceId: event.traceId,
      firstSeq: event.seq,
      spans: new Set<string>(),
      errored: false,
      exited: false
    };
    entry.firstSeq = Math.min(entry.firstSeq, event.seq);
    entry.spans.add(event.spanId);
    if (event.type === "error") entry.errored = true;
    if (event.type === "exit") entry.exited = true;
    byTrace.set(key, entry);
  }
  return [...byTrace.values()]
    .map((entry) => ({
      datasetId: scope.datasetId,
      projectId: scope.projectId,
      sessionId: entry.sessionId,
      traceId: entry.traceId,
      status: (entry.errored ? "errored" : entry.exited ? "complete" : "running") as TraceRow["status"],
      startedAt: entry.firstSeq,
      spanCount: entry.spans.size
    }))
    .sort(
      (left, right) =>
        right.startedAt - left.startedAt ||
        left.traceId.localeCompare(right.traceId) ||
        traceKey(left).localeCompare(traceKey(right))
    );
}
