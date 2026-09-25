/**
 * One frame of the new TUI: header (title + keys that work now), body of the current screen,
 * footer (prompt, banner or status). Pure: the same state and size give the same lines.
 *
 * Layout of the trace screen: the list (tree, table or kosmo-text) takes 40% of the body, the lower
 * part shows the detail of the selected span or the focused aux pane. Enter on the tree gives the
 * detail the whole body. Below 40x10 the frame is `tooSmallFrame` from terminal.ts.
 *
 * Every line is at most `cols` wide and the frame has exactly `rows` lines. Lines may carry SGR
 * from `paint` and, with links enabled, OSC 8 around a validated `file://` URI; nothing else.
 */

import { truncateVisible } from "../ansi.js";
import type { ColorLevel } from "../color.js";
import { spanKey } from "../format/types.js";
import { isTooSmall, tooSmallFrame } from "../terminal.js";
import { detailLines } from "./detail.js";
import {
  areasPane,
  bookmarksPane,
  footerLine,
  headerLine,
  headerTitle,
  keyHints,
  resultsPane,
  stackPane,
  startBody,
  tracesBody,
  treeBody
} from "./panes.js";
import { valuesOf, type ViewState } from "./state.js";

export type RenderEnv = { readonly color: ColorLevel; readonly links: boolean };

/** Share of the trace-screen body given to the list; the rest is detail or an aux pane. */
export const LIST_SHARE = 0.4;

export function renderFrame(state: ViewState, size: { cols: number; rows: number }, env: RenderEnv): string[] {
  const cols = Math.max(0, Math.floor(size.cols));
  const rows = Math.max(0, Math.floor(size.rows));
  if (isTooSmall({ cols, rows })) {
    const small = [...tooSmallFrame({ cols, rows })];
    while (small.length < rows) small.push("");
    return small;
  }
  const bodyHeight = rows - 2;
  const header = headerLine(headerTitle(state, env.color), `${keyHints(state)} `, cols);
  const body =
    state.screen === "start"
      ? startBody(state, cols, bodyHeight, env.color)
      : state.screen === "traces"
        ? tracesBody(state, cols, bodyHeight, env.color)
        : traceBody(state, cols, bodyHeight, env);
  const frame = [header, ...body.slice(0, bodyHeight), footerLine(state, cols, env.color)];
  while (frame.length < rows) frame.splice(frame.length - 1, 0, "");
  return frame.map((line) => truncateVisible(line, cols));
}

function detailFor(state: ViewState, width: number, height: number, env: RenderEnv, focused: boolean): string[] {
  const model = state.trace;
  if (model === null || state.selected === null || model.get(state.selected) === undefined) {
    const lines = ["   nothing selected: j/k to move"];
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }
  const key = spanKey(state.selected);
  // One column of margin, as in the spec 6.4 drawing.
  return detailLines(
    {
      model,
      ref: state.selected,
      root: state.root,
      values: valuesOf(state, state.selected),
      snippet: state.snippets.get(key)
    },
    { width: width - 1, height, focused, scroll: state.detailScroll, color: env.color, links: env.links }
  ).map((line) => (line === "" ? "" : ` ${line}`));
}

function traceBody(state: ViewState, width: number, height: number, env: RenderEnv): string[] {
  if (state.pane === "detail") return detailFor(state, width, height, env, true);
  const listHeight = Math.max(3, Math.floor(height * LIST_SHARE));
  const lowerHeight = height - listHeight;
  const list = treeBody(state, width, listHeight, env.color);
  let lower: string[];
  switch (state.pane) {
    case "areas":
      lower = areasPane(state, width, lowerHeight, env.color);
      break;
    case "stack":
      lower = stackPane(state, width, lowerHeight, env.color);
      break;
    case "bookmarks":
      lower = bookmarksPane(state, width, lowerHeight, env.color);
      break;
    case "results":
      lower = resultsPane(state, width, lowerHeight, env.color);
      break;
    default:
      lower = detailFor(state, width, lowerHeight, env, false);
  }
  return [...list, ...lower];
}
