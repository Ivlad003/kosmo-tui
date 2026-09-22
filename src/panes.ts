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
import {
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
  return null;
}

export function emptyMessage(state: ViewState): string {
  const { connection } = state;
  if (connection.kind === "disconnected") return "  no data: daemon unreachable";
  if (connection.sdk === "absent") return "  no data: SDK not attached to the application";
  if (connection.events === "none") return "  no data: SDK attached, nothing recorded yet";
  if (state.filters.errorsOnly || state.filters.search) return "  no rows match the current filter";
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
  if (state.searchInput !== null) {
    // The prompt replaces the hints rather than adding a row, so opening search cannot
    // change the height of the body underneath it.
    return [rule(width), fit(`search: ${shown(state.searchInput)}_  (enter apply, esc cancel)`, width)];
  }
  const filters = [
    state.filters.errorsOnly ? "errors-only" : null,
    state.filters.search === null ? null : `search="${shown(state.filters.search)}"`
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
  const keys = state.replay
    ? "j/k move  n/b step  L live  space expand  v view  d dsl  e errors  / search  q quit"
    : "j/k move  space expand  p pause  v view  d dsl  e errors  / search  q quit";
  const prefix = filters.length === 0 ? `${state.view}/${state.dsl}` : `${state.view}/${state.dsl}  [${filters}]`;
  return [rule(width), fit(`${prefix}  ${keys}`, width)];
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
