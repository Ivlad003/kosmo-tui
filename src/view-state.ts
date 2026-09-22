/**
 * Pure view state for the interactive viewer (design D6), ported from kosmo-callflow
 * `packages/cli/src/connect/view-state.ts`.
 *
 * Deliberately independent of the wire format and of any daemon type: the caller maps
 * projection pages and deltas onto the small row shapes below. That keeps stable
 * selection, pause semantics and the distinct "nothing to show" states testable as
 * plain data.
 *
 * Identity is the full qualified ref `(datasetId, projectId, sessionId, traceId,
 * spanId)`, never a bare id and never a list index. Two sessions that reuse the same
 * traceId/spanId are two different spans: selecting, expanding or dropping one of them
 * must not touch the other. Keys are the shared `replayTraceKey`/`replaySpanKey` from
 * `@kosmo-callflow/replay`, so the viewer and the replay reducer cannot disagree about
 * what "the same span" means.
 */

import type { TraceTextDocumentV1 } from "@kosmo-callflow/protocol";
import { replaySpanKey, replayTraceKey, type ReplaySpanRef, type ReplayTraceRef } from "@kosmo-callflow/replay";
import { isBookmarked, toggleBookmark, type Bookmark } from "./bookmarks.js";
import { checkCommand, type Capabilities, type Command } from "./capabilities.js";
import {
  backspace,
  clearLine,
  insertText,
  openCommandLine,
  pushHistory,
  stepHistory,
  type CommandLineInput
} from "./command-line.js";
import type { CommandResult, DepthLevel } from "./commands.js";
import { stepIndex, type ReplaySchedule, type ReplayTimeline } from "./replay.js";

/** Full identity of one trace: `(datasetId, projectId, sessionId, traceId)`. */
export type TraceRef = ReplayTraceRef;
/** Full identity of one span: `(datasetId, projectId, sessionId, traceId, spanId)`. */
export type SpanRef = ReplaySpanRef;

/** Stable map key of a trace ref; extra fields on the argument are ignored. */
export function traceKey(ref: TraceRef): string {
  return replayTraceKey(ref);
}

/** Stable map key of a span ref; extra fields on the argument are ignored. */
export function spanKey(ref: SpanRef): string {
  return replaySpanKey(ref);
}

/** Copy exactly the five identity fields, so a row never leaks into a selection. */
export function spanRefOf(ref: SpanRef): SpanRef {
  return {
    datasetId: ref.datasetId,
    projectId: ref.projectId,
    sessionId: ref.sessionId,
    traceId: ref.traceId,
    spanId: ref.spanId
  };
}

export function sameTrace(left: TraceRef, right: TraceRef): boolean {
  return traceKey(left) === traceKey(right);
}

export function sameSpan(left: SpanRef, right: SpanRef): boolean {
  return spanKey(left) === spanKey(right);
}

export type TraceRow = TraceRef & {
  /**
   * The projection's own vocabulary, deliberately not renamed: translating "complete"
   * to "completed" here would create a second spelling of the same fact.
   */
  status: "running" | "complete" | "errored";
  startedAt: number;
  spanCount: number;
};

export type SpanRow = SpanRef & {
  /** Parent spanId inside the same trace ref; null for a root or a re-rooted orphan. */
  parentSpanId: string | null;
  nodeId: string;
  depth: number;
  errored: boolean;
  /** Semantic span kind when the projection records one; absent on v1 summaries. */
  spanKind?: string;
};

export type Selection = SpanRef | null;

/**
 * One recorded value in the details pane.
 *
 * Every non-recorded case carries its own marker. A missing value is never rendered as
 * an empty string or as a plausible-looking default.
 */
export type DetailValue =
  | { state: "recorded"; text: string }
  | { state: "masked" }
  | { state: "not-recorded" }
  | { state: "unavailable"; reason: string };

export type DetailDuration = { state: "recorded"; ms: number } | { state: "unavailable"; reason: string };

/** Code anchor for the selected span. `line` is null when no line evidence exists. */
export type DetailAnchor = { file: string; symbol: string; line: number | null };

