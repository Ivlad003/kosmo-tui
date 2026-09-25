/**
 * View state of the new TUI (spec 5.4, 6.1–6.7): screens start → traces → trace, the tree over
 * `TraceModel`, panes, filters, the prompt and every async answer the session feeds back in.
 *
 * `update` is pure: it returns the next state and the effects the session must run (open a file,
 * load a trace, read lazy values or a code snippet, copy, reload, change root, quit). Nothing here
 * touches I/O or a clock.
 *
 * Identity is always the full `SpanRef` (`spanKey`), never a list index: selection, expansion,
 * bookmarks and caches follow the span, including spans whose parent lives in another session.
 *
 * Every walk is iterative (review focus 1): a 50 000-deep chain must not overflow the stack.
 *
 * Lazy values and code snippets are a cache bounded by CACHE_MAX_BYTES (spec 5.2, D9): the oldest
 * loaded spans are evicted first, never the selected one, and are asked for again when selected.
 */

import { CACHE_MAX_BYTES, jsonBytes } from "../bounds.js";
import type { AreaKey, AreaRow, ParentOf, TraceModel } from "../format/model.js";
import { areaKeyId } from "../format/model.js";
import { kindMatchesGlob } from "../format/kinds.js";
import {
  spanKey,
  type DatasetInfo,
  type Location,
  type SpanRef,
  type SpanRow,
  type SpanValues,
  type TraceSummary
} from "../format/types.js";
import { utf8Bytes } from "../format/validate.js";
import { renderKosmoText } from "../output/kosmo-text.js";
import type { DatasetRootRejection, WideRootRejection } from "../code/root.js";
import type { ContainerKind, Notice, Origin, ReaderError, TraceListPage } from "../readers/types.js";
import type { Snippet } from "../code/snippet.js";
import { rootUnsetText } from "./labels.js";
import { regexFromLiteral } from "./refs.js";

export type Screen = "start" | "traces" | "trace";
export type Pane = "tree" | "detail" | "areas" | "stack" | "bookmarks" | "results";
/** Panes that replace the detail area while they have focus. */
export type AuxPane = "areas" | "stack" | "bookmarks" | "results";
export type TreeFilter = {
  readonly errorsOnly: boolean;
  readonly search: string | null;
  readonly name: string | null;
  readonly kindGlob: string | null;
  readonly area: AreaKey | null;
};
export type StartRow = {
  readonly path: string;
  readonly size: number | null;
  readonly mtimeMs: number | null;
  readonly source: "found" | "recent";
  readonly missing: boolean;
};
export type Bookmark = { readonly ref: SpanRef; readonly name: string };
/**
 * A reader notice, or one the session adds (spec 4.8): `dataset.root` failed the checks of rule 2 and
 * the root is elsewhere, or no automatic rule left a code root at all.
 */
export type ViewNotice =
  | Notice
  | {
      readonly kind: "dataset-root-ignored";
      readonly datasetRoot: string;
      readonly reason: DatasetRootRejection;
      readonly stdin: boolean;
    }
  | { readonly kind: "code-root-unset"; readonly reason: WideRootRejection };
export type DatasetView = {
  readonly info: DatasetInfo;
  readonly kind: ContainerKind;
  readonly origin: Origin;
  readonly traces: readonly TraceSummary[];
  readonly hasMore: boolean;
  readonly notices: readonly ViewNotice[];
  readonly reloadable: boolean;
};
export type ResultsKind = "find" | "callers" | "ancestors" | "path";
/** What the results pane shows besides the refs; `labels[i]` null means the default row for `refs[i]`. */
export type ResultsInfo = {
  readonly kind: ResultsKind;
  readonly title: string;
  readonly labels: readonly (string | null)[];
  readonly footer: string | null;
};
export type Results = ResultsInfo & { readonly refs: readonly SpanRef[] };

export type ViewState = {
  readonly screen: Screen;
  readonly start: { readonly rows: readonly StartRow[]; readonly cursor: number; readonly filter: string };
  readonly dataset: DatasetView | null;
  readonly traceList: { readonly cursor: number; readonly filter: string };
  readonly trace: TraceModel | null;
  /** The code root (spec 4.8); null: none yet, or no automatic rule survived (no snippets, no OSC 8). */
  readonly root: string | null;
  /** Why `root` is null after a dataset opened; null otherwise. */
  readonly rootUnset: WideRootRejection | null;
  readonly view: "tree" | "table" | "text";
  readonly pane: Pane;
  /** spanKey of spans the user expanded explicitly; everything is expanded unless in `collapsed`. */
  readonly expanded: ReadonlySet<string>;
  readonly collapsed: ReadonlySet<string>;
  readonly selected: SpanRef | null;
  readonly filter: TreeFilter;
  readonly detailScroll: number;
  readonly bookmarks: readonly Bookmark[];
  readonly results: readonly SpanRef[] | null;
  readonly prompt: { readonly kind: "command" | "search"; readonly text: string } | null;
  readonly banner: { readonly level: "info" | "error"; readonly text: string } | null;
  readonly values: ReadonlyMap<string, SpanValues | "loading">;
  readonly snippets: ReadonlyMap<string, Snippet | "loading">;
  readonly reading: number | null;
  readonly readOnly: boolean;
  /** Cursor inside the focused aux pane (areas, stack, bookmarks, results). */
  readonly paneCursor: number;
  /** The dataset was opened from the start screen, so Esc on the trace list goes back there. */
  readonly fromStart: boolean;
  /** Select this span once the trace that holds it has loaded (bookmark in another trace, reload). */
  readonly pendingSelect: SpanRef | null;
  readonly resultsInfo: ResultsInfo | null;
  /** `jsonBytes` of the loaded entries of `values` and `snippets` ("loading" is 0); kept ≤ CACHE_MAX_BYTES. */
  readonly cacheBytes: number;
};

export type Effect =
  | { kind: "open"; origin: Origin }
  | { kind: "loadTrace"; id: string }
  | { kind: "loadMoreTraces" }
  | { kind: "loadValues"; ref: SpanRef }
  | { kind: "loadSnippet"; ref: SpanRef; location: Location }
  | { kind: "copy"; text: string }
  | { kind: "reload" }
  | { kind: "setRoot"; dir: string }
  /** The view dropped its dataset (Esc to the start screen): late answers are dropped, then it is closed. */
  | { kind: "closeDataset" }
  | { kind: "quit" };

