/**
 * `--print --format json` (spec 7.1): a normalized `kosmo-trace/v1` document, or a slice
 * with one trace and the links that touch it (4.12). No byte cap: this is a data export.
 *
 * - No terminal escaping. C0, DEL, C1 and bidi characters are written as JSON `\uXXXX`
 *   escapes (JSON.stringify's short forms `\n`, `\t`, … are rewritten too), so the text
 *   contains no control character at all.
 * - Key masking (8.3) is applied; a value keeps its state.
 * - Fields dropped while reading (location, snippet, attrs entries, durationMs) are not
 *   written, so the output validates again. `invalid-value` becomes
 *   `{"state":"not-recorded","reason":"invalid-value"}`, an unknown state becomes
 *   `not-recorded` with the raw state as reason.
 * - Spans are written per trace in DFS order (4.3), so the document does not depend on
 *   the order of the input file.
 */
import { maskAttrs } from "../format/kinds.js";
import type { TraceModel } from "../format/model.js";
import type { Area, DatasetInfo, LinkRow, Location, SpanRef, SpanRow, TraceSummary, Value } from "../format/types.js";
import { maskValue } from "../format/value.js";
import { walkDfs, type ValuesLookup } from "./kosmo-text.js";

/** A JSON tree as written by this module. */
export type JsonOut = null | boolean | number | string | JsonOut[] | { [key: string]: JsonOut };

export function renderDatasetJson(input: {
  dataset: DatasetInfo;
  traces: readonly TraceSummary[];
  models: readonly TraceModel[];
  values: ValuesLookup;
}): string {
  return jsonText({
    format: "kosmo-trace",
    version: 1,
    dataset: datasetJson(input.dataset),
    traces: input.traces.map(traceJson),
    spans: input.models.flatMap((model) => spansJson(model, input.values)),
    links: collectLinks(input.models)
  });
}

export function renderTraceSliceJson(input: {
  dataset: DatasetInfo;
  model: TraceModel;
  values: ValuesLookup;
  links: readonly LinkRow[];
}): string {
  const id = input.model.trace.id;
  return jsonText({
    format: "kosmo-trace",
    version: 1,
    dataset: datasetJson(input.dataset),
    traces: [traceJson(input.model.trace)],
    spans: spansJson(input.model, input.values),
    links: input.links.filter((link) => link.from.trace === id || link.to.trace === id).map(linkJson)
  });
}

const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  b: "\\u0008",
  t: "\\u0009",
  n: "\\u000a",
  f: "\\u000c",
  r: "\\u000d"
};

/** Pretty JSON (2 spaces) where every C0, DEL, C1 and bidi character is a `\uXXXX` escape. */
export function jsonText(document: JsonOut): string {
  const text = JSON.stringify(document, null, 2)
    .replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (whole, escape: string) => SHORT_ESCAPES[escape] ?? whole)
    .replace(
      /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
    );
  return `${text}\n`;
}

function datasetJson(dataset: DatasetInfo): JsonOut {
  const out: Record<string, JsonOut> = { id: dataset.id };
  if (dataset.producer !== undefined) {
    out.producer =
      dataset.producer.version === undefined
        ? { name: dataset.producer.name }
        : { name: dataset.producer.name, version: dataset.producer.version };
  }
  if (dataset.createdAt !== undefined) out.createdAt = dataset.createdAt;
  if (dataset.root !== undefined) out.root = dataset.root;
  if (dataset.title !== undefined) out.title = dataset.title;
  return out;
}

function traceJson(trace: TraceSummary): JsonOut {
  return trace.name === null ? { id: trace.id } : { id: trace.id, name: trace.name };
}

function spansJson(model: TraceModel, values: ValuesLookup): JsonOut[] {
  const spans: JsonOut[] = [];
  for (const { ref } of walkDfs(model, model.roots())) {
    const span = model.get(ref);
    if (span !== undefined) spans.push(spanJson(span, values(ref) ?? span.values));
  }
  return spans;
}