export type SpanDetail = SpanRef & {
  nodeId: string;
  status: TraceRow["status"];
  args: DetailValue;
  ret: DetailValue;
  error: DetailValue;
  duration: DetailDuration;
  anchor: DetailAnchor;
  /**
   * The span as a trace-text document, kept so the `d` toggle can render it in either
   * dialect through the protocol's own renderer instead of a private codec.
   */
  document: TraceTextDocumentV1 | null;
};

/**
 * Why the selected row is not currently in the visible list: its trace aged out of
 * retention, a filter hides it, or its row was evicted from the loaded scope while the
 * trace is still loaded.
 */
export type SelectionAbsence = "retention" | "filter" | "evicted" | null;

/** Filters apply to the loaded scope only; `scope` in state says how much that is. */
export type Filters = {
  errorsOnly: boolean;
  /** `/` search: substring of the node id. */
  search: string | null;
  /** Exact node id. */
  nodeId?: string | null;
  /** Exact semantic span kind; rows without a kind never match. */
  spanKind?: string | null;
};

/** How much of the dataset is loaded; filters and search run over this much only. */
export type LoadedScope = {
  loaded: number;
  total: number | null;
  truncated: boolean;
};

/** Reserved command keys whose actions arrive in later waves; they still gate on caps. */
export type ReservedCommand = Extract<
  Command,
  "finding" | "todo" | "finalizeReview" | "yank" | "compare" | "commandLine"
>;

/**
 * The no-data states the spec requires be told apart: "daemon unreachable", "SDK not
 * attached" and "attached but nothing recorded yet" need different user action.
 */
export type ConnectionState =
  | { kind: "disconnected"; reason: string }
  | { kind: "connected"; sdk: "absent" }
  | { kind: "connected"; sdk: "present"; events: "none" }
  | { kind: "connected"; sdk: "present"; events: "flowing" };

/**
 * An active replay session. `null` means the view is live. It is never cleared by
 * reaching the end of the recording — only by the explicit `returnToLive` action.
 */
export type ReplaySession = {
  timeline: ReplayTimeline;
  schedule: ReplaySchedule;
  /** Position in `timeline.frames`; -1 before the first frame is shown. */
  index: number;
};

export type ViewState = {
  connection: ConnectionState;
  traces: TraceRow[];
  spans: SpanRow[];
  selection: Selection;
  selectionAbsence: SelectionAbsence;
  /** Last known rendering of the selection, kept so a pinned selection can still show detail. */
  lastKnownSpan: SpanRow | null;
  /** Expanded spans, keyed by `spanKey` — never by bare spanId. */
  expanded: Set<string>;
  focus: "list" | "detail";
  view: "tree" | "table";
  dsl: "lisp" | "tab";
  filters: Filters;
  paused: boolean;
  /** Deltas folded while paused, applied on resume. Bounded by backlogCap. */
  backlog: Delta[];
  backlogCap: number;
  backlogOverflowed: boolean;
  behindLive: boolean;
  retentionGap: boolean;
  effectivePolicy: string | null;
  replay: ReplaySession | null;
  detail: SpanDetail | null;
  /** Live search buffer while the `/` prompt is open; null when it is closed. */
  searchInput: string | null;
  /**
   * Index of the first visible row. Held in state, not derived, so rows inserted above
   * the selection can be compensated for and the selected row keeps its screen position.
   */
  scrollTop: number;
  /** Rows available for the list body; the terminal layer keeps this in sync on resize. */
  viewportHeight: number;
  /**
   * Effective capabilities (capabilities.ts). null is the legacy viewer, which gates
   * nothing and keeps the kosmo-callflow footer.
   */
  caps: Capabilities | null;
  /** One-line notice for the last explicit command, e.g. `replayStep: unavailable(...)`. */
  notice: string | null;
  /** Session bookmarks by full ref; they survive reloads and eviction. */
  bookmarks: Bookmark[];
  /** The `'` jump list while open. */
  bookmarkList: { index: number } | null;
  stackOpen: boolean;
  scope: LoadedScope | null;
  /** The `:` prompt while open; null when closed. */
  commandLine: CommandLineInput | null;
  /** Submitted `:` lines, oldest first; bounded by COMMAND_HISTORY_CAP. */
  commandHistory: string[];
  /** Typed result of the last query command, shown in the result pane; esc closes it. */
  commandResult: CommandResult | null;
  /** `:depth` level for the shared canonical depth projection; null is the default view. */
  depth: DepthLevel | null;
};

