/**
 * Session = source + view state + terminal + background loader (design D1/D9, tasks
 * 5.5, 5.9, 7.5, 7.6).
 *
 * One lifetime AbortController covers every read; the detail loader has its own
 * controller and a generation counter. Rules this module keeps:
 *
 *  - Selection change bumps the generation and aborts the previous detail read; a
 *    response is applied only if its generation and retention epoch are still current,
 *    so a late answer is dropped even when the transport ignored the AbortSignal.
 *  - Details load after a 50 ms debounce.
 *  - Live polling (default 250 ms) keeps at most ONE delta read in flight: the next read
 *    is scheduled only after the previous one settled. `refreshMs` is the redraw cadence
 *    and never starts a read.
 *  - Network/5xx failures reconnect after 1..10 s with jitter; 401/403 stop polling with
 *    a visible notice; 409 (or a reset body) replaces the baseline atomically.
 *  - SQLite/export sources are static snapshots and are never polled.
 *  - Frames parked while paused are bounded (bounds.ts); overflow reloads a baseline
 *    and says so. Rows and details share one byte budget with explicit eviction.
 *  - Replay runs on a pinned snapshot (replay-pin.ts) and never sees live deltas; `L`
 *    explicitly loads a new live baseline.
 *  - `y` copies the full versioned trace-text document (clipboard.ts); without a
 *    clipboard it is printed only after the terminal has been restored.
 *  - `close()` cancels every timer and request, restores the terminal and is idempotent.
 */

import {
  projectTraceTextDocumentV2,
  type CanonicalPageEnvelopeV2,
  type CanonicalSpanProjectionItemV2,
  type TraceTextDocumentV2
} from "@kosmo-callflow/protocol";
import type { ReplayRecord, ReplayState } from "@kosmo-callflow/replay";
import {
  BoundedQueue,
  ByteLru,
  CACHE_MAX_BYTES,
  FRAME_QUEUE_MAX_BYTES,
  FRAME_QUEUE_MAX_FRAMES,
  jsonBytes
} from "./bounds.js";
import {
  checkCommand,
  effectiveCapabilities,
  type Capabilities,
  type Command,
  type SessionPolicy
} from "./capabilities.js";
import { StdoutFallback, buildCopyDocument, copyToClipboard, withAfterClose, type ClipboardDeps } from "./clipboard.js";
import { runCommandLine, type CommandDeps, type CommandResult, type DepthLevel } from "./commands.js";
import type { DepthMapping } from "./depth.js";
import { compareSpanPair } from "./compare.js";
import { spanDocumentFor } from "./detail.js";
import { runLocalEval, type EvalOutcome, type EvalRunOptions, type EvalSnapshot } from "./eval.js";
import { decodeBookmarkKey, decodeCommandLineKey, decodeKey, decodeSearchKey } from "./keys.js";
import { renderFrame } from "./render.js";
import { REPLAY_SPEED_MAX, REPLAY_SPEED_MIN, type ReplaySchedule } from "./replay.js";
import {
  delayAfter,
  detailAtCutoff,
  pinReplay,
  pinnedSchedule,
  seekPinned,
  stepSeq,
  type PinnedReplay
} from "./replay-pin.js";
import type { EvidenceDocument, SanitizeContext } from "./review-format.js";
import type { FindingInput, ReviewResult } from "./review.js";
import type {
  LiveDeltaBody,
  SnapshotRef,
  SourceOpenResult,
  SpanEvidence,
  TraceSelection,
  TraceSource,
  VersionedCanonicalPage
} from "./source.js";
import type { StreamSource } from "./source-stream.js";
import { isTooSmall, tooSmallFrame, type Terminal } from "./terminal.js";
import { findValueCandidates } from "./values.js";
import {
  applyAction,
  canonicalKeyOf,
  canonicalPageKey,
  initialViewState,
  reduceDelta,
  showReplayFrame,
  spanKey,
  spanRefOf,
  traceKey,
  type Action,
  type ConnectionState,
  type DetailValue,
  type SpanDetail,
  type SpanRef,
  type SpanRow,
  type TraceRef,
  type TraceRow,
  type ViewState
} from "./view-state.js";

export const SESSION_POLL_MS = 250;
export const SESSION_REFRESH_MS = 250;
export const DETAIL_DEBOUNCE_MS = 50;
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 10_000;
/** Per-value cap for detail text kept in state, so one pinned selection stays bounded. */
export const DETAIL_VALUE_MAX_BYTES = 64 * 1024;
const RECORD_PAGE_LIMIT = 1_000;
/** Traces whose canonical v2 page is loaded (per load) for the span rows, request selector and depth rows. */
export const CANONICAL_PAGE_TRACES = 20;
/** Trace rows read per `>` (load more) from the pinned snapshot. */
export const TRACE_PAGE_LIMIT = 50;
/** Reconnect/backoff delays kept in `stats().reconnectDelays` (the most recent ones). */
export const RECONNECT_DELAYS_KEPT = 32;
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

