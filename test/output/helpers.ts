/** Small models for output tests, built through the Task 5 model (no fixtures needed). */
import { buildTraceModel, type TraceModel } from "../../src/format/model.js";
import { NOT_RECORDED, type LinkRow, type SpanRow, type SpanValues } from "../../src/format/types.js";

export const NO_VALUES: SpanValues = { args: NOT_RECORDED, return: NOT_RECORDED, error: NOT_RECORDED };

export type SpanInput = Partial<Omit<SpanRow, "ref">> & { session?: string; trace?: string };

export function span(id: string, parent: string | null, order: number, extra: SpanInput = {}): SpanRow {
  const { session = "s1", trace = "t1", ...rest } = extra;
  return {
    ref: { trace, session, id },
    parent,
    order,
    name: id,
    kind: "function",
    status: "complete",
    droppedAttrs: 0,
    marks: [],
    values: NO_VALUES,
    ...rest
  };
}

export function model(
  spans: readonly SpanRow[],
  options: { links?: readonly LinkRow[]; id?: string; name?: string | null } = {}
): TraceModel {
  return buildTraceModel(
    { id: options.id ?? "t1", name: options.name === undefined ? "GET /cart" : options.name },
    spans,
    options.links ?? []
  );
}

/** Lookup that knows nothing: renderers fall back to SpanRow.values. */
export const fromSpans = (): undefined => undefined;

/** A chain root → c1 → c2 → … of `depth` spans, built without recursion. */
export function chain(depth: number): SpanRow[] {
  const spans: SpanRow[] = [];
  for (let i = 0; i < depth; i += 1) spans.push(span(`c${i}`, i === 0 ? null : `c${i - 1}`, i));
  return spans;
}

export function utf8(text: string): number {
  return new TextEncoder().encode(text).length;
}
