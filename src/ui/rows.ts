/**
 * One screen line per row: tree row, table row, session separator, trace-list row (spec 6.2, 6.3).
 * Every piece of data is escaped (labels.ts) before it is fitted; styles come from `paint`, so a
 * line may carry SGR and nothing else.
 */

import { padVisible, truncateVisible } from "../ansi.js";
import { THEME, paint, type ColorLevel, type Style } from "../color.js";
import type { TraceModel } from "../format/model.js";
import type { SpanRow, SpanStatus, SpanValues, TraceSummary } from "../format/types.js";
import { maskString } from "../format/value.js";
import { escapeTerminalControls } from "../sanitize.js";
import {
  DENIED_TEXT,
  ERROR_PATH_GLYPH,
  STATUS_GLYPH,
  STRICT_MARK,
  areaText,
  durationText,
  httpText,
  isDenied,
  isErrorPathKind,
  isStrictDuplicate,
  locationText,
  parentMark,
  statusText
} from "./labels.js";
import type { TreeRow } from "./state.js";

export type RowContext = {
  readonly selected: boolean;
  readonly width: number;
  readonly color: ColorLevel;
  /** Values of the span when known (inline or loaded), for `→ false (denied)`. */
  readonly values: SpanValues | undefined;
};

const CURSOR = "▸";
const DIM: Style = { dim: true };

const GLYPH_STYLE: Readonly<Record<SpanStatus, Style>> = {
  complete: { fg: THEME.ok },
  errored: { fg: THEME.error },
  running: { fg: THEME.warn },
  suspended: { fg: THEME.muted },
  unknown: { fg: THEME.warn }
};

/**
 * Indentation that never eats the row: two columns per level up to a third of the width, then a
 * `·<depth>` marker so a 50 000-deep span still shows its name.
 */
export function indentText(depth: number, width: number): string {
  const budget = Math.max(0, Math.floor(width / 3));
  if (depth * 2 <= budget) return "  ".repeat(depth);
  const label = `·${depth} `;
  return " ".repeat(Math.max(0, budget - label.length)) + label;
}

type Piece = { text: string; style?: Style };

function join(pieces: readonly Piece[], color: ColorLevel, whole: Style | null): string {
  if (whole !== null) return paint(pieces.map((piece) => piece.text).join(""), whole, color);
  return pieces
    .map((piece) => (piece.style === undefined ? piece.text : paint(piece.text, piece.style, color)))
    .join("");
}

/** The parts after the glyph that tree and table rows share, in spec 6.3 order. */
function spanPieces(span: SpanRow, context: RowContext): Piece[] {
  const pieces: Piece[] = [];
  if (isErrorPathKind(span.kind)) pieces.push({ text: `${ERROR_PATH_GLYPH} `, style: { fg: THEME.error } });
  pieces.push({ text: escapeTerminalControls(span.name), ...(context.selected ? { style: { bold: true } } : {}) });
  if (span.kind !== "function") pieces.push({ text: " " }, { text: escapeTerminalControls(span.kind), style: DIM });
  const http = httpText(span);
  if (http !== null) pieces.push({ text: ` ${http}` });
  if (isDenied(span, context.values)) pieces.push({ text: ` ${DENIED_TEXT}`, style: { fg: THEME.warn } });
  return pieces;
}

function tailText(span: SpanRow, model: TraceModel): string {
  const parts = [locationText(span)];
  if (span.status === "running" || span.status === "unknown") parts.push(statusText(span));
  else if (span.durationMs !== undefined) parts.push(durationText(span));
  const mark = parentMark(model.parentOf(span.ref));
  if (mark !== null) parts.push(mark);
  if (isStrictDuplicate(span)) parts.push(STRICT_MARK);
  return `  ${parts.join("  ")}`;
}

/**
 * Tree row: cursor, indent, expander (`-` open, `+` collapsed), status glyph, name, kind (unless
 * `function`, in full and dimmed), framework forms, `file:line`, duration or status, marks. A
 * context ancestor of a filter match and a StrictMode duplicate are dimmed as a whole.
 */