export type SessionTimers = {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const defaultTimers: SessionTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export type SessionLimits = { queueFrames: number; queueBytes: number; cacheBytes: number };

export type ReplayRequest = { seq?: number; speed?: number; stepIntervalMs?: number };

/**
 * The review writes a session can make (review.ts `ReviewSession` satisfies it). A
 * disabled capability keeps the port but every `f`/`t`/`R` answers `review disabled`.
 */
export type ReviewPort = {
  readonly capability: { enabled: true } | { enabled: false; reason: string };
  addFinding(input: FindingInput): Promise<ReviewResult>;
  addTodo(note: string): Promise<ReviewResult>;
  finalize(): Promise<ReviewResult>;
  close(): Promise<void>;
};

/** What `:js` reads: the pinned offline snapshot, or why there is none (live, stream). */
export type EvalSnapshotSource = () => EvalSnapshot | { unavailable: string };

export type SessionOptions = {
  source: TraceSource;
  policy?: SessionPolicy;
  terminal?: Terminal;
  timers?: SessionTimers;
  random?: () => number;
  pollMs?: number;
  /** Redraw cadence for background changes (`--refresh`); never a read rate. */
  refreshMs?: number;
  detailDebounceMs?: number;
  /** `--projection-version`; default is the newest version the source serves. */
  projectionVersion?: 1 | 2;
  limits?: Partial<SessionLimits>;
  /** `--replay` on open. */
  replay?: ReplayRequest;
  /** Clipboard adapters and the stdout the fallback prints to after the terminal closes. */
  clipboard?: ClipboardDeps & { stdout: { write(chunk: string): unknown } };
  sanitize?: SanitizeContext;
  onExit?: () => void;
  /** `--depth`: initial level for the shared canonical depth projection. */
  depth?: DepthLevel;
  /** Roots and producer logical mapping for the depth projector. */
  depthMapping?: DepthMapping;
  /**
   * Opens the review port once the source is open (its identity decides resume). Null,
   * a disabled capability or no factory at all make `f`/`t`/`R` answer `review disabled`.
   */
  review?: (opened: SourceOpenResult) => Promise<ReviewPort | null>;
  /** Deps of the `:` command line (shared graph selectors, `:sql`); `liveSeek` defaults on. */
  commands?: CommandDeps;
  /** The snapshot `:js` evaluates over. */
  evalSnapshot?: EvalSnapshotSource;
  /** The local eval runner (eval.ts `runLocalEval`) and the env its allowlist filters. */
  runEval?: (options: EvalRunOptions) => Promise<EvalOutcome>;
  evalEnv?: Record<string, string | undefined>;
  /** `--detail` / `--values` for the documents `y` copies and `f` records (default 2 / as the source allows). */
  detail?: 0 | 1 | 2;
  values?: boolean;
};

export type PollingState = { state: "off" | "active" | "reconnecting" | "stopped"; reason: string | null };

export type SessionStats = {
  deltaReads: number;
  deltaInFlight: number;
  maxDeltaInFlight: number;
  detailReads: number;
  staleDetailsIgnored: number;
  queueFrames: number;
  queueBytes: number;
  queueRefused: number;
  cacheBytes: number;
  cacheEntries: number;
  evictedRows: number;
  reconnectDelays: number[];
  polling: PollingState;
};

export type Session = {
  /** The terminal the session paints on, wrapped so closing it also flushes the copy fallback. */
  readonly terminal: Terminal | undefined;
  start(): Promise<void>;
  state(): ViewState;
  snapshot(): SnapshotRef | null;
  press(key: string): void;
  dispatch(action: Action): void;
  enterReplay(request?: ReplayRequest): Promise<void>;
  seek(seq: number): void;
  setReplaySpeed(speed: number): void;
  returnToLive(): Promise<void>;
  yank(): Promise<void>;
  stats(): SessionStats;
  close(): Promise<void>;
};

export type SourceFailure =
  | { kind: "aborted" }
  | { kind: "auth"; status: number }
  | { kind: "reset" }
  | { kind: "retry"; status: number | null; message: string }
  | { kind: "fatal"; status: number; message: string };

/** How a failed source read is handled; `status`/`statusCode` on the error carry HTTP status. */
export function classifyFailure(error: unknown): SourceFailure {
  const shape = (error ?? {}) as { name?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
  if (shape.name === "AbortError") return { kind: "aborted" };
  const status =
    typeof shape.status === "number" ? shape.status : typeof shape.statusCode === "number" ? shape.statusCode : null;
  const message = typeof shape.message === "string" ? shape.message : String(error);
  if (status === 401 || status === 403) return { kind: "auth", status };
  if (status === 409) return { kind: "reset" };
  if (status === null || status >= 500) return { kind: "retry", status, message };
  return { kind: "fatal", status, message };
}

/** Exponential backoff with jitter, always inside 1..10 s. */
export function reconnectDelayMs(attempt: number, random: () => number): number {
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.max(0, attempt - 1));
  const jittered = base / 2 + random() * (base / 2);
  return Math.round(Math.min(RECONNECT_MAX_MS, Math.max(RECONNECT_MIN_MS, jittered)));
}

function capValue(value: DetailValue): DetailValue {
  if (value.state !== "recorded" || Buffer.byteLength(value.text, "utf8") <= DETAIL_VALUE_MAX_BYTES) return value;
  const decoded = Buffer.from(value.text, "utf8").subarray(0, DETAIL_VALUE_MAX_BYTES).toString("utf8");
  // A cut inside a multi-byte character decodes to one replacement character; drop it.
  const cut = decoded.endsWith(REPLACEMENT_CHAR) ? decoded.slice(0, -1) : decoded;
  return { state: "recorded", text: `${cut}… [truncated at ${DETAIL_VALUE_MAX_BYTES} bytes]` };
}

/** Typed evidence → the pane's detail; a missing anchor line stays null, never invented. */
export function detailFromEvidence(evidence: SpanEvidence): SpanDetail {
  const hash = evidence.nodeId.lastIndexOf("#");
  return {
    ...spanRefOf(evidence.ref),
    nodeId: evidence.nodeId,
    status: evidence.status,
    args: capValue(evidence.args),
    ret: capValue(evidence.ret),
    error: capValue(evidence.error),
    duration: evidence.duration,
    anchor: evidence.anchor ?? {
      file: hash === -1 ? evidence.nodeId : evidence.nodeId.slice(0, hash),
      symbol: hash === -1 ? evidence.nodeId : evidence.nodeId.slice(hash + 1),
      line: null
    },
    document: null
  };
}

function epochKey(snapshot: SnapshotRef): string {
  return JSON.stringify([snapshot.datasetId, snapshot.projectId, snapshot.retentionEpoch]);
}

type PinnedSession = {
  pin: PinnedReplay;
  schedule: ReplaySchedule;
  index: number;
  state: ReplayState | null;
  autoplayPaused: boolean;
  /** What the last seek could not show (a hole, no later pinned record); kept on later notices. */
  frameNote: string | null;
};

export function createSession(options: SessionOptions): Session {
  const { source } = options;
  const policy: SessionPolicy = options.policy ?? { readOnly: false, noEval: false, print: false };
  const timers = options.timers ?? defaultTimers;
  const random = options.random ?? Math.random;
  const pollMs = options.pollMs ?? SESSION_POLL_MS;
  const refreshMs = options.refreshMs ?? SESSION_REFRESH_MS;
  const debounceMs = options.detailDebounceMs ?? DETAIL_DEBOUNCE_MS;
  const limits: SessionLimits = {
    queueFrames: options.limits?.queueFrames ?? FRAME_QUEUE_MAX_FRAMES,
    queueBytes: options.limits?.queueBytes ?? FRAME_QUEUE_MAX_BYTES,
    cacheBytes: options.limits?.cacheBytes ?? CACHE_MAX_BYTES
  };
  const fallback = options.clipboard ? new StdoutFallback(options.clipboard.stdout) : null;
  const terminal = options.terminal ? withAfterClose(options.terminal, () => fallback?.flush()) : undefined;

  const lifetime = new AbortController();
  const queue = new BoundedQueue<LiveDeltaBody>({ maxItems: limits.queueFrames, maxBytes: limits.queueBytes });
  /** Rows (`s`/`t` + full key) and details (`d` + span key) share one byte budget. */
  const cache = new ByteLru<string, true | SpanDetail>(limits.cacheBytes);

  let state: ViewState = initialViewState();
  let snapshot: SnapshotRef | null = null;
  let deltaCursor: string | null = null;
  let caps: Capabilities | null = null;
  /** Continuation of the trace list inside the pinned snapshot; null when all is loaded. */
  let pageCursor: string | null = null;
  /** Traces whose canonical page (and so span rows) was already read for this snapshot. */
  const canonicalLoaded = new Set<string>();
  let review: ReviewPort | null = null;
  let closed = false;
  let closing: Promise<void> | null = null;
  let dirty = false;

  let pollTimer: unknown = null;
  let redrawTimer: unknown = null;
  let debounceTimer: unknown = null;
  let autoplayTimer: unknown = null;
  let polling: PollingState = { state: "off", reason: null };
  let failures = 0;
  let needsBaseline = false;
  /** Consecutive resets (409 / reset reload failures) with no successful delta read between them. */
  let resetRun = 0;
  /** A backed-off baseline reload is due at the next poll instead of a delta read. */
  let reloadDue = false;
  /** Single flight for canonical page loads; a request during a load runs once more after it. */
  let canonicalRun: Promise<void> | null = null;
  let canonicalAgain = false;

  let generation = 0;
  let selectedKey: string | null = null;
  let detailController: AbortController | null = null;
  let pinned: PinnedSession | null = null;

  const stats = {
    deltaReads: 0,
    deltaInFlight: 0,
    maxDeltaInFlight: 0,
    detailReads: 0,
    staleDetailsIgnored: 0,
    evictedRows: 0,
    reconnectDelays: [] as number[]
  };

  const clear = (handle: unknown): null => {
    if (handle !== null) timers.clearTimeout(handle);
    return null;
  };

  // -- painting ------------------------------------------------------------------------

  function paintNow(): void {
    dirty = false;
    if (closed || !terminal) return;
    const size = terminal.size();
    terminal.paint(isTooSmall(size) ? tooSmallFrame(size) : renderFrame(state, size.cols, size.rows));
  }

  /** Background change: coalesced to the redraw cadence. */
  function invalidate(): void {
    dirty = true;
    if (closed || redrawTimer !== null || !terminal) return;
    redrawTimer = timers.setTimeout(() => {
      redrawTimer = null;
      if (dirty) paintNow();
    }, refreshMs);
  }

  function notice(text: string): void {
    state = { ...state, notice: text };
    invalidate();
  }

  // -- rows and the bounded cache ------------------------------------------------------

  function trackRows(traces: TraceRow[], spans: SpanRow[], pages: CanonicalPageEnvelopeV2[] = []): void {
    const evicted: string[] = [];
    for (const row of traces) evicted.push(...cache.set(`t${traceKey(row)}`, true, jsonBytes(row)));
    for (const row of spans) {
      // A trace with fresh spans is in use: keep its row recent so it is not evicted first.
      cache.get(`t${traceKey(row)}`);
      evicted.push(...cache.set(`s${spanKey(row)}`, true, jsonBytes(row)));
    }
    // Canonical pages share the byte budget with rows and details (they are the largest entries).
    for (const page of pages) evicted.push(...cache.set(`c${canonicalKeyOf(page)}`, true, jsonBytes(page)));
    const evictSpans: SpanRef[] = [];
    const evictTraces: TraceRef[] = [];
    const dropPages = new Map<string, { datasetId: string; projectId: string; traceId: string }>();
    const dropPage = (ref: { datasetId: string; projectId: string; traceId: string }): void => {
      const key = canonicalPageKey(ref);
      dropPages.set(key, { datasetId: ref.datasetId, projectId: ref.projectId, traceId: ref.traceId });
    };
    for (const key of evicted) {
      if (key.startsWith("d")) continue;
      const parts = JSON.parse(key.slice(1)) as string[];
      if (key.startsWith("c")) {
        const [datasetId, projectId, traceId] = parts as [string, string, string];
        dropPage({ datasetId, projectId, traceId });
        continue;
      }
      const [datasetId, projectId, sessionId, traceId, spanId] = parts as [string, string, string, string, string?];
      if (key.startsWith("s")) evictSpans.push({ datasetId, projectId, sessionId, traceId, spanId: spanId! });
      else evictTraces.push({ datasetId, projectId, sessionId, traceId });
    }
    // A page whose rows are evicted goes with them; the trace is read again if it comes back.
    for (const ref of [...evictSpans, ...evictTraces]) {
      dropPage(ref);
      canonicalLoaded.delete(traceKey(ref));
    }
    if (dropPages.size > 0) {
      for (const key of dropPages.keys()) cache.delete(`c${key}`);
      state = reduceDelta(state, { kind: "dropCanonical", traces: [...dropPages.values()] });
    }
    if (evictSpans.length === 0 && evictTraces.length === 0) return;
    stats.evictedRows += evictSpans.length + evictTraces.length;
    state = reduceDelta(state, { kind: "evict", spans: evictSpans, traces: evictTraces });
    state = reduceDelta(state, {
      kind: "scope",
      scope: {
        loaded: state.spans.length,
        total: null,
        truncated: true,
        reason: `cache cap ${limits.cacheBytes} bytes, ${stats.evictedRows} row(s) evicted`
      }
    });
  }

  function applyBaselineRows(traces: TraceRow[], spans: SpanRow[], gap: boolean): void {
    cache.clear();
    // A baseline replaces every row: its canonical pages are read again, and any backlog
    // overflow it replaced is no longer outstanding.
    canonicalLoaded.clear();
    state = { ...state, canonical: [], backlogOverflowed: false };
    state = reduceDelta(state, { kind: "baseline", traces, spans, gap });
    trackRows(traces, spans);
  }

  function adoptOpen(opened: SourceOpenResult, gap: boolean): void {
    snapshot = opened.snapshot;
    deltaCursor = opened.deltaCursor ?? opened.snapshot.snapshotId;
    pageCursor = opened.firstPage.cursor;
    canonicalLoaded.clear();
    state = { ...state, canonical: [], morePages: pageCursor !== null, scope: null };
    applyBaselineRows(opened.firstPage.items, [], gap);
    const { coverage, truncated } = opened.firstPage;
    if (state.scope?.reason === undefined) {
      state = reduceDelta(state, {
        kind: "scope",
        scope: {
          loaded: coverage.loaded,
          total: coverage.total,
          truncated,
          // The source's own completeness (e.g. `incomplete(incomplete-stream)`) is shown.
          ...(coverage.reason === undefined ? {} : { reason: coverage.reason })
        }
      });
    }
  }

  /** A fresh open replaces everything at once: rows, cursor, caches, parked frames. */
  async function reloadBaseline(gap: boolean, message: string | null): Promise<void> {
    const opened = await source.open(lifetime.signal);
    if (closed) return;
    queue.reset();
    needsBaseline = false;
    bumpGeneration();
    adoptOpen(opened, gap);
    if (message !== null) state = { ...state, notice: message };
    afterChange();
    void loadCanonicalPages();
  }

  /**
   * What the header says about the source. Only a live daemon is "connected; live"; an
   * export, a SQLite file or a stdin stream names itself and, for a stream, how it ended.
   */
  function sourceConnection(flowing: boolean): ConnectionState {
    switch (source.kind) {
      case "export":
        return { kind: "offline", label: "export snapshot" };
      case "sqlite":
        return { kind: "offline", label: "sqlite snapshot (static)" };
      case "stream": {
        const stream = source as Partial<StreamSource>;
        const version = stream.version?.() ?? null;
        const completeness = stream.completeness?.().state;
        const phase = completeness === "complete" ? "ended" : completeness === "pending" ? "following" : "incomplete";
        return { kind: "offline", label: `stream${version === null ? "" : ` v${version}`} (${phase})` };
      }
      default:
        return flowing
          ? { kind: "connected", sdk: "present", events: "flowing" }
          : { kind: "connected", sdk: "present", events: "none" };
    }
  }

  function applyFrame(frame: LiveDeltaBody): void {
    // A trace announced again (new spans, a status change) has its canonical page re-read.
    for (const row of frame.traces) canonicalLoaded.delete(traceKey(row));
    state = reduceDelta(state, { kind: "traces", rows: frame.traces });
    state = reduceDelta(state, { kind: "spans", rows: frame.spans });
    if (frame.dropped.length > 0 || frame.gap)
      state = reduceDelta(state, { kind: "retention", dropped: frame.dropped });
    trackRows(frame.traces, frame.spans);
  }

  // -- live polling --------------------------------------------------------------------

  function schedulePoll(delay: number): void {
    if (closed || polling.state === "stopped" || pollTimer !== null) return;
    pollTimer = timers.setTimeout(() => {
      pollTimer = null;
      void poll();
    }, delay);
  }

  function stopPolling(reason: string): void {
    pollTimer = clear(pollTimer);
    polling = { state: "stopped", reason };
  }

  async function poll(): Promise<void> {
    if (closed || stats.deltaInFlight > 0 || deltaCursor === null || !source.deltas) return;
    stats.deltaInFlight += 1;
    stats.deltaReads += 1;
    stats.maxDeltaInFlight = Math.max(stats.maxDeltaInFlight, stats.deltaInFlight);
    let next: number | null = pollMs;
    try {
      if (reloadDue) {
        // A backed-off reload after repeated resets, instead of a delta read.
        reloadDue = false;
        await reloadBaseline(true, `retention reset (409, ${resetRun} in a row): baseline replaced`);
      } else {
        const body = await source.deltas(deltaCursor, lifetime.signal);
        if (closed) return;
        failures = 0;
        resetRun = 0;
        polling = { state: "active", reason: null };
        await handleBody(body);
      }
    } catch (error) {
      if (closed) return;
      next = await handleFailure(error);
    } finally {
      stats.deltaInFlight -= 1;
    }
    if (next !== null) schedulePoll(next);
    invalidate();
  }

  async function handleBody(body: LiveDeltaBody): Promise<void> {
    const epochChanged = snapshot !== null && epochKey(body.snapshot) !== epochKey(snapshot);
    if (body.reset || epochChanged) {
      const from = snapshot?.retentionEpoch;
      snapshot = body.snapshot;
      deltaCursor = body.cursor;
      bumpGeneration();
      queue.reset();
      if (pinned !== null) {
        // The replay frame is pinned; the new live baseline waits for an explicit `L`.
        needsBaseline = true;
        notice(resetDuringReplay(from, body.snapshot.retentionEpoch));
        return;
      }
      if (state.paused) {
        needsBaseline = true;
        return;
      }
      applyBaselineRows(body.traces, body.spans, true);
      state = {
        ...state,
        notice: `retention reset (epoch ${String(from)} → ${body.snapshot.retentionEpoch}): baseline replaced`
      };
      afterChange();
      void loadCanonicalPages();
      return;
    }
    snapshot = body.snapshot;
    deltaCursor = body.cursor;
    if (pinned !== null) {
      // Replay never applies live deltas; the view only learns it is behind live.
      state = reduceDelta(state, { kind: "behindLive", behind: true });
      return;
    }
    if (state.paused) {
      if (!queue.push(body)) state = { ...state, backlogOverflowed: true, retentionGap: true };
      return;
    }
    applyFrame(body);
    state = reduceDelta(state, { kind: "connection", connection: sourceConnection(true) });
    afterChange();
    // Traces that arrived by delta get span rows like the initial page (bounded per load).
    if (body.traces.length > 0) void loadCanonicalPages();
  }

  function resetDuringReplay(from: number | undefined, to: number | "new"): string {
    const text = `retention reset on the live source (epoch ${String(from)} → ${to}); replay stays on pinned snapshot ${pinned!.pin.snapshot.snapshotId}; L loads the new live baseline`;
    // What the frame could not show stays said: a reset notice does not hide a hole.
    return pinned!.frameNote === null ? text : `${pinned!.frameNote}; ${text}`;
  }

  function recordDelay(delay: number): void {
    stats.reconnectDelays.push(delay);
    if (stats.reconnectDelays.length > RECONNECT_DELAYS_KEPT) {
      stats.reconnectDelays.splice(0, stats.reconnectDelays.length - RECONNECT_DELAYS_KEPT);
    }
  }

  /** Returns the delay before the next read, or null when polling stops. */
  async function handleFailure(error: unknown): Promise<number | null> {
    const failure = classifyFailure(error);
    switch (failure.kind) {
      case "aborted":
        return null;
      case "auth":
        stopPolling(`auth failed (${failure.status})`);
        notice(`live updates stopped: auth failed (${failure.status}); fix credentials and reopen`);
        return null;
      case "reset": {
        bumpGeneration();
        if (pinned !== null) {
          needsBaseline = true;
          polling = { state: "stopped", reason: "retention reset during replay" };
          notice(resetDuringReplay(snapshot?.retentionEpoch, "new"));
          return null;
        }
        resetRun += 1;
        if (resetRun > 1) {
          // Resets in a row (or a reload that is itself reset): back off like a reconnect.
          const delay = reconnectDelayMs(resetRun - 1, random);
          recordDelay(delay);
          reloadDue = true;
          notice(
            `retention reset again (409, ${resetRun} in a row); reloading the baseline in ${Math.round(delay / 100) / 10}s`
          );
          return delay;
        }
        try {
          await reloadBaseline(true, "retention reset (409): baseline replaced");
          return pollMs;
        } catch (reloadError) {
          return handleFailure(reloadError);
        }
      }
      case "retry": {
        failures += 1;
        const delay = reconnectDelayMs(failures, random);
        recordDelay(delay);
        polling = { state: "reconnecting", reason: failure.message };
        state = reduceDelta(state, {
          kind: "connection",
          connection: { kind: "disconnected", reason: failure.message }
        });
        notice(
          `live source unreachable (${failure.status ?? "network"}); reconnecting in ${Math.round(delay / 100) / 10}s`
        );
        return delay;
      }
      case "fatal":
        stopPolling(`source error (${failure.status})`);
        notice(`live updates stopped: source error ${failure.status}: ${failure.message}`);
        return null;
    }
  }

  // -- details -------------------------------------------------------------------------

  function bumpGeneration(): void {
    generation += 1;
    detailController?.abort();
    detailController = null;
    debounceTimer = clear(debounceTimer);
    selectedKey = null;
  }

  /** Called after every change: a new selection gets a new generation and a debounced load. */
  function afterChange(): void {
    const key = state.selection ? spanKey(state.selection) : null;
    if (key === selectedKey) return;
    bumpGeneration();
    selectedKey = key;
    const selection = state.selection;
    if (selection === null) {
      state = reduceDelta(state, { kind: "detail", detail: null });
      return;
    }
    if (pinned !== null) {
      // A replay frame's detail comes only from records at or before the cutoff.
      state = reduceDelta(state, {
        kind: "detail",
        detail: pinned.state ? detailAtCutoff(pinned.state, selection) : null
      });
      return;
    }
    const cached = cache.get(`d${key}`);
    if (cached !== undefined && cached !== true) {
      state = reduceDelta(state, { kind: "detail", detail: cached });
      return;
    }
    const mine = generation;
    debounceTimer = timers.setTimeout(() => {
      debounceTimer = null;
      void loadDetail(mine, selection);
    }, debounceMs);
  }

  async function loadDetail(mine: number, ref: SpanRef): Promise<void> {
    if (closed || mine !== generation || snapshot === null || !source.details) return;
    if (caps !== null && !caps.values.available) return;
    const pinnedEpoch = epochKey(snapshot);
    const controller = new AbortController();
    detailController = controller;
    const onLifetimeAbort = (): void => controller.abort();
    lifetime.signal.addEventListener("abort", onLifetimeAbort, { once: true });
    stats.detailReads += 1;
    try {
      const evidence = await source.details(snapshot, ref, controller.signal);
      // Stale even if the transport ignored abort: another selection, reset, or close.
      if (closed || mine !== generation || snapshot === null || epochKey(snapshot) !== pinnedEpoch || pinned !== null) {
        stats.staleDetailsIgnored += 1;
        return;
      }
      const detail = detailFromEvidence(evidence);
      cache.set(`d${spanKey(ref)}`, detail);
      state = reduceDelta(state, { kind: "detail", detail });
      invalidate();
    } catch (error) {
      if (closed || mine !== generation) {
        stats.staleDetailsIgnored += 1;
        return;
      }
      if (classifyFailure(error).kind !== "aborted")
        notice(`detail unavailable: ${(error as Error).message ?? String(error)}`);
    } finally {
      lifetime.signal.removeEventListener("abort", onLifetimeAbort);
      if (detailController === controller) detailController = null;
    }
  }

  // -- replay on a pinned snapshot -----------------------------------------------------

  function gate(command: Command): boolean {
    if (caps === null) return true;
    const check = checkCommand(caps, command);
    if (!check.ok) notice(check.notice);
    return check.ok;
  }

  async function loadRecords(pin: SnapshotRef): Promise<{ records: ReplayRecord[]; truncatedReason: string | null }> {
    const refs = state.traces.map((row) => ({
      datasetId: row.datasetId,
      projectId: row.projectId,
      sessionId: row.sessionId,
      traceId: row.traceId
    }));
    const records: ReplayRecord[] = [];
    const budget = Math.max(0, limits.cacheBytes - cache.bytes);
    let used = 0;
    let cursor: string | null = null;
    do {
      const page = await source.records!(
        pin,
        { kind: "traces", refs },
        { limit: RECORD_PAGE_LIMIT, cursor },
        lifetime.signal
      );
      for (const record of page.items) {
        const bytes = jsonBytes(record);
        if (used + bytes > budget) return { records, truncatedReason: `record staging cap ${limits.cacheBytes} bytes` };
        used += bytes;
        records.push(record);
      }
      cursor = page.cursor;
      if (cursor === null && page.truncated) {
        return { records, truncatedReason: page.coverage.reason ?? "source truncated the records" };
      }
    } while (cursor !== null && !closed);
    return { records, truncatedReason: null };
  }

  async function enterReplay(request: ReplayRequest = {}): Promise<void> {
    if (closed || snapshot === null) return;
    if (!gate("seek")) return;
    if (pinned === null) {
      const pin = snapshot;
      let loaded;
      try {
        loaded = await loadRecords(pin);
      } catch (error) {
        if (!closed) notice(`replay unavailable: ${(error as Error).message ?? String(error)}`);
        return;
      }
      if (closed) return;
      const replayPin = pinReplay(loaded.records, pin, { truncatedReason: loaded.truncatedReason });
      pinned = {
        pin: replayPin,
        schedule: scheduleFor(replayPin, request),
        index: -1,
        state: null,
        autoplayPaused: false,
        frameNote: null
      };
      bumpGeneration();
    } else if (request.speed !== undefined || request.stepIntervalMs !== undefined) {
      pinned.schedule = scheduleFor(pinned.pin, request);
    }
    const first = pinned.pin.seqs[0];
    if (first === undefined) {
      state = showReplayFrame(state, viewReplay(), { traces: [], spans: [] }, null);
      notice("replay: the pinned snapshot holds no records");
      return;
    }
    seek(request.seq ?? first);
    if (pinned.schedule.mode === "speed-fallback") {
      const { schedule } = pinned;
      notice(`speed: unavailable(${schedule.reason}); fixed step every ${schedule.intervalMs}ms, n/b stepping works`);
    }
    scheduleAutoplay();
  }

  function scheduleFor(pin: PinnedReplay, request: ReplayRequest): ReplaySchedule {
    return pinnedSchedule(pin, {
      ...(request.speed !== undefined ? { speed: request.speed } : {}),
      ...(request.stepIntervalMs !== undefined ? { stepIntervalMs: request.stepIntervalMs } : {})
    });
  }

  function viewReplay() {
    return { timeline: pinned!.pin.timeline, schedule: pinned!.schedule, index: pinned!.index };
  }

  function seek(seq: number): void {
    if (closed) return;
    if (pinned === null) {
      void enterReplay({ seq });
      return;
    }
    const outcome = seekPinned(pinned.pin, seq);
    if (!outcome.ok) {
      // Explicit refusal; the frame on screen does not move.
      notice(outcome.notice);
      return;
    }
    pinned.index = outcome.index;
    pinned.state = outcome.state;
    const detail = state.selection ? detailAtCutoff(outcome.state, state.selection) : null;
    state = showReplayFrame(state, viewReplay(), outcome.rows, detail);
    selectedKey = state.selection ? spanKey(state.selection) : null;
    const parts: string[] = [];
    if (outcome.hole) {
      if (outcome.hole.nextRecord === null) {
        // Past the last pinned record: the frame is the last recorded state of the LOADED
        // traces, not the dataset at that seq. Say so rather than land there silently.
        parts.push(
          `seq ${outcome.requested}: no pinned record after seq ${outcome.applied} (pinned records cover the loaded traces only${state.retentionGap ? "; earlier records may be gone to retention" : ""}); showing state after seq ${outcome.applied}`
        );
      } else {
        parts.push(
          `seq ${outcome.requested}: no record; showing state after seq ${outcome.applied}, next record at seq ${outcome.hole.nextRecord}`
        );
      }
    }
    if (outcome.knownGaps > 0) parts.push(`${outcome.knownGaps} known loss gap(s) up to this seq`);
    pinned.frameNote = parts.length > 0 ? parts.join("; ") : null;
    if (parts.length > 0) state = { ...state, notice: parts.join("; ") };
    invalidate();
  }

  function step(delta: number): void {
    if (pinned === null) return;
    const seq = stepSeq(pinned.pin, pinned.index, delta);
    if (seq === null) {
      const at = pinned.pin.seqs[pinned.index];
      notice(
        `replay: at the ${delta > 0 ? "last" : "first"} record${at === undefined ? "" : ` (seq ${at})`}; L returns to live`
      );
      return;
    }
    seek(seq);
  }

  function scheduleAutoplay(): void {
    autoplayTimer = clear(autoplayTimer);
    if (closed || pinned === null || pinned.autoplayPaused) return;
    const delay = delayAfter(pinned.pin, pinned.schedule, pinned.index);
    if (delay === null) return;
    autoplayTimer = timers.setTimeout(() => {
      autoplayTimer = null;
      step(1);
      scheduleAutoplay();
    }, delay);
  }

  function setReplaySpeed(speed: number): void {
    if (pinned === null) return notice("speed: no replay session");
    if (!Number.isFinite(speed) || speed < REPLAY_SPEED_MIN || speed > REPLAY_SPEED_MAX) {
      return notice(`speed ${String(speed)}: must be in ${REPLAY_SPEED_MIN}..${REPLAY_SPEED_MAX}`);
    }
    pinned.schedule = scheduleFor(pinned.pin, { speed });
    state = { ...state, replay: viewReplay() };
    if (pinned.schedule.mode === "speed-fallback") {
      notice(
        `speed: unavailable(${pinned.schedule.reason}); fixed step every ${pinned.schedule.intervalMs}ms, n/b stepping works`
      );
    } else invalidate();
    scheduleAutoplay();
  }

  async function returnToLive(): Promise<void> {
    if (pinned === null) {
      state = applyAction(state, { kind: "returnToLive" });
      return;
    }
    autoplayTimer = clear(autoplayTimer);
    const hadReset = needsBaseline;
    pinned = null;
    bumpGeneration();
    state = applyAction(state, { kind: "returnToLive" });
    state = reduceDelta(state, { kind: "behindLive", behind: false });
    try {
      await reloadBaseline(
        hadReset,
        hadReset ? "live baseline loaded after a retention reset (gap)" : "live baseline loaded"
      );
    } catch (error) {
      if (!closed) notice(`live baseline unavailable: ${(error as Error).message ?? String(error)}`);
      return;
    }
    if (polling.state === "stopped" && polling.reason === "retention reset during replay") {
      polling = { state: "active", reason: null };
      schedulePoll(pollMs);
    }
  }

  // -- yank ----------------------------------------------------------------------------

  async function yank(): Promise<void> {
    if (!gate("yank")) return;
    if (!options.clipboard || fallback === null) return notice("yank: unavailable(no clipboard or stdout port)");
    const selection = state.selection;
    if (selection === null) return notice("yank: nothing selected");
    if (pinned !== null) {
      return notice(
        "yank: unavailable(replay frame: the snapshot projection would include later records); L returns to live"
      );
    }
    const document = await documentFor(selection);
    if (closed) return;
    if (typeof document === "string") return notice(`yank: unavailable(${document})`);
    const built = buildCopyDocument(document, state.dsl, options.sanitize ?? {});
    if (!built.ok) return notice(`yank: ${built.reason}`);
    const doc = built.document;
    const label = `kosmo.trace-text/v${doc.version} ${doc.format} (${doc.bytes} bytes${doc.truncated ? ", truncated" : ""})`;
    const line = doc.sourceLineUnavailable ? "; source line unavailable" : "";
    const outcome = await copyToClipboard(doc.text, options.clipboard);
    if (outcome.copied) return notice(`yank: copied ${label} via ${outcome.via}${line}`);
    fallback.queue(doc.text);
    notice(`yank: clipboard unavailable (${outcome.reason}); ${label} will be printed to stdout after exit${line}`);
  }

  // -- value candidates and pair comparison -------------------------------------------

  /** A v2 canonical page with typed value evidence, or why none can be read. */
  async function canonicalV2(selection: TraceSelection, what: string): Promise<VersionedCanonicalPage | string> {
    if (pinned !== null) {
      return `replay frame: the snapshot projection would include later records; L returns to live`;
    }
    if (!source.canonical || snapshot === null || !(caps?.projectionVersions ?? []).includes(2)) {
      return `${what} needs typed value evidence (projection v2)`;
    }
    try {
      const page = await source.canonical(
        snapshot,
        selection,
        { version: 2, detail: 2, values: true },
        lifetime.signal
      );
      return page.version === 2 ? page : `${what} needs typed value evidence (projection v2)`;
    } catch (error) {
      return (error as Error).message ?? String(error);
    }
  }

  function showResult(result: CommandResult): void {
    state = applyAction(state, { kind: "commandResult", result });
    invalidate();
  }

  /** `w`: equal-value candidates for the selected span, searched in its loaded trace. */
  async function valueMatches(): Promise<void> {
    if (!gate("values")) return;
    const selection = state.selection;
    if (selection === null) return notice("values: nothing selected");
    const { datasetId, projectId, sessionId, traceId } = selection;
    const page = await canonicalV2(
      { kind: "trace", ref: { datasetId, projectId, sessionId, traceId } },
      "value matching"
    );
    if (closed) return;
    if (typeof page === "string") return notice(`values: unavailable(${page})`);
    const partial = page.truncated || page.envelope.truncated || page.coverage.scope === "partial";
    const result = findValueCandidates(page.envelope.items, selection, {
      truncated: partial,
      reason: partial ? (page.coverage.reason ?? "loaded page is partial") : null
    });
    showResult({ kind: "values", command: "values", result });
  }

  /** `=` with A and B marked: the shared diffTraces over the two spans. */
  async function comparePair(a: SpanRef, b: SpanRef): Promise<void> {
    const [left, right] = await Promise.all([spanItemV2(a), spanItemV2(b)]);
    if (closed) return;
    if (typeof left === "string") return notice(`compare: A unavailable(${left})`);
    if (typeof right === "string") return notice(`compare: B unavailable(${right})`);
    showResult({ kind: "compare", command: "compare", result: compareSpanPair(left, right) });
  }

  async function spanItemV2(ref: SpanRef): Promise<CanonicalSpanProjectionItemV2 | string> {
    const page = await canonicalV2({ kind: "span", ref }, "compare");
    if (typeof page === "string") return page;
    if (page.version !== 2) return "compare needs typed value evidence (projection v2)";
    const key = spanKey(ref);
    const item = page.envelope.items.find(
      (candidate): candidate is CanonicalSpanProjectionItemV2 =>
        candidate.kind === "span" && spanKey((candidate as CanonicalSpanProjectionItemV2).span) === key
    );
    return item ?? "span is not in the projection";
  }

  /**
   * Canonical v2 pages of loaded traces not read yet (bounded per call), for the span
   * rows, the request selector and the depth rows. Rows come from the source's own v2
   * projection whatever `--projection-version` chose for documents; without v2 the view
   * keeps its trace-summary rows and nothing is invented.
   */
  function loadCanonicalPages(): Promise<void> {
    if (canonicalRun !== null) {
      canonicalAgain = true;
      return canonicalRun;
    }
    canonicalRun = (async () => {
      try {
        do {
          canonicalAgain = false;
          await loadCanonicalOnce();
        } while (canonicalAgain && !closed);
      } finally {
        canonicalRun = null;
      }
    })();
    return canonicalRun;
  }

  async function loadCanonicalOnce(): Promise<void> {
    if (closed || pinned !== null || snapshot === null || !source.canonical) return;
    if (!(caps?.projectionVersions ?? []).includes(2)) return;
    const pin = snapshot;
    const traces = state.traces.filter((row) => !canonicalLoaded.has(traceKey(row))).slice(0, CANONICAL_PAGE_TRACES);
    for (const trace of traces) canonicalLoaded.add(traceKey(trace));
    const pages: CanonicalPageEnvelopeV2[] = [];
    for (const trace of traces) {
      try {
        const page = await source.canonical(
          pin,
          {
            kind: "trace",
            ref: {
              datasetId: trace.datasetId,
              projectId: trace.projectId,
              sessionId: trace.sessionId,
              traceId: trace.traceId
            }
          },
          { version: 2, detail: 2, values: false },
          lifetime.signal
        );
        if (page.version === 2) pages.push(page.envelope);
      } catch {
        // That trace keeps its trace-summary row (reason no-projection-v2).
      }
      if (closed || snapshot === null || epochKey(snapshot) !== epochKey(pin)) return;
    }
    if (pages.length === 0) return;
    const rows = pages.flatMap(spanRowsFromCanonicalV2);
    state = reduceDelta(state, { kind: "canonical", pages });
    state = reduceDelta(state, { kind: "spans", rows });
    trackRows([], rows, pages);
    afterChange();
    invalidate();
  }

  function projectionVersion(): 1 | 2 | null {
    const versions = caps?.projectionVersions ?? [];
    if (options.projectionVersion !== undefined)
      return versions.includes(options.projectionVersion) ? options.projectionVersion : null;
    return versions.includes(2) ? 2 : versions.includes(1) ? 1 : null;
  }

  const documentDetail = options.detail ?? 2;
  function documentValues(): boolean {
    return (options.values ?? true) && caps?.values.level === "full";
  }

  async function documentFor(ref: SpanRef): Promise<EvidenceDocument | string> {
    const version = projectionVersion();
    if (version === null || !source.canonical || snapshot === null) {
      const local = state.detail?.document ?? null;
      if (local !== null && state.selection && spanKey(state.detail!) === spanKey(ref)) return local;
      return caps?.projection.available === false ? caps.projection.reason : "no projection for this version";
    }
    try {
      const page = await source.canonical(
        snapshot,
        { kind: "span", ref },
        { version, detail: documentDetail, values: documentValues() },
        lifetime.signal
      );
      if (page.version === 1) {
        const document = spanDocumentFor(page.envelope, ref);
        if (document === "ambiguous") return "selected span is unknown(ambiguous) in the projection";
        return document ?? "selected span is not in the projection";
      }
      return (
        spanDocumentV2(page.envelope, ref, { detail: documentDetail, values: documentValues() }) ??
        "selected span is not in the projection"
      );
    } catch (error) {
      return (error as Error).message ?? String(error);
    }
  }

  // -- pagination: load more / reload ---------------------------------------------------

  /** `>`: the next page of the SAME pinned snapshot; a foreign/stale cursor is refused by the source. */
  async function loadMore(): Promise<void> {
    if (!gate("loadMore")) return;
    if (pinned !== null) return notice("loadMore: unavailable(replay frame is pinned; L returns to live)");
    if (snapshot === null || pageCursor === null) return notice("loadMore: unavailable(no-more-pages)");
    const pin = snapshot;
    const cursor = pageCursor;
    let page;
    try {
      page = await source.traces(pin, { limit: TRACE_PAGE_LIMIT, cursor }, lifetime.signal);
    } catch (error) {
      if (!closed) notice(`loadMore: unavailable(${(error as Error).message ?? String(error)})`);
      return;
    }
    // A reload or reset while reading: this page belongs to the old snapshot.
    if (closed || snapshot === null || snapshot.snapshotId !== pin.snapshotId || pageCursor !== cursor) return;
    pageCursor = page.cursor;
    const evictedBefore = stats.evictedRows;
    state = reduceDelta(state, { kind: "traces", rows: page.items });
    trackRows(page.items, []);
    state = { ...state, morePages: page.cursor !== null };
    if (stats.evictedRows === evictedBefore) {
      state = reduceDelta(state, {
        kind: "scope",
        scope: {
          loaded: page.coverage.loaded,
          total: page.coverage.total,
          truncated: page.truncated,
          ...(page.coverage.reason === undefined ? {} : { reason: page.coverage.reason })
        }
      });
    }
    const total = page.coverage.total === null ? "" : `/${page.coverage.total}`;
    notice(
      `loaded ${page.items.length} more trace(s): ${page.coverage.loaded}${total}${page.cursor === null ? " (all loaded)" : "; > loads more"}`
    );
    afterChange();
    void loadCanonicalPages();
  }

  /** `r`: an explicit NEW snapshot. Earlier pages and cursors stop being valid. */
  async function reload(): Promise<void> {
    if (!gate("reload")) return;
    if (pinned !== null) return notice("reload: unavailable(replay frame is pinned; L returns to live)");
    const before = snapshot;
    const reread = (source as { reload?: (signal: AbortSignal) => Promise<SourceOpenResult> }).reload;
    let opened: SourceOpenResult;
    try {
      opened = reread ? await reread.call(source, lifetime.signal) : await source.open(lifetime.signal);
    } catch (error) {
      if (!closed) notice(`reload failed: ${(error as Error).message ?? String(error)}`);
      return;
    }
    if (closed) return;
    const gap = before !== null && epochKey(before) !== epochKey(opened.snapshot);
    queue.reset();
    needsBaseline = false;
    bumpGeneration();
    adoptOpen(opened, gap);
    const same = before !== null && before.snapshotId === opened.snapshot.snapshotId;
    state = {
      ...state,
      notice: same
        ? `reloaded: snapshot ${opened.snapshot.snapshotId} unchanged`
        : `reloaded: snapshot ${before?.snapshotId ?? "none"} -> ${opened.snapshot.snapshotId}${gap ? " (retention gap)" : ""}`
    };
    afterChange();
    invalidate();
    void loadCanonicalPages();
  }

  // -- review: f / t / R -------------------------------------------------------------

  /** Review commands name the review capability's reason: `review disabled: <reason>`. */
  function reviewGate(command: "finding" | "todo" | "finalizeReview"): boolean {
    if (caps === null) return review !== null;
    const check = checkCommand(caps, command);
    if (check.ok && review !== null) return true;
    notice(
      check.ok
        ? "review disabled: no review session"
        : check.capability === "review"
          ? `review disabled: ${check.reason}`
          : check.notice
    );
    return false;
  }

  /** `f`/`t` open the `:` prompt prefilled, so the note is typed like any command line. */
  function promptFor(prefix: "finding" | "todo"): void {
    state = applyAction(state, { kind: "command", command: "commandLine" });
    state = applyAction(state, { kind: "commandInput", text: `${prefix} ` });
  }

  function reviewNotice(what: string, result: ReviewResult): void {
    if (!result.ok) return notice(`${what} not saved: ${result.message}`);
    const extra = result.notice === undefined ? "" : `; ${result.notice}`;
    notice(`${what} saved: ${result.path} (revision ${result.revision}, ${result.status})${extra}`);
  }

  /**
   * A finding captures the selection's snapshot evidence through the same document path
   * `y` uses (documentFor → buildEvidence in the review), bound to the pinned snapshot.
   */
  async function addFinding(note: string): Promise<void> {
    if (!reviewGate("finding")) return;
    const selection = state.selection;
    if (selection === null) return notice("finding: nothing selected; select a span, or add a todo with t");
    if (pinned !== null) {
      return notice(
        "finding: unavailable(replay frame: the snapshot projection would include later records); L returns to live"
      );
    }
    const pin = snapshot;
    if (pin === null) return notice("finding: no snapshot loaded");
    const document = await documentFor(selection);
    if (closed) return;
    const key = spanKey(selection);
    const detail = state.detail !== null && spanKey(state.detail) === key ? state.detail : null;
    const row = state.spans.find((candidate) => spanKey(candidate) === key) ?? state.lastKnownSpan;
    const input: FindingInput = {
      note,
      ref: spanRefOf(selection),
      node: detail?.nodeId ?? row?.nodeId ?? null,
      snapshot: {
        snapshotId: pin.snapshotId,
        watermark: pin.watermark ?? 0,
        retentionEpoch: pin.retentionEpoch,
        seq: null
      },
      source: detail?.anchor ? { file: detail.anchor.file, line: detail.anchor.line, column: null } : null,
      evidence: typeof document === "string" ? null : document
    };
    reviewNotice("finding", await review!.addFinding(input));
  }

  async function addTodo(note: string): Promise<void> {
    if (!reviewGate("todo")) return;
    reviewNotice("todo", await review!.addTodo(note));
  }

  async function finalizeReview(): Promise<void> {
    if (!reviewGate("finalizeReview")) return;
    const result = await review!.finalize();
    if (!result.ok) return notice(`review not finalized: ${result.message}`);
    notice(`review ${result.status}: ${result.path} (revision ${result.revision})`);
  }

  // -- the : command line ------------------------------------------------------------

  /**
   * Run a submitted line against the state AS IT WAS at submit time. `finding`, `todo`
   * and `js` are session commands; everything else goes to commands.ts.
   */
  async function submitLine(line: string, at: ViewState): Promise<void> {
    const own = /^\s*:?\s*(finding|todo|js)(?:[ \t]+([\s\S]*))?$/.exec(line);
    if (own) {
      const rest = (own[2] ?? "").trim();
      if (own[1] === "finding") return addFinding(rest);
      if (own[1] === "todo") return addTodo(rest);
      return runJs(rest);
    }
    let outcome;
    try {
      outcome = await runCommandLine(at, line, { liveSeek: true, ...options.commands });
    } catch (error) {
      if (!closed) notice(`command failed: ${(error as Error).message ?? String(error)}`);
      return;
    }
    if (closed || outcome === null) return;
    for (const action of outcome.actions) {
      if (action.kind === "quit") {
        void close();
        options.onExit?.();
        return;
      }
      dispatch(action);
    }
    showResult(outcome.result);
  }

  /** `:js <expression>`: trusted local code in the eval child over the pinned snapshot. */
  async function runJs(code: string): Promise<void> {
    if (!gate("eval")) return;
    if (code === "") return notice("usage: :js <expression>");
    const snap = options.evalSnapshot?.() ?? { unavailable: "no-eval-snapshot" };
    if ("unavailable" in snap) return notice(`eval: unavailable(${snap.unavailable})`);
    const outcome = await (options.runEval ?? runLocalEval)({
      code,
      snapshot: snap,
      env: options.evalEnv ?? {},
      signal: lifetime.signal
    });
    if (closed) return;
    if (!outcome.ok) return notice(`js failed: ${outcome.code}: ${outcome.message}`);
    showResult({ kind: "value", command: "js", envelope: outcome.envelope });
  }

  // -- keys and actions ----------------------------------------------------------------

  function press(key: string): void {
    if (closed) return;
    const action =
      state.searchInput !== null
        ? decodeSearchKey(key)
        : state.bookmarkList !== null
          ? decodeBookmarkKey(key)
          : state.commandLine !== null
            ? decodeCommandLineKey(key)
            : decodeKey(key);
    if (!action) return;
    if (action.kind === "quit") {
      void close();
      options.onExit?.();
      return;
    }
    dispatch(action);
    paintNow();
  }

  function dispatch(action: Action): void {
    if (closed) return;
    if (state.notice !== null) state = { ...state, notice: null };
    switch (action.kind) {
      case "replayStep":
        if (pinned !== null) {
          if (gate("replayStep")) step(action.delta);
          return;
        }
        break;
      case "replaySeek":
        if (pinned !== null || (caps !== null && source.records)) {
          if (gate("seek")) seek(action.seq);
          return;
        }
        break;
      case "returnToLive":
        if (pinned !== null) {
          if (gate("returnToLive")) void returnToLive();
          return;
        }
        break;
      case "togglePause":
        if (pinned !== null) {
          // In replay, `p` pauses autoplay; live capture is untouched.
          pinned.autoplayPaused = !pinned.autoplayPaused;
          notice(pinned.autoplayPaused ? "replay autoplay paused" : "replay autoplay resumed");
          scheduleAutoplay();
          return;
        }
        {
          const wasPaused = state.paused;
          state = applyAction(state, action);
          if (wasPaused && !state.paused) void drainQueue();
        }
        afterChange();
        return;
      case "commandSubmit": {
        const line = state.commandLine?.text ?? null;
        state = applyAction(state, action);
        if (line !== null) void submitLine(line, state);
        return;
      }
      case "command":
        if (action.command === "loadMore") {
          void loadMore();
          return;
        }
        if (action.command === "reload") {
          void reload();
          return;
        }
        if (action.command === "finding" || action.command === "todo") {
          if (reviewGate(action.command)) promptFor(action.command);
          return;
        }
        if (action.command === "finalizeReview") {
          void finalizeReview();
          return;
        }
        if (action.command === "yank") {
          void yank();
          return;
        }
        if (action.command === "values") {
          void valueMatches();
          return;
        }
        if (action.command === "compare") {
          state = applyAction(state, action);
          if (state.compareRefs.length === 2) void comparePair(state.compareRefs[0]!, state.compareRefs[1]!);
          afterChange();
          return;
        }
        break;
      case "setDepth":
      case "depthStep":
        state = applyAction(state, action);
        if (state.canonical.length === 0) void loadCanonicalPages();
        afterChange();
        return;
      default:
        break;
    }
    state = applyAction(state, action);
    afterChange();
  }

  async function drainQueue(): Promise<void> {
    if (queue.overflowed > 0 || needsBaseline) {
      const refused = queue.overflowed;
      try {
        await reloadBaseline(
          true,
          refused > 0
            ? `frame queue overflow: ${refused} frame(s) refused while paused; baseline reloaded (gap)`
            : "retention reset while paused: baseline reloaded (gap)"
        );
      } catch (error) {
        if (!closed) notice(`live baseline unavailable: ${(error as Error).message ?? String(error)}`);
      }
      return;
    }
    for (const frame of queue.drain()) applyFrame(frame);
    afterChange();
    invalidate();
    void loadCanonicalPages();
  }

  // -- lifecycle -----------------------------------------------------------------------

  async function start(): Promise<void> {
    const opened = await source.open(lifetime.signal);
    if (closed) return;
    caps = effectiveCapabilities(opened, source, policy);
    if (caps.review.available) {
      // Review is a session capability: the port decides (project root, -r, writable dir).
      try {
        review = options.review ? await options.review(opened) : null;
      } catch (error) {
        review = null;
        caps = {
          ...caps,
          review: { available: false, reason: `review unavailable: ${(error as Error).message ?? String(error)}` }
        };
      }
      if (closed) return;
      if (review === null && caps.review.available)
        caps = { ...caps, review: { available: false, reason: "no-review-session" } };
      else if (review !== null && !review.capability.enabled)
        caps = { ...caps, review: { available: false, reason: review.capability.reason } };
    }
    const size = terminal?.size() ?? { cols: 80, rows: 24 };
    state = initialViewState({
      caps,
      ...(options.depth !== undefined ? { depth: options.depth } : {}),
      ...(options.depthMapping !== undefined ? { depthMapping: options.depthMapping } : {}),
      viewportHeight: Math.max(1, size.rows - 4),
      connection: sourceConnection(opened.firstPage.items.length > 0)
    });
    adoptOpen(opened, false);
    void loadCanonicalPages();
    terminal?.onKey(press);
    terminal?.onResize((next) => {
      state = reduceDelta(state, { kind: "resize", viewportHeight: Math.max(1, next.rows - 4) });
      paintNow();
    });
    const polls = source.kind !== "sqlite" && source.kind !== "export" && caps.follow.available;
    if (polls) {
      polling = { state: "active", reason: null };
      schedulePoll(pollMs);
    }
    if (options.replay) await enterReplay(options.replay);
    paintNow();
  }

  async function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      pollTimer = clear(pollTimer);
      redrawTimer = clear(redrawTimer);
      debounceTimer = clear(debounceTimer);
      autoplayTimer = clear(autoplayTimer);
      polling = { state: "stopped", reason: "closed" };
      detailController?.abort();
      lifetime.abort();
      // Restores the screen first; the wrapped close then flushes the copy fallback.
      if (terminal) terminal.close();
      else fallback?.flush();
      try {
        await review?.close();
      } catch {
        // The review lock is advisory; a stale one is reclaimed by the next session.
      }
      try {
        await source.close();
      } catch {
        // Closing is best effort; the terminal is already restored.
      }
    })();
    return closing;
  }

  return {
    terminal,
    start,
    state: () => state,
    snapshot: () => snapshot,
    press,
    dispatch,
    enterReplay,
    seek,
    setReplaySpeed,
    returnToLive,
    yank,
    stats: () => ({
      ...stats,
      reconnectDelays: [...stats.reconnectDelays],
      queueFrames: queue.size,
      queueBytes: queue.bytes,
      queueRefused: queue.overflowed,
      cacheBytes: cache.bytes,
      cacheEntries: cache.size,
      polling
    }),
    close
  };
}

