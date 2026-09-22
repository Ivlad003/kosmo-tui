/**
 * The SQLite source (task 4.4, design D4 "SQLite"; tui-debugger "Узгоджений offline
 * snapshot").
 *
 * The file is a daemon `events.sqlite` read offline. All reading goes through the shared
 * `readSqliteDatasetSnapshot` of `@kosmo-callflow/query/sqlite`: driver-native read-only
 * open (never created, migrated, checkpointed or opened `immutable=1`), a
 * `schema_meta.schema_version` check, and ONE short read transaction that materializes
 * the selected project into a `TraceDatasetSnapshot` before the handle is closed. No read
 * lock is held while the viewer is open, so the daemon keeps writing.
 *
 * The snapshot is static: no polling, no follow. Every page, canonical projection
 * (the same pure `projectCanonicalPage` the daemon uses), detail, replay page and probe
 * page is served from that one pinned snapshot. Reading anything newer is an explicit
 * `reload()`, which produces a new snapshot identity; a cursor or snapshot ref from the
 * old read is then refused (`snapshot-changed`) instead of silently mixing revisions.
 *
 * Every failure is explicit: a missing driver is `unavailable(sqlite-driver)` with an
 * install hint, and the reader's `future-schema`, `busy`, `wal-unavailable`,
 * `read-only-filesystem`, `project-ambiguous`, `dataset-too-large`, ... codes are kept.
 */

import type { ReplayRecord } from "@kosmo-callflow/replay";
import { projectCanonicalPage, TraceSnapshotError, type TraceDatasetSnapshot } from "@kosmo-callflow/query/snapshot";
import {
  readSqliteDatasetSnapshot,
  SqliteSourceError,
  type ReadSqliteSnapshotOptions
} from "@kosmo-callflow/query/sqlite";
import type { TraceSqlDriver } from "@kosmo-callflow/query/sql";
import { sanitizeStructuredEvidence } from "@kosmo-callflow/trace-artifacts";
import { valueOf } from "./detail.js";
import { eventsFromExportRecords } from "./eval.js";
import { traceRowsFromEvents } from "./replay.js";
import { SourceError, canonicalPageMeta, evidenceFromCanonicalV2 } from "./source-common.js";
import {
  decodeCursor,
  encodeCursor,
  type CursorBinding,
  type Page,
  type PageFilter,
  type PageOptions,
  type ProbeRecord,
  type QualifiedTraceRef,
  type SnapshotRef,
  type SourceOffers,
  type SourceOpenResult,
  type TraceSelection,
  type TraceSource
} from "./source.js";
import { detectSqliteDriver, type SqliteDriverSelection } from "./sqlite-driver.js";
import type { DetailValue, TraceRow } from "./view-state.js";

export type SqliteSnapshotReader = (filePath: string, options: ReadSqliteSnapshotOptions) => TraceDatasetSnapshot;

export type SqliteSourceOptions = {
  path: string;
  /** Explicit project; required when the store holds several. */
  projectId?: string;
  /** Narrow the materialized scope to one trace (the answer to `dataset-too-large`). */
  traceId?: string;
  /** Injected driver selection; default is feature detection. */
  driver?: SqliteDriverSelection;
  /** Injected reader; default is the shared `readSqliteDatasetSnapshot`. */
  read?: SqliteSnapshotReader;
  busyTimeoutMs?: number;
  maxRows?: number;
  pageSize?: number;
};

export type SqliteSource = TraceSource & {
  readonly kind: "sqlite";
  readonly sourceId: string;
  /**
   * The pinned dataset snapshot the SQL and graph adapters read. With a snapshot ref,
   * it must be the current one: a stale ref is `snapshot-changed`, never the newer data.
   */
  datasetSnapshot(snapshot?: SnapshotRef): TraceDatasetSnapshot;
  /** The driver the SQL runner's child should load (the same one the reader used). */
  sqlDriver(): TraceSqlDriver | undefined;
  /** Explicitly read a NEW snapshot; earlier snapshot refs and cursors stop being valid. */
  reload(signal: AbortSignal): Promise<SourceOpenResult>;
};

