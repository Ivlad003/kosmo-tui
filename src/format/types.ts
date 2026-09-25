/**
 * Model types of `kosmo-trace/v1` (spec 4.1–4.4, 4.12, 5.3). No runtime dependencies.
 *
 * A span is identified by the triple (trace, session, id); a trace by its id only (spec 4.3).
 * `spanKey` is the one string form of that triple used as a Map/Set key everywhere.
 */

export type SpanRef = { readonly trace: string; readonly session: string; readonly id: string };
export type TraceRef = { readonly trace: string };

/** Map/Set key of a span: `JSON.stringify([trace, session, id])`, unambiguous for any strings. */
export function spanKey(ref: SpanRef): string {
  return JSON.stringify([ref.trace, ref.session, ref.id]);
}

export function sameRef(a: SpanRef, b: SpanRef): boolean {
  return a.trace === b.trace && a.session === b.session && a.id === b.id;
}

export type SpanStatus = "complete" | "errored" | "running" | "suspended" | "unknown";
export type TraceStatus = "complete" | "errored" | "incomplete";
export type Runtime = "node" | "browser" | "edge" | "other";

export type Location = {
  readonly file: string;
  readonly line: number;
  readonly column?: number;
  readonly endLine?: number;
  readonly snippet?: string;
  readonly snippetCut?: boolean;
};
export type Area = { readonly module?: string; readonly feature?: string };
export type AttrValue = string | number | boolean;
export type Attrs = Readonly<Record<string, AttrValue>>;

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type Value =
  | { readonly state: "recorded"; readonly value: Json }
  | { readonly state: "truncated"; readonly value: Json; readonly reason?: string }
  | { readonly state: "masked"; readonly reason?: string }
  | { readonly state: "not-recorded"; readonly reason?: string }
  | { readonly state: "live"; readonly value: Json }
  | { readonly state: "invalid-value"; readonly position: string; readonly what: string }
  | { readonly state: "unknown-state"; readonly raw: string };
export type SpanValues = { readonly args: Value; readonly return: Value; readonly error: Value };

/** A missing `args`/`return`/`error` field (spec 4.2). */
export const NOT_RECORDED: Value = Object.freeze({ state: "not-recorded" });

export type SpanMark = "invalid-location" | "invalid-snippet" | "invalid-attrs" | "invalid-duration" | "unknown-status";
export type SpanRow = {
  readonly ref: SpanRef;
  readonly parent: string | null;
  readonly parentSession?: string;
  readonly order: number;
  readonly name: string;
  readonly kind: string;
  readonly status: SpanStatus;
  readonly statusReason?: string;
  readonly durationMs?: number;
  readonly runtime?: Runtime;
  readonly location?: Location;
  readonly area?: Area;
  readonly attrs?: Attrs;
  readonly droppedAttrs: number;
  readonly marks: readonly SpanMark[];
  readonly values?: SpanValues;
};
export type LinkRow = { readonly from: SpanRef; readonly to: SpanRef; readonly kind: string };
export type DatasetInfo = {
  readonly id: string;
  readonly producer?: { readonly name: string; readonly version?: string };
  readonly createdAt?: string;
  readonly root?: string;
  readonly title?: string;
};
export type TraceDecl = { readonly id: string; readonly name: string | null };
export type RequestSummary = {
  readonly first: {
    readonly method: string | null;
    readonly route: string | null;
    readonly status: number | string | null;
  } | null;
  readonly count: number;
};
export type TraceSummary = {
  readonly id: string;
  readonly name: string | null;
  readonly spans: number | null;
  readonly status: TraceStatus | null;
  readonly requests: RequestSummary | null;
};
/** "$.spans[3].location.line" | "line 12" | "kosmo_spans(t,s,id)" */
export type Position = string;
export type Fatal = {
  readonly ok: false;
  readonly code:
    | "not-a-kosmo-trace"
    | "not-a-kosmo-trace-store"
    | "unsupported-version"
    | "invalid"
    | "too-large"
    | "trace-too-large";
  readonly position: Position;
  readonly what: string;
};
