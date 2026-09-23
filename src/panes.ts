/**
 * The viewer's panes: header, trace list, span row, footer and details (design D1).
 * Split out of kosmo-callflow `packages/cli/src/connect/render.ts`; `render.ts` only
 * lays them out.
 *
 * Pure plain text: no ANSI escapes are emitted here. Widths are measured with the
 * grapheme-aware `visibleWidth`/`truncateVisible` from ansi.ts, never with
 * `string.length`, so a CJK or emoji node id cannot overflow the row. Every recorded
 * string (trace ids, node ids, session ids, reasons) passes through the shared
 * `escapeTerminalControls` first, so recorded data can never emit a control sequence.
 */

import { renderTraceText } from "@kosmo-callflow/protocol";
import { escapeTerminalControls } from "@kosmo-callflow/trace-artifacts";
import { truncateVisible } from "./ansi.js";
import { resolveBookmarks } from "./bookmarks.js";
import { checkCommand, isAvailable } from "./capabilities.js";
import { comparisonLines } from "./compare.js";
import type { CommandResult, ResultMeta } from "./commands.js";
import { ancestorChain, stopText } from "./stack.js";
import { focusText, formatDepthRow } from "./depth.js";
import { formatSelectorRow, selectorRows } from "./requests.js";
import { tabCell } from "./serializers.js";
import { valueMatchLines } from "./values.js";
import {
  currentDepthView,
  filtersActive,
  parentKey,
  spanKey,
  traceKey,
  type DetailValue,
  type SpanDetail,
  type SpanRow,
  type TraceRef,
  type ViewState
} from "./view-state.js";

/** Rows given to the trace list when there are traces to show. */
export const TRACE_LIST_HEIGHT = 5;

/** Upper bound on the details pane, so it can never crowd out the span list. */
export const DETAIL_PANE_HEIGHT = 12;

/** Recorded text as it may reach the screen: control characters escaped, never emitted. */
export function shown(text: string): string {
  return escapeTerminalControls(text);
}

/** Fit a line into `width` visible columns, grapheme-aware, with `…` when cut. */
export function fit(line: string, width: number): string {
  return truncateVisible(line, width);
}

export function rule(width: number): string {
  return "─".repeat(width);
}

/**
 * Qualifier for a ref whose bare ids are shared by another loaded ref.
 *
 * Nothing is added when the bare ids are unique, so an ordinary view reads exactly as
 * before. When two sessions reuse an id, the session is named; when the collision
 * crosses datasets or projects too, the whole scope is named.
 */
export function qualifier(ref: TraceRef, peers: readonly TraceRef[]): string {
  const others = peers.filter((peer) => traceKey(peer) !== traceKey(ref));
  if (others.length === 0) return "";
  const sameScope = others.every((peer) => peer.datasetId === ref.datasetId && peer.projectId === ref.projectId);
  return sameScope
    ? ` @${shown(ref.sessionId)}`
    : ` @${shown(ref.datasetId)}/${shown(ref.projectId)}/${shown(ref.sessionId)}`;
}

export function renderHeader(state: ViewState, width: number): string[] {
  return [fit(connectionLine(state), width), rule(width)];
}

/**
 * "daemon unreachable", "SDK not attached" and "attached but no events yet" read
 * differently, because each one needs a different user action.
 */
export function connectionLine(state: ViewState): string {
  const parts: string[] = [];
  const { connection } = state;
  if (connection.kind === "disconnected") {
    parts.push(`disconnected: ${shown(connection.reason)}`);
  } else if (connection.kind === "offline") {
    parts.push(shown(connection.label));
  } else if (connection.sdk === "absent") {
    parts.push("connected; SDK not attached");
  } else if (connection.events === "none") {
    parts.push("connected; SDK attached; no events recorded yet");
  } else {
    parts.push("connected; live");
  }
  if (state.paused) parts.push("PAUSED (view only)");
  // While paused the parked backlog IS the distance from live; saying how far keeps a
  // frozen view from reading as a quiet system.
  if (state.paused && state.backlog.length > 0) parts.push(`behind live by ${state.backlog.length} parked update(s)`);
  if (state.behindLive) parts.push("behind live");
  if (state.retentionGap) parts.push("retention gap");
  if (state.backlogOverflowed) parts.push("backlog overflow");
  if (state.scope?.truncated && state.scope.reason) parts.push(`truncated: ${shown(state.scope.reason)}`);
  // A source that is not complete says so (e.g. a stdin stream that ended without `end`).
  else if (state.scope?.reason) parts.push(`coverage: ${shown(state.scope.reason)}`);
  if (state.replay) parts.push(...replayParts(state));
  parts.push(`capture: ${state.effectivePolicy === null ? "unavailable" : shown(state.effectivePolicy)}`);
  return parts.join(" | ");
}

