import { truncateVisible } from "../ansi.js";
import { escapeTerminalControls } from "../sanitize.js";
import { pausedRows } from "./debug-reduce.js";
import { windowStart } from "./panes.js";
import type { ViewState } from "./state.js";

export function debugPane(state: ViewState, width: number, height: number): string[] {
  const confirm = state.debug.confirm;
  if (confirm !== null) {
    return fit(
      [
        ` ${escapeTerminalControls(confirm.title)}`,
        ...confirm.lines.map((line) => ` ${escapeTerminalControls(line)}`),
        "",
        confirm.declined === undefined ? " y confirm · n cancel" : " y yes · n no · Esc cancel"
      ],
      width,
      height
    );
  }
  if (state.pane === "hits") {
    const points = state.debug.points.map(
      (point) =>
        ` ${point.kind} ${point.id} ${escapeTerminalControls(point.file)}:${point.line}${point.runtime === null ? "" : ` [${point.runtime}]`} · ${escapeTerminalControls(point.state)}`
    );
    if (state.debug.hits.length === 0) return fit([...points, " no hits yet"], width, height);
    const room = Math.max(1, height - points.length);
    return fit(
      [...points, ...listRows(state.debug.hits, state.paneCursor, room, ` Hits (${state.debug.hits.length})`)],
      width,
      height
    );
  }
  if (state.pane === "paused") {
    const rows = pausedRows(state);
    if (rows.length === 0) return fit([" live JS stack (paused)", " (no frames)"], width, height);
    return fit(listRows(rows, state.paneCursor, height, " live JS stack (paused)"), width, height);
  }
  const rows = state.debug.targets.length === 0 ? [" no debug targets · r rescan"] : [];
  const start = windowStart(state.debug.targets.length, state.paneCursor, Math.max(1, height - 1));
  rows.push(" Debug targets");
  for (let index = start; index < state.debug.targets.length && rows.length < height; index += 1) {
    const row = state.debug.targets[index]!;
    const mark = index === state.paneCursor ? "▸" : " ";
    const dot =
      row.kind === "browser-launch" ? "◆" : row.inspector === "on" ? "●" : row.inspector === "off" ? "○" : "?";
    const hint =
      row.inspector === "off" && row.kind === "node"
        ? "  inspector off (Enter → enable via SIGUSR1)"
        : row.inspector === "off" && row.kind === "supervisor"
          ? "  inspector off"
          : "";
    rows.push(
      `${mark} ${dot} ${escapeTerminalControls(row.label)}  pid ${row.pid ?? "-"}  ${row.host ?? ""}:${row.port ?? ""}${row.sameProject ? "  same project" : ""}${hint}`
    );
  }
  return fit(rows, width, height);
}

/** Title plus the window of `items` around `cursor`; the cursor row is marked. */
function listRows(items: readonly string[], cursor: number, height: number, title: string): string[] {
  const visible = Math.max(1, height - 1);
  const start = windowStart(items.length, cursor, visible);
  const rows = [title];
  for (let index = start; index < items.length && rows.length < height; index += 1) {
    rows.push(`${index === cursor ? "▸" : " "} ${escapeTerminalControls(items[index]!)}`);
  }
  return rows;
}

function fit(lines: string[], width: number, height: number): string[] {
  const out = lines.slice(0, height).map((line) => truncateVisible(line, width));
  while (out.length < height) out.push("");
  return out;
}