export type Delta =
  | { kind: "traces"; rows: TraceRow[] }
  | { kind: "spans"; rows: SpanRow[] }
  | { kind: "retention"; dropped: TraceRef[] }
  | { kind: "behindLive"; behind: boolean }
  | { kind: "connection"; connection: ConnectionState }
  | { kind: "policy"; effectivePolicy: string }
  | { kind: "resize"; viewportHeight: number }
  | { kind: "detail"; detail: SpanDetail | null }
  /** Span rows dropped from the bounded cache; their traces stay loaded. */
  | { kind: "evict"; spans: SpanRef[] }
  | { kind: "scope"; scope: LoadedScope };

export type Action =
  | { kind: "move"; delta: number }
  | { kind: "moveTo"; edge: "first" | "last" }
  | { kind: "focus"; pane: "list" | "detail" }
  | { kind: "expand" }
  | { kind: "collapse" }
  | { kind: "toggleExpand" }
  | { kind: "togglePause" }
  | { kind: "toggleView" }
  | { kind: "toggleDsl" }
  | { kind: "search" }
  | { kind: "searchInput"; text: string }
  | { kind: "searchBackspace" }
  | { kind: "searchCommit" }
  | { kind: "searchCancel" }
  | { kind: "filterErrorsOnly" }
  | { kind: "clearSelection" }
  | { kind: "replayStep"; delta: number }
  | { kind: "returnToLive" }
  | {
      kind: "setFilter";
      nodeId?: string | null;
      spanKind?: string | null;
      errorsOnly?: boolean;
      search?: string | null;
    }
  | { kind: "bookmark" }
  | { kind: "openBookmarks" }
  | { kind: "bookmarkMove"; delta: number }
  | { kind: "bookmarkJump" }
  | { kind: "bookmarkClose" }
  | { kind: "toggleStack" }
  | { kind: "command"; command: ReservedCommand }
  // The `:` command line (commands.ts runs the submitted line).
  | { kind: "commandInput"; text: string }
  | { kind: "commandBackspace" }
  | { kind: "commandClearLine" }
  | { kind: "commandHistory"; delta: number }
  | { kind: "commandCancel" }
  | { kind: "commandSubmit" }
  | { kind: "commandResult"; result: CommandResult }
  | { kind: "closeCommandResult" }
  | { kind: "replaySeek"; seq: number }
  | { kind: "setDepth"; level: DepthLevel }
  | { kind: "selectRef"; ref: SpanRef }
  | { kind: "quit" };

export const defaultBacklogCap = 1_000;

export function initialViewState(overrides: Partial<ViewState> = {}): ViewState {
  return {
    connection: { kind: "disconnected", reason: "not connected" },
    traces: [],
    spans: [],
    selection: null,
    selectionAbsence: null,
    lastKnownSpan: null,
    expanded: new Set<string>(),
    focus: "list",
    view: "tree",
    dsl: "lisp",
    filters: { errorsOnly: false, search: null },
    paused: false,
    backlog: [],
    backlogCap: defaultBacklogCap,
    backlogOverflowed: false,
    behindLive: false,
    retentionGap: false,
    effectivePolicy: null,
    replay: null,
    detail: null,
    searchInput: null,
    scrollTop: 0,
    viewportHeight: 20,
    caps: null,
    notice: null,
    bookmarks: [],
    bookmarkList: null,
    stackOpen: false,
    scope: null,
    commandLine: null,
    commandHistory: [],
    commandResult: null,
    depth: null,
    ...overrides
  };
}