export type Action =
  // keys: lists of the current screen (start rows, trace list, tree)
  | { readonly type: "move"; readonly delta: number }
  | { readonly type: "moveTo"; readonly edge: "first" | "last" }
  | { readonly type: "expand" }
  | { readonly type: "collapse" }
  | { readonly type: "toggleExpand" }
  /** Enter outside aux panes: start → open file, traces → open trace, tree → focus detail. */
  | { readonly type: "activate" }
  /** Tab: focus back on the tree. */
  | { readonly type: "focusTree" }
  /** Esc outside the prompt and aux panes: clear filter, deselect, back to the start screen. */
  | { readonly type: "escape" }
  /** T / Backspace: from the trace screen back to the trace list. */
  | { readonly type: "back" }
  | { readonly type: "toggleTable" }
  | { readonly type: "toggleText" }
  | { readonly type: "toggleErrors" }
  | { readonly type: "openPane"; readonly pane: "areas" | "stack" | "bookmarks" }
  | { readonly type: "paneMove"; readonly delta: number }
  | { readonly type: "paneMoveTo"; readonly edge: "first" | "last" }
  | { readonly type: "paneActivate" }
  | { readonly type: "closePane" }
  | { readonly type: "scrollDetail"; readonly delta: number }
  | { readonly type: "scrollDetailTo"; readonly edge: "first" | "last" }
  | { readonly type: "toggleBookmark" }
  | { readonly type: "copySubtree" }
  | { readonly type: "loadMore" }
  | { readonly type: "reload" }
  | { readonly type: "quit" }
  // prompt editing
  | { readonly type: "openPrompt"; readonly kind: "command" | "search" }
  | { readonly type: "promptInput"; readonly text: string }
  | { readonly type: "promptBackspace" }
  | { readonly type: "promptClear" }
  | { readonly type: "promptCancel" }
  /** Enter in the `/` prompt. */
  | { readonly type: "promptSubmit" }
  /** Enter in the `:` prompt: keys.ts parses the line (commands.ts) and hands over the outcome. */
  | { readonly type: "runCommand"; readonly result: Action | { readonly error: string } }
  // commands
  | { readonly type: "openTrace"; readonly id: string }
  | { readonly type: "setFilter"; readonly patch: Partial<TreeFilter> }
  | { readonly type: "clearFilters" }
  | { readonly type: "showResults"; readonly results: Results }
  | { readonly type: "selectRef"; readonly ref: SpanRef }
  | { readonly type: "showBanner"; readonly level: "info" | "error"; readonly text: string }
  | { readonly type: "setRoot"; readonly dir: string }
  // session answers
  | { readonly type: "startRows"; readonly rows: readonly StartRow[] }
  | { readonly type: "datasetOpened"; readonly dataset: DatasetView }
  | { readonly type: "datasetFailed"; readonly error: ReaderError }
  | { readonly type: "tracesPage"; readonly page: TraceListPage }
  | { readonly type: "tracesPageFailed"; readonly error: ReaderError }
  | { readonly type: "traceLoaded"; readonly model: TraceModel }
  | { readonly type: "traceFailed"; readonly id: string; readonly error: ReaderError }
  | { readonly type: "valuesLoaded"; readonly ref: SpanRef; readonly values: SpanValues }
  | { readonly type: "valuesFailed"; readonly ref: SpanRef; readonly reason: string }
  | { readonly type: "snippetLoaded"; readonly ref: SpanRef; readonly snippet: Snippet }
  | { readonly type: "readingProgress"; readonly spans: number | null }
  | { readonly type: "rootChanged"; readonly root: string | null; readonly unset?: WideRootRejection }
  /** After `closeDataset`: back to the root before any dataset (`--root`/`:root`, or none), no banner. */
  | { readonly type: "rootReset"; readonly root: string | null };

export type TreeRow = {
  readonly ref: SpanRef;
  readonly depth: number;
  /** A dimmed ancestor kept only as context for a filter match. */
  readonly context: boolean;
  /** «┄┄ browser → node · n1 ┄┄» drawn above this row; never a selectable row itself. */
  readonly separator?: string;
};

/** PgUp/PgDn step: update does not know the terminal height (resize is not state). */
export const PAGE_STEP = 10;
export const BOOKMARK_CAP = 64;
export const PROMPT_MAX = 1024;
/** `G` in the focused detail: render clamps it to the real bottom. */
export const DETAIL_SCROLL_END = 1_000_000_000;

export const EMPTY_FILTER: TreeFilter = { errorsOnly: false, search: null, name: null, kindGlob: null, area: null };

export function initialState(input: {
  root: string | null;
  readOnly: boolean;
  start?: readonly StartRow[];
}): ViewState {
  return {
    screen: "start",
    start: { rows: input.start ?? [], cursor: 0, filter: "" },
    dataset: null,
    traceList: { cursor: 0, filter: "" },
    trace: null,
    root: input.root,
    rootUnset: null,
    view: "tree",
    pane: "tree",
    expanded: new Set<string>(),
    collapsed: new Set<string>(),
    selected: null,
    filter: EMPTY_FILTER,
    detailScroll: 0,
    bookmarks: [],
    results: null,
    prompt: null,
    banner: null,
    values: new Map(),
    snippets: new Map(),
    reading: null,
    readOnly: input.readOnly,
    paneCursor: 0,
    fromStart: false,
    pendingSelect: null,
    resultsInfo: null,
    cacheBytes: 0
  };
}

/* ---------------------------------------------------------------- selectors */

export function filterActive(filter: TreeFilter): boolean {
  return (
    filter.errorsOnly ||
    filter.search !== null ||
    filter.name !== null ||
    filter.kindGlob !== null ||
    filter.area !== null
  );
}

export function visibleStartRows(state: ViewState): readonly StartRow[] {
  const needle = state.start.filter.toLowerCase();
  return needle === "" ? state.start.rows : state.start.rows.filter((row) => row.path.toLowerCase().includes(needle));
}