/**
 * The replay status. The position is a frame count and the frame's `seq`, never an
 * elapsed time: `seq` is the order of observation, not a duration (replay-clock.md).
 */
function replayParts(state: ViewState): string[] {
  const session = state.replay!;
  const total = session.timeline.frames.length;
  const frame = session.index >= 0 ? session.timeline.frames[session.index] : undefined;
  const parts = [
    `REPLAY ${Math.max(0, session.index + 1)}/${total}${frame ? ` seq=${frame.seq}` : ""} (L returns to live)`
  ];
  if (session.schedule.mode === "speed") {
    parts.push(`speed x${session.schedule.speed} (source clock)`);
  } else if (session.schedule.mode === "speed-fallback") {
    // Honest fallback: say the multiplier could not be honoured and why.
    parts.push(
      `speed x${session.schedule.speed} unavailable: ${shown(session.schedule.reason)}; stepping every ${session.schedule.intervalMs}ms`
    );
  } else if (session.schedule.mode === "step-interval") {
    parts.push(`step every ${session.schedule.intervalMs}ms`);
  } else {
    parts.push("manual stepping (n forward, b back)");
  }
  if (session.timeline.windowOnly) {
    parts.push("aggregate windows: window-level replay only, per-call order unavailable");
  }
  if (session.timeline.missingSeqs.length > 0) {
    // Reported, never skipped over; capped so one damaged range cannot push the rest of
    // the status line off the screen.
    const shownSeqs = session.timeline.missingSeqs.slice(0, 5);
    const rest = session.timeline.missingSeqs.length - shownSeqs.length;
    parts.push(`missing seq: ${shownSeqs.join(",")}${rest > 0 ? ` (+${rest} more)` : ""}`);
  }
  return parts;
}

export function renderTraceList(state: ViewState, width: number): string[] {
  if (state.traces.length === 0) return [];
  const selected = state.selection ?? state.lastKnownSpan;
  const selectedKey = selected ? traceKey(selected) : null;
  const shownRows = state.traces.slice(0, TRACE_LIST_HEIGHT);
  const lines = shownRows.map((row) => {
    const marker = traceKey(row) === selectedKey ? ">" : " ";
    const status = row.status === "errored" ? "!" : row.status === "running" ? "~" : " ";
    const peers = state.traces.filter((peer) => peer.traceId === row.traceId);
    return fit(`${marker}${status} ${shown(row.traceId)}${qualifier(row, peers)}  (${row.spanCount})`, width);
  });
  const hidden = state.traces.length - shownRows.length;
  if (hidden > 0) {
    lines.push(fit(`   … ${hidden} more traces`, width));
  }
  lines.push(rule(width));
  return lines;
}

/**
 * Explains a pinned selection that is not on screen. The selection is never moved to
 * make it visible, so without this the viewer would look simply broken.
 */
export function selectionBanner(state: ViewState): string | null {
  if (state.selectionAbsence === "retention") {
    return "selected trace aged out of retention (gap) — showing last known values";
  }
  if (state.selectionAbsence === "filter") {
    return "selection hidden by the current filter — showing last known values";
  }
  if (state.selectionAbsence === "evicted") {
    const name = state.lastKnownSpan ? shown(state.lastKnownSpan.nodeId) : shown(state.selection?.spanId ?? "");
    // The hint follows the effective capabilities: a stdin stream cannot be re-read.
    const reload = state.caps === null ? null : checkCommand(state.caps, "reload");
    const hint = reload === null || reload.ok ? "reload to fetch it" : `reload unavailable(${shown(reload.reason)})`;
    return `selected span ${name} evicted from the loaded scope — showing last known values (${hint})`;
  }
  return null;
}