/**
 * Fold a delta from the projection stream.
 *
 * While paused the delta is queued rather than applied: pause freezes the view only. It
 * must not unsubscribe and must never touch capture policy.
 */
export function applyDelta(state: ViewState, delta: Delta): ViewState {
  if (state.paused) {
    if (state.backlog.length >= state.backlogCap) {
      // Record the gap instead of dropping silently.
      return { ...state, backlogOverflowed: true, retentionGap: true };
    }
    return { ...state, backlog: [...state.backlog, delta] };
  }
  return reduceDelta(state, delta);
}

function reduceDelta(state: ViewState, delta: Delta): ViewState {
  switch (delta.kind) {
    case "traces":
      return preservingScreenRow(state, (draft) => ({ ...draft, traces: mergeTraces(draft.traces, delta.rows) }));
    case "spans":
      return preservingScreenRow(state, (draft) => ({ ...draft, spans: mergeSpans(draft.spans, delta.rows) }));
    case "retention": {
      // Dropped by full trace ref: another session's trace with the same traceId stays.
      const dropped = new Set(delta.dropped.map(traceKey));
      return preservingScreenRow(state, (draft) => ({
        ...draft,
        traces: draft.traces.filter((row) => !dropped.has(traceKey(row))),
        spans: draft.spans.filter((row) => !dropped.has(traceKey(row))),
        retentionGap: true
      }));
    }
    case "behindLive":
      return { ...state, behindLive: delta.behind };
    case "connection":
      return { ...state, connection: delta.connection };
    case "policy":
      return { ...state, effectivePolicy: delta.effectivePolicy };
    case "resize":
      return { ...state, viewportHeight: Math.max(1, Math.floor(delta.viewportHeight)) };
    case "detail":
      return { ...state, detail: delta.detail };
    case "evict": {
      const evicted = new Set(delta.spans.map(spanKey));
      return preservingScreenRow(state, (draft) => ({
        ...draft,
        spans: draft.spans.filter((row) => !evicted.has(spanKey(row)))
      }));
    }
    case "scope":
      return { ...state, scope: delta.scope };
  }
}

/**
 * Apply a list mutation while keeping the viewport anchored: the selected row stays on
 * the same screen line as rows sort in around it. When the selection is not on screen
 * (hidden, evicted, or no selection), the row at the top of the viewport is the anchor
 * instead, so arrivals above it do not scroll the view either.
 */
function preservingScreenRow(state: ViewState, mutate: (draft: ViewState) => ViewState): ViewState {
  const rowsBefore = visibleSpans(state);
  const next = resolveSelection(mutate(state));
  const rowsAfter = visibleSpans(next);
  const selected = state.selection ? spanKey(state.selection) : null;
  const selBefore = selected === null ? -1 : rowsBefore.findIndex((row) => spanKey(row) === selected);
  const selAfter = selected === null ? -1 : rowsAfter.findIndex((row) => spanKey(row) === selected);
  if (selBefore !== -1 && selAfter !== -1) {
    return { ...next, scrollTop: Math.max(0, next.scrollTop + (selAfter - selBefore)) };
  }
  const top = Math.min(state.scrollTop, Math.max(0, rowsBefore.length - Math.max(1, state.viewportHeight)));
  const anchor = rowsBefore[top];
  if (!anchor) return next;
  const anchorKey = spanKey(anchor);
  const anchorAfter = rowsAfter.findIndex((row) => spanKey(row) === anchorKey);
  if (anchorAfter === -1) return next;
  return { ...next, scrollTop: Math.max(0, next.scrollTop + (anchorAfter - top)) };
}

/** Index of the selection within the currently visible rows, or -1. */
export function selectionIndex(state: ViewState): number {
  if (!state.selection) return -1;
  const key = spanKey(state.selection);
  return visibleSpans(state).findIndex((row) => spanKey(row) === key);
}

