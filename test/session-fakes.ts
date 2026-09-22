/**
 * Controllable TraceSource for session tests: every read is a deferred the test settles
 * by hand, and every read records the AbortSignal it was given. The reads deliberately
 * IGNORE their signal (an abort-ignorant transport), so a test proves the session drops
 * stale answers by its own generation check, not because the fake rejected them.
 */
import type { CanonicalPageEnvelopeV2, CanonicalSpanProjectionItemV2 } from "@kosmo-callflow/protocol";
import type { ReplayRecord } from "@kosmo-callflow/replay";
import type {
  LiveDeltaBody,
  SnapshotRef,
  SourceKind,
  SourceOffers,
  SpanEvidence,
  TraceSource,
  VersionedCanonicalPage
} from "../src/source.js";
import type { SpanRef, SpanRow, TraceRow } from "../src/view-state.js";
import { FULL_OFFERS } from "./source-fake.js";

export type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  signal: AbortSignal;
};

function deferred<T>(signal: AbortSignal): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject, signal };
}

export const DS = { datasetId: "local", projectId: "p" };

export function traceRow(traceId: string, startedAt = 1, sessionId = "s-1"): TraceRow {
  return { ...DS, sessionId, traceId, status: "running", startedAt, spanCount: 1 };
}

export function spanRow(traceId: string, spanId: string, overrides: Partial<SpanRow> = {}): SpanRow {
  return {
    ...DS,
    sessionId: "s-1",
    traceId,
    spanId,
    parentSpanId: null,
    nodeId: `src/${spanId}.ts#${spanId}`,
    depth: 0,
    errored: false,
    ...overrides
  };
}

export function snapshotRef(overrides: Partial<SnapshotRef> = {}): SnapshotRef {
  return { ...DS, revision: "r1", watermark: 100, retentionEpoch: 1, snapshotId: "snap-1", ...overrides };
}

export function evidence(ref: SpanRef, text: string, snapshot = snapshotRef()): SpanEvidence {
  return {
    ref,
    nodeId: `src/${ref.spanId}.ts#${ref.spanId}`,
    status: "complete",
    args: { state: "recorded", text },
    ret: { state: "not-recorded" },
    error: { state: "not-recorded" },
    duration: { state: "unavailable", reason: "none" },
    anchor: null,
    snapshot
  };
}

export type LiveFakeOptions = {
  kind?: SourceKind;
  offers?: Partial<SourceOffers>;
  /** Traces each `open()` returns, in order; the last one repeats. */
  opens?: Array<{ snapshot?: Partial<SnapshotRef>; traces: TraceRow[] }>;
  records?: ReplayRecord[];
  canonical?: (ref: SpanRef) => VersionedCanonicalPage;
};

export function liveFake(options: LiveFakeOptions = {}) {
  const opens = options.opens ?? [{ traces: [traceRow("t-1")] }];
  const deltaCalls: Array<Deferred<LiveDeltaBody> & { cursor: string }> = [];
  const detailCalls: Array<Deferred<SpanEvidence> & { ref: SpanRef }> = [];
  const log: string[] = [];
  let openCount = 0;
  let closes = 0;
  const source: TraceSource = {
    kind: options.kind ?? "live",
    async open(signal) {
      const spec = opens[Math.min(openCount, opens.length - 1)]!;
      openCount += 1;
      log.push(`open ${openCount}`);
      signal.throwIfAborted();
      const items = spec.traces;
      return {
        snapshot: snapshotRef({ snapshotId: `snap-${openCount}`, ...spec.snapshot }),
        offers: { ...FULL_OFFERS, ...options.offers },
        firstPage: {
          items,
          coverage: { scope: "complete", loaded: items.length, total: items.length },
          truncated: false,
          cursor: null
        },
        stableDataset: true,
        deltaCursor: `cursor-${openCount}`
      };
    },
    async traces() {
      return { items: [], coverage: { scope: "complete", loaded: 0, total: 0 }, truncated: false, cursor: null };
    },
    details(_snapshot, ref, signal) {
      const call = { ...deferred<SpanEvidence>(signal), ref };
      detailCalls.push(call);
      log.push(`details ${ref.spanId}`);
      return call.promise;
    },
    deltas(cursor, signal) {
      const call = { ...deferred<LiveDeltaBody>(signal), cursor };
      deltaCalls.push(call);
      return call.promise;
    },
    async records(_snapshot, _selection, pageOptions) {
      const all = options.records ?? [];
      const start = pageOptions.cursor ? Number(pageOptions.cursor) : 0;
      const items = all.slice(start, start + pageOptions.limit);
      const end = start + items.length;
      return {
        items,
        coverage: { scope: end < all.length ? "partial" : "complete", loaded: end, total: all.length },
        truncated: end < all.length,
        cursor: end < all.length ? String(end) : null
      };
    },
    async close() {
      closes += 1;
    }
  };
  if (options.canonical) {
    const build = options.canonical;
    source.canonical = async (_snapshot, selection) => {
      if (selection.kind !== "span") throw new Error("span selection expected");
      return build(selection.ref);
    };
  }
  return {
    source,
    deltaCalls,
    detailCalls,
    log,
    opens: () => openCount,
    closes: () => closes
  };
}

export function deltaBody(overrides: Partial<LiveDeltaBody> = {}): LiveDeltaBody {
  return {
    cursor: "next",
    snapshot: snapshotRef(),
    traces: [],
    spans: [],
    dropped: [],
    gap: false,
    reset: false,
    ...overrides
  };
}

export function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

/** Let queued promise callbacks run (the fake timers do not advance anything here). */
export async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

// ---- canonical v2 fixtures (shape from kosmo-callflow tests/support/connect-v2-fixtures.ts)

export function canonicalSpanV2(
  ref: SpanRef,
  overrides: Partial<CanonicalSpanProjectionItemV2> = {}
): CanonicalSpanProjectionItemV2 {
  return {
    kind: "span",
    id: `span-${ref.traceId}-${ref.spanId}`,
    span: { ...ref },
    spanKind: "function",
    node: {
      datasetId: ref.datasetId,
      projectId: ref.projectId,
      graphRevision: "g",
      nodeId: `src/${ref.spanId}.ts#${ref.spanId}`,
      displayName: ref.spanId,
      location: { file: `src/${ref.spanId}.ts`, line: 3, column: 1 },
      identityConfidence: "runtime"
    },
    runtime: "node",
    serviceName: "api",
    lifecycle: "complete",
    sequence: { firstSeq: 1, lastSeq: 2 },
    parent: { state: "root" },
    causalLinks: [],
    provenance: { runtime: "node", source: "live", firstSeq: 1, lastSeq: 2 },
    coverage: { states: ["full"] },
    framework: { state: "not-recorded", reason: "no-framework-metadata" },
    lifecycleIssues: [],
    args: { state: "recorded", value: ["x"] },
    ret: { state: "recorded", value: null },
    error: { state: "not-recorded", reason: "no-error-event" },
    duration: { state: "recorded", ms: 4, source: "recorded-duration", domain: "monotonic" },
    ...overrides
  } as CanonicalSpanProjectionItemV2;
}

export function canonicalPageV2(items: CanonicalPageEnvelopeV2["items"], traceId = "t-1"): CanonicalPageEnvelopeV2 {
  return {
    projectionVersion: 2,
    dataset: {
      datasetId: "local",
      projectId: "p",
      source: "live",
      graphRevision: "g",
      watermarkSeq: 5,
      retentionEpoch: 1
    },
    selection: { traceId },
    order: "causal",
    items,
    coverage: { states: ["full"] },
    truncated: false
  } as CanonicalPageEnvelopeV2;
}