/** Map a shared-reader failure to a typed source error; the reader's code is kept. */
export function sqliteSourceError(error: unknown): SourceError {
  if (error instanceof SourceError) return error;
  if (error instanceof SqliteSourceError) {
    const detail = error.reason === undefined ? error.code : `${error.code}(${error.reason})`;
    return new SourceError(error.code, `kosmo-tui: sqlite source ${detail}: ${error.message.slice(0, 500)}`);
  }
  if (error instanceof TraceSnapshotError) {
    return new SourceError(error.code, `kosmo-tui: sqlite source ${error.code}: ${error.message.slice(0, 500)}`);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new SourceError("read-failed", `kosmo-tui: sqlite source read-failed: ${message.slice(0, 500)}`);
}

type Loaded = {
  snapshot: SnapshotRef;
  dataset: TraceDatasetSnapshot;
  rows: TraceRow[];
  records: ReplayRecord[];
  sourceId: string;
};

function selectionRefs(selection: TraceSelection): QualifiedTraceRef[] {
  return selection.kind === "traces" ? selection.refs : [selection.ref];
}

function sameTrace(left: QualifiedTraceRef, right: { sessionId: string; traceId: string }): boolean {
  return left.sessionId === right.sessionId && left.traceId === right.traceId;
}

function probeValue(probe: TraceDatasetSnapshot["probes"][number]): DetailValue {
  if (probe.status === "masked" || probe.masked) return { state: "masked" };
  if (probe.status === "unavailable") return { state: "unavailable", reason: probe.reason ?? "probe-unavailable" };
  return valueOf(sanitizeStructuredEvidence(probe.value).value);
}

export function createSqliteSource(options: SqliteSourceOptions): SqliteSource {
  const pageSize = Math.max(1, Math.min(options.pageSize ?? 50, 1000));
  const read = options.read ?? readSqliteDatasetSnapshot;
  let selection: SqliteDriverSelection | undefined = options.driver;
  let loaded: Loaded | null = null;
  let closed = false;

  function driverSelection(): SqliteDriverSelection {
    selection ??= detectSqliteDriver();
    return selection;
  }

  async function load(signal: AbortSignal): Promise<Loaded> {
    if (closed) throw new SourceError("closed", "kosmo-tui: the sqlite source is closed");
    signal.throwIfAborted();
    const driver = driverSelection();
    if (!driver.ok) throw new SourceError("unavailable", driver.message);
    let dataset: TraceDatasetSnapshot;
    try {
      dataset = read(options.path, {
        driver: driver.read,
        ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
        ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
        ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
        ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows })
      });
    } catch (error) {
      throw sqliteSourceError(error);
    }
    const identity = dataset.identity;
    const snapshot: SnapshotRef = {
      datasetId: identity.datasetId,
      projectId: identity.projectId,
      revision: identity.sourceRevision ?? identity.graphRevision,
      watermark: identity.watermarkSeq,
      retentionEpoch: identity.retentionEpoch,
      snapshotId: identity.snapshotId
    };
    const runtime = dataset.records as unknown as Array<Record<string, unknown>>;
    const rows = traceRowsFromEvents(eventsFromExportRecords(runtime), {
      datasetId: identity.datasetId,
      projectId: identity.projectId
    });
    // Replay pages carry the same sanitized values every other surface shows.
    const records = runtime.map((record) => ({
      ...record,
      payload: sanitizeStructuredEvidence(record.payload ?? {}).value
    })) as unknown as ReplayRecord[];
    return { snapshot, dataset, rows, records, sourceId: `sqlite:${identity.datasetId}` };
  }

  function binding(snapshot: SnapshotRef, filter: PageFilter): CursorBinding {
    return {
      sourceId: loaded?.sourceId ?? "sqlite",
      snapshotId: snapshot.snapshotId,
      retentionEpoch: snapshot.retentionEpoch,
      projectionVersion: null,
      filter
    };
  }

  function requireLoaded(snapshot?: SnapshotRef): Loaded {
    if (loaded === null) throw new SourceError("not-open", "kosmo-tui: the sqlite source is not open");
    if (snapshot !== undefined && snapshot.snapshotId !== loaded.snapshot.snapshotId) {
      throw new SourceError(
        "snapshot-changed",
        "kosmo-tui: this snapshot is no longer the pinned SQLite read; reload shows the newer data as a new snapshot"
      );
    }
    return loaded;
  }

  function page<T>(items: T[], snapshot: SnapshotRef, pageOptions: PageOptions, extra = ""): Page<T> {
    const filter = pageOptions.filter ?? {};
    let start = 0;
    if (pageOptions.cursor) {
      const decoded = decodeCursor(pageOptions.cursor, binding(snapshot, filter));
      if (!decoded.ok) throw new SourceError("cursor-rejected", `kosmo-tui: cursor rejected (${decoded.reason})`, 400);
      const [position, key] = JSON.parse(decoded.position) as [number, string];
      if (key !== extra) throw new SourceError("cursor-rejected", "kosmo-tui: cursor rejected (filter-changed)", 400);
      start = position;
    }
    const limit = Math.max(1, Math.min(pageOptions.limit, 1000));
    const slice = items.slice(start, start + limit);
    const end = start + slice.length;
    const more = end < items.length;
    return {
      items: slice,
      coverage: { scope: more ? "partial" : "complete", loaded: end, total: items.length },
      truncated: more,
      cursor: more ? encodeCursor(binding(snapshot, filter), JSON.stringify([end, extra])) : null
    };
  }

  function openResult(state: Loaded): SourceOpenResult {
    const hasRecords = state.records.length > 0;
    const offers: SourceOffers = {
      projectionVersions: hasRecords ? [1, 2] : [],
      ...(hasRecords ? {} : { projectionReason: "no-runtime-records" }),
      follow: { available: false, reason: "static-snapshot" },
      replay: hasRecords ? { available: true } : { available: false, reason: "no-replay-records" },
      values: hasRecords ? { level: "full" } : { level: "none", reason: "no-runtime-records" },
      probes: state.dataset.probes.length > 0 ? { available: true } : { available: false, reason: "no-probe-records" },
      staticGraph: { available: false, reason: "no-static-graph-reader" },
      sql: { available: true }
    };
    return {
      snapshot: state.snapshot,
      offers,
      firstPage: page(state.rows, state.snapshot, { limit: pageSize }),
      stableDataset: true
    };
  }

  function canonicalV2(state: Loaded, traceId: string, depth?: "module" | "symbol" | "call") {
    try {
      return projectCanonicalPage(state.dataset, {
        projectionVersion: 2,
        traceId,
        maxSpans: 1000,
        ...(depth ? { depth } : {})
      });
    } catch (error) {
      throw sqliteSourceError(error);
    }
  }

  const source: SqliteSource = {
    kind: "sqlite",
    get sourceId() {
      return loaded?.sourceId ?? "sqlite";
    },

    async open(signal) {
      loaded = await load(signal);
      return openResult(loaded);
    },

    async reload(signal) {
      const next = await load(signal);
      loaded = next;
      return openResult(next);
    },

    datasetSnapshot(snapshot) {
      return requireLoaded(snapshot).dataset;
    },

    sqlDriver() {
      const driver = driverSelection();
      return driver.ok ? driver.sql : undefined;
    },

    async traces(snapshot, pageOptions, signal) {
      signal.throwIfAborted();
      const state = requireLoaded(snapshot);
      const filter = pageOptions.filter ?? {};
      const rows = state.rows.filter(
        (row) =>
          (!filter.errorsOnly || row.status === "errored") &&
          (filter.search === undefined || filter.search === "" || row.traceId.includes(filter.search))
      );
      return page(rows, snapshot, pageOptions);
    },

    async canonical(snapshot, traceSelection, projection, signal) {
      signal.throwIfAborted();
      const state = requireLoaded(snapshot);
      const refs = selectionRefs(traceSelection);
      if (refs.length !== 1) {
        throw new SourceError("unsupported-selection", "kosmo-tui: a canonical page is read for one trace at a time");
      }
      const traceId = refs[0]!.traceId;
      const depth = projection.depth === "function" ? "symbol" : projection.depth;
      if (projection.version === 2) {
        const envelope = canonicalV2(state, traceId, depth);
        return { version: 2, envelope, ...canonicalPageMeta(envelope) };
      }
      let envelope;
      try {
        envelope = projectCanonicalPage(state.dataset, {
          projectionVersion: 1,
          traceId,
          maxSpans: 1000,
          maxEvents: 1000,
          ...(depth ? { depth } : {})
        });
      } catch (error) {
        throw sqliteSourceError(error);
      }
      return { version: 1, envelope, ...canonicalPageMeta(envelope) };
    },

    async details(snapshot, ref, signal) {
      signal.throwIfAborted();
      const state = requireLoaded(snapshot);
      const evidence = evidenceFromCanonicalV2(canonicalV2(state, ref.traceId), ref, snapshot);
      if (evidence === null)
        throw new SourceError("span-not-found", "kosmo-tui: the sqlite snapshot has no such span", 404);
      return evidence;
    },

    async records(snapshot, traceSelection, pageOptions, signal) {
      signal.throwIfAborted();
      const state = requireLoaded(snapshot);
      const refs = selectionRefs(traceSelection);
      const items = state.records.filter((record) => {
        const shape = record as unknown as { sessionId: string; traceId: string; spanId: string };
        if (!refs.some((ref) => sameTrace(ref, shape))) return false;
        return traceSelection.kind !== "span" || shape.spanId === traceSelection.ref.spanId;
      });
      return page(items, snapshot, pageOptions, JSON.stringify(refs.map((ref) => [ref.sessionId, ref.traceId])));
    },

    async probes(snapshot, traceSelection, pageOptions, signal) {
      signal.throwIfAborted();
      const state = requireLoaded(snapshot);
      const refs = selectionRefs(traceSelection);
      const items: ProbeRecord[] = state.dataset.probes
        .filter((probe) => refs.some((ref) => sameTrace(ref, probe)))
        .filter((probe) => traceSelection.kind !== "span" || probe.spanId === traceSelection.ref.spanId)
        .map((probe) => ({
          ref: {
            datasetId: snapshot.datasetId,
            projectId: snapshot.projectId,
            sessionId: probe.sessionId,
            traceId: probe.traceId,
            spanId: probe.spanId
          },
          probeId: probe.probeId,
          // The probe table's own seq domain, never the runtime seq.
          probeSeq: probe.seq,
          label: probe.expression,
          value: probeValue(probe)
        }));
      return page(items, snapshot, pageOptions, JSON.stringify(refs.map((ref) => [ref.sessionId, ref.traceId])));
    },

    async close() {
      closed = true;
      loaded = null;
    }
  };
  return source;
}
