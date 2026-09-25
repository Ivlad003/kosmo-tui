/**
 * Hand-written validator of `kosmo-trace/v1` (spec 4.1, 4.3, 4.4, 4.8, 4.9, 4.11, 4.12). No dependencies.
 *
 * Outcomes follow the 4.9 table exactly. Fatal: wrong/missing required field or JSON type, id-like string
 * > 256 B, text > 1024 B (dataset `title`, `createdAt` and `producer.*` included), dataset `root` > 4096 B,
 * `order` not an integer 0…2^53−1, `parentSession` with `parent: null`, duplicates.
 * Degrading (the span stays, a mark is added): every `location` problem → `invalid-location` (location
 * dropped); a bad `snippet`/`snippetCut` → `invalid-snippet` (location kept); `durationMs` < 0 or not finite
 * → dropped, `invalid-duration`; `attrs` not an object or bad entries → `invalid-attrs`; a bad Value →
 * `invalid-value` in that field. Unknown `status` → `unknown` with `statusReason` = the raw value and
 * `unknown-status`; unknown `runtime` → `other`; unknown fields are ignored (4.11).
 *
 * "Absent" means the key is missing or `undefined`. `null` is a wrong type everywhere except `parent`,
 * so a reader built on SQL rows must turn NULL columns into missing keys before calling `validateSpan`.
 *
 * Positions: every function appends JSON-path segments to the `position` it gets (`atPath`):
 * `$.spans[3]` → `$.spans[3].location.line`, `line 12` → `line 12.trace`.
 */
import { compareBytes, utf8Bytes } from "./bytes.js";
import { validateAttrs } from "./kinds.js";
import { requestSummaryOf, traceStatusOf } from "./model.js";
import {
  spanKey,
  type Area,
  type DatasetInfo,
  type Fatal,
  type LinkRow,
  type Location,
  type Position,
  type Runtime,
  type SpanMark,
  type SpanRef,
  type SpanRow,
  type SpanStatus,
  type TraceDecl,
  type TraceSummary
} from "./types.js";
import { capValue, compactJson, parseValue } from "./value.js";

export { compareBytes, utf8Bytes };

export const LIMITS = {
  fileBytes: 67_108_864,
  ndjsonLineBytes: 1_048_576,
  streamBytes: 67_108_864,
  streamSpans: 200_000,
  traceSpans: 200_000,
  idBytes: 256,
  textBytes: 1024,
  fileBytesPath: 4096,
  snippetBytes: 512
} as const;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Record_ = Record<string, unknown>;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const STATUSES: ReadonlySet<string> = new Set(["complete", "errored", "running", "suspended", "unknown"]);
const RUNTIMES: ReadonlySet<string> = new Set(["node", "browser", "edge", "other"]);
const DOCUMENT_FIELDS: ReadonlySet<string> = new Set(["format", "version", "dataset", "traces", "spans", "links"]);

/**
 * Append JSON-path segments: numbers as `[i]`, identifiers as `.key`, anything else as `["key"]` quoted by
 * `compactJson`, so a key from the data never puts a control or bidi character into a position.
 */
export function atPath(base: Position, ...segments: readonly (string | number)[]): Position {
  let out = base;
  for (const segment of segments) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += IDENTIFIER.test(segment) ? `.${segment}` : `[${compactJson(segment)}]`;
  }
  return out;
}

function fatal(code: Fatal["code"], position: Position, what: string): Fatal {
  return { ok: false, code, position, what };
}

function invalid(position: Position, what: string): Fatal {
  return fatal("invalid", position, what);
}

