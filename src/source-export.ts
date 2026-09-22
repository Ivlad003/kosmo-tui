/**
 * The portable export source (task 4.2, design D3/D4).
 *
 * The file is size-checked BEFORE it is parsed: `stat` first, then a bounded read that
 * refuses to take more than the cap even if the file grows in between. The parsed JSON
 * goes through the shared importer (`snapshotFromPortableExport` in
 * `@kosmo-callflow/query/snapshot`, which calls `importPortableExport` from
 * `@kosmo-callflow/replay`): schema validation, export redaction and the deterministic
 * content namespace all stay there, so kosmo-tui never sees an unredacted value and
 * reopening an unchanged file keeps the same span refs. Canonical pages come from the
 * same pure `projectCanonicalPage` the daemon uses.
 *
 * Capabilities follow the content, not the source kind: replay only when the export
 * carries ordered runtime records (`unavailable(no-replay-records)` otherwise), probes
 * only when it carries probe records. An export is a static snapshot: no follow.
 */

import { open as openFile, stat as statFile } from "node:fs/promises";
import { PORTABLE_EXPORT_FORMAT_VERSION, importPortableExport, type ReplayRecord } from "@kosmo-callflow/replay";
import {
  DEFAULT_EXPORT_MAX_BYTES,
  TraceSnapshotError,
  portableExportNamespace,
  projectCanonicalPage,
  snapshotFromPortableExport,
  type TraceDatasetSnapshot
} from "@kosmo-callflow/query/snapshot";
import { valueOf } from "./detail.js";
import { eventsFromExportRecords } from "./eval.js";
import { traceRowsFromEvents } from "./replay.js";
import { SourceError, canonicalPageMeta, evidenceFromCanonicalV2 } from "./source-common.js";
import {
  decodeCursor,
  encodeCursor,
  type CursorBinding,
  type PageFilter,
  type Page,
  type PageOptions,
  type ProbeRecord,
  type QualifiedTraceRef,
  type SnapshotRef,
  type SourceOffers,
  type SourceOpenResult,
  type TraceSelection,
  type TraceSource
} from "./source.js";
import type { DetailValue, TraceRow } from "./view-state.js";

export const EXPORT_MAX_BYTES = DEFAULT_EXPORT_MAX_BYTES;

/** Read-only file port: size first, then at most `maxBytes + 1` bytes. */
export type ExportFs = {
  size(filePath: string): Promise<number>;
  readBounded(filePath: string, maxBytes: number): Promise<Uint8Array>;
};