function mergeTraces(current: TraceRow[], incoming: TraceRow[]): TraceRow[] {
  const byKey = new Map(current.map((row) => [traceKey(row), row]));
  for (const row of incoming) byKey.set(traceKey(row), row);
  // Newest first; the full key is the final tie-break so two sessions that reuse a
  // traceId still sort deterministically.
  return [...byKey.values()].sort(
    (left, right) =>
      right.startedAt - left.startedAt ||
      left.traceId.localeCompare(right.traceId) ||
      traceKey(left).localeCompare(traceKey(right))
  );
}

function mergeSpans(current: SpanRow[], incoming: SpanRow[]): SpanRow[] {
  const byKey = new Map(current.map((row) => [spanKey(row), row]));
  for (const row of incoming) byKey.set(spanKey(row), row);
  return [...byKey.values()];
}

/**
 * Recompute why a selection is not visible, without ever moving it. A selection that
 * falls out of retention or is hidden by a filter stays pinned; it is cleared only by an
 * explicit user action.
 */
function resolveSelection(state: ViewState): ViewState {
  if (!state.selection) return { ...state, selectionAbsence: null };
  const key = spanKey(state.selection);
  const span = state.spans.find((row) => spanKey(row) === key);
  if (!span) {
    const trace = traceKey(state.selection);
    const traceStillPresent = state.traces.some((row) => traceKey(row) === trace);
    return { ...state, selectionAbsence: traceStillPresent ? "evicted" : "retention" };
  }
  if (!passesFilters(span, state.filters)) {
    return { ...state, selectionAbsence: "filter", lastKnownSpan: span };
  }
  return { ...state, selectionAbsence: null, lastKnownSpan: span };
}

export function passesFilters(span: SpanRow, filters: Filters): boolean {
  if (filters.errorsOnly && !span.errored) return false;
  if (filters.search && !span.nodeId.includes(filters.search)) return false;
  if (filters.nodeId && span.nodeId !== filters.nodeId) return false;
  if (filters.spanKind && span.spanKind !== filters.spanKind) return false;
  return true;
}

export function filtersActive(filters: Filters): boolean {
  return filters.errorsOnly || Boolean(filters.search) || Boolean(filters.nodeId) || Boolean(filters.spanKind);
}

/** The pinned selection that is not on screen, with why; null when it is visible or unset. */
export type SelectedPlaceholder = {
  ref: SpanRef;
  reason: Exclude<SelectionAbsence, null>;
  lastKnown: SpanRow | null;
};

export function selectedPlaceholder(state: ViewState): SelectedPlaceholder | null {
  if (!state.selection || state.selectionAbsence === null) return null;
  const last = state.lastKnownSpan && sameSpan(state.lastKnownSpan, state.selection) ? state.lastKnownSpan : null;
  return { ref: spanRefOf(state.selection), reason: state.selectionAbsence, lastKnown: last };
}

/** Key of a span's parent inside the same trace ref, or null for a root. */
export function parentKey(span: SpanRow): string | null {
  return span.parentSpanId === null ? null : spanKey({ ...span, spanId: span.parentSpanId });
}

/** Spans currently eligible for display, in stable tree order. */
export function visibleSpans(state: ViewState): SpanRow[] {
  return state.spans
    .filter((span) => passesFilters(span, state.filters))
    .filter((span) => {
      const parent = parentKey(span);
      return parent === null || state.expanded.has(parent);
    })
    .sort(
      (left, right) =>
        left.depth - right.depth ||
        left.spanId.localeCompare(right.spanId) ||
        spanKey(left).localeCompare(spanKey(right))
    );
}

/** The capability-gated command behind an action, if any. */
function commandOf(action: Action): Command | null {
  switch (action.kind) {
    case "replayStep":
      return "replayStep";
    case "returnToLive":
      return "returnToLive";
    case "togglePause":
      return "pause";
    case "bookmark":
      return "bookmark";
    case "openBookmarks":
      return "bookmarkList";
    case "toggleStack":
      return "stack";
    case "replaySeek":
      return "seek";
    case "setDepth":
      return "depth";
    case "command":
      return action.command;
    default:
      return null;
  }
}