/** Trace list after `/`: substring of `id` or `name`, case-insensitive. */
export function visibleTraces(state: ViewState): readonly TraceSummary[] {
  const traces = state.dataset?.traces ?? [];
  const needle = state.traceList.filter.toLowerCase();
  if (needle === "") return traces;
  return traces.filter(
    (trace) => trace.id.toLowerCase().includes(needle) || (trace.name?.toLowerCase().includes(needle) ?? false)
  );
}

export function selectedSpan(state: ViewState): SpanRow | undefined {
  return state.selected === null ? undefined : state.trace?.get(state.selected);
}

/** Values of a span: inline (json/ndjson) or from the lazy SQLite cache; undefined = not asked yet. */
export function valuesOf(state: ViewState, ref: SpanRef): SpanValues | "loading" | undefined {
  return state.trace?.get(ref)?.values ?? state.values.get(spanKey(ref));
}

/**
 * Spec 6.3: a child with another `session` or `runtime` than its parent gets a separator row.
 * Raw text: the session is data, the renderer escapes it.
 */
export function sessionSeparator(parent: SpanRow, child: SpanRow): string | undefined {
  if (parent.ref.session === child.ref.session && parent.runtime === child.runtime) return undefined;
  return `┄┄ ${parent.runtime ?? "-"} → ${child.runtime ?? "-"} · ${child.ref.session} ┄┄`;
}

export type AncestorWalk = { readonly frames: readonly SpanRef[]; readonly stop: ParentOf };

/** Walks kept per model: the stack pane and its item count ask for the same span on every frame. */
const ANCESTOR_MEMO_SPANS = 4;
/**
 * spanKey → walk, least recently used first (a hit moves its entry to the end), so the first key is
 * the one to evict. A pure memo: a model never changes, and an entry goes with its model.
 */
const ancestorMemo = new WeakMap<TraceModel, Map<string, AncestorWalk>>();

/**
 * Recorded ancestors of `ref`: the span itself first, then each resolved parent. `stop` is the
 * `parentOf` of the last frame (`root`, `unknown(…)` or `cycle`). Iterative, bounded by the model size.
 * Memoized for the ANCESTOR_MEMO_SPANS most recently used spans of each model (LRU), so a deep chain
 * is walked once, not once per frame or pane move.
 */
export function ancestorsOf(model: TraceModel, ref: SpanRef): AncestorWalk {
  const key = spanKey(ref);
  let memo = ancestorMemo.get(model);
  const known = memo?.get(key);
  if (known !== undefined) {
    // Map order is insertion order: re-insert to make this the most recently used entry.
    memo!.delete(key);
    memo!.set(key, known);
    return known;
  }
  const walk = walkAncestors(model, ref);
  if (memo === undefined) {
    memo = new Map();
    ancestorMemo.set(model, memo);
  }
  memo.set(key, walk);
  if (memo.size > ANCESTOR_MEMO_SPANS) memo.delete(memo.keys().next().value as string);
  return walk;
}

function walkAncestors(model: TraceModel, ref: SpanRef): AncestorWalk {
  const frames: SpanRef[] = [ref];
  let stop = model.parentOf(ref);
  let guard = model.size;
  while (stop.kind === "resolved" && guard > 0) {
    frames.push(stop.ref);
    stop = model.parentOf(stop.ref);
    guard -= 1;
  }
  return { frames, stop };
}

type RowsCache = {
  readonly collapsed: ReadonlySet<string>;
  readonly filter: TreeFilter;
  readonly rows: readonly TreeRow[];
  readonly index: ReadonlyMap<string, number>;
};
/**
 * The last rows of each model, for the (collapsed, filter) they were built from. A pure memo: the
 * answer depends only on its inputs, and an entry goes with its model.
 */
const rowsCache = new WeakMap<TraceModel, RowsCache>();
const NO_ROWS: Pick<RowsCache, "rows" | "index"> = { rows: [], index: new Map() };

/**
 * Tree rows in spec 4.3 DFS order (never re-sorted). Filters keep matches plus their ancestors as
 * dimmed context rows; a collapsed span hides its descendants. Memoised on the inputs' identity,
 * so moving the selection over 200 000 rows does not rebuild them.
 */
export function visibleRows(state: ViewState): readonly TreeRow[] {
  return rowsOf(state).rows;
}

/** Position of `ref` in {@link visibleRows}, or -1. */
export function rowIndex(state: ViewState, ref: SpanRef | null): number {
  if (ref === null) return -1;
  return rowsOf(state).index.get(spanKey(ref)) ?? -1;
}

function rowsOf(state: ViewState): { rows: readonly TreeRow[]; index: ReadonlyMap<string, number> } {
  const model = state.trace;
  if (model === null) return NO_ROWS;
  const cached = rowsCache.get(model);
  if (cached !== undefined && cached.collapsed === state.collapsed && cached.filter === state.filter) return cached;
  const rows = computeRows(model, state.collapsed, state.filter);
  const index = new Map<string, number>();
  rows.forEach((row, position) => index.set(spanKey(row.ref), position));
  const entry: RowsCache = { collapsed: state.collapsed, filter: state.filter, rows, index };
  rowsCache.set(model, entry);
  return entry;
}

function matcher(model: TraceModel, filter: TreeFilter): ((span: SpanRow) => boolean) | null {
  if (!filterActive(filter)) return null;
  const search = filter.search === null ? null : filter.search.toLowerCase();
  const compiled = filter.name === null ? null : regexFromLiteral(filter.name);
  const name = compiled === null || compiled instanceof RegExp ? compiled : /$^/;
  const area = filter.area === null ? null : areaKeyId(filter.area);
  return (span) =>
    (!filter.errorsOnly || span.status === "errored") &&
    (search === null ||
      span.name.toLowerCase().includes(search) ||
      (span.location?.file.toLowerCase().includes(search) ?? false)) &&
    (name === null || name.test(span.name)) &&
    (filter.kindGlob === null || kindMatchesGlob(span.kind, filter.kindGlob)) &&
    (area === null || areaKeyId(model.areaOf(span.ref)) === area);
}

