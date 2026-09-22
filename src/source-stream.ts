/**
 * The NDJSON stream source for `kosmo-tui -` (task 4.3, design D15).
 *
 * stdin only. Every byte goes through the protocol's reference reader
 * (`createConnectStreamReader`): the line buffer is capped before parsing, split UTF-8
 * and CRLF are handled, every frame is validated against its version, v2 canonical
 * chunks are committed atomically per trace and `reset`/`gap` discard staged chunks.
 * Summaries and snapshots are keyed by the FULL trace ref
 * `(datasetId, projectId, sessionId, traceId)`: two sessions reusing a traceId never
 * share or overwrite a snapshot.
 *
 * What the stream can answer is what its header declares:
 *  - v1 carries trace SUMMARIES only: no span projection, no values, no replay, no
 *    probes. Nothing here reconstructs spans from a summary.
 *  - v2 adds canonical projection-v2 snapshots per trace (and the typed evidence in
 *    them); still no replay records. Follow only if the producer declared `follow:true`.
 *
 * A finite stream (`follow:false`, and every v1 stream) is read to `end`/EOF during
 * `open`, so the view is one consistent snapshot. EOF freezes it: the open result says
 * how complete it is (`incomplete-stream`, `gap`, `missing-snapshots`), and the source
 * never touches the terminal, so the keyboard port stays fully usable afterwards.
 *
 * This source has no network client at all: data on stdin never makes kosmo-tui
 * contact a daemon, whatever endpoint or cursor the frames mention.
 */

import {
  connectTraceRefKey,
  createConnectStreamReader,
  type ConnectStreamCompleteness,
  type ConnectStreamReaderOptions,
  type ConnectStreamState,
  type ConnectTraceFrame
} from "@kosmo-callflow/protocol";
import { SourceError, canonicalPageMeta, evidenceFromCanonicalV2 } from "./source-common.js";
import {
  decodeCursor,
  encodeCursor,
  type CursorBinding,
  type LiveDeltaBody,
  type PageFilter,
  type PageOptions,
  type QualifiedTraceRef,
  type SnapshotRef,
  type SourceOffers,
  type SourceOpenResult,
  type TracePage,
  type TraceSelection,
  type TraceSource
} from "./source.js";
import type { TraceRow } from "./view-state.js";

export type StreamInput = AsyncIterable<Uint8Array | string> & { destroy?: () => void };

export type StreamSourceOptions = {
  input: StreamInput;
  reader?: ConnectStreamReaderOptions;
  pageSize?: number;
};

export type StreamCompleteness = ConnectStreamCompleteness;

export type StreamSource = TraceSource & {
  readonly sourceId: string;
  /** Completeness of what has been read; `complete` only after a clean `end`. */
  completeness(): StreamCompleteness;
  /** The stream version once the header was read; null before. */
  version(): 1 | 2 | null;
};

function describeIncomplete(completeness: ConnectStreamCompleteness): string | undefined {
  if (completeness.state === "incomplete") {
    const missing = completeness.missingSnapshotIds.length;
    return `incomplete(${completeness.reasons.join(",")}${missing > 0 ? `; ${missing} snapshot(s) missing` : ""})`;
  }
  if (completeness.state === "pending") return "incomplete(still-reading)";
  return undefined;
}

function streamError(state: ConnectStreamState): SourceError | null {
  if (state.completeness.state !== "failed") return null;
  const { code, line, message } = state.completeness.error;
  return new SourceError(`stream-${code}`, `kosmo-tui: stdin stream line ${line}: ${code}: ${message}`);
}

function selectionRefs(selection: TraceSelection): QualifiedTraceRef[] {
  return selection.kind === "traces" ? selection.refs : [selection.ref];
}