export function emptyMessage(state: ViewState): string {
  const { connection } = state;
  if (connection.kind === "disconnected") return "  no data: daemon unreachable";
  if (connection.kind === "connected" && connection.sdk === "absent")
    return "  no data: SDK not attached to the application";
  if (connection.kind === "connected" && connection.events === "none")
    return "  no data: SDK attached, nothing recorded yet";
  if (filtersActive(state.filters)) return "  no rows match the current filter";
  if (connection.kind === "offline" && state.traces.length === 0)
    return `  no data: the ${shown(connection.label)} holds no traces`;
  return "  no rows";
}

export function renderSpanRow(span: SpanRow, state: ViewState): string {
  const key = spanKey(span);
  const selected = state.selection !== null && spanKey(state.selection) === key;
  const marker = selected ? ">" : " ";
  // Children are matched by full parent ref: another session's span with the same
  // parentSpanId does not make this one expandable.
  const expandable = state.spans.some((row) => parentKey(row) === key);
  const toggle = expandable ? (state.expanded.has(key) ? "-" : "+") : " ";
  const indent = "  ".repeat(span.depth);
  const status = span.errored ? "!" : " ";
  const peers = state.spans.filter((peer) => peer.traceId === span.traceId && peer.spanId === span.spanId);
  return `${marker}${status}${indent}${toggle} ${shown(span.nodeId)}${qualifier(span, peers)}`;
}