/** spanKey → true for a match, false for an ancestor kept as context. */
function keepSet(model: TraceModel, match: (span: SpanRow) => boolean): Map<string, boolean> {
  const keep = new Map<string, boolean>();
  for (const ref of model.dfs()) {
    const span = model.get(ref);
    if (span === undefined || !match(span)) continue;
    keep.set(spanKey(ref), true);
    let parent = model.parentOf(ref);
    let guard = model.size;
    while (parent.kind === "resolved" && guard > 0) {
      const key = spanKey(parent.ref);
      if (keep.has(key)) break;
      keep.set(key, false);
      parent = model.parentOf(parent.ref);
      guard -= 1;
    }
  }
  return keep;
}

function computeRows(model: TraceModel, collapsed: ReadonlySet<string>, filter: TreeFilter): TreeRow[] {
  const match = matcher(model, filter);
  const keep = match === null ? null : keepSet(model, match);
  const rows: TreeRow[] = [];
  const stack: Array<{ ref: SpanRef; depth: number; parent: SpanRow | null }> = [];
  const roots = model.roots();
  for (let index = roots.length - 1; index >= 0; index -= 1) stack.push({ ref: roots[index]!, depth: 0, parent: null });
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const key = spanKey(frame.ref);
    const kept = keep === null ? true : keep.get(key);
    if (kept === undefined) continue;
    const span = model.get(frame.ref);
    if (span === undefined) continue;
    const separator = frame.parent === null ? undefined : sessionSeparator(frame.parent, span);
    const context = keep !== null && kept === false;
    rows.push(
      separator === undefined
        ? { ref: span.ref, depth: frame.depth, context }
        : { ref: span.ref, depth: frame.depth, context, separator }
    );
    if (collapsed.has(key)) continue;
    const children = model.children(frame.ref);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ ref: children[index]!, depth: frame.depth + 1, parent: span });
    }
  }
  return rows;
}

/** Stack pane frames, results, bookmarks or areas: how many rows the focused aux pane has. */
export function paneItemCount(state: ViewState): number {
  switch (state.pane) {
    case "areas":
      return state.trace?.areas().length ?? 0;
    case "stack":
      return state.trace !== null && state.selected !== null
        ? ancestorsOf(state.trace, state.selected).frames.length
        : 0;
    case "bookmarks":
      return state.bookmarks.length;
    case "results":
      return state.results?.length ?? 0;
    default:
      return 0;
  }
}

/* ---------------------------------------------------------------- update */

type Result = readonly [ViewState, readonly Effect[]];

const NO_EFFECTS: readonly Effect[] = [];

/** Session answers keep the banner; any user action clears it first (a banner answers one action). */
const SESSION_ACTIONS = new Set<Action["type"]>([
  "startRows",
  "datasetOpened",
  "datasetFailed",
  "tracesPage",
  "tracesPageFailed",
  "traceLoaded",
  "traceFailed",
  "valuesLoaded",
  "valuesFailed",
  "snippetLoaded",
  "readingProgress",
  "rootChanged",
  "rootReset",
  "showBanner"
]);

