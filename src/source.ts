/**
 * The `TraceSource` boundary contract (design D4). Types only, plus the opaque cursor
 * helpers every source shares; the live/sqlite/export/stream implementations live in
 * their own `source-*.ts` modules.
 *
 * A source is opened once and reports what it can actually read (`SourceOffers`); the
 * source kind is only an upper bound, and capabilities.ts turns the open result plus
 * the session policy into the effective capabilities the UI uses. Every page is bound
 * to one pinned `SnapshotRef` and says how much of the dataset it covers; a cursor from
 * one source, snapshot, filter or retention epoch is never accepted by another.
 */

import type { CanonicalPageEnvelope, CanonicalPageEnvelopeV2 } from "@kosmo-callflow/protocol";
import type { ReplayRecord } from "@kosmo-callflow/replay";
import type { DetailAnchor, DetailDuration, DetailValue, SpanRef, SpanRow, TraceRef, TraceRow } from "./view-state.js";

export type SourceKind = "live" | "sqlite" | "export" | "stream";

/** Canonical projection versions a source may serve. */
export type ProjectionVersion = 1 | 2;

/**
 * One pinned read of a dataset. `revision` and `watermark` say which writes it includes;
 * `retentionEpoch` changes whenever retention drops data out from under earlier pages.
 * `snapshotId` names this exact read so a load-more cannot silently mix revisions.
 */
export type SnapshotRef = {
  datasetId: string;
  projectId: string;
  revision: string;
  watermark: number | null;
  retentionEpoch: number;
  snapshotId: string;
};

/** Full span identity `(datasetId, projectId, sessionId, traceId, spanId)`. */
export type QualifiedSpanRef = SpanRef;
export type QualifiedTraceRef = TraceRef;

/**
 * How much of the requested scope a page covers. `total` is null when the source cannot
 * count without reading everything; `reason` explains a partial page.
 */
export type Coverage = {
  scope: "complete" | "partial";
  loaded: number;
  total: number | null;
  reason?: string;
};

/** Filters a source may apply server-side; also part of the cursor binding. */
export type PageFilter = {
  errorsOnly?: boolean;
  nodeId?: string;
  spanKind?: string;
  search?: string;
};

export type PageOptions = {
  limit: number;
  /** Opaque cursor from a previous page of the same snapshot and filter; null starts over. */
  cursor?: string | null;
  filter?: PageFilter;
};

export type Page<T> = {
  items: T[];
  coverage: Coverage;
  truncated: boolean;
  /** Opaque continuation, or null when there is nothing more in this snapshot. */
  cursor: string | null;
};

export type TracePage = Page<TraceRow>;
export type ReplayPage = Page<ReplayRecord>;

/** One recorded probe observation, in its own sequence domain (never runtime seq). */
export type ProbeRecord = {
  ref: QualifiedSpanRef;
  probeId: string;
  probeSeq: number;
  label: string;
  value: DetailValue;
};
export type ProbePage = Page<ProbeRecord>;

export type TraceSelection =
  | { kind: "trace"; ref: QualifiedTraceRef }
  | { kind: "traces"; refs: QualifiedTraceRef[] }
  | { kind: "span"; ref: QualifiedSpanRef };

export type ProjectionOptions = {
  version: ProjectionVersion;
  depth?: "module" | "function" | "call";
  detail?: 0 | 1 | 2;
  values?: boolean;
};

export type VersionedCanonicalPage =
  | ({ version: 1; envelope: CanonicalPageEnvelope } & Omit<Page<never>, "items">)
  | ({ version: 2; envelope: CanonicalPageEnvelopeV2 } & Omit<Page<never>, "items">);

/** Typed evidence for one span; every missing value carries its own marker. */
export type SpanEvidence = {
  ref: QualifiedSpanRef;
  nodeId: string;
  status: TraceRow["status"];
  args: DetailValue;
  ret: DetailValue;
  error: DetailValue;
  duration: DetailDuration;
  anchor: DetailAnchor | null;
  snapshot: SnapshotRef;
};

/**
 * One live delta response. `reset` means the epoch changed (409): the caller replaces
 * its baseline and records `gap` rather than appending.
 */
export type LiveDeltaBody = {
  cursor: string;
  snapshot: SnapshotRef;
  traces: TraceRow[];
  spans: SpanRow[];
  dropped: QualifiedTraceRef[];
  gap: boolean;
  reset: boolean;
};

