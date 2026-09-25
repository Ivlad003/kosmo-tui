/**
 * In-code dataset builder for kosmo-trace/v1 fixtures (spec 13.1).
 *
 * It produces plain JSON objects in the document shape of spec 4.1 and validates nothing,
 * so a test can also build a broken document on purpose. Defaults: the session is the
 * current one ("s1" after every `trace()`/`inTrace()`), `parent` is null, `status` is
 * "complete", `order` is the next free integer in (trace, session) counting from 0.
 * Keys are always emitted in one fixed order, so `JSON.stringify` of a built document is
 * deterministic and comparable with a committed fixture.
 */

export type RawJson = null | boolean | number | string | RawJson[] | { [key: string]: RawJson };
export type RawRef = { trace: string; session: string; id: string };
export type RawLocation = {
  file: string;
  line: number;
  column?: number;
  endLine?: number;
  snippet?: string;
  snippetCut?: boolean;
};
export type RawArea = { module?: string; feature?: string };
export type RawDataset = {
  id: string;
  producer?: { name: string; version?: string };
  createdAt?: string;
  root?: string;
  title?: string;
};
export type RawTrace = { id: string; name?: string };
export type RawSpan = {
  trace: string;
  session: string;
  id: string;
  parent: string | null;
  parentSession?: string;
  order: number;
  name: string;
  kind?: string;
  status: string;
  statusReason?: string;
  durationMs?: number;
  runtime?: string;
  location?: RawLocation;
  area?: RawArea;
  attrs?: RawJson;
  args?: RawJson;
  return?: RawJson;
  error?: RawJson;
};
export type RawLink = { from: RawRef; to: RawRef; kind: string };
export type RawDocument = {
  format: string;
  version: number;
  dataset: RawDataset;
  traces?: RawTrace[];
  spans: RawSpan[];
  links?: RawLink[];
  [extra: string]: unknown;
};

export type SpanInput = {
  session?: string;
  parent?: string | null;
  parentSession?: string;
  order?: number;
  kind?: string;
  status?: string;
  statusReason?: string;
  durationMs?: number;
  runtime?: string;
  location?: RawLocation;
  area?: RawArea;
  attrs?: RawJson;
  args?: RawJson;
  return?: RawJson;
  error?: RawJson;
};

/** A link end: a bare id means "this id in the current trace and session". */
export type RefInput = string | { trace?: string; session?: string; id: string };

export function recorded(value: RawJson): RawJson {
  return { state: "recorded", value };
}
export function truncated(value: RawJson, reason?: string): RawJson {
  return reason === undefined ? { state: "truncated", value } : { state: "truncated", value, reason };
}
export function masked(reason?: string): RawJson {
  return reason === undefined ? { state: "masked" } : { state: "masked", reason };
}
export function notRecorded(reason?: string): RawJson {
  return reason === undefined ? { state: "not-recorded" } : { state: "not-recorded", reason };
}

export class TraceBuilder {
  private readonly traces: RawTrace[] = [];
  private readonly spans: RawSpan[] = [];
  private readonly links: RawLink[] = [];
  private readonly extras: Array<[string, RawJson]> = [];
  private readonly nextOrder = new Map<string, number>();
  private currentTrace: string | null = null;
  private currentSession = "s1";

  constructor(private readonly info: RawDataset) {}

  /** Declare a trace in `traces[]` and make it current. */
  trace(id: string, name?: string): this {
    this.traces.push(name === undefined ? { id } : { id, name });
    this.currentTrace = id;
    this.currentSession = "s1";
    return this;
  }

  /** Make a trace current WITHOUT declaring it: it exists only through `span.trace` (spec 4.1). */
  inTrace(id: string): this {
    this.currentTrace = id;
    this.currentSession = "s1";
    return this;
  }

  session(id: string): this {
    this.currentSession = id;
    return this;
  }

  span(id: string, name: string, input: SpanInput = {}): this {
    const trace = this.requireTrace();
    const session = input.session ?? this.currentSession;
    const counterKey = JSON.stringify([trace, session]);
    const next = this.nextOrder.get(counterKey) ?? 0;
    const order = input.order ?? next;
    this.nextOrder.set(counterKey, Math.max(next, order + 1));
    const span: RawSpan = {
      trace,
      session,
      id,
      parent: input.parent ?? null,
      ...(input.parentSession !== undefined ? { parentSession: input.parentSession } : {}),
      order,
      name,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      status: input.status ?? "complete",
      ...(input.statusReason !== undefined ? { statusReason: input.statusReason } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
      ...(input.location !== undefined ? { location: { ...input.location } } : {}),
      ...(input.area !== undefined ? { area: { ...input.area } } : {}),
      ...(input.attrs !== undefined ? { attrs: input.attrs } : {}),
      ...(input.args !== undefined ? { args: input.args } : {}),
      ...(input.return !== undefined ? { return: input.return } : {}),
      ...(input.error !== undefined ? { error: input.error } : {})
    };
    this.spans.push(span);
    return this;
  }

  link(from: RefInput, to: RefInput, kind: string): this {
    this.links.push({ from: this.ref(from), to: this.ref(to), kind });
    return this;
  }

  /** An unknown top-level document field (spec 4.11: ignored and counted). */
  field(key: string, value: RawJson): this {
    this.extras.push([key, value]);
    return this;
  }

  build(): RawDocument {
    const doc: RawDocument = {
      format: "kosmo-trace",
      version: 1,
      dataset: structuredClone(this.info),
      ...(this.traces.length > 0 ? { traces: structuredClone(this.traces) } : {}),
      spans: structuredClone(this.spans),
      ...(this.links.length > 0 ? { links: structuredClone(this.links) } : {})
    };
    for (const [key, value] of this.extras) doc[key] = structuredClone(value);
    return doc;
  }

  private requireTrace(): string {
    if (this.currentTrace === null) throw new Error("TraceBuilder: call trace() or inTrace() before span()");
    return this.currentTrace;
  }

  private ref(input: RefInput): RawRef {
    const trace = this.requireTrace();
    if (typeof input === "string") return { trace, session: this.currentSession, id: input };
    return { trace: input.trace ?? trace, session: input.session ?? this.currentSession, id: input.id };
  }
}

export function dataset(id: string, fields: Omit<RawDataset, "id"> = {}): TraceBuilder {
  return new TraceBuilder({ id, ...fields });
}