function isFatal(value: unknown): value is Fatal {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

function isRecord(value: unknown): value is Record_ {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function present(record: Record_, key: string): boolean {
  return Object.hasOwn(record, key) && record[key] !== undefined;
}

function checkedString(value: unknown, position: Position, maxBytes: number | undefined): string | Fatal {
  if (typeof value !== "string") return invalid(position, "must be a string");
  if (maxBytes !== undefined && utf8Bytes(value) > maxBytes) return invalid(position, `exceeds ${maxBytes} bytes`);
  return value;
}

function requiredString(record: Record_, key: string, base: Position, maxBytes?: number): string | Fatal {
  if (!present(record, key)) return invalid(atPath(base, key), "is required");
  return checkedString(record[key], atPath(base, key), maxBytes);
}

function optionalString(record: Record_, key: string, base: Position, maxBytes?: number): string | undefined | Fatal {
  if (!present(record, key)) return undefined;
  return checkedString(record[key], atPath(base, key), maxBytes);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** Spec 4.8: relative POSIX path, no `..`, no absolute path, no scheme, no control or bidi character. */
function isValidTraceFile(file: string): boolean {
  if (file === "" || utf8Bytes(file) > LIMITS.fileBytesPath) return false;
  if (file.startsWith("/") || file.includes("\\") || SCHEME.test(file) || CONTROL_OR_BIDI.test(file)) return false;
  return !file.split("/").includes("..");
}

type LocationResult = {
  readonly location?: Location;
  readonly invalidLocation: boolean;
  readonly invalidSnippet: boolean;
};

function parseLocation(raw: unknown): LocationResult {
  const bad: LocationResult = { invalidLocation: true, invalidSnippet: false };
  if (!isRecord(raw)) return bad;
  const { file, line } = raw;
  if (typeof file !== "string" || !isValidTraceFile(file) || !isPositiveInteger(line)) return bad;
  const location: Mutable<Location> = { file, line };
  if (present(raw, "column")) {
    if (!isPositiveInteger(raw.column)) return bad;
    location.column = raw.column;
  }
  if (present(raw, "endLine")) {
    if (!isPositiveInteger(raw.endLine) || raw.endLine < line) return bad;
    location.endLine = raw.endLine;
  }
  // A non-boolean snippetCut is invalid-snippet even without a snippet: the schema rejects it (4.10 parity).
  let invalidSnippet = present(raw, "snippetCut") && typeof raw.snippetCut !== "boolean";
  if (present(raw, "snippet")) {
    const { snippet } = raw;
    const snippetOk =
      typeof snippet === "string" && utf8Bytes(snippet) <= LIMITS.snippetBytes && !snippet.includes("\n");
    if (snippetOk && !invalidSnippet) {
      location.snippet = snippet;
      if (raw.snippetCut === true) location.snippetCut = true;
    } else {
      invalidSnippet = true;
    }
  }
  return { location, invalidLocation: false, invalidSnippet };
}

function parseArea(raw: unknown, position: Position): Area | undefined | Fatal {
  if (!isRecord(raw)) return invalid(position, "must be an object");
  const module = optionalString(raw, "module", position, LIMITS.textBytes);
  if (isFatal(module)) return module;
  const feature = optionalString(raw, "feature", position, LIMITS.textBytes);
  if (isFatal(feature)) return feature;
  if (module === undefined && feature === undefined) return undefined;
  const area: Mutable<Area> = {};
  if (module !== undefined) area.module = module;
  if (feature !== undefined) area.feature = feature;
  return area;
}

function parseSpanRef(raw: unknown, position: Position): SpanRef | Fatal {
  if (!isRecord(raw)) return invalid(position, "must be an object");
  const trace = requiredString(raw, "trace", position, LIMITS.idBytes);
  if (isFatal(trace)) return trace;
  const session = requiredString(raw, "session", position, LIMITS.idBytes);
  if (isFatal(session)) return session;
  const id = requiredString(raw, "id", position, LIMITS.idBytes);
  if (isFatal(id)) return id;
  return { trace, session, id };
}

/** Header fields (`format`, `version`, `dataset`) of a JSON document, an NDJSON header line or SQLite meta. */
export function validateHeader(raw: unknown, position: Position): { ok: true; dataset: DatasetInfo } | Fatal {
  if (!isRecord(raw)) return fatal("not-a-kosmo-trace", position, "must be an object");
  if (raw.format !== "kosmo-trace") {
    return fatal("not-a-kosmo-trace", atPath(position, "format"), 'must be "kosmo-trace"');
  }
  if (!present(raw, "version")) return invalid(atPath(position, "version"), "is required");
  if (typeof raw.version !== "number") return invalid(atPath(position, "version"), "must be a number");
  if (raw.version !== 1) {
    return fatal("unsupported-version", atPath(position, "version"), `version ${raw.version} is not supported`);
  }
  const base = atPath(position, "dataset");
  if (!present(raw, "dataset")) return invalid(base, "is required");
  const dataset = raw.dataset;
  if (!isRecord(dataset)) return invalid(base, "must be an object");
  const id = requiredString(dataset, "id", base, LIMITS.idBytes);
  if (isFatal(id)) return id;
  const info: Mutable<DatasetInfo> = { id };
  if (present(dataset, "producer")) {
    const producerAt = atPath(base, "producer");
    const producer = dataset.producer;
    if (!isRecord(producer)) return invalid(producerAt, "must be an object");
    const name = requiredString(producer, "name", producerAt, LIMITS.textBytes);
    if (isFatal(name)) return name;
    const version = optionalString(producer, "version", producerAt, LIMITS.textBytes);
    if (isFatal(version)) return version;
    info.producer = version === undefined ? { name } : { name, version };
  }
  // `root` is an absolute path on the producing host, so it gets the path limit; the others are text.
  for (const [key, maxBytes] of [
    ["createdAt", LIMITS.textBytes],
    ["root", LIMITS.fileBytesPath],
    ["title", LIMITS.textBytes]
  ] as const) {
    const value = optionalString(dataset, key, base, maxBytes);
    if (isFatal(value)) return value;
    if (value !== undefined) info[key] = value;
  }
  return { ok: true, dataset: info };
}

/** One entry of `traces` (or an NDJSON `trace` line). A missing name is null. */
export function validateTraceDecl(raw: unknown, position: Position): { ok: true; trace: TraceDecl } | Fatal {
  if (!isRecord(raw)) return invalid(position, "must be an object");
  const id = requiredString(raw, "id", position, LIMITS.idBytes);
  if (isFatal(id)) return id;
  const name = optionalString(raw, "name", position, LIMITS.textBytes);
  if (isFatal(name)) return name;
  return { ok: true, trace: { id, name: name ?? null } };
}

/**
 * One span (spec 4.1 table, 4.3, 4.4, 4.8, 4.9). `opts.values: false` (SQLite, lazy values) skips
 * `args`/`return`/`error` and leaves `values` undefined; otherwise each is `capValue(parseValue(…))`.
 */
export function validateSpan(
  raw: unknown,
  position: Position,
  opts: { values?: boolean } = {}
): { ok: true; span: SpanRow } | Fatal {
  if (!isRecord(raw)) return invalid(position, "must be an object");
  const trace = requiredString(raw, "trace", position, LIMITS.idBytes);
  if (isFatal(trace)) return trace;
  const session = requiredString(raw, "session", position, LIMITS.idBytes);
  if (isFatal(session)) return session;
  const id = requiredString(raw, "id", position, LIMITS.idBytes);
  if (isFatal(id)) return id;

  if (!Object.hasOwn(raw, "parent") || raw.parent === undefined)
    return invalid(atPath(position, "parent"), "is required");
  const parent = raw.parent;
  if (parent !== null && typeof parent !== "string")
    return invalid(atPath(position, "parent"), "must be a string or null");
  if (parent !== null && utf8Bytes(parent) > LIMITS.idBytes) {
    return invalid(atPath(position, "parent"), `exceeds ${LIMITS.idBytes} bytes`);
  }
  const parentSession = optionalString(raw, "parentSession", position, LIMITS.idBytes);
  if (isFatal(parentSession)) return parentSession;
  if (parentSession !== undefined && parent === null) {
    return invalid(atPath(position, "parentSession"), "is not allowed with parent: null");
  }

  if (!present(raw, "order")) return invalid(atPath(position, "order"), "is required");
  const order = raw.order;
  if (typeof order !== "number" || !Number.isSafeInteger(order) || order < 0) {
    return invalid(atPath(position, "order"), "must be an integer from 0 to 2^53-1");
  }

  const name = requiredString(raw, "name", position, LIMITS.textBytes);
  if (isFatal(name)) return name;
  const kind = optionalString(raw, "kind", position, LIMITS.textBytes);
  if (isFatal(kind)) return kind;
  const rawStatus = requiredString(raw, "status", position, LIMITS.textBytes);
  if (isFatal(rawStatus)) return rawStatus;
  let statusReason = optionalString(raw, "statusReason", position, LIMITS.textBytes);
  if (isFatal(statusReason)) return statusReason;
  const knownStatus = STATUSES.has(rawStatus);
  const status = (knownStatus ? rawStatus : "unknown") as SpanStatus;
  if (!knownStatus) statusReason = rawStatus;

  let durationMs: number | undefined;
  let invalidDuration = false;
  if (present(raw, "durationMs")) {
    if (typeof raw.durationMs !== "number") return invalid(atPath(position, "durationMs"), "must be a number");
    if (Number.isFinite(raw.durationMs) && raw.durationMs >= 0) durationMs = raw.durationMs;
    else invalidDuration = true;
  }

  const rawRuntime = optionalString(raw, "runtime", position);
  if (isFatal(rawRuntime)) return rawRuntime;
  const runtime = rawRuntime === undefined ? undefined : ((RUNTIMES.has(rawRuntime) ? rawRuntime : "other") as Runtime);

  const location: LocationResult = present(raw, "location")
    ? parseLocation(raw.location)
    : { invalidLocation: false, invalidSnippet: false };

  let area: Area | undefined;
  if (present(raw, "area")) {
    const parsed = parseArea(raw.area, atPath(position, "area"));
    if (isFatal(parsed)) return parsed;
    area = parsed;
  }

  const attrs = validateAttrs(raw.attrs);

  const marks: SpanMark[] = [];
  if (location.invalidLocation) marks.push("invalid-location");
  if (location.invalidSnippet) marks.push("invalid-snippet");
  if (attrs.invalidWhole || attrs.dropped > 0) marks.push("invalid-attrs");
  if (invalidDuration) marks.push("invalid-duration");
  if (!knownStatus) marks.push("unknown-status");

  const span: Mutable<SpanRow> = {
    ref: { trace, session, id },
    parent,
    order,
    name,
    kind: kind ?? "function",
    status,
    droppedAttrs: attrs.dropped,
    marks
  };
  if (parentSession !== undefined) span.parentSession = parentSession;
  if (statusReason !== undefined) span.statusReason = statusReason;
  if (durationMs !== undefined) span.durationMs = durationMs;
  if (runtime !== undefined) span.runtime = runtime;
  if (location.location !== undefined) span.location = location.location;
  if (area !== undefined) span.area = area;
  if (attrs.attrs !== undefined) span.attrs = attrs.attrs;
  if (opts.values !== false) {
    span.values = {
      args: capValue(parseValue(raw.args, atPath(position, "args"))),
      return: capValue(parseValue(raw.return, atPath(position, "return"))),
      error: capValue(parseValue(raw.error, atPath(position, "error")))
    };
  }
  return { ok: true, span };
}

/** One link (spec 4.12): only the SpanRef shapes and the kind are checked, never that the spans exist. */
export function validateLink(raw: unknown, position: Position): { ok: true; link: LinkRow } | Fatal {
  if (!isRecord(raw)) return invalid(position, "must be an object");
  if (!present(raw, "from")) return invalid(atPath(position, "from"), "is required");
  const from = parseSpanRef(raw.from, atPath(position, "from"));
  if (isFatal(from)) return from;
  if (!present(raw, "to")) return invalid(atPath(position, "to"), "is required");
  const to = parseSpanRef(raw.to, atPath(position, "to"));
  if (isFatal(to)) return to;
  const kind = requiredString(raw, "kind", position, LIMITS.textBytes);
  if (isFatal(kind)) return kind;
  return { ok: true, link: { from, to, kind } };
}

type TraceBucket = { decl: TraceDecl | null; readonly spans: SpanRow[] };

/**
 * Collects validated traces, spans and links for one dataset (JSON, NDJSON and SQLite share it).
 * A trace exists once it is declared or once a span names it; a link alone never creates a trace.
 */
export class DatasetAccumulator {
  readonly #traces = new Map<string, TraceBucket>();
  readonly #links = new Map<string, LinkRow[]>();
  readonly #spanKeys = new Set<string>();
  readonly #orderKeys = new Set<string>();
  #spanCount = 0;

  get spanCount(): number {
    return this.#spanCount;
  }

  #bucket(traceId: string): TraceBucket {
    let bucket = this.#traces.get(traceId);
    if (bucket === undefined) {
      bucket = { decl: null, spans: [] };
      this.#traces.set(traceId, bucket);
    }
    return bucket;
  }

  /** A second declaration of the same trace id is fatal (spec 4.5, 4.9). */
  addTrace(trace: TraceDecl, position: Position): Fatal | null {
    const bucket = this.#bucket(trace.id);
    if (bucket.decl !== null) return invalid(position, "duplicate trace id");
    bucket.decl = trace;
    return null;
  }

  /** A duplicate (trace, session, id) or (trace, session, order) is fatal (spec 4.9). */
  addSpan(span: SpanRow, position: Position): Fatal | null {
    const key = spanKey(span.ref);
    if (this.#spanKeys.has(key)) return invalid(position, "duplicate span (trace, session, id)");
    const orderKey = JSON.stringify([span.ref.trace, span.ref.session, span.order]);
    if (this.#orderKeys.has(orderKey)) return invalid(position, "duplicate order in (trace, session)");
    this.#spanKeys.add(key);
    this.#orderKeys.add(orderKey);
    this.#bucket(span.ref.trace).spans.push(span);
    this.#spanCount += 1;
    return null;
  }

  /** Kept under each trace that owns one of its ends (spec 4.12: `--trace` keeps links touching the trace). */
  addLink(link: LinkRow): void {
    for (const traceId of new Set([link.from.trace, link.to.trace])) {
      const list = this.#links.get(traceId);
      if (list === undefined) this.#links.set(traceId, [link]);
      else list.push(link);
    }
  }

  /** Every trace by id, byte-wise ascending (spec 4.3), with span count, status (4.4) and requests (6.2). */
  traceSummaries(): TraceSummary[] {
    return [...this.#traces.entries()]
      .sort(([a], [b]) => compareBytes(a, b))
      .map(([id, bucket]) => ({
        id,
        name: bucket.decl?.name ?? null,
        spans: bucket.spans.length,
        status: traceStatusOf(bucket.spans),
        requests: requestSummaryOf(bucket.spans)
      }));
  }

  /** Spans of a trace in the order they were added; empty for an unknown trace. */
  spansOf(traceId: string): readonly SpanRow[] {
    return this.#traces.get(traceId)?.spans ?? [];
  }

  /** Links with at least one end in the trace, in the order they were added. */
  linksOf(traceId: string): readonly LinkRow[] {
    return this.#links.get(traceId) ?? [];
  }
}

/** A whole JSON document (spec 4.1). `unknownFields` counts unknown top-level keys for the banner (4.5). */
export function validateDocument(
  raw: unknown
): { ok: true; dataset: DatasetInfo; acc: DatasetAccumulator; unknownFields: number } | Fatal {
  if (!isRecord(raw)) return fatal("not-a-kosmo-trace", "$", "must be a JSON object");
  const header = validateHeader(raw, "$");
  if (!header.ok) return header;
  const acc = new DatasetAccumulator();

  if (present(raw, "traces")) {
    if (!Array.isArray(raw.traces)) return invalid("$.traces", "must be an array");
    const traces: readonly unknown[] = raw.traces;
    for (let index = 0; index < traces.length; index += 1) {
      const position = atPath("$.traces", index);
      const result = validateTraceDecl(traces[index], position);
      if (!result.ok) return result;
      const duplicate = acc.addTrace(result.trace, position);
      if (duplicate !== null) return duplicate;
    }
  }

  if (!present(raw, "spans")) return invalid("$.spans", "is required");
  if (!Array.isArray(raw.spans)) return invalid("$.spans", "must be an array");
  const spans: readonly unknown[] = raw.spans;
  for (let index = 0; index < spans.length; index += 1) {
    const position = atPath("$.spans", index);
    const result = validateSpan(spans[index], position);
    if (!result.ok) return result;
    const duplicate = acc.addSpan(result.span, position);
    if (duplicate !== null) return duplicate;
  }

  if (present(raw, "links")) {
    if (!Array.isArray(raw.links)) return invalid("$.links", "must be an array");
    const links: readonly unknown[] = raw.links;
    for (let index = 0; index < links.length; index += 1) {
      const result = validateLink(links[index], atPath("$.links", index));
      if (!result.ok) return result;
      acc.addLink(result.link);
    }
  }

  const unknownFields = Object.keys(raw).filter((key) => !DOCUMENT_FIELDS.has(key)).length;
  return { ok: true, dataset: header.dataset, acc, unknownFields };
}