export function update(current: ViewState, action: Action): Result {
  const state = SESSION_ACTIONS.has(action.type) || current.banner === null ? current : { ...current, banner: null };
  switch (action.type) {
    case "move":
      return move(state, action.delta, null);
    case "moveTo":
      return move(state, 0, action.edge);
    case "expand":
      return expand(state);
    case "collapse":
      return collapse(state);
    case "toggleExpand": {
      const span = state.screen === "trace" ? selectedSpan(state) : undefined;
      if (span === undefined || state.trace!.children(span.ref).length === 0) return [state, NO_EFFECTS];
      return state.collapsed.has(spanKey(span.ref)) ? expand(state) : collapse(state);
    }
    case "activate":
      return activate(state);
    case "focusTree":
      return state.screen === "trace" ? [{ ...state, pane: "tree" }, NO_EFFECTS] : [state, NO_EFFECTS];
    case "escape":
      return escape(state);
    case "back":
      return state.screen === "trace" ? [backToTraces(state), NO_EFFECTS] : [state, NO_EFFECTS];
    case "toggleTable":
      return onTrace(state, (s) => [{ ...s, view: s.view === "table" ? "tree" : "table" }, NO_EFFECTS]);
    case "toggleText":
      return onTrace(state, (s) => [{ ...s, view: s.view === "text" ? "tree" : "text" }, NO_EFFECTS]);
    case "toggleErrors":
      return onTrace(state, (s) => [{ ...s, filter: { ...s.filter, errorsOnly: !s.filter.errorsOnly } }, NO_EFFECTS]);
    case "openPane":
      return onTrace(state, (s) => openPane(s, action.pane));
    case "paneMove":
    case "paneMoveTo": {
      const count = paneItemCount(state);
      if (count === 0) return [state, NO_EFFECTS];
      const target =
        action.type === "paneMove" ? state.paneCursor + action.delta : action.edge === "first" ? 0 : count - 1;
      return [{ ...state, paneCursor: clamp(target, 0, count - 1) }, NO_EFFECTS];
    }
    case "paneActivate":
      return paneActivate(state);
    case "closePane":
      return [{ ...state, pane: "tree" }, NO_EFFECTS];
    case "scrollDetail":
      return [
        { ...state, detailScroll: Math.max(0, Math.min(DETAIL_SCROLL_END, state.detailScroll + action.delta)) },
        NO_EFFECTS
      ];
    case "scrollDetailTo":
      return [{ ...state, detailScroll: action.edge === "first" ? 0 : DETAIL_SCROLL_END }, NO_EFFECTS];
    case "toggleBookmark":
      return onTrace(state, toggleBookmark);
    case "copySubtree":
      return onTrace(state, copySubtree);
    case "loadMore":
      if (state.dataset === null) return [banner(state, "error", "more: no dataset open"), NO_EFFECTS];
      if (!state.dataset.hasMore) return [banner(state, "info", "no more traces"), NO_EFFECTS];
      return [banner(state, "info", "loading more traces…"), [{ kind: "loadMoreTraces" }]];
    case "reload":
      if (state.dataset === null) return [banner(state, "error", "reload: unavailable(no-dataset)"), NO_EFFECTS];
      if (!state.dataset.reloadable) {
        const reason = state.dataset.origin === "stdin" ? "stdin-stream" : "not-reloadable";
        return [banner(state, "error", `reload: unavailable(${reason})`), NO_EFFECTS];
      }
      return [banner(state, "info", "reloading…"), [{ kind: "reload" }]];
    case "quit":
      return [state, [{ kind: "quit" }]];
    case "openPrompt":
      return [
        { ...state, prompt: { kind: action.kind, text: action.kind === "search" ? searchPrefill(state) : "" } },
        NO_EFFECTS
      ];
    case "promptInput":
      if (state.prompt === null) return [state, NO_EFFECTS];
      return [
        {
          ...state,
          prompt: {
            ...state.prompt,
            text: Array.from(state.prompt.text + action.text)
              .slice(0, PROMPT_MAX)
              .join("")
          }
        },
        NO_EFFECTS
      ];
    case "promptBackspace": {
      if (state.prompt === null) return [state, NO_EFFECTS];
      const chars = Array.from(state.prompt.text);
      chars.pop();
      return [{ ...state, prompt: { ...state.prompt, text: chars.join("") } }, NO_EFFECTS];
    }
    case "promptClear":
      return state.prompt === null
        ? [state, NO_EFFECTS]
        : [{ ...state, prompt: { ...state.prompt, text: "" } }, NO_EFFECTS];
    case "promptCancel":
      return [{ ...state, prompt: null }, NO_EFFECTS];
    case "promptSubmit":
      return submitSearch(state);
    case "runCommand": {
      const closed: ViewState = { ...state, prompt: null };
      // An Action always has `type`; the parse error object never does (datasetFailed also has `error`).
      if (!("type" in action.result)) return [banner(closed, "error", action.result.error), NO_EFFECTS];
      return update(closed, action.result);
    }
    case "openTrace":
      if (state.dataset === null) return [banner(state, "error", "trace: no dataset open"), NO_EFFECTS];
      return [banner(state, "info", `loading trace ${action.id}…`), [{ kind: "loadTrace", id: action.id }]];
    case "setFilter":
      return onTrace(state, (s) => [{ ...s, filter: { ...s.filter, ...action.patch } }, NO_EFFECTS]);
    case "clearFilters":
      return onTrace(state, (s) => [{ ...s, filter: EMPTY_FILTER }, NO_EFFECTS]);
    case "showResults":
      return onTrace(state, (s) => {
        const { refs, ...info } = action.results;
        return [{ ...s, results: refs, resultsInfo: info, pane: "results", paneCursor: 0 }, NO_EFFECTS];
      });
    case "selectRef":
      return selectRef(state, action.ref);
    case "showBanner":
      return [banner(state, action.level, action.text), NO_EFFECTS];
    case "setRoot":
      return [state, [{ kind: "setRoot", dir: action.dir }]];
    case "startRows": {
      const next = { ...state, start: { ...state.start, rows: action.rows } };
      return [
        { ...next, start: { ...next.start, cursor: clampIndex(next.start.cursor, visibleStartRows(next).length) } },
        NO_EFFECTS
      ];
    }
    case "datasetOpened":
      return datasetOpened(state, action.dataset);
    case "datasetFailed":
      return [
        banner({ ...state, reading: null }, "error", `${action.error.code}: ${action.error.message}`),
        NO_EFFECTS
      ];
    case "tracesPage":
      if (state.dataset === null) return [state, NO_EFFECTS];
      return [
        {
          ...state,
          banner: null,
          dataset: {
            ...state.dataset,
            traces: [...state.dataset.traces, ...action.page.items],
            hasMore: action.page.hasMore
          }
        },
        NO_EFFECTS
      ];
    case "tracesPageFailed":
      return [banner(state, "error", `more: ${action.error.code}: ${action.error.message}`), NO_EFFECTS];
    case "traceLoaded":
      return traceLoaded(state, action.model);
    case "traceFailed":
      return [
        banner(
          { ...state, pendingSelect: null },
          "error",
          `trace ${action.id}: ${action.error.code}: ${action.error.message}`
        ),
        NO_EFFECTS
      ];
    // A reply is taken only for a key still in flight: a late answer for a trace the user left (its
    // entries went in `cacheOfTrace`), after Esc or a reload (fresh maps), or a second answer is dropped.
    case "valuesLoaded":
      if (!inFlight(state.values, action.ref)) return [state, NO_EFFECTS];
      return [cacheValues(state, action.ref, action.values), NO_EFFECTS];
    case "valuesFailed": {
      if (!inFlight(state.values, action.ref)) return [state, NO_EFFECTS];
      const failed = { state: "not-recorded", reason: `read-error: ${action.reason}` } as const;
      return [cacheValues(state, action.ref, { args: failed, return: failed, error: failed }), NO_EFFECTS];
    }
    case "snippetLoaded":
      if (!inFlight(state.snippets, action.ref)) return [state, NO_EFFECTS];
      return [cacheSnippet(state, action.ref, action.snippet), NO_EFFECTS];
    case "readingProgress":
      return [{ ...state, reading: action.spans }, NO_EFFECTS];
    case "rootChanged": {
      const rootUnset = action.root === null ? (action.unset ?? null) : null;
      const cleared: ViewState = banner(
        { ...state, root: action.root, rootUnset, snippets: new Map(), cacheBytes: mapBytes(state.values) },
        "info",
        action.root === null ? rootUnsetText(rootUnset) : `root: ${action.root}`
      );
      if (cleared.selected === null) return [cleared, NO_EFFECTS];
      const [next, effects] = select(cleared, cleared.selected);
      return [{ ...next, detailScroll: state.detailScroll }, effects];
    }
    case "rootReset":
      // Spec 4.8: the closed dataset's root and its reason must not outlive it (`:root` on the start screen).
      return [
        { ...state, root: action.root, rootUnset: null, snippets: new Map(), cacheBytes: mapBytes(state.values) },
        NO_EFFECTS
      ];
    default:
      // Unreachable for typed callers; a stray action from JS must not crash the session.
      return [state, NO_EFFECTS];
  }
}

function banner(state: ViewState, level: "info" | "error", text: string): ViewState {
  return { ...state, banner: { level, text } };
}

