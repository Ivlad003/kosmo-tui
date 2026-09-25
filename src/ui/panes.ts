/**
 * Panes of the new TUI (spec 6.1–6.5): start screen, trace list, the tree in its three views,
 * Areas, Stack, Bookmarks, Results, the header with the keys that work right now and the footer
 * (prompt, banner or status). Each function returns at most `height` lines of at most `width`
 * columns; data is escaped before it is fitted.
 *
 * Lists are windowed around their cursor (half a page of context on each side), so a list of
 * 200 000 rows costs only the rows on screen.
 */

import { padVisible, truncateVisible, visibleWidth } from "../ansi.js";
import { THEME, paint, type ColorLevel } from "../color.js";
import type { TraceModel } from "../format/model.js";
import { spanKey } from "../format/types.js";
import { renderKosmoText } from "../output/kosmo-text.js";
import type { Notice } from "../readers/types.js";
import { escapeTerminalControls } from "../sanitize.js";
import { STATUS_GLYPH, areaText, locationText } from "./labels.js";
import { formatSpanRef } from "./refs.js";
import { separatorRowText, tableHeaderText, tableRowText, traceListRowText, treeRowText } from "./rows.js";
import {
  ancestorsOf,
  filterActive,
  rowIndex,
  valuesOf,
  visibleRows,
  visibleStartRows,
  visibleTraces,
  type TreeRow,
  type ViewState
} from "./state.js";

const CURSOR = "▸";

/** First index of a window of `height` rows that keeps `cursor` in the middle when it can. */
export function windowStart(count: number, cursor: number, height: number): number {
  if (count <= height || height <= 0) return 0;
  return Math.min(Math.max(0, cursor - Math.floor(height / 2)), count - height);
}