/** A read the source can or cannot offer, with the reason when it cannot. */
export type Offer = { available: true } | { available: false; reason: string };

/**
 * What the opened source can read. `values.level` is a promise about reading, never
 * about content: `count` means only call counts were recorded, so no payload exists.
 */
export type SourceOffers = {
  /** Empty when only summaries exist (v1 NDJSON). */
  projectionVersions: ProjectionVersion[];
  projectionReason?: string;
  follow: Offer;
  replay: Offer;
  values: { level: "full" | "count" | "none"; reason?: string };
  probes: Offer;
  staticGraph: Offer;
  sql: Offer;
};

export type SourceOpenResult = {
  snapshot: SnapshotRef;
  offers: SourceOffers;
  firstPage: TracePage;
  /** False for sources without a stable dataset identity: those never auto-resume reviews. */
  stableDataset: boolean;
};

export interface TraceSource {
  readonly kind: SourceKind;
  open(signal: AbortSignal): Promise<SourceOpenResult>;
  traces(snapshot: SnapshotRef, options: PageOptions, signal: AbortSignal): Promise<TracePage>;
  canonical?(
    snapshot: SnapshotRef,
    selection: TraceSelection,
    options: ProjectionOptions,
    signal: AbortSignal
  ): Promise<VersionedCanonicalPage>;
  details?(snapshot: SnapshotRef, ref: QualifiedSpanRef, signal: AbortSignal): Promise<SpanEvidence>;
  records?(
    snapshot: SnapshotRef,
    selection: TraceSelection,
    options: PageOptions,
    signal: AbortSignal
  ): Promise<ReplayPage>;
  probes?(
    snapshot: SnapshotRef,
    selection: TraceSelection,
    options: PageOptions,
    signal: AbortSignal
  ): Promise<ProbePage>;
  deltas?(cursor: string, signal: AbortSignal): Promise<LiveDeltaBody>;
  close(): Promise<void>;
}

/** What a cursor is valid for. Any mismatch makes the cursor foreign. */
export type CursorBinding = {
  /** Identity of the opened source instance (kind + target), not just its kind. */
  sourceId: string;
  snapshotId: string;
  retentionEpoch: number;
  projectionVersion: ProjectionVersion | null;
  filter: PageFilter;
};

export type CursorRejection =
  "malformed" | "foreign-source" | "snapshot-changed" | "epoch-changed" | "version-changed" | "filter-changed";

export type CursorDecode = { ok: true; position: string } | { ok: false; reason: CursorRejection };

type CursorBody = {
  v: 1;
  src: string;
  snap: string;
  epoch: number;
  pv: ProjectionVersion | null;
  filter: string;
  pos: string;
};

/** Stable text of a filter: key order and absent-vs-undefined do not matter. */
export function filterKey(filter: PageFilter): string {
  const entries = Object.entries(filter)
    .filter(([, value]) => value !== undefined && value !== false && value !== "")
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries);
}

export function encodeCursor(binding: CursorBinding, position: string): string {
  const body: CursorBody = {
    v: 1,
    src: binding.sourceId,
    snap: binding.snapshotId,
    epoch: binding.retentionEpoch,
    pv: binding.projectionVersion,
    filter: filterKey(binding.filter),
    pos: position
  };
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

/**
 * Accept a cursor only for exactly the binding it was issued under. The checks run from
 * the broadest mismatch to the narrowest so the reason names the real cause.
 */
export function decodeCursor(cursor: string, binding: CursorBinding): CursorDecode {
  let body: Partial<CursorBody>;
  try {
    body = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorBody>;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (body === null || typeof body !== "object" || body.v !== 1 || typeof body.pos !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (body.src !== binding.sourceId) return { ok: false, reason: "foreign-source" };
  if (body.epoch !== binding.retentionEpoch) return { ok: false, reason: "epoch-changed" };
  if (body.snap !== binding.snapshotId) return { ok: false, reason: "snapshot-changed" };
  if ((body.pv ?? null) !== binding.projectionVersion) return { ok: false, reason: "version-changed" };
  if (body.filter !== filterKey(binding.filter)) return { ok: false, reason: "filter-changed" };
  return { ok: true, position: body.pos };
}