export function applyAction(current: ViewState, action: Action): ViewState {
  // A notice answers exactly one command; the next action clears it.
  const state = current.notice === null ? current : { ...current, notice: null };
  const command = commandOf(action);
  if (command !== null && state.caps !== null) {
    const check = checkCommand(state.caps, command);
    // An explicit command the session cannot serve says so; it is never a silent no-op.
    if (!check.ok) return { ...state, notice: check.notice };
  }
  switch (action.kind) {
    case "move":
      return moveSelection(state, action.delta);
    case "moveTo": {
      const rows = visibleSpans(state);
      if (rows.length === 0) return state;
      const target = action.edge === "first" ? rows[0]! : rows[rows.length - 1]!;
      return select(state, target);
    }
    case "focus":
      return { ...state, focus: action.pane };
    case "expand":
      return state.selection ? { ...state, expanded: withAdded(state.expanded, spanKey(state.selection)) } : state;
    case "collapse":
      return state.selection ? { ...state, expanded: withRemoved(state.expanded, spanKey(state.selection)) } : state;
    case "toggleExpand": {
      if (!state.selection) return state;
      const key = spanKey(state.selection);
      return {
        ...state,
        expanded: state.expanded.has(key) ? withRemoved(state.expanded, key) : withAdded(state.expanded, key)
      };
    }
    case "togglePause":
      return state.paused ? resume(state) : { ...state, paused: true };
    case "toggleView":
      return { ...state, view: state.view === "tree" ? "table" : "tree" };
    case "toggleDsl":
      return { ...state, dsl: state.dsl === "lisp" ? "tab" : "lisp" };
    case "search":
      // Opening the prompt seeds it with the active search, so refining a filter does
      // not mean retyping it.
      return { ...state, searchInput: state.filters.search ?? "" };
    case "searchInput":
      return state.searchInput === null ? state : { ...state, searchInput: state.searchInput + action.text };
    case "searchBackspace":
      return state.searchInput === null || state.searchInput.length === 0
        ? state
        : { ...state, searchInput: state.searchInput.slice(0, -1) };
    case "searchCommit": {
      if (state.searchInput === null) return state;
      const search = state.searchInput.length === 0 ? null : state.searchInput;
      // Not a move: a filter that hides the selected span pins it and explains itself
      // rather than retargeting the selection.
      return preservingScreenRow(state, (draft) => ({
        ...draft,
        searchInput: null,
        filters: { ...draft.filters, search }
      }));
    }
    case "searchCancel":
      return state.searchInput === null ? state : { ...state, searchInput: null };
    case "filterErrorsOnly":
      return preservingScreenRow(state, (draft) => ({
        ...draft,
        filters: { ...draft.filters, errorsOnly: !draft.filters.errorsOnly }
      }));
    case "setFilter":
      return preservingScreenRow(state, (draft) => ({
        ...draft,
        filters: {
          ...draft.filters,
          ...(action.nodeId !== undefined ? { nodeId: action.nodeId || null } : {}),
          ...(action.spanKind !== undefined ? { spanKind: action.spanKind || null } : {}),
          ...(action.errorsOnly !== undefined ? { errorsOnly: action.errorsOnly } : {}),
          ...(action.search !== undefined ? { search: action.search || null } : {})
        }
      }));
    case "bookmark":
      return markSelection(state);
    case "openBookmarks":
      return state.bookmarks.length === 0
        ? { ...state, notice: "bookmarks: none yet (m marks the selected span)" }
        : { ...state, bookmarkList: { index: 0 } };
    case "bookmarkMove":
      return state.bookmarkList === null
        ? state
        : {
            ...state,
            bookmarkList: { index: clamp(state.bookmarkList.index + action.delta, 0, state.bookmarks.length - 1) }
          };
    case "bookmarkJump":
      return jumpToBookmark(state);
    case "bookmarkClose":
      return state.bookmarkList === null ? state : { ...state, bookmarkList: null };
    case "toggleStack":
      return { ...state, stackOpen: !state.stackOpen };
    case "command":
      if (action.command === "commandLine") return { ...state, commandLine: openCommandLine() };
      // Capability passed; the action itself lands in a later wave. Say so visibly.
      return { ...state, notice: `${action.command}: not available in this build yet` };
    case "commandInput":
      return state.commandLine === null ? state : { ...state, commandLine: insertText(state.commandLine, action.text) };
    case "commandBackspace":
      return state.commandLine === null ? state : { ...state, commandLine: backspace(state.commandLine) };
    case "commandClearLine":
      return state.commandLine === null ? state : { ...state, commandLine: clearLine(state.commandLine) };
    case "commandHistory":
      return state.commandLine === null
        ? state
        : { ...state, commandLine: stepHistory(state.commandLine, state.commandHistory, action.delta) };
    case "commandCancel":
      return state.commandLine === null ? state : { ...state, commandLine: null };
    case "commandSubmit":
      // Closes the prompt and records the line; the caller runs it (commands.ts).
      return state.commandLine === null
        ? state
        : { ...state, commandLine: null, commandHistory: pushHistory(state.commandHistory, state.commandLine.text) };
    case "commandResult":
      // Receipts and refusals are one-line notices; typed query results get the pane.
      return action.result.kind === "receipt" ||
        action.result.kind === "unavailable" ||
        action.result.kind === "error" ||
        action.result.kind === "deadline-exceeded"
        ? { ...state, notice: action.result.notice }
        : { ...state, commandResult: action.result };
    case "closeCommandResult":
      return { ...state, commandResult: null };
    case "replaySeek":
      return replaySeek(state, action.seq);
    case "setDepth":
      return { ...state, depth: action.level };
    case "selectRef":
      return selectByRef(state, action.ref);
    case "clearSelection":
      // An open result pane is closed first, so esc never drops a selection behind it.
      if (state.commandResult !== null) return { ...state, commandResult: null };
      return { ...state, selection: null, selectionAbsence: null, lastKnownSpan: null };
    case "replayStep":
      return replayStep(state, action.delta);
    case "returnToLive":
      // The ONLY way out of replay. Running off the end of the recording parks at the
      // last frame instead of rejoining live behind the user's back.
      return state.replay === null ? state : { ...state, replay: null };
    case "quit":
      return state;
  }
}