export function formatBytes(size: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${size} B`;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** `YYYY-MM-DD` in UTC: the renderer has no clock and no time zone. */
export function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Left title and right-aligned key hints in one line; the title may take up to 60% of the width. */
export function headerLine(left: string, right: string, width: number): string {
  const titleWidth = Math.min(visibleWidth(left), Math.max(Math.floor(width * 0.6), width - visibleWidth(right) - 1));
  const title = truncateVisible(left, titleWidth);
  const hints = truncateVisible(right, Math.max(0, width - visibleWidth(title) - 1));
  const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(hints));
  return truncateVisible(`${title}${" ".repeat(gap)}${hints}`, width);
}

function fit(lines: readonly string[], width: number, height: number): string[] {
  const out = lines.slice(0, height).map((line) => truncateVisible(line, width));
  while (out.length < height) out.push("");
  return out;
}

export function headerTitle(state: ViewState, color: ColorLevel): string {
  const name = paint("kosmo-tui", { bold: true }, color);
  if (state.screen === "trace" && state.trace !== null) {
    const trace = state.trace.trace;
    return ` ${name} · ${escapeTerminalControls(trace.name ?? trace.id)} · ${state.trace.size} spans · ${trace.status ?? "-"}`;
  }
  if (state.screen === "traces" && state.dataset !== null) {
    const info = state.dataset.info;
    const count = `${state.dataset.traces.length}${state.dataset.hasMore ? "+" : ""} traces`;
    return ` ${name} · ${escapeTerminalControls(info.title ?? info.id)} · ${count}`;
  }
  return ` ${name}`;
}

/** Keys that do something right now (capability-driven: `r` only when the source can be re-read). */
export function keyHints(state: ViewState): string {
  if (state.prompt !== null)
    return state.prompt.kind === "command" ? "Enter run · Esc cancel" : "Enter apply · Esc cancel";
  if (state.screen === "start") return "Enter open · / filter · q quit";
  const reload = state.dataset?.reloadable === true ? "r reload" : null;
  if (state.screen === "traces") {
    const parts = [
      "Enter open",
      "/ filter",
      state.dataset?.hasMore === true ? "> more" : null,
      state.fromStart ? "Esc back" : null,
      reload,
      "q quit"
    ];
    return parts.filter((part) => part !== null).join(" · ");
  }
  if (state.pane === "detail") return "j/k scroll · Tab back · q quit";
  if (state.pane !== "tree") return "j/k move · Enter go · Esc close";
  const parts = [
    "Enter detail",
    "/ search",
    "e errors",
    "a areas",
    "s stack",
    state.view === "table" ? "v tree" : "v table",
    state.view === "text" ? "d tree" : "d text",
    "m mark",
    "y copy",
    ": cmd",
    "T back",
    reload,
    "q quit"
  ];
  return parts.filter((part) => part !== null).join(" · ");
}

export function noticeText(notice: Notice): string {
  switch (notice.kind) {
    case "stream-stopped":
      return notice.line === null
        ? `stream stopped: ${escapeTerminalControls(notice.reason)}`
        : `stream stopped at line ${notice.line}: ${escapeTerminalControls(notice.reason)}`;
    case "unknown-lines-skipped":
      return `${notice.count} unknown lines skipped`;
    case "unknown-fields-ignored":
      return `${notice.count} unknown fields ignored`;
  }
}

function filterText(state: ViewState): string[] {
  const filter = state.filter;
  const parts: string[] = [];
  if (filter.errorsOnly) parts.push("errors only");
  if (filter.search !== null) parts.push(`search ${JSON.stringify(escapeTerminalControls(filter.search))}`);
  if (filter.name !== null) parts.push(`name ${escapeTerminalControls(filter.name)}`);
  if (filter.kindGlob !== null) parts.push(`kind ${escapeTerminalControls(filter.kindGlob)}`);
  if (filter.area !== null) parts.push(`area ${areaText(filter.area)}`);
  return parts;
}

/** Footer: the open prompt, else the banner, else the status line. */
export function footerLine(state: ViewState, width: number, color: ColorLevel): string {
  if (state.prompt !== null) {
    const sigil = state.prompt.kind === "command" ? ":" : "/";
    return truncateVisible(` ${sigil}${escapeTerminalControls(state.prompt.text)}_`, width);
  }
  if (state.banner !== null) {
    const text = ` ${state.banner.level === "error" ? "! " : ""}${escapeTerminalControls(state.banner.text)}`;
    return truncateVisible(state.banner.level === "error" ? paint(text, { fg: THEME.error }, color) : text, width);
  }
  const parts: string[] = [];
  if (state.reading !== null) parts.push(`reading… ${state.reading} spans`);
  if (state.screen !== "start" && state.dataset !== null) parts.push(...state.dataset.notices.map(noticeText));
  if (state.screen === "trace" && state.trace !== null) {
    parts.push(state.view, ...filterText(state));
    if (state.selected !== null && rowIndex(state, state.selected) === -1) parts.push("selection hidden by the filter");
  }
  if (parts.length === 0) return "";
  return truncateVisible(paint(` ${parts.join(" · ")}`, { fg: THEME.muted }, color), width);
}

/* ---------------------------------------------------------------- start and traces */

export function startBody(state: ViewState, width: number, height: number, color: ColorLevel): string[] {
  if (state.reading !== null && state.dataset === null) return fit([` reading… ${state.reading} spans`], width, height);
  const rows = visibleStartRows(state);
  if (rows.length === 0) {
    const lines =
      state.start.filter !== ""
        ? [` no files match ${JSON.stringify(escapeTerminalControls(state.start.filter))}`]
        : [
            " no *.kosmo-trace.json|ndjson|sqlite files in ./ (depth 2) and nothing recent",
            " open one with: kosmo-tui <file>"
          ];
    return fit(lines, width, height);
  }
  const lines: string[] = [];
  let cursorLine = 0;
  rows.forEach((row, index) => {
    if (index === 0 || rows[index - 1]!.source !== row.source) {
      lines.push(row.source === "found" ? " Found in ./ (depth 2)" : " Recent");
    }
    if (index === state.start.cursor) cursorLine = lines.length;
    const meta = row.missing
      ? paint("file-not-found", { fg: THEME.error }, color)
      : `${(row.size === null ? "-" : formatBytes(row.size)).padStart(8)}  ${row.mtimeMs === null ? "-" : formatDate(row.mtimeMs)}`;
    const pathWidth = Math.max(8, width - 4 - visibleWidth(meta) - 2);
    const cursor = index === state.start.cursor ? CURSOR : " ";
    lines.push(` ${cursor} ${padVisible(escapeTerminalControls(row.path), pathWidth)}  ${meta}`);
  });
  const start = windowStart(lines.length, cursorLine, height);
  return fit(lines.slice(start, start + height), width, height);
}

export function tracesBody(state: ViewState, width: number, height: number, color: ColorLevel): string[] {
  const dataset = state.dataset;
  if (dataset === null) return fit([], width, height);
  const traces = visibleTraces(state);
  if (traces.length === 0) {
    const text =
      state.traceList.filter !== ""
        ? ` no traces match ${JSON.stringify(escapeTerminalControls(state.traceList.filter))}`
        : " the dataset holds no traces";
    return fit([text], width, height);
  }
  const more = dataset.hasMore ? 1 : 0;
  const room = Math.max(1, height - more);
  const start = windowStart(traces.length, state.traceList.cursor, room);
  const lines = traces
    .slice(start, start + room)
    .map((trace, offset) => traceListRowText(trace, start + offset === state.traceList.cursor, width, color));
  if (more === 1) lines.push(paint("   … more traces: press >", { fg: THEME.muted }, color));
  return fit(lines, width, height);
}

/* ---------------------------------------------------------------- tree, table, text */

/** Rows `[from, to)` of `rows` around `selected` whose lines (separators included) fit `height`. */
function treeWindow(rows: readonly TreeRow[], selected: number, height: number): [number, number] {
  const cost = (index: number): number => (rows[index]!.separator === undefined ? 1 : 2);
  const at = Math.max(0, selected);
  let from = at;
  let to = at + 1;
  let used = Math.min(height, cost(at));
  const above = Math.floor((height - used) / 2);
  let up = 0;
  while (from > 0 && up + cost(from - 1) <= above) {
    from -= 1;
    up += cost(from);
  }
  used += up;
  while (to < rows.length && used + cost(to) <= height) {
    used += cost(to);
    to += 1;
  }
  while (from > 0 && used + cost(from - 1) <= height) {
    from -= 1;
    used += cost(from);
  }
  return [from, to];
}

type TextCache = { model: TraceModel; lines: readonly string[]; index: ReadonlyMap<string, number> };
let textCache: TextCache | null = null;

/** kosmo-text/v1 of the whole trace with `--detail 0` (spec 7.2), one line per span after the header. */
function kosmoTextLines(state: ViewState, model: TraceModel): TextCache {
  if (textCache !== null && textCache.model === model) return textCache;
  const text = renderKosmoText(model, {
    detail: 0,
    values: (ref) => {
      const found = valuesOf(state, ref);
      return found === "loading" ? undefined : found;
    }
  });
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const index = new Map<string, number>();
  model.dfs().forEach((ref, position) => index.set(spanKey(ref), position + 1));
  textCache = { model, lines, index };
  return textCache;
}

export function treeBody(state: ViewState, width: number, height: number, color: ColorLevel): string[] {
  const model = state.trace;
  if (model === null || height <= 0) return fit([], width, height);
  if (state.view === "text") {
    const { lines, index } = kosmoTextLines(state, model);
    const selected = state.selected === null ? -1 : (index.get(spanKey(state.selected)) ?? -1);
    const cursor = selected >= 0 && selected < lines.length ? selected : lines.length - 1;
    const start = windowStart(lines.length, cursor, height);
    const shown = lines
      .slice(start, start + height)
      .map((line, offset) => ` ${start + offset === selected ? CURSOR : " "} ${escapeTerminalControls(line)}`);
    return fit(shown, width, height);
  }
  const rows = visibleRows(state);
  if (rows.length === 0) {
    return fit(
      [filterActive(state.filter) ? "   no spans match the filter (Esc clears it)" : "   the trace has no spans"],
      width,
      height
    );
  }
  const selected = rowIndex(state, state.selected);
  const context = (row: TreeRow) => ({
    selected: state.selected !== null && selected !== -1 && rows[selected] === row,
    width,
    color,
    values: (() => {
      const found = valuesOf(state, row.ref);
      return found === "loading" ? undefined : found;
    })()
  });
  if (state.view === "table") {
    const room = Math.max(0, height - 1);
    const start = windowStart(rows.length, Math.max(0, selected), room);
    const lines = [tableHeaderText(width, color)];
    for (const row of rows.slice(start, start + room)) lines.push(tableRowText(model, row, context(row)));
    return fit(lines, width, height);
  }
  const [from, to] = treeWindow(rows, selected, height);
  const lines: string[] = [];
  for (let index = from; index < to; index += 1) {
    const row = rows[index]!;
    const own = treeRowText(model, row, state.collapsed.has(spanKey(row.ref)), context(row));
    if (row.separator !== undefined && lines.length + 2 <= height) lines.push(separatorRowText(row, width, color));
    lines.push(own);
  }
  return fit(lines, width, height);
}

/* ---------------------------------------------------------------- aux panes */

function titled(
  title: string,
  items: readonly string[],
  cursor: number,
  width: number,
  height: number,
  trailer: string | null
): string[] {
  const room = Math.max(0, height - 1 - (trailer === null ? 0 : 1));
  const start = windowStart(items.length, cursor, room);
  const lines = [title, ...items.slice(start, start + room)];
  if (trailer !== null) lines.push(trailer);
  return fit(lines, width, height);
}

function pointer(index: number, cursor: number): string {
  return index === cursor ? CURSOR : " ";
}

function spanLabel(model: TraceModel, ref: Parameters<TraceModel["get"]>[0]): string {
  const span = model.get(ref);
  if (span === undefined) return `${escapeTerminalControls(formatSpanRef(ref))} (not in this trace)`;
  return `${STATUS_GLYPH[span.status]} ${escapeTerminalControls(span.name)}  ${locationText(span)}`;
}

export function areasPane(state: ViewState, width: number, height: number, color: ColorLevel): string[] {
  const rows = state.trace?.areas() ?? [];
  const nameWidth = Math.max(10, Math.floor(width * 0.5));
  const items = rows.map(
    (row, index) =>
      ` ${pointer(index, state.paneCursor)} ${padVisible(areaText(row), nameWidth)} ${String(row.spans).padStart(6)} spans  ${
        row.errors > 0 ? paint(`${row.errors} errors`, { fg: THEME.error }, color) : "0 errors"
      }`
  );
  return titled(
    paint(` areas (${rows.length}) · Enter filter · Esc close`, { bold: true }, color),
    items,
    state.paneCursor,
    width,
    height,
    null
  );
}

export function stackPane(state: ViewState, width: number, height: number, color: ColorLevel): string[] {
  const model = state.trace;
  const title = paint(" stack · recorded ancestors, not a live JS stack", { bold: true }, color);
  if (model === null || state.selected === null) return titled(title, ["   nothing selected"], 0, width, height, null);
  const walk = ancestorsOf(model, state.selected);
  const items = walk.frames.map(
    (ref, index) => ` ${pointer(index, state.paneCursor)} #${index} ${spanLabel(model, ref)}`
  );
  const stop =
    walk.stop.kind === "root"
      ? "   root reached"
      : walk.stop.kind === "unknown"
        ? `   parent unknown(${walk.stop.reason})`
        : walk.stop.kind === "cycle"
          ? "   cycle: parent edge dropped"
          : "   walk stopped";
  return titled(title, items, state.paneCursor, width, height, paint(stop, { fg: THEME.muted }, color));
}