function onTrace(state: ViewState, run: (state: ViewState) => Result): Result {
  return state.screen === "trace" && state.trace !== null ? run(state) : [state, NO_EFFECTS];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampIndex(value: number, count: number): number {
  return count === 0 ? 0 : clamp(value, 0, count - 1);
}

function withEntry<V>(map: ReadonlyMap<string, V>, key: string, value: V): Map<string, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

function withKey(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set);
  next.add(key);
  return next;
}

function withoutKey(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set);
  next.delete(key);
  return next;
}

/* ---------------------------------------------------------------- cache of lazy values and snippets */

/** What an entry of `values`/`snippets` costs; a request in flight ("loading") holds no data. */
function entryBytes(entry: SpanValues | Snippet | "loading" | undefined): number {
  return entry === undefined || entry === "loading" ? 0 : jsonBytes(entry);
}

function mapBytes(map: ReadonlyMap<string, SpanValues | Snippet | "loading">): number {
  let total = 0;
  for (const entry of map.values()) total += entryBytes(entry);
  return total;
}

/** `select` put "loading" under this key and no answer has settled it yet. */
function inFlight(map: ReadonlyMap<string, unknown>, ref: SpanRef): boolean {
  return map.get(spanKey(ref)) === "loading";
}

function cacheValues(state: ViewState, ref: SpanRef, values: SpanValues): ViewState {
  const key = spanKey(ref);
  const cacheBytes = state.cacheBytes - entryBytes(state.values.get(key)) + jsonBytes(values);
  return trimCache({ ...state, values: withEntry(state.values, key, values), cacheBytes });
}

function cacheSnippet(state: ViewState, ref: SpanRef, snippet: Snippet): ViewState {
  const key = spanKey(ref);
  const cacheBytes = state.cacheBytes - entryBytes(state.snippets.get(key)) + jsonBytes(snippet);
  return trimCache({ ...state, snippets: withEntry(state.snippets, key, snippet), cacheBytes });
}

/**
 * Spec 5.2, D9: loaded values and snippets together stay within CACHE_MAX_BYTES. The oldest span keys
 * go first, in Map insertion order (`values`, then the keys only `snippets` has), a span's value and
 * snippet together. The selected span and requests in flight stay; an evicted span has no entry, so
 * `select` asks the session for it again.
 */
function trimCache(state: ViewState): ViewState {
  if (state.cacheBytes <= CACHE_MAX_BYTES) return state;
  const keep = state.selected === null ? null : spanKey(state.selected);
  const values = new Map(state.values);
  const snippets = new Map(state.snippets);
  let bytes = state.cacheBytes;
  const drop = <V>(map: Map<string, V | "loading">, key: string): void => {
    const entry = map.get(key);
    if (entry === undefined || entry === "loading") return;
    bytes -= jsonBytes(entry);
    map.delete(key);
  };
  for (const order of [state.values.keys(), state.snippets.keys()]) {
    for (const key of order) {
      if (bytes <= CACHE_MAX_BYTES) break;
      if (key === keep) continue;
      drop(values, key);
      drop(snippets, key);
    }
  }
  return { ...state, values, snippets, cacheBytes: bytes };
}

/** Select a span and ask for what its detail needs: lazy values (SQLite) and the code snippet. */
function select(state: ViewState, ref: SpanRef): Result {
  let next: ViewState = { ...state, selected: ref, detailScroll: 0 };
  const effects: Effect[] = [];
  const span = next.trace?.get(ref);
  if (span !== undefined) {
    const key = spanKey(ref);
    if (span.values === undefined && !next.values.has(key)) {
      next = { ...next, values: withEntry(next.values, key, "loading") };
      effects.push({ kind: "loadValues", ref: span.ref });
    }
    // Without a code root nothing is read: the detail says so instead (spec 4.8).
    if (span.location !== undefined && next.root !== null && !next.snippets.has(key)) {
      next = { ...next, snippets: withEntry(next.snippets, key, "loading") };
      effects.push({ kind: "loadSnippet", ref: span.ref, location: span.location });
    }
  }
  return [next, effects];
}

function move(state: ViewState, delta: number, edge: "first" | "last" | null): Result {
  if (state.screen === "start") {
    const count = visibleStartRows(state).length;
    const target = edge === "first" ? 0 : edge === "last" ? count - 1 : state.start.cursor + delta;
    return [{ ...state, start: { ...state.start, cursor: clampIndex(target, count) } }, NO_EFFECTS];
  }
  if (state.screen === "traces") {
    const count = visibleTraces(state).length;
    const target = edge === "first" ? 0 : edge === "last" ? count - 1 : state.traceList.cursor + delta;
    return [{ ...state, traceList: { ...state.traceList, cursor: clampIndex(target, count) } }, NO_EFFECTS];
  }
  const rows = visibleRows(state);
  if (rows.length === 0) return [state, NO_EFFECTS];
  const index = rowIndex(state, state.selected);
  let target: number;
  if (edge === "first") target = 0;
  else if (edge === "last") target = rows.length - 1;
  // A selection hidden by a filter is released by moving: start from the top, never guess a neighbour.
  else if (index === -1) target = 0;
  else target = clamp(index + delta, 0, rows.length - 1);
  return select(state, rows[target]!.ref);
}

function expand(state: ViewState): Result {
  const span = state.screen === "trace" ? selectedSpan(state) : undefined;
  if (span === undefined) return [state, NO_EFFECTS];
  const key = spanKey(span.ref);
  return [
    { ...state, collapsed: withoutKey(state.collapsed, key), expanded: withKey(state.expanded, key) },
    NO_EFFECTS
  ];
}

/** `h`: collapse an open span with children; on a leaf or a collapsed span, go to the parent row. */
function collapse(state: ViewState): Result {
  const span = state.screen === "trace" ? selectedSpan(state) : undefined;
  if (span === undefined) return [state, NO_EFFECTS];
  const model = state.trace!;
  const key = spanKey(span.ref);
  if (model.children(span.ref).length > 0 && !state.collapsed.has(key)) {
    return [
      { ...state, collapsed: withKey(state.collapsed, key), expanded: withoutKey(state.expanded, key) },
      NO_EFFECTS
    ];
  }
  const parent = model.parentOf(span.ref);
  if (parent.kind === "resolved" && rowIndex(state, parent.ref) !== -1) return select(state, parent.ref);
  return [state, NO_EFFECTS];
}