/**
 * Show the recorded projection state one step forward or back. The frame carries a whole
 * recorded state, so back-stepping re-shows exactly what was recorded. The selection is
 * carried across by full identity and re-resolved.
 */
function replayStep(state: ViewState, delta: number): ViewState {
  const session = state.replay;
  if (session === null || session.timeline.frames.length === 0) return state;
  // Before the first frame, stepping back is a no-op rather than a disguised step
  // forward onto frame 0.
  if (session.index < 0 && delta < 0) return state;
  const index = stepIndex(session.timeline, session.index, delta);
  if (index === session.index) return state;
  const frame = session.timeline.frames[index]!;
  return resolveSelection({
    ...state,
    replay: { ...session, index },
    traces: frame.state.traces,
    spans: frame.state.spans
  });
}

/**
 * Index of the last frame at or before `seq` — `seq` is a cutoff on recorded frames, not
 * a frame index. -1 when every frame is later than `seq` (or there are none).
 */
export function replaySeekIndex(timeline: ReplayTimeline, seq: number): number {
  let found = -1;
  timeline.frames.forEach((frame, index) => {
    if (frame.seq <= seq) found = index;
  });
  return found;
}

/** `:seq N`: show the recorded state at cutoff N. Never leaves replay, never goes live. */
function replaySeek(state: ViewState, seq: number): ViewState {
  const session = state.replay;
  if (session === null) return { ...state, notice: "seq: no replay session (open with --replay)" };
  const index = replaySeekIndex(session.timeline, seq);
  if (index === -1) return { ...state, notice: `seq ${seq}: precedes the first recorded frame` };
  const frame = session.timeline.frames[index]!;
  return resolveSelection({
    ...state,
    replay: { ...session, index },
    traces: frame.state.traces,
    spans: frame.state.spans
  });
}