/** The v2 trace-text document narrowed to one span by full ref. */
function spanDocumentV2(
  envelope: CanonicalPageEnvelopeV2,
  ref: SpanRef,
  options: { detail: 0 | 1 | 2; values: boolean }
): TraceTextDocumentV2 | null {
  try {
    const document = projectTraceTextDocumentV2(envelope, options);
    const items = document.items.filter(
      (item) =>
        item.kind === "span" &&
        item.ref.datasetId === ref.datasetId &&
        item.ref.projectId === ref.projectId &&
        item.ref.sessionId === ref.sessionId &&
        item.ref.traceId === ref.traceId &&
        item.ref.spanId === ref.spanId
    );
    return items.length === 0 ? null : { ...document, items };
  } catch {
    return null;
  }
}

/**
 * Span rows of one canonical v2 page: full refs, the recorded parent when it is in the
 * same trace ref AND in the page (otherwise the row is a re-rooted orphan, never attached
 * to a guess), depth by the parent chain with a cycle guard.
 */
export function spanRowsFromCanonicalV2(envelope: CanonicalPageEnvelopeV2): SpanRow[] {
  const items = envelope.items.filter((item): item is CanonicalSpanProjectionItemV2 => item.kind === "span");
  const byKey = new Map(items.map((item) => [spanKey(item.span), item]));
  const parentOf = (item: CanonicalSpanProjectionItemV2): CanonicalSpanProjectionItemV2 | null => {
    if (item.parent.state !== "known") return null;
    const parent = item.parent.span;
    if (traceKey(parent) !== traceKey(item.span)) return null;
    return byKey.get(spanKey(parent)) ?? null;
  };
  return items.map((item) => {
    const parent = parentOf(item);
    let depth = 0;
    const seen = new Set<string>([spanKey(item.span)]);
    for (let at = parent; at !== null && !seen.has(spanKey(at.span)); at = parentOf(at)) {
      seen.add(spanKey(at.span));
      depth += 1;
    }
    return {
      ...spanRefOf(item.span),
      parentSpanId: parent === null ? null : parent.span.spanId,
      nodeId: item.node.nodeId,
      depth,
      errored: item.error.state === "recorded",
      ...(item.spanKind ? { spanKind: item.spanKind } : {}),
      ...(routeOf(item) === undefined ? {} : { route: routeOf(item) })
    };
  });
}

/** The framework route recorded on a span (`/orders/:orderId`), when there is one. */
function routeOf(item: CanonicalSpanProjectionItemV2): string | undefined {
  if (item.framework.state !== "recorded") return undefined;
  const route = (item.framework.value as { route?: unknown }).route;
  return typeof route === "string" && route.length > 0 ? route : undefined;
}
