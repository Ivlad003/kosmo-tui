/**
 * A tiny in-memory TraceSource for tests. It pages traces with the shared opaque cursor
 * helpers, so a cursor from another fake, snapshot, filter or epoch is rejected the
 * same way a real source rejects it. Optional reads are implemented only when asked.
 */
import {
  decodeCursor,
  encodeCursor,
  type CursorBinding,
  type PageFilter,
  type PageOptions,
  type ReplayPage,
  type SnapshotRef,
  type SourceKind,
  type SourceOffers,
  type SourceOpenResult,
  type TracePage,
  type TraceSource
} from "../src/source.js";
import type { TraceRow } from "../src/view-state.js";

export const FULL_OFFERS: SourceOffers = {
  projectionVersions: [1, 2],
  follow: { available: true },
  replay: { available: true },
  values: { level: "full" },
  probes: { available: true },
  staticGraph: { available: true },
  sql: { available: true }
};

export type FakeSourceOptions = {
  kind?: SourceKind;
  sourceId?: string;
  snapshot?: Partial<SnapshotRef>;
  offers?: Partial<SourceOffers>;
  traces?: TraceRow[];
  pageSize?: number;
  /** Which optional reads exist; omitted means none. */
  implement?: Partial<Record<"canonical" | "details" | "records" | "probes" | "deltas", boolean>>;
};

export type FakeSource = TraceSource & { closeCalls(): number; sourceId: string };

export function createFakeSource(options: FakeSourceOptions = {}): FakeSource {
  const kind = options.kind ?? "export";
  const sourceId = options.sourceId ?? `fake:${kind}`;
  const snapshot: SnapshotRef = {
    datasetId: "local",
    projectId: "p",
    revision: "r1",
    watermark: 10,
    retentionEpoch: 1,
    snapshotId: "snap-1",
    ...options.snapshot
  };
  const offers: SourceOffers = { ...FULL_OFFERS, ...options.offers };
  const traces = options.traces ?? [];
  const pageSize = options.pageSize ?? 50;
  let closes = 0;

  const binding = (snap: SnapshotRef, filter: PageFilter): CursorBinding => ({
    sourceId,
    snapshotId: snap.snapshotId,
    retentionEpoch: snap.retentionEpoch,
    projectionVersion: null,
    filter
  });

  function page(snap: SnapshotRef, opts: PageOptions): TracePage {
    const filter = opts.filter ?? {};
    const matching = traces.filter((row) => !filter.errorsOnly || row.status === "errored");
    let start = 0;
    if (opts.cursor) {
      const decoded = decodeCursor(opts.cursor, binding(snap, filter));
      if (!decoded.ok) throw new Error(`cursor rejected: ${decoded.reason}`);
      start = Number(decoded.position);
    }
    const limit = Math.min(opts.limit, pageSize);
    const items = matching.slice(start, start + limit);
    const end = start + items.length;
    const more = end < matching.length;
    return {
      items,
      coverage: { scope: more ? "partial" : "complete", loaded: end, total: matching.length },
      truncated: more,
      cursor: more ? encodeCursor(binding(snap, filter), String(end)) : null
    };
  }

  const source: FakeSource = {
    kind,
    sourceId,
    async open(signal): Promise<SourceOpenResult> {
      signal.throwIfAborted();
      return { snapshot, offers, firstPage: page(snapshot, { limit: pageSize }), stableDataset: kind !== "stream" };
    },
    async traces(snap, opts, signal) {
      signal.throwIfAborted();
      return page(snap, opts);
    },
    async close() {
      closes += 1;
    },
    closeCalls: () => closes
  };
  const implement = options.implement ?? {};
  if (implement.records) {
    source.records = async (): Promise<ReplayPage> => ({
      items: [],
      coverage: { scope: "complete", loaded: 0, total: 0 },
      truncated: false,
      cursor: null
    });
  }
  if (implement.canonical) source.canonical = async () => Promise.reject(new Error("fake: no canonical data"));
  if (implement.details) source.details = async () => Promise.reject(new Error("fake: no details"));
  if (implement.probes) {
    source.probes = async () => ({
      items: [],
      coverage: { scope: "complete", loaded: 0, total: 0 },
      truncated: false,
      cursor: null
    });
  }
  if (implement.deltas) source.deltas = async () => Promise.reject(new Error("fake: no deltas"));
  return source;
}