export function renderFooter(state: ViewState, width: number): string[] {
  if (state.commandLine !== null) {
    // Same single row as the hints: the prompt never changes the body height.
    return [rule(width), fit(`:${shown(state.commandLine.text)}_  (enter run, esc cancel, up/down history)`, width)];
  }
  if (state.searchInput !== null) {
    // The prompt replaces the hints rather than adding a row, so opening search cannot
    // change the height of the body underneath it.
    const hint = state.searchSelected
      ? "(type to refine, backspace clears, enter apply, esc cancel)"
      : "(enter apply, esc cancel)";
    return [rule(width), fit(`search: ${shown(state.searchInput)}_  ${hint}`, width)];
  }
  if (state.bookmarkList !== null) {
    return [rule(width), fit("bookmarks: j/k move  enter jump  esc close", width)];
  }
  if (state.notice !== null) {
    // Same single row as the hints, so a notice cannot change the body height.
    return [rule(width), fit(`! ${shown(state.notice)}`, width)];
  }
  const filters = [
    state.filters.errorsOnly ? "errors-only" : null,
    state.filters.search === null ? null : `search="${shown(state.filters.search)}"`,
    state.filters.nodeId ? `node=${shown(state.filters.nodeId)}` : null,
    state.filters.spanKind ? `kind=${shown(state.filters.spanKind)}` : null
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
  // Filters run over what is loaded; when the scope is known it is named, so an empty
  // result is never read as "nothing in the dataset".
  const scope = filters.length > 0 && state.scope !== null ? ` over loaded ${scopeText(state)}` : "";
  const keys = keyHints(state);
  const prefix =
    filters.length === 0 ? `${state.view}/${state.dsl}` : `${state.view}/${state.dsl}  [${filters}${scope}]`;
  return [rule(width), fit(`${prefix}  ${keys}`, width)];
}

function scopeText(state: ViewState): string {
  const scope = state.scope!;
  const count = scope.total === null ? `${scope.loaded}` : `${scope.loaded}/${scope.total}`;
  return `${count} rows${scope.truncated ? ", truncated" : ""}`;
}

/**
 * Footer key hints. Without capabilities this is the kosmo-callflow footer verbatim;
 * with them, only commands the session can actually serve are advertised.
 */
function keyHints(state: ViewState): string {
  const caps = state.caps;
  if (caps === null) {
    return state.replay
      ? "j/k move  n/b step  L live  space expand  v view  d dsl  e errors  / search  q quit"
      : "j/k move  space expand  p pause  v view  d dsl  e errors  / search  q quit";
  }
  const hints = ["j/k move"];
  if (state.replay && isAvailable(caps, "replayStep")) hints.push("n/b step", "L live");
  hints.push("space expand");
  if (!state.replay && isAvailable(caps, "pause")) hints.push("p pause");
  hints.push("v view", "d dsl", "e errors", "/ search");
  if (isAvailable(caps, "bookmark")) hints.push("m mark", "' marks");
  if (isAvailable(caps, "stack")) hints.push("s stack");
  if (isAvailable(caps, "finding")) hints.push("f/t review");
  if (state.morePages && isAvailable(caps, "loadMore")) hints.push("> more");
  if (isAvailable(caps, "reload")) hints.push("r reload");
  hints.push("q quit");
  return hints.join("  ");
}

/** The `'` jump list; evicted or aged-out bookmarks stay listed as placeholders. */
export function renderBookmarkList(state: ViewState, width: number, height: number): string[] {
  const resolved = resolveBookmarks(state.bookmarks, state.spans, state.traces);
  const index = state.bookmarkList?.index ?? -1;
  const lines = [`bookmarks (${resolved.length})`];
  const peers = state.bookmarks.map((bookmark) => bookmark.ref);
  resolved.forEach((entry, position) => {
    const marker = position === index ? ">" : " ";
    const name = `${shown(entry.bookmark.nodeId)}${qualifier(
      entry.bookmark.ref,
      peers.filter((peer) => peer.traceId === entry.bookmark.ref.traceId)
    )}`;
    const where =
      entry.state === "loaded"
        ? ""
        : entry.reason === "retention"
          ? "  (placeholder: aged out of retention)"
          : "  (placeholder: evicted from the loaded scope)";
    lines.push(
      `${marker} ${position + 1}. ${name} ${shown(entry.bookmark.ref.traceId)}/${shown(entry.bookmark.ref.spanId)}${where}`
    );
  });
  return lines.slice(0, height).map((line) => fit(line, width));
}

/**
 * The stack pane: the recorded ancestor chain of the selection, target first. It is
 * never a live JavaScript stack, and it names where and why the walk stopped.
 */
export function renderStackPane(state: ViewState, width: number, height: number): string[] {
  const lines = [rule(width), "stack (recorded ancestors, not a live JS stack)"];
  const chain = state.selection
    ? ancestorChain(state.spans, state.selection, { retentionGap: state.retentionGap }, state.lastKnownSpan)
    : null;
  if (chain === null) {
    lines.push("  unavailable (no selected span loaded)");
  } else {
    chain.frames.forEach((frame, depth) => {
      const peers = state.spans.filter((peer) => peer.traceId === frame.traceId && peer.spanId === frame.spanId);
      lines.push(`  #${depth} ${shown(frame.nodeId)}${qualifier(frame, peers)}`);
    });
    lines.push(`  ${shown(stopText(chain.stop))}`);
  }
  return lines.slice(0, height).map((line) => fit(line, width));
}

/**
 * The details pane for the selected span. `[masked]`, `not recorded` and `unavailable`
 * are printed verbatim: a pane that renders a missing value as blank — or as a
 * plausible default — is how a reader ends up debugging a value never produced.
 */
export function renderDetailPane(detail: SpanDetail, state: ViewState, width: number, height: number): string[] {
  const lines: string[] = [
    rule(width),
    `detail: ${shown(detail.nodeId)} [${detail.status}]`,
    `  anchor: ${anchorText(detail)}`,
    `  duration: ${detail.duration.state === "recorded" ? `${detail.duration.ms}ms` : `unavailable (${shown(detail.duration.reason)})`}`,
    `  args: ${valueText(detail.args)}`,
    `  ret: ${valueText(detail.ret)}`
  ];
  if (detail.error.state !== "not-recorded") {
    lines.push(`  error: ${valueText(detail.error)}`);
  }
  if (detail.lateError !== undefined) {
    lines.push(`  late-error (after completion): ${valueText(detail.lateError)}`);
  }
  lines.push(...dslLines(detail, state));
  return lines.slice(0, height).map((line) => fit(line, width));
}

/**
 * Render the selected span in the active dialect through the protocol's own renderer;
 * a second spelling of Lisp or Tab here would be another codec to keep in step.
 */
function dslLines(detail: SpanDetail, state: ViewState): string[] {
  if (detail.document === null) return [`  ${state.dsl}: unavailable (no projection for this span)`];
  const text = renderTraceText(detail.document, { dialect: state.dsl });
  return (
    text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      // The protocol renderer already escapes recorded values; the tab dialect's own
      // separators are kept as tabs here and expanded to spaces by fit(), so the row is
      // what a terminal would show and its width is measured honestly.
      .map((line) => `  ${state.dsl}: ${escapeTerminalControls(line, { preserveNewlines: true })}`)
  );
}

function anchorText(detail: SpanDetail): string {
  const where = `${shown(detail.anchor.file)}#${shown(detail.anchor.symbol)}`;
  return detail.anchor.line === null ? `${where} (line unavailable)` : `${where}:${detail.anchor.line}`;
}

function valueText(value: DetailValue): string {
  switch (value.state) {
    case "recorded":
      return shown(value.text);
    case "masked":
      return "[masked]";
    case "not-recorded":
      return "not recorded";
    case "unavailable":
      return `unavailable (${shown(value.reason)})`;
  }
}

/**
 * The `:` result pane. It shows only rows that exist in the loaded scope, says how much
 * of the dataset that is, and keeps static/possible callers visibly apart from recorded
 * ones. esc closes it.
 */
export function renderCommandResultPane(result: CommandResult, width: number, height: number): string[] {
  const lines = [rule(width), ...commandResultLines(result)];
  return lines.slice(0, height).map((line) => fit(line, width));
}

const VALUE_RESULT_MAX_LINES = 40;

export function commandResultLines(result: CommandResult): string[] {
  switch (result.kind) {
    case "receipt":
    case "unavailable":
    case "error":
    case "deadline-exceeded":
      return [shown(result.notice)];
    case "projection":
      return [
        `${shown(result.title)}  (esc closes)`,
        ...(result.spans.length === 0 ? ["  no spans"] : result.spans.map(spanLine)),
        ...(result.note === null ? [] : [`  ${shown(result.note)}`]),
        metaLine(result.meta)
      ];
    case "path":
      if (result.status === "found") {
        return [
          `path ${shown(result.from)} -> ${shown(result.to)}: ${result.spans.length - 1} recorded edge(s)  (esc closes)`,
          ...result.spans.map(spanLine),
          metaLine(result.meta)
        ];
      }
      if (result.status === "no-path") {
        const why =
          result.reason === "different-trace"
            ? "endpoints are in different traces; recorded edges never cross traces"
            : "both endpoints loaded; the recorded chain reaches the root without the first endpoint";
        return [`no-path: ${shown(result.from)} -> ${shown(result.to)} (${why})`, metaLine(result.meta)];
      }
      return [
        `unknown-path(${result.reason}): ${shown(result.from)} -> ${shown(result.to)}${
          result.endpoint === null ? "" : ` (${result.endpoint} endpoint not in the loaded scope)`
        }`,
        metaLine(result.meta)
      ];
    case "table": {
      const lines = [`callers of ${shown(result.nodeId)} (recorded, direct parent edges)  (esc closes)`];
      if (result.recorded.length === 0) lines.push("  none recorded in the loaded scope");
      for (const row of result.recorded) lines.push(`  ${row.calls}x  ${shown(row.nodeId)}`);
      if (result.static !== null) {
        if (!result.static.available) {
          lines.push(`static/possible callers: unavailable(${shown(result.static.reason)})`);
        } else {
          lines.push("static/possible callers (not observed; not counted above)");
          if (result.static.callers.length === 0) lines.push("  none");
          for (const row of result.static.callers) {
            lines.push(`  possible  ${shown(row.nodeId)}  [${shown(row.provenance)}]`);
          }
        }
      }
      lines.push(metaLine(result.meta));
      return lines;
    }
    case "values":
      return valueMatchLines(result.result);
    case "compare":
      return comparisonLines(result.result);
    case "value": {
      // A computed-local value: the user's own code ran over the snapshot; it is not evidence.
      const { envelope } = result;
      const body = JSON.stringify(envelope.value, null, 2) ?? "undefined";
      const lines = body.split("\n");
      const shownLines = lines.slice(0, VALUE_RESULT_MAX_LINES);
      return [
        `js: ${envelope.provenance} value (not recorded evidence)${envelope.truncated ? " truncated(output-bytes)" : ""}  (esc closes)`,
        ...shownLines.map((line) => `  ${shown(line)}`),
        ...(lines.length > shownLines.length ? [`  … ${lines.length - shownLines.length} more line(s)`] : []),
        `scope: ${shown(envelope.scope.source)} project ${shown(envelope.scope.projectId)}; coverage ${envelope.coverage.scope}${
          envelope.coverage.reason === undefined ? "" : ` (${shown(envelope.coverage.reason)})`
        }`
      ];
    }
    case "sql": {
      // A table of rows from the shared runner: never drawn as spans. The runner already
      // escaped every control character in its strings, so they are shown as they are
      // (tabCell would escape the runner's backslashes a second time); `shown` still
      // guards the terminal. Non-strings use the lossless Tab cell form.
      const table = result.result;
      const rows = `${table.rows.length} row(s)${table.truncated ? ` truncated(${table.truncation?.reason ?? "limit"})` : ""}`;
      const cellText = (cell: unknown): string => shown(typeof cell === "string" ? cell : tabCell(cell));
      return [
        `sql ${table.schema}: ${rows}  (esc closes)`,
        `  ${table.columns.map(cellText).join(" | ")}`,
        ...table.rows.map((row) => `  ${row.map(cellText).join(" | ")}`),
        `scope: project ${shown(table.scope.projectId)} snapshot ${shown(table.scope.snapshotId)} watermark ${table.scope.watermarkSeq}; ` +
          `coverage: ${table.coverage.exhaustive ? "exhaustive" : "partial"}${table.coverage.retention ? ", retention gap" : ""}${table.coverage.loss ? ", loss" : ""}`
      ];
    }
  }
}

function spanLine(row: SpanRow): string {
  return `  ${row.errored ? "!" : " "} ${shown(row.nodeId)}  ${shown(row.traceId)}/${shown(row.spanId)}`;
}

/**
 * The request selector: one row per inbound request span (full ref), trace-summary rows
 * for traces without request metadata. Shown in place of the trace list once canonical v2
 * pages are loaded.
 */
export function renderRequestList(state: ViewState, width: number): string[] {
  const rows = selectorRows(state.canonical, state.traces);
  if (rows.length === 0) return [];
  const selected = state.selection ?? state.lastKnownSpan;
  const spanSel = selected ? spanKey(selected) : null;
  const traceSel = selected ? traceKey(selected) : null;
  const shownRows = rows.slice(0, TRACE_LIST_HEIGHT);
  const lines = shownRows.map((row) => {
    const hit = row.mode === "request" ? row.key === spanSel : row.key === traceSel;
    return fit(`${hit ? ">" : " "} ${formatSelectorRow(row)}`, width);
  });
  if (rows.length > shownRows.length) lines.push(fit(`   … ${rows.length - shownRows.length} more requests`, width));
  lines.push(rule(width));
  return lines;
}

/** Grouped depth rows (app..symbol) from the shared projector, with the highlighted row. */
export function renderDepthPane(state: ViewState, width: number, height: number): string[] {
  const view = currentDepthView(state);
  const head = `depth ${view.level}${view.focus ? `  ${focusText(view.focus)}` : ""}  (- coarser, + focus/finer)`;
  const lines = [fit(head, width)];
  if (view.rows.length === 0) {
    lines.push(
      state.canonical.length === 0 ? "  no depth rows: no canonical v2 page loaded" : "  no depth rows in scope"
    );
    return lines;
  }
  const budget = Math.max(1, height - 1);
  const cursor = Math.min(state.depthCursor, view.rows.length - 1);
  const start = Math.max(0, Math.min(cursor - budget + 1, view.rows.length - budget));
  view.rows.slice(Math.max(0, start), Math.max(0, start) + budget).forEach((row, offset) => {
    lines.push(fit(`${Math.max(0, start) + offset === cursor ? ">" : " "} ${formatDepthRow(row)}`, width));
  });
  return lines;
}

function metaLine(meta: ResultMeta): string {
  const scope = meta.scope.loaded
    ? `${meta.scope.loaded.loaded}${meta.scope.loaded.total === null ? "" : `/${meta.scope.loaded.total}`} rows`
    : `${meta.scope.spans} spans in ${meta.scope.traces} trace(s)`;
  const parts = [`scope: loaded ${scope}`, `coverage ${meta.coverage}`];
  if (meta.truncated) parts.push("truncated");
  if (meta.scope.retentionGap) parts.push("retention gap");
  if (meta.missing !== null) parts.push(`missing: ${shown(meta.missing)}`);
  return `  ${parts.join("; ")}`;
}
