/**
 * Small builders for UI tests: SpanRow literals and a TraceModel through the real
 * `buildTraceModel`, so every UI test sees the spec 4.3 order the model produces.
 */
import { buildTraceModel, type TraceModel } from "../../src/format/model.js";
import type { LinkRow, SpanRef, SpanRow } from "../../src/format/types.js";

export type SpanInput = Partial<Omit<SpanRow, "ref">> & { id: string; session?: string; trace?: string };

export function span(input: SpanInput): SpanRow {
  const { id, session = "s1", trace = "t1", ...rest } = input;
  return {
    ref: { trace, session, id },
    parent: null,
    order: 0,
    name: id,
    kind: "function",
    status: "complete",
    droppedAttrs: 0,
    marks: [],
    ...rest
  };
}

export function ref(id: string, session = "s1", trace = "t1"): SpanRef {
  return { trace, session, id };
}

export function model(
  spans: readonly SpanRow[],
  links: readonly LinkRow[] = [],
  name: string | null = "GET /cart"
): TraceModel {
  const trace = spans[0]?.ref.trace ?? "t1";
  return buildTraceModel({ id: trace, name }, spans, links);
}

/** root → a → b → c …: `depth` spans in one session, each the only child of the previous. */
export function chain(depth: number): SpanRow[] {
  const spans: SpanRow[] = [];
  for (let index = 0; index < depth; index += 1) {
    spans.push(span({ id: `c${index}`, parent: index === 0 ? null : `c${index - 1}`, order: index }));
  }
  return spans;
}
