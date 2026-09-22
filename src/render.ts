/**
 * Pure frame rendering for the viewer, ported from kosmo-callflow
 * `packages/cli/src/connect/render.ts`; the panes themselves live in panes.ts.
 *
 * Returns an array of lines rather than a blob so tests can assert exact rows without a
 * PTY, and so the terminal layer can diff line-by-line and repaint only what changed.
 * No ANSI escapes are emitted here; styling belongs to the terminal layer.
 */

import {
  DETAIL_PANE_HEIGHT,
  TRACE_LIST_HEIGHT,
  emptyMessage,
  fit,
  renderBookmarkList,
  renderCommandResultPane,
  renderDepthPane,
  renderDetailPane,
  renderFooter,
  renderHeader,
  renderRequestList,
  renderSpanRow,
  renderStackPane,
  renderTraceList,
  selectionBanner
} from "./panes.js";
import { groupDepthShown, spanKey, visibleSpans, type SpanRow, type ViewState } from "./view-state.js";

export { DETAIL_PANE_HEIGHT, TRACE_LIST_HEIGHT, connectionLine, renderDetailPane, selectionBanner } from "./panes.js";

export type Frame = string[];

export function renderFrame(state: ViewState, cols: number, rows: number): Frame {
  const width = Math.max(20, Math.floor(cols));
  const height = Math.max(5, Math.floor(rows));

  const header = renderHeader(state, width);
  const footer = renderFooter(state, width);
  const bodyHeight = Math.max(1, height - header.length - footer.length);
  const body = renderBody(state, width, bodyHeight);

  return [...header, ...body, ...footer].map((line) => fit(line, width));
}

function renderBody(state: ViewState, width: number, height: number): Frame {
  const banner = selectionBanner(state);
  const bannerLines = banner ? [fit(banner, width)] : [];

  // The trace list appears only when there are traces, and never gets more than half
  // the body, so it cannot crowd out the spans; the whole body is clamped so the frame
  // is always exactly `height` rows.
  const available = Math.max(1, height - bannerLines.length);
  const traceBudget = Math.min(TRACE_LIST_HEIGHT + 1, Math.floor(available / 2));
  // With canonical v2 pages loaded the list is request-centric (requests.ts).
  const traceList = state.canonical.length > 0 ? renderRequestList(state, width) : renderTraceList(state, width);
  const traceLines = traceList.slice(0, Math.max(0, traceBudget));
  const afterTraces = Math.max(1, available - traceLines.length);

  // The details pane only appears once detail is actually loaded: a placeholder would
  // steal a row to say nothing and invite filling it with invented values.
  const detailBudget = state.detail === null ? 0 : Math.min(DETAIL_PANE_HEIGHT, Math.floor(afterTraces / 2));
  const detailLines = detailBudget === 0 ? [] : renderDetailPane(state.detail!, state, width, detailBudget);
  const afterDetail = Math.max(1, afterTraces - detailLines.length);
  // The stack pane is opt-in (`s`) and takes at most a third of what is left.
  const stackBudget = state.stackOpen ? Math.min(DETAIL_PANE_HEIGHT, Math.floor(afterDetail / 3)) : 0;
  const stackLines = stackBudget === 0 ? [] : renderStackPane(state, width, stackBudget);
  const afterStack = Math.max(1, afterDetail - stackLines.length);
  // The `:` result pane appears only while a query result is shown.
  const resultBudget = state.commandResult === null ? 0 : Math.min(DETAIL_PANE_HEIGHT, Math.floor(afterStack / 2));
  const resultLines = resultBudget === 0 ? [] : renderCommandResultPane(state.commandResult!, width, resultBudget);
  const remaining = Math.max(1, afterStack - resultLines.length);
  // At call depth a focus narrows the span rows to its shared-projector membership.
  const members = state.depth === "call" && state.depthFocus !== null ? new Set(state.depthFocus.members) : null;
  const rows = members === null ? visibleSpans(state) : visibleSpans(state).filter((row) => members.has(spanKey(row)));

  const spanLines =
    state.bookmarkList !== null
      ? pad(renderBookmarkList(state, width, remaining), remaining)
      : groupDepthShown(state)
        ? pad(renderDepthPane(state, width, remaining), remaining)
        : rows.length === 0
          ? pad([emptyMessage(state)], remaining)
          : pad(
              windowAround(rows, state, remaining).map((span) => renderSpanRow(span, state)),
              remaining
            );

  return pad(
    [...bannerLines, ...traceLines, ...spanLines, ...resultLines, ...stackLines, ...detailLines].slice(0, height),
    height
  );
}

/**
 * Slice the visible window from the anchored scrollTop held in state. The window is
 * NOT centred on the selection: centring would drag the viewport every time a row sorts
 * in above it. The reducer already compensates scrollTop for inserted rows.
 */
function windowAround(rows: SpanRow[], state: ViewState, height: number): SpanRow[] {
  if (rows.length <= height) return rows;
  const maxTop = Math.max(0, rows.length - height);
  const start = Math.min(Math.max(0, state.scrollTop), maxTop);
  return rows.slice(start, start + height);
}

function pad(lines: Frame, height: number): Frame {
  const out = lines.slice(0, height);
  while (out.length < height) out.push("");
  return out;
}
