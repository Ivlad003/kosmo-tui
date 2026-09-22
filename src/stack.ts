/**
 * The recorded ancestor chain of a span (the "stack" pane, design D6).
 *
 * This is the chain of recorded parent edges, never a live JavaScript stack. Parents are
 * resolved by full ref inside the same `(dataset, project, session, trace)`: the same
 * spanId in another session is a different span and is never linked. The walk stops
 * with an explicit marker on anything it cannot prove: a parent that is not loaded
 * (aged out of retention or never loaded), a parent with conflicting records, a cycle,
 * or the depth guard. Coverage is `complete` only when the walk reached a recorded root.
 */

import { spanKey, spanRefOf, type SpanRef, type SpanRow } from "./view-state.js";

export const DEFAULT_STACK_DEPTH = 256;

export type StackStop =
  | { kind: "root" }
  | { kind: "unknown"; parent: SpanRef; reason: "retention" | "not-loaded" }
  | { kind: "ambiguous"; parent: SpanRef; candidates: number }
  | { kind: "cycle"; at: SpanRef }
  | { kind: "depth-limit"; limit: number };

export type AncestorChain = {
  target: SpanRef;
  /** The target first, then each recorded parent up to where the walk stopped. */
  frames: SpanRow[];
  stop: StackStop;
  coverage: "complete" | "partial";
};

export type StackOptions = {
  maxDepth?: number;
  /** True when retention dropped data from this view, so a missing parent is attributed to it. */
  retentionGap?: boolean;
};

/**
 * Build the chain for `target`. `targetRow` stands in for a target that is itself no
 * longer loaded (a pinned, evicted selection); without either, there is no chain.
 */
export function ancestorChain(
  spans: readonly SpanRow[],
  target: SpanRef,
  options: StackOptions = {},
  targetRow: SpanRow | null = null
): AncestorChain | null {
  const byKey = new Map<string, SpanRow[]>();
  for (const row of spans) {
    const key = spanKey(row);
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }
  const limit = Math.max(1, options.maxDepth ?? DEFAULT_STACK_DEPTH);
  const start = pick(byKey.get(spanKey(target))) ?? targetRow;
  if (!start) return null;

  const frames: SpanRow[] = [start];
  const seen = new Set<string>([spanKey(start)]);
  let current = start;
  for (;;) {
    if (current.parentSpanId === null) return done(target, frames, { kind: "root" });
    const parent: SpanRef = spanRefOf({ ...current, spanId: current.parentSpanId });
    const key = spanKey(parent);
    if (seen.has(key)) return done(target, frames, { kind: "cycle", at: parent });
    const candidates = byKey.get(key) ?? [];
    if (candidates.length === 0) {
      return done(target, frames, {
        kind: "unknown",
        parent,
        reason: options.retentionGap ? "retention" : "not-loaded"
      });
    }
    const row = pick(candidates);
    if (!row) return done(target, frames, { kind: "ambiguous", parent, candidates: candidates.length });
    if (frames.length >= limit) return done(target, frames, { kind: "depth-limit", limit });
    frames.push(row);
    seen.add(key);
    current = row;
  }
}

/**
 * One row for a key, or null when the loaded records disagree about the span's own
 * parent edge: guessing between them would invent a chain.
 */
function pick(rows: SpanRow[] | undefined): SpanRow | null {
  if (!rows || rows.length === 0) return null;
  const first = rows[0]!;
  return rows.every((row) => row.parentSpanId === first.parentSpanId) ? first : null;
}

function done(target: SpanRef, frames: SpanRow[], stop: StackStop): AncestorChain {
  return { target: spanRefOf(target), frames, stop, coverage: stop.kind === "root" ? "complete" : "partial" };
}

/** Plain-text description of where the walk stopped, for the stack pane. */
export function stopText(stop: StackStop): string {
  switch (stop.kind) {
    case "root":
      return "root reached (coverage complete)";
    case "unknown":
      return stop.reason === "retention"
        ? `parent ${stop.parent.spanId} unknown(retention) (coverage partial)`
        : `parent ${stop.parent.spanId} unknown(not-loaded) (coverage partial)`;
    case "ambiguous":
      return `parent ${stop.parent.spanId} ambiguous (${stop.candidates} conflicting records; coverage partial)`;
    case "cycle":
      return `cycle at ${stop.at.spanId} (walk stopped; coverage partial)`;
    case "depth-limit":
      return `depth guard ${stop.limit} reached (coverage partial)`;
  }
}