export function createStreamSource(options: StreamSourceOptions): StreamSource {
  const reader = createConnectStreamReader(options.reader);
  const pageSize = Math.max(1, Math.min(options.pageSize ?? 50, 1000));
  const sourceId = "stream:stdin";
  let ended = false;
  let closed = false;
  let pump: Promise<void> | null = null;
  let pumpError: unknown = null;
  let headerWaiters: Array<() => void> = [];
  let endWaiters: Array<() => void> = [];
  /** Order in which traces were (re)announced, as full-ref keys; the delta cursor is a position in it. */
  const updates: string[] = [];
  let gapsSeen = 0;

  const wake = (): void => {
    const state = reader.state();
    if (state.header !== null || state.completeness.state === "failed" || ended) {
      const waiters = headerWaiters;
      headerWaiters = [];
      for (const waiter of waiters) waiter();
    }
    if (ended || state.completeness.state === "failed") {
      const waiters = endWaiters;
      endWaiters = [];
      for (const waiter of waiters) waiter();
    }
  };

  function startPump(): Promise<void> {
    pump ??= (async () => {
      try {
        for await (const chunk of options.input) {
          if (closed) break;
          const before = new Map(reader.state().traces);
          reader.push(chunk);
          const state = reader.state();
          for (const [key, frame] of state.traces) {
            if (before.get(key) !== frame) updates.push(key);
          }
          wake();
          if (state.completeness.state === "failed") break;
        }
      } catch (error) {
        pumpError = error;
      } finally {
        if (!closed) reader.finish();
        ended = true;
        wake();
      }
    })();
    return pump;
  }

  const until = (waiters: "header" | "end", signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason);
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      const done = (): void => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      if (waiters === "header") headerWaiters.push(done);
      else endWaiters.push(done);
      wake();
    });

  function snapshotRef(state: ConnectStreamState): SnapshotRef {
    const header = state.header!;
    const dataset = header.dataset;
    return {
      datasetId: dataset.datasetId,
      projectId: header.project.projectId,
      revision: dataset.graphRevision,
      watermark: dataset.watermarkSeq,
      retentionEpoch: dataset.retentionEpoch,
      // A stream has no persisted identity; the id names this read and its frame count.
      snapshotId: `stream:${dataset.datasetId}:e${dataset.retentionEpoch}:w${dataset.watermarkSeq}:l${state.lines}`
    };
  }

  function rowOf(snapshot: SnapshotRef, frame: ConnectTraceFrame): TraceRow {
    return {
      datasetId: snapshot.datasetId,
      projectId: snapshot.projectId,
      sessionId: frame.sessionId,
      traceId: frame.traceId,
      status: frame.status,
      startedAt: frame.firstSeq,
      spanCount: frame.spansCount
    };
  }

  function rows(snapshot: SnapshotRef, filter: PageFilter): TraceRow[] {
    return [...reader.state().traces.values()]
      .map((frame) => rowOf(snapshot, frame))
      .filter(
        (row) =>
          (!filter.errorsOnly || row.status === "errored") &&
          (filter.search === undefined || filter.search === "" || row.traceId.includes(filter.search))
      )
      .sort((left, right) => right.startedAt - left.startedAt || left.traceId.localeCompare(right.traceId));
  }

  let pinned: SnapshotRef | null = null;

  const binding = (snapshot: SnapshotRef, filter: PageFilter): CursorBinding => ({
    sourceId,
    snapshotId: snapshot.snapshotId,
    retentionEpoch: snapshot.retentionEpoch,
    projectionVersion: null,
    filter
  });

  function page(snapshot: SnapshotRef, options: PageOptions): TracePage {
    const filter = options.filter ?? {};
    const all = rows(snapshot, filter);
    let start = 0;
    if (options.cursor) {
      const decoded = decodeCursor(options.cursor, binding(snapshot, filter));
      if (!decoded.ok) throw new SourceError("cursor-rejected", `kosmo-tui: cursor rejected (${decoded.reason})`, 400);
      start = Number(decoded.position);
    }
    const limit = Math.max(1, Math.min(options.limit, 1000));
    const items = all.slice(start, start + limit);
    const end = start + items.length;
    const more = end < all.length;
    const reason = describeIncomplete(reader.state().completeness);
    return {
      items,
      coverage: {
        scope: more || reason !== undefined ? "partial" : "complete",
        loaded: end,
        total: all.length,
        ...(reason === undefined ? {} : { reason })
      },
      truncated: more,
      cursor: more ? encodeCursor(binding(snapshot, filter), String(end)) : null
    };
  }

  function requireState(snapshot: SnapshotRef): ConnectStreamState {
    if (pinned === null) throw new SourceError("not-open", "kosmo-tui: the stream source is not open");
    if (snapshot.datasetId !== pinned.datasetId || snapshot.retentionEpoch !== pinned.retentionEpoch) {
      throw new SourceError("snapshot-changed", "kosmo-tui: the snapshot does not belong to this stream");
    }
    return reader.state();
  }

  function committed(state: ConnectStreamState, ref: QualifiedTraceRef) {
    if (state.version !== 2) {
      throw new SourceError(
        "unavailable",
        "kosmo-tui: unavailable(summary-only-stream): stream v1 carries trace summaries, not spans"
      );
    }
    // The stream holds ONE dataset (its header's): snapshots are keyed by that dataset/project
    // plus the ref's session and trace. A ref may also be qualified by the snapshot page's own
    // dataset identity (span refs read from the envelope); anything else is another dataset.
    const header = state.header!;
    const key = connectTraceRefKey({
      datasetId: header.dataset.datasetId,
      projectId: header.project.projectId,
      sessionId: ref.sessionId,
      traceId: ref.traceId
    });
    const found = state.snapshots.get(key);
    const entry =
      found !== undefined &&
      (ref.datasetId === header.dataset.datasetId || ref.datasetId === found.page.dataset.datasetId) &&
      (ref.projectId === header.project.projectId || ref.projectId === found.page.dataset.projectId)
        ? found
        : undefined;
    if (entry === undefined) {
      throw new SourceError(
        "unavailable",
        `kosmo-tui: unavailable(no-canonical-snapshot): the stream carried no complete canonical snapshot for trace ${ref.traceId} of session ${ref.sessionId}`
      );
    }
    return entry;
  }

  const source: StreamSource = {
    kind: "stream",
    sourceId,
    completeness: () => reader.state().completeness,
    version: () => reader.state().version,

    async open(signal): Promise<SourceOpenResult> {
      if (closed) throw new SourceError("closed", "kosmo-tui: the stream source is closed");
      void startPump();
      await until("header", signal);
      let state = reader.state();
      const failure = streamError(state);
      if (failure) throw failure;
      if (pumpError !== null) {
        throw new SourceError(
          "stream-read-failed",
          `kosmo-tui: reading stdin failed: ${(pumpError as Error).message ?? String(pumpError)}`
        );
      }
      if (state.header === null) {
        throw new SourceError("stream-missing-header", "kosmo-tui: stdin ended before a connect header frame arrived");
      }
      if (!state.follow) {
        // A finite snapshot: read it whole, so the view never shows half of it.
        await until("end", signal);
        state = reader.state();
        const late = streamError(state);
        if (late) throw late;
        if (pumpError !== null) {
          throw new SourceError(
            "stream-read-failed",
            `kosmo-tui: reading stdin failed: ${(pumpError as Error).message ?? String(pumpError)}`
          );
        }
      }
      const snapshot = snapshotRef(state);
      pinned = snapshot;
      gapsSeen = state.gaps;
      const v2 = state.version === 2 && state.capabilities.includes("canonical-snapshots");
      const offers: SourceOffers = {
        projectionVersions: v2 ? [2] : [],
        ...(v2 ? {} : { projectionReason: "summary-only-stream" }),
        follow: state.follow ? { available: true } : { available: false, reason: "finite-stream" },
        replay: { available: false, reason: "no-replay-records" },
        values: v2 ? { level: "full" } : { level: "none", reason: "summary-only-stream" },
        probes: { available: false, reason: v2 ? "no-probe-records" : "summary-only-stream" },
        staticGraph: { available: false, reason: "no-static-graph-reader" },
        sql: { available: false, reason: "stream-not-queryable" }
      };
      return {
        snapshot,
        offers,
        firstPage: page(snapshot, { limit: pageSize }),
        stableDataset: false,
        deltaCursor: encodeCursor(binding(snapshot, {}), String(updates.length))
      };
    },

    async traces(snapshot, options, signal) {
      signal.throwIfAborted();
      requireState(snapshot);
      return page(snapshot, options);
    },

    async canonical(snapshot, selection, options, signal) {
      signal.throwIfAborted();
      const state = requireState(snapshot);
      if (options.version !== 2) {
        throw new SourceError(
          "projection-version-unavailable",
          `kosmo-tui: unavailable(projection-v${options.version}): the stream carries projection v2 only`
        );
      }
      const refs = selectionRefs(selection);
      if (refs.length !== 1) {
        throw new SourceError("unsupported-selection", "kosmo-tui: a canonical page is read for one trace at a time");
      }
      const entry = committed(state, refs[0]!);
      return { version: 2, envelope: entry.page, ...canonicalPageMeta(entry.page) };
    },

    async details(snapshot, ref, signal) {
      signal.throwIfAborted();
      const state = requireState(snapshot);
      const entry = committed(state, ref);
      const evidence = evidenceFromCanonicalV2(entry.page, ref, snapshot);
      if (evidence === null)
        throw new SourceError("span-not-found", "kosmo-tui: the stream snapshot has no such span", 404);
      return evidence;
    },

    async deltas(cursor, signal): Promise<LiveDeltaBody> {
      signal.throwIfAborted();
      if (pinned === null) throw new SourceError("not-open", "kosmo-tui: the stream source is not open");
      const decoded = decodeCursor(cursor, binding(pinned, {}));
      if (!decoded.ok)
        throw new SourceError("cursor-rejected", `kosmo-tui: delta cursor rejected (${decoded.reason})`, 400);
      const failure = streamError(reader.state());
      if (failure) throw failure;
      const from = Number(decoded.position);
      const state = reader.state();
      const snapshot: SnapshotRef = { ...pinned, snapshotId: snapshotRef(state).snapshotId };
      const reset = state.gaps > gapsSeen;
      gapsSeen = state.gaps;
      const changed = reset ? [...state.traces.keys()] : [...new Set(updates.slice(from))];
      const traces = changed
        .map((key) => state.traces.get(key))
        .filter((frame): frame is ConnectTraceFrame => frame !== undefined)
        .map((frame) => rowOf(snapshot, frame));
      return {
        cursor: encodeCursor(binding(pinned, {}), String(updates.length)),
        snapshot,
        traces,
        spans: [],
        dropped: [],
        gap: reset,
        reset
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      options.input.destroy?.();
      wake();
    }
  };
  return source;
}