function activate(state: ViewState): Result {
  if (state.screen === "start") {
    const row = visibleStartRows(state)[state.start.cursor];
    if (row === undefined) return [state, NO_EFFECTS];
    if (row.missing) return [banner(state, "error", `file-not-found: ${row.path}`), NO_EFFECTS];
    return [
      banner({ ...state, fromStart: true }, "info", `opening ${row.path}…`),
      [{ kind: "open", origin: { path: row.path } }]
    ];
  }
  if (state.screen === "traces") {
    const trace = visibleTraces(state)[state.traceList.cursor];
    if (trace === undefined) return [state, NO_EFFECTS];
    return [banner(state, "info", `loading trace ${trace.id}…`), [{ kind: "loadTrace", id: trace.id }]];
  }
  if (state.pane === "tree" && state.selected !== null) return [{ ...state, pane: "detail" }, NO_EFFECTS];
  return [state, NO_EFFECTS];
}

function escape(state: ViewState): Result {
  if (state.screen === "start") {
    return state.start.filter === ""
      ? [state, NO_EFFECTS]
      : [{ ...state, start: { ...state.start, filter: "", cursor: 0 } }, NO_EFFECTS];
  }
  if (state.screen === "traces") {
    if (state.traceList.filter !== "") return [{ ...state, traceList: { filter: "", cursor: 0 } }, NO_EFFECTS];
    if (!state.fromStart) return [state, NO_EFFECTS];
    return [
      {
        ...state,
        screen: "start",
        dataset: null,
        traceList: { cursor: 0, filter: "" },
        fromStart: false,
        values: new Map(),
        snippets: new Map(),
        cacheBytes: 0
      },
      [{ kind: "closeDataset" }]
    ];
  }
  if (state.pane !== "tree") return [{ ...state, pane: "tree" }, NO_EFFECTS];
  if (filterActive(state.filter)) return [{ ...state, filter: EMPTY_FILTER }, NO_EFFECTS];
  if (state.selected !== null) return [{ ...state, selected: null, detailScroll: 0 }, NO_EFFECTS];
  return [state, NO_EFFECTS];
}

function backToTraces(state: ViewState): ViewState {
  const id = state.trace?.trace.id;
  const cleared: ViewState = {
    ...state,
    screen: "traces",
    trace: null,
    pane: "tree",
    collapsed: new Set(),
    expanded: new Set(),
    selected: null,
    filter: EMPTY_FILTER,
    detailScroll: 0,
    results: null,
    resultsInfo: null,
    values: new Map(),
    snippets: new Map(),
    cacheBytes: 0,
    pendingSelect: null
  };
  const cursor = visibleTraces(cleared).findIndex((trace) => trace.id === id);
  return { ...cleared, traceList: { ...cleared.traceList, cursor: cursor === -1 ? cleared.traceList.cursor : cursor } };
}

function openPane(state: ViewState, pane: "areas" | "stack" | "bookmarks"): Result {
  if (state.pane === pane) return [{ ...state, pane: "tree" }, NO_EFFECTS];
  if (pane === "bookmarks" && state.bookmarks.length === 0) {
    return [banner(state, "info", "bookmarks: none yet (m marks the selected span)"), NO_EFFECTS];
  }
  if (pane === "stack" && state.selected === null)
    return [banner(state, "info", "stack: nothing selected"), NO_EFFECTS];
  let cursor = 0;
  if (pane === "areas" && state.filter.area !== null) {
    const id = areaKeyId(state.filter.area);
    cursor = Math.max(
      0,
      state.trace!.areas().findIndex((row) => areaKeyId(row) === id)
    );
  }
  return [{ ...state, pane, paneCursor: cursor }, NO_EFFECTS];
}

function areaKeyOfRow(row: AreaRow): AreaKey {
  return { module: row.module, feature: row.feature, derived: row.derived };
}

function paneActivate(state: ViewState): Result {
  if (state.screen !== "trace" || state.trace === null) return [state, NO_EFFECTS];
  const model = state.trace;
  switch (state.pane) {
    case "areas": {
      const row = model.areas()[state.paneCursor];
      if (row === undefined) return [state, NO_EFFECTS];
      return [{ ...state, pane: "tree", filter: { ...state.filter, area: areaKeyOfRow(row) } }, NO_EFFECTS];
    }
    case "stack": {
      if (state.selected === null) return [state, NO_EFFECTS];
      const frame = ancestorsOf(model, state.selected).frames[state.paneCursor];
      return frame === undefined ? [state, NO_EFFECTS] : selectRef({ ...state, pane: "tree" }, frame);
    }
    case "bookmarks": {
      const bookmark = state.bookmarks[state.paneCursor];
      return bookmark === undefined ? [state, NO_EFFECTS] : selectRef({ ...state, pane: "tree" }, bookmark.ref);
    }
    case "results": {
      const ref = state.results?.[state.paneCursor];
      return ref === undefined ? [state, NO_EFFECTS] : selectRef(state, ref);
    }
    default:
      return [state, NO_EFFECTS];
  }
}

/**
 * Jump to a span by full ref. In the open trace: expand its ancestors and select it. In another
 * trace of the dataset: load that trace and select it once loaded. Never a neighbour.
 */
function selectRef(state: ViewState, ref: SpanRef): Result {
  const model = state.trace;
  if (model !== null && ref.trace === model.trace.id) {
    const span = model.get(ref);
    if (span === undefined)
      return [banner(state, "error", `span ${ref.session}:${ref.id} not found in this trace`), NO_EFFECTS];
    let collapsed = state.collapsed;
    const walk = ancestorsOf(model, span.ref);
    for (const frame of walk.frames.slice(1)) {
      const key = spanKey(frame);
      if (collapsed.has(key)) collapsed = withoutKey(collapsed, key);
    }
    return select({ ...state, collapsed }, span.ref);
  }
  if (state.dataset === null) return [banner(state, "error", "no dataset open"), NO_EFFECTS];
  return [
    banner({ ...state, pendingSelect: ref }, "info", `loading trace ${ref.trace}…`),
    [{ kind: "loadTrace", id: ref.trace }]
  ];
}