/** `m`: mark or unmark the selection, including a pinned one that is off screen. */
function markSelection(state: ViewState): ViewState {
  if (!state.selection) return { ...state, notice: "bookmark: nothing selected" };
  const key = spanKey(state.selection);
  const row =
    state.spans.find((candidate) => spanKey(candidate) === key) ??
    (state.lastKnownSpan && spanKey(state.lastKnownSpan) === key ? state.lastKnownSpan : null);
  if (!row) return { ...state, notice: "bookmark: selected span is not loaded" };
  const bookmarks = toggleBookmark(state.bookmarks, row);
  return { ...state, bookmarks, notice: isBookmarked(bookmarks, row) ? "bookmark set" : "bookmark removed" };
}

/**
 * Jump to the highlighted bookmark by full ref. A loaded span is selected and its
 * ancestors expanded; an evicted or aged-out one becomes a pinned selection with its
 * placeholder reason. The jump never lands on a different span.
 */
function jumpToBookmark(state: ViewState): ViewState {
  if (state.bookmarkList === null) return state;
  const bookmark = state.bookmarks[state.bookmarkList.index];
  const closed: ViewState = { ...state, bookmarkList: null };
  if (!bookmark) return closed;
  return selectByRef(closed, bookmark.ref);
}

/**
 * Select by full ref: a loaded span is selected with its ancestors expanded; one that is
 * not loaded becomes a pinned selection with its placeholder reason. Never a neighbour.
 */
function selectByRef(state: ViewState, ref: SpanRef): ViewState {
  const key = spanKey(ref);
  const row = state.spans.find((candidate) => spanKey(candidate) === key);
  if (row) return resolveSelection(select(withAncestorsExpanded(state, row), row));
  const last = state.lastKnownSpan && sameSpan(state.lastKnownSpan, ref) ? state.lastKnownSpan : null;
  return resolveSelection({ ...state, selection: spanRefOf(ref), lastKnownSpan: last });
}

function withAncestorsExpanded(state: ViewState, row: SpanRow): ViewState {
  const byKey = new Map(state.spans.map((span) => [spanKey(span), span]));
  const expanded = new Set(state.expanded);
  const seen = new Set<string>();
  let parent = parentKey(row);
  while (parent !== null && !seen.has(parent)) {
    seen.add(parent);
    expanded.add(parent);
    const next = byKey.get(parent);
    parent = next ? parentKey(next) : null;
  }
  return { ...state, expanded };
}

function resume(state: ViewState): ViewState {
  let next: ViewState = { ...state, paused: false, backlog: [] };
  for (const delta of state.backlog) {
    next = reduceDelta(next, delta);
  }
  return next;
}

function moveSelection(state: ViewState, delta: number): ViewState {
  const rows = visibleSpans(state);
  if (rows.length === 0) return state;
  if (!state.selection) {
    return select(state, delta >= 0 ? rows[0]! : rows[rows.length - 1]!);
  }
  const key = spanKey(state.selection);
  const index = rows.findIndex((row) => spanKey(row) === key);
  if (index === -1) {
    // The pinned selection is not on screen. Moving is the explicit user action that
    // releases the pin, so start from the top rather than guessing a neighbour.
    return select(state, rows[0]!);
  }
  const target = rows[clamp(index + delta, 0, rows.length - 1)]!;
  return select(state, target);
}

function select(state: ViewState, span: SpanRow): ViewState {
  const selected: ViewState = {
    ...state,
    selection: spanRefOf(span),
    selectionAbsence: null,
    lastKnownSpan: span
  };
  // User-driven movement is the one case where the viewport may follow, and then only
  // by the minimum needed to keep the selection on screen.
  const index = selectionIndex(selected);
  if (index === -1) return selected;
  const height = Math.max(1, selected.viewportHeight);
  let scrollTop = selected.scrollTop;
  if (index < scrollTop) scrollTop = index;
  else if (index >= scrollTop + height) scrollTop = index - height + 1;
  return { ...selected, scrollTop: Math.max(0, scrollTop) };
}

function withAdded(set: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(set);
  next.add(value);
  return next;
}

function withRemoved(set: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(set);
  next.delete(value);
  return next;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