export const defaultExportFs: ExportFs = {
  async size(filePath) {
    return (await statFile(filePath)).size;
  },
  async readBounded(filePath, maxBytes) {
    const handle = await openFile(filePath, "r");
    try {
      const buffer = new Uint8Array(maxBytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return buffer.subarray(0, offset);
    } finally {
      await handle.close();
    }
  }
};

export type ExportSourceOptions = {
  path: string;
  maxBytes?: number;
  fs?: ExportFs;
  pageSize?: number;
};

type ProbeLike = Record<string, unknown> & { probeId: string; traceId: string; sessionId: string; spanId: string };

function isRuntimeRecord(record: Record<string, unknown>): boolean {
  return (
    "localSeq" in record && "spanId" in record && "nodeId" in record && "runtime" in record && !("probeId" in record)
  );
}

function isProbeRecord(record: Record<string, unknown>): record is ProbeLike {
  return (
    typeof record.probeId === "string" &&
    typeof record.traceId === "string" &&
    typeof record.sessionId === "string" &&
    typeof record.spanId === "string"
  );
}

function selectionRefs(selection: TraceSelection): QualifiedTraceRef[] {
  return selection.kind === "traces" ? selection.refs : [selection.ref];
}

function sameTrace(left: QualifiedTraceRef, right: { sessionId: string; traceId: string }): boolean {
  return left.sessionId === right.sessionId && left.traceId === right.traceId;
}

function probeValue(record: Record<string, unknown>): DetailValue {
  if (record.status === "masked" || record.masked === true) return { state: "masked" };
  if (record.status === "unavailable") {
    return { state: "unavailable", reason: typeof record.reason === "string" ? record.reason : "probe-unavailable" };
  }
  return valueOf(record.value);
}

export type ExportSource = TraceSource & {
  readonly sourceId: string;
  /** The pinned dataset snapshot the shared graph selectors read (snapshot-selectors.ts). */
  datasetSnapshot(snapshot?: SnapshotRef): TraceDatasetSnapshot;
};

export function createExportSource(options: ExportSourceOptions): ExportSource {
  const maxBytes = options.maxBytes ?? EXPORT_MAX_BYTES;
  const fs = options.fs ?? defaultExportFs;
  const pageSize = Math.max(1, Math.min(options.pageSize ?? 50, 1000));
  let loaded: {
    snapshot: SnapshotRef;
    dataset: TraceDatasetSnapshot;
    rows: TraceRow[];
    records: ReplayRecord[];
    probes: ProbeLike[];
    sourceId: string;
  } | null = null;
  let closed = false;

  async function load(signal: AbortSignal) {
    if (closed) throw new SourceError("closed", "kosmo-tui: the export source is closed");
    const size = await fs.size(options.path);
    if (size > maxBytes) {
      throw new SourceError(
        "export-too-large",
        `kosmo-tui: the export is ${size} bytes, over the ${maxBytes}-byte cap; it was not parsed`
      );
    }
    signal.throwIfAborted();
    const bytes = await fs.readBounded(options.path, maxBytes);
    if (bytes.length > maxBytes) {
      throw new SourceError(
        "export-too-large",
        `kosmo-tui: the export grew past the ${maxBytes}-byte cap while it was read; it was not parsed`
      );
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\ufeff/, "");
    } catch {
      throw new SourceError("invalid-export", "kosmo-tui: the export is not valid UTF-8");
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new SourceError("invalid-export", "kosmo-tui: the export is not valid JSON");
    }
    const version = (value as { formatVersion?: unknown } | null)?.formatVersion;
    if (version !== PORTABLE_EXPORT_FORMAT_VERSION) {
      throw new SourceError(
        "unsupported-export-version",
        `kosmo-tui: portable export formatVersion ${JSON.stringify(version ?? null)} is not supported; supported: ${PORTABLE_EXPORT_FORMAT_VERSION}`
      );
    }
    let dataset: TraceDatasetSnapshot;
    try {
      dataset = snapshotFromPortableExport(value, { maxBytes });
    } catch (error) {
      const code = error instanceof TraceSnapshotError ? error.code : "invalid-export";
      throw new SourceError(
        code,
        `kosmo-tui: the export was rejected by the shared importer: ${(error as Error).message.slice(0, 500)}`
      );
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
    // Replay records and probes come from the importer's sanitized, namespaced record
    // set (the projector snapshot keeps runtime records only); never from the raw file.
    const imported = importPortableExport(value, {
      namespace: portableExportNamespace(value).namespace,
      maxBytes
    }).dataset;
    const replayable = imported.records
      .filter((record) => isRuntimeRecord(record) || record.type === "payload-supplement")
      .sort((left, right) => Number(left.seq) - Number(right.seq));
    const records = replayable as unknown as ReplayRecord[];
    const events = eventsFromExportRecords(replayable);
    const rows = traceRowsFromEvents(events, { datasetId: identity.datasetId, projectId: identity.projectId });
    const probes = imported.records.filter(isProbeRecord);
    return { snapshot, dataset, rows, records, probes, sourceId: `export:${identity.datasetId}` };
  }

  function binding(snapshot: SnapshotRef, filter: PageFilter): CursorBinding {
    return {
      sourceId: loaded?.sourceId ?? "export",
      snapshotId: snapshot.snapshotId,
      retentionEpoch: snapshot.retentionEpoch,
      projectionVersion: null,
      filter
    };
  }

  function requireLoaded(snapshot: SnapshotRef) {
    if (loaded === null) throw new SourceError("not-open", "kosmo-tui: the export source is not open");
    if (snapshot.snapshotId !== loaded.snapshot.snapshotId) {
      throw new SourceError("snapshot-changed", "kosmo-tui: the snapshot does not belong to this export");
    }
    return loaded;
  }

  function page<T>(items: T[], snapshot: SnapshotRef, options: PageOptions, extra = ""): Page<T> {
    const filter = options.filter ?? {};
    let start = 0;
    if (options.cursor) {
      const decoded = decodeCursor(options.cursor, binding(snapshot, filter));
      if (!decoded.ok) throw new SourceError("cursor-rejected", `kosmo-tui: cursor rejected (${decoded.reason})`, 400);
      const [position, key] = JSON.parse(decoded.position) as [number, string];
      if (key !== extra) throw new SourceError("cursor-rejected", "kosmo-tui: cursor rejected (filter-changed)", 400);
      start = position;
    }
    const limit = Math.max(1, Math.min(options.limit, 1000));
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

  function filteredRows(rows: TraceRow[], filter: PageFilter): TraceRow[] {
    return rows.filter(
      (row) =>
        (!filter.errorsOnly || row.status === "errored") &&
        (filter.search === undefined || filter.search === "" || row.traceId.includes(filter.search))
    );
  }

  const source: ExportSource = {
    kind: "export",
    get sourceId() {
      return loaded?.sourceId ?? "export";
    },

    datasetSnapshot(snapshot) {
      if (loaded === null) throw new SourceError("not-open", "kosmo-tui: the export source is not open");
      return (snapshot === undefined ? loaded : requireLoaded(snapshot)).dataset;
    },

    async open(signal): Promise<SourceOpenResult> {
      loaded = await load(signal);
      const hasRecords = loaded.records.length > 0;
      const offers: SourceOffers = {
        projectionVersions: hasRecords ? [1, 2] : [],
        ...(hasRecords ? {} : { projectionReason: "no-runtime-records" }),
        follow: { available: false, reason: "static-snapshot" },
        replay: hasRecords ? { available: true } : { available: false, reason: "no-replay-records" },
        values: hasRecords ? { level: "full" } : { level: "none", reason: "no-runtime-records" },
        probes: loaded.probes.length > 0 ? { available: true } : { available: false, reason: "no-probe-records" },
        staticGraph: { available: false, reason: "no-static-graph-reader" },
        sql: { available: false, reason: "sql-reader-pending" }
      };
      return {
        snapshot: loaded.snapshot,
        offers,
        firstPage: page(loaded.rows, loaded.snapshot, { limit: pageSize }),
        stableDataset: true
      };
    },

    async traces(snapshot, options, signal) {
      signal.throwIfAborted();
      const state = requireLoaded(snapshot);
      return page(filteredRows(state.rows, options.filter ?? {}), snapshot, options);
    },

    async canonical(snapshot, selection, options, signal) {
      signal.throwIfAborted();
      const state = requireLoaded(snapshot);
      const refs = selectionRefs(selection);
      if (refs.length !== 1) {
        throw new SourceError("unsupported-selection", "kosmo-tui: a canonical page is read for one trace at a time");
      }
      const traceId = refs[0]!.traceId;
      const depth = options.depth === "function" ? "symbol" : options.depth;
      if (options.version === 2) {
        const envelope = projectCanonicalPage(state.dataset, {
          projectionVersion: 2,
          traceId,
          maxSpans: 1000,
          ...(depth ? { depth } : {})
        });
        return { version: 2, envelope, ...canonicalPageMeta(envelope) };
      }
      const envelope = projectCanonicalPage(state.dataset, {
        projectionVersion: 1,
        traceId,
        maxSpans: 1000,
        maxEvents: 1000,
        ...(depth ? { depth } : {})
      });
      return { version: 1, envelope, ...canonicalPageMeta(envelope) };
    },

    async details(snapshot, ref, signal) {
      signal.throwIfAborted();
      const state = requireLoaded(snapshot);
      const envelope = projectCanonicalPage(state.dataset, {
        projectionVersion: 2,
        traceId: ref.traceId,
        maxSpans: 1000
      });
      const evidence = evidenceFromCanonicalV2(envelope, ref, snapshot);
      if (evidence === null) throw new SourceError("span-not-found", "kosmo-tui: the export has no such span", 404);
      return evidence;
    },

    async records(snapshot, selection, options, signal) {
      signal.throwIfAborted();
      const state = requireLoaded(snapshot);
      const refs = selectionRefs(selection);
      const items = state.records.filter((record) => {
        const shape = record as unknown as { sessionId?: string; traceId?: string; spanId?: string };
        if (typeof shape.traceId !== "string" || typeof shape.sessionId !== "string") return false;
        if (!refs.some((ref) => sameTrace(ref, shape as { sessionId: string; traceId: string }))) return false;
        return selection.kind !== "span" || shape.spanId === selection.ref.spanId;
      });
      return page(items, snapshot, options, JSON.stringify(refs.map((ref) => [ref.sessionId, ref.traceId])));
    },

    async probes(snapshot, selection, options, signal) {
      signal.throwIfAborted();
      const state = requireLoaded(snapshot);
      const refs = selectionRefs(selection);
      const items: ProbeRecord[] = state.probes
        .filter((record) => refs.some((ref) => sameTrace(ref, record)))
        .filter((record) => selection.kind !== "span" || record.spanId === selection.ref.spanId)
        .map((record) => ({
          ref: {
            datasetId: snapshot.datasetId,
            projectId: snapshot.projectId,
            sessionId: record.sessionId,
            traceId: record.traceId,
            spanId: record.spanId
          },
          probeId: record.probeId,
          probeSeq: Number(record.seq ?? record.localSeq ?? 0),
          label: String(record.expression ?? record.probeId),
          value: probeValue(record)
        }));
      return page(items, snapshot, options, JSON.stringify(refs.map((ref) => [ref.sessionId, ref.traceId])));
    },

    async close() {
      closed = true;
      loaded = null;
    }
  };
  return source;
}