function toggleBookmark(state: ViewState): Result {
  const span = selectedSpan(state);
  if (span === undefined) return [banner(state, "info", "bookmark: nothing selected"), NO_EFFECTS];
  const key = spanKey(span.ref);
  if (state.bookmarks.some((bookmark) => spanKey(bookmark.ref) === key)) {
    return [
      banner(
        { ...state, bookmarks: state.bookmarks.filter((bookmark) => spanKey(bookmark.ref) !== key) },
        "info",
        "bookmark removed"
      ),
      NO_EFFECTS
    ];
  }
  const bookmarks = [...state.bookmarks, { ref: span.ref, name: span.name }];
  return [
    banner(
      { ...state, bookmarks: bookmarks.slice(Math.max(0, bookmarks.length - BOOKMARK_CAP)) },
      "info",
      "bookmark set"
    ),
    NO_EFFECTS
  ];
}

/** `y`: kosmo-text/v1 of the selected subtree with `--detail 0` (spec 6.7, 7.2), same byte cap. */
function copySubtree(state: ViewState): Result {
  const model = state.trace!;
  if (state.selected === null || model.get(state.selected) === undefined) {
    return [banner(state, "info", "copy: nothing selected"), NO_EFFECTS];
  }
  const text = renderKosmoText(model, {
    detail: 0,
    values: (ref) => {
      const found = valuesOf(state, ref);
      return found === "loading" ? undefined : found;
    },
    subtree: state.selected
  });
  return [banner(state, "info", `copied ${utf8Bytes(text)} B of kosmo-text/v1`), [{ kind: "copy", text }]];
}

function searchPrefill(state: ViewState): string {
  if (state.screen === "start") return state.start.filter;
  if (state.screen === "traces") return state.traceList.filter;
  return state.filter.search ?? "";
}

function submitSearch(state: ViewState): Result {
  if (state.prompt === null || state.prompt.kind !== "search") return [{ ...state, prompt: null }, NO_EFFECTS];
  const text = state.prompt.text;
  const closed: ViewState = { ...state, prompt: null };
  if (state.screen === "start") return [{ ...closed, start: { ...closed.start, filter: text, cursor: 0 } }, NO_EFFECTS];
  if (state.screen === "traces") return [{ ...closed, traceList: { filter: text, cursor: 0 } }, NO_EFFECTS];
  return [{ ...closed, filter: { ...closed.filter, search: text === "" ? null : text } }, NO_EFFECTS];
}

function datasetOpened(state: ViewState, dataset: DatasetView): Result {
  const open = state.trace;
  const base: ViewState = {
    ...state,
    dataset,
    reading: null,
    banner: null,
    values: new Map(),
    snippets: new Map(),
    cacheBytes: 0
  };
  // `r` on the trace screen: keep the trace open and the selection, re-read both.
  if (state.screen === "trace" && open !== null && dataset.traces.some((trace) => trace.id === open.trace.id)) {
    return [
      banner({ ...base, pendingSelect: state.selected }, "info", `reloaded; loading trace ${open.trace.id}…`),
      [{ kind: "loadTrace", id: open.trace.id }]
    ];
  }
  const listed: ViewState = {
    ...base,
    screen: "traces",
    traceList: { cursor: 0, filter: "" },
    trace: null,
    pane: "tree",
    collapsed: new Set(),
    expanded: new Set(),
    selected: null,
    filter: EMPTY_FILTER,
    detailScroll: 0,
    results: null,
    resultsInfo: null,
    pendingSelect: null,
    prompt: null
  };
  const vanished =
    state.screen === "trace" && open !== null ? `trace ${open.trace.id} is no longer in the dataset` : null;
  // Spec 5.4: a dataset with one trace opens the trace screen directly.
  const only = dataset.traces.length === 1 && !dataset.hasMore ? dataset.traces[0]! : null;
  if (only !== null) return [banner(listed, "info", `loading trace ${only.id}…`), [{ kind: "loadTrace", id: only.id }]];
  return [vanished === null ? listed : banner(listed, "info", vanished), NO_EFFECTS];
}

/** Keep only the cache entries of `trace`; spanKey starts with the trace id. */
function cacheOfTrace(state: ViewState, trace: string): ViewState {
  const prefix = `${JSON.stringify([trace]).slice(0, -1)},`;
  const keep = <V>(map: ReadonlyMap<string, V>): Map<string, V> =>
    new Map([...map].filter(([key]) => key.startsWith(prefix)));
  const values = keep(state.values);
  const snippets = keep(state.snippets);
  return { ...state, values, snippets, cacheBytes: mapBytes(values) + mapBytes(snippets) };
}

function traceLoaded(state: ViewState, model: TraceModel): Result {
  // Defence in depth: the session drops late answers, but without a dataset there is nothing to show
  // a trace of (Esc went back to the start screen).
  if (state.dataset === null) return [state, NO_EFFECTS];
  // Another trace (`:trace`, a bookmark, a result): the previous trace's values and snippets go;
  // entries of this trace, including requests in flight, stay.
  const cached = cacheOfTrace(state, model.trace.id);
  const loaded: ViewState = {
    ...cached,
    screen: "trace",
    trace: model,
    pane: "tree",
    collapsed: new Set(),
    expanded: new Set(),
    selected: null,
    filter: EMPTY_FILTER,
    detailScroll: 0,
    results: null,
    resultsInfo: null,
    pendingSelect: null,
    banner: null
  };
  const cursor = visibleTraces(loaded).findIndex((trace) => trace.id === model.trace.id);
  const listed: ViewState = cursor === -1 ? loaded : { ...loaded, traceList: { ...loaded.traceList, cursor } };
  const pending = state.pendingSelect;
  if (pending !== null && pending.trace === model.trace.id && model.get(pending) !== undefined) {
    return selectRef(listed, pending);
  }
  const first = visibleRows(listed)[0];
  const [selected, effects] = first === undefined ? [listed, NO_EFFECTS] : select(listed, first.ref);
  if (pending !== null && pending.trace === model.trace.id) {
    return [banner(selected, "info", `span ${pending.session}:${pending.id} is not in this trace any more`), effects];
  }
  return [selected, effects];
}