function spanJson(span: SpanRow, values: SpanRow["values"]): JsonOut {
  const out: Record<string, JsonOut> = {
    trace: span.ref.trace,
    session: span.ref.session,
    id: span.ref.id,
    parent: span.parent
  };
  if (span.parentSession !== undefined) out.parentSession = span.parentSession;
  out.order = span.order;
  out.name = span.name;
  out.kind = span.kind;
  out.status = span.status;
  if (span.statusReason !== undefined) out.statusReason = span.statusReason;
  if (span.durationMs !== undefined) out.durationMs = span.durationMs;
  if (span.runtime !== undefined) out.runtime = span.runtime;
  if (span.location !== undefined) out.location = locationJson(span.location);
  if (span.area !== undefined) out.area = areaJson(span.area);
  if (span.attrs !== undefined && Object.keys(span.attrs).length > 0) out.attrs = maskAttrs(span.attrs);
  if (values !== undefined) {
    out.args = valueJson(values.args);
    out.return = valueJson(values.return);
    out.error = valueJson(values.error);
  }
  return out;
}

function locationJson(location: Location): JsonOut {
  const out: Record<string, JsonOut> = { file: location.file, line: location.line };
  if (location.column !== undefined) out.column = location.column;
  if (location.endLine !== undefined) out.endLine = location.endLine;
  if (location.snippet !== undefined) {
    out.snippet = location.snippet;
    if (location.snippetCut === true) out.snippetCut = true;
  }
  return out;
}

function areaJson(area: Area): JsonOut {
  const out: Record<string, JsonOut> = {};
  if (area.module !== undefined) out.module = area.module;
  if (area.feature !== undefined) out.feature = area.feature;
  return out;
}

/** The value as it goes back into a file: masked, and only the four file states (4.2). */
export function valueJson(value: Value): JsonOut {
  const masked = maskValue(value);
  switch (masked.state) {
    case "recorded":
      return { state: "recorded", value: masked.value as JsonOut };
    case "truncated":
      return masked.reason === undefined
        ? { state: "truncated", value: masked.value as JsonOut }
        : { state: "truncated", value: masked.value as JsonOut, reason: masked.reason };
    case "masked":
      return masked.reason === undefined ? { state: "masked" } : { state: "masked", reason: masked.reason };
    case "not-recorded":
      return masked.reason === undefined ? { state: "not-recorded" } : { state: "not-recorded", reason: masked.reason };
    case "invalid-value":
      return { state: "not-recorded", reason: "invalid-value" };
    case "unknown-state":
      return { state: "not-recorded", reason: masked.raw };
    case "live":
      return { state: "not-recorded", reason: "live" };
  }
}

function refJson(ref: SpanRef): JsonOut {
  return { trace: ref.trace, session: ref.session, id: ref.id };
}

function linkJson(link: LinkRow): JsonOut {
  return { from: refJson(link.from), to: refJson(link.to), kind: link.kind };
}

/**
 * Every link of the dataset from the models: outgoing links of each span, plus incoming
 * links whose `from` span exists in no model (so a link is never written twice).
 */
function collectLinks(models: readonly TraceModel[]): JsonOut[] {
  const byTrace = new Map(models.map((model) => [model.trace.id, model] as const));
  const known = (ref: SpanRef): boolean => byTrace.get(ref.trace)?.get(ref) !== undefined;
  const links: JsonOut[] = [];
  for (const model of models) {
    for (const { ref } of walkDfs(model, model.roots())) {
      const views = model.links(ref);
      for (const view of views.out) links.push(linkJson({ from: ref, to: view.other, kind: view.kind }));
      for (const view of views.in) {
        if (!known(view.other)) links.push(linkJson({ from: view.other, to: ref, kind: view.kind }));
      }
    }
  }
  return links;
}