export function treeRowText(model: TraceModel, row: TreeRow, collapsed: boolean, context: RowContext): string {
  const span = model.get(row.ref);
  if (span === undefined) return "";
  const expander = model.children(row.ref).length === 0 ? " " : collapsed ? "+" : "-";
  const whole = row.context || isStrictDuplicate(span) ? DIM : null;
  const pieces: Piece[] = [
    { text: ` ${context.selected ? CURSOR : " "} ${indentText(row.depth, context.width)}${expander} ` },
    { text: STATUS_GLYPH[span.status], style: GLYPH_STYLE[span.status] },
    { text: " " },
    ...spanPieces(span, context),
    { text: tailText(span, model) }
  ];
  return truncateVisible(join(pieces, context.color, whole), context.width);
}

/** «┄┄ browser → node · n1 ┄┄» at the child's depth; never selectable. */
export function separatorRowText(row: TreeRow, width: number, color: ColorLevel): string {
  if (row.separator === undefined) return "";
  const text = `     ${indentText(row.depth, width)}${escapeTerminalControls(row.separator)}`;
  return truncateVisible(paint(text, DIM, color), width);
}

function columns(width: number): { name: number; kind: number; location: number } {
  const available = Math.max(20, width - 5);
  return {
    name: Math.floor(available * 0.28),
    kind: Math.floor(available * 0.18),
    location: Math.floor(available * 0.26)
  };
}

export function tableHeaderText(width: number, color: ColorLevel): string {
  const cols = columns(width);
  const text = `   S ${padVisible("NAME", cols.name)} ${padVisible("KIND", cols.kind)} ${padVisible("LOCATION", cols.location)} ${"DURATION".padStart(8)}  AREA`;
  return truncateVisible(paint(text, DIM, color), width);
}

/** Table row: the same DFS rows as the tree, flat, one column per field. */
export function tableRowText(model: TraceModel, row: TreeRow, context: RowContext): string {
  const span = model.get(row.ref);
  if (span === undefined) return "";
  const cols = columns(context.width);
  const kind = span.kind === "function" ? "" : escapeTerminalControls(span.kind);
  const duration = span.status === "running" ? "running" : durationText(span);
  const pieces: Piece[] = [
    { text: ` ${context.selected ? CURSOR : " "} ` },
    { text: STATUS_GLYPH[span.status], style: GLYPH_STYLE[span.status] },
    { text: " " },
    {
      text: padVisible(escapeTerminalControls(span.name), cols.name),
      ...(context.selected ? { style: { bold: true } } : {})
    },
    { text: " " },
    { text: padVisible(kind, cols.kind), style: DIM },
    {
      text: ` ${padVisible(locationText(span), cols.location)} ${duration.padStart(8)}  ${areaText(model.areaOf(span.ref))}`
    }
  ];
  const whole = row.context || isStrictDuplicate(span) ? DIM : null;
  return truncateVisible(join(pieces, context.color, whole), context.width);
}

/**
 * `METHOD route → status` of the first http.server span, `N requests` when there are several. The
 * route is masked (spec 8.3, `maskString`) before it is escaped, as in the tree row.
 */
export function requestsText(summary: TraceSummary): string {
  const requests = summary.requests;
  if (requests === null) return "";
  const parts: string[] = [];
  if (requests.first !== null) {
    const { method, route, status } = requests.first;
    parts.push(
      `${escapeTerminalControls(method ?? "-")} ${route === null ? "-" : escapeTerminalControls(maskString(route))} → ${
        status === null ? "-" : escapeTerminalControls(String(status))
      }`
    );
  }
  if (requests.count > 1) parts.push(`${requests.count} requests`);
  return parts.join(" · ");
}

/** Trace list row (spec 6.2): id, name, span count, status and the request summary. Nulls are `-`. */
export function traceListRowText(summary: TraceSummary, selected: boolean, width: number, color: ColorLevel): string {
  const idWidth = Math.max(8, Math.min(24, Math.floor(width * 0.25)));
  const nameWidth = Math.max(8, Math.min(32, Math.floor(width * 0.3)));
  const status = summary.status ?? "-";
  const statusStyle: Style =
    status === "errored" ? { fg: THEME.error } : status === "incomplete" ? { fg: THEME.warn } : {};
  const requests = requestsText(summary);
  const text =
    ` ${selected ? CURSOR : " "} ${padVisible(escapeTerminalControls(summary.id), idWidth)} ` +
    `${padVisible(escapeTerminalControls(summary.name ?? "-"), nameWidth)} ` +
    `${String(summary.spans ?? "-").padStart(7)}  ${paint(requests === "" ? status : status.padEnd(10), statusStyle, color)}` +
    (requests === "" ? "" : `  ${requests}`);
  return truncateVisible(text, width);
}