export function bookmarksPane(state: ViewState, width: number, height: number, color: ColorLevel): string[] {
  const current = state.trace?.trace.id ?? null;
  const items = state.bookmarks.map((bookmark, index) => {
    const where = bookmark.ref.trace === current ? "" : `  (trace ${escapeTerminalControls(bookmark.ref.trace)})`;
    return ` ${pointer(index, state.paneCursor)} ${index + 1}. ${escapeTerminalControls(bookmark.name)}  ${escapeTerminalControls(formatSpanRef(bookmark.ref))}${where}`;
  });
  return titled(
    paint(` bookmarks (${items.length}) · Enter jump · Esc close`, { bold: true }, color),
    items,
    state.paneCursor,
    width,
    height,
    null
  );
}

export function resultsPane(state: ViewState, width: number, height: number, color: ColorLevel): string[] {
  const model = state.trace;
  const info = state.resultsInfo;
  const refs = state.results ?? [];
  if (model === null || info === null) return fit([], width, height);
  const items = refs.map((ref, index) => {
    const label = info.labels[index] ?? null;
    return ` ${pointer(index, state.paneCursor)} ${label === null ? spanLabel(model, ref) : escapeTerminalControls(label)}`;
  });
  const title = paint(` ${escapeTerminalControls(info.title)} · Enter go · Esc close`, { bold: true }, color);
  const trailer =
    info.footer === null ? null : paint(`   ${escapeTerminalControls(info.footer)}`, { fg: THEME.muted }, color);
  return titled(title, items, state.paneCursor, width, height, trailer);
}
