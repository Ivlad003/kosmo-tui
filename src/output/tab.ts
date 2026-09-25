/**
 * `--print --format tab` (spec 7.1): tab-separated rows, one per trace or per span.
 *
 * - trace list: `id\tname\tspans\tstatus`; a null field is `-`.
 * - spans of one trace, in DFS order: `session\tid\tparent\tstatus\tkind\tfile:line\tname`;
 *   `parent` is the recorded parent id (`-` for a root), no location is `-`.
 * - every cell escapes `\t`, `\n`, `\\` and every control/bidi character as `\uXXXX`, so a
 *   row is always one line with exactly the listed columns.
 * - at most 51 200 B with the trailer; whole rows are dropped from the end.
 */
import type { TraceModel } from "../format/model.js";
import type { SpanRow, TraceSummary } from "../format/types.js";
import { joinWithinCap, walkDfs } from "./kosmo-text.js";

const CELL_ESCAPES = /[\u0000-\u001f\\\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export function escapeTabCell(text: string): string {
  return text.replace(CELL_ESCAPES, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function row(cells: readonly string[]): string {
  return `${cells.map(escapeTabCell).join("\t")}\n`;
}

export function renderTraceListTab(items: readonly TraceSummary[]): string {
  const rows = items.map((item) =>
    row([item.id, item.name ?? "-", item.spans === null ? "-" : String(item.spans), item.status ?? "-"])
  );
  return joinWithinCap("", rows, items.length, "traces");
}

export function renderSpansTab(model: TraceModel): string {
  const rows = (function* (): Generator<string> {
    for (const { ref } of walkDfs(model, model.roots())) {
      const span = model.get(ref);
      if (span === undefined) continue;
      yield row([span.ref.session, span.ref.id, span.parent ?? "-", span.status, span.kind, location(span), span.name]);
    }
  })();
  return joinWithinCap("", rows, model.size, "spans");
}

function location(span: SpanRow): string {
  if (span.location !== undefined) return `${span.location.file}:${span.location.line}`;
  return span.marks.includes("invalid-location") ? "(invalid-location)" : "-";
}
