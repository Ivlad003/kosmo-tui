/**
 * `TraceModel` (spec 4.3, 4.4, 4.7, 4.12, 5.3): immutable, built once per trace.
 *
 * Parent resolution of span S (4.3), never guessed from time or order:
 *   1. `parent: null` → a true root.
 *   2. `parentSession` set → exactly (S.trace, parentSession, parent), else unknown(missing); no other try,
 *      even when parentSession equals S.session.
 *   3. otherwise (S.trace, S.session, parent); else the spans with id = parent in other sessions:
 *      exactly one → it, two or more → unknown(ambiguous), none → unknown(missing).
 *   4. a span with an unknown parent is drawn as a root with its mark.
 *   5. spans whose parent chain never reaches a root form cycles; in each cycle the member with the smallest
 *      (session byte-wise, order) becomes a root marked `cycle` and its parent edge is dropped.
 * Children of P: same session as P by order, then other sessions grouped by session byte-wise, by order.
 * Roots: true roots, then unknown(missing|ambiguous), then cycle roots; each class by (session, order).
 * So the tree does not depend on the order of spans in the input.
 *
 * Every traversal is iterative (no recursion), so a 50 000-deep chain cannot overflow the stack.
 * This file must never import `validate.ts`: the validator imports `traceStatusOf`/`requestSummaryOf`.
 */
import { compareBytes } from "./bytes.js";
import {
  spanKey,
  type LinkRow,
  type RequestSummary,
  type SpanRef,
  type SpanRow,
  type TraceDecl,
  type TraceStatus,
  type TraceSummary
} from "./types.js";

export type ParentOf =
  | { readonly kind: "root" }
  | { readonly kind: "resolved"; readonly ref: SpanRef }
  | { readonly kind: "unknown"; readonly reason: "ambiguous" | "missing" }
  | { readonly kind: "cycle" };
export type AreaKey = { readonly module: string | null; readonly feature: string | null; readonly derived: boolean };
export type AreaRow = AreaKey & { readonly spans: number; readonly errors: number };
export type LinkView = { readonly kind: string; readonly other: SpanRef; readonly otherName: string | null };
export interface TraceModel {
  readonly trace: TraceSummary;
  readonly size: number;
  get(ref: SpanRef): SpanRow | undefined;
  roots(): readonly SpanRef[];
  children(ref: SpanRef): readonly SpanRef[];
  parentOf(ref: SpanRef): ParentOf;
  areaOf(ref: SpanRef): AreaKey;
  areas(): readonly AreaRow[];
  spansInArea(key: AreaKey): readonly SpanRef[];
  links(ref: SpanRef): { readonly out: readonly LinkView[]; readonly in: readonly LinkView[] };
  /** Every link with an end in this trace (by trace id), in input order, even when no end has a span. */
  linkRows(): readonly LinkRow[];
  dfs(): readonly SpanRef[];
  depthOf(ref: SpanRef): number;
}

/** Spec 4.4: `errored` if any span is errored; `incomplete` if any is running/unknown; otherwise `complete`. */
export function traceStatusOf(spans: readonly SpanRow[]): TraceStatus {
  let incomplete = false;
  for (const span of spans) {
    if (span.status === "errored") return "errored";
    if (span.status === "running" || span.status === "unknown") incomplete = true;
  }
  return incomplete ? "incomplete" : "complete";
}

/** (session byte-wise, order): the one ordering of spans inside a trace (spec 4.3). */
function compareSessionOrder(a: SpanRow, b: SpanRow): number {
  return compareBytes(a.ref.session, b.ref.session) || a.order - b.order;
}

/**
 * Spec 6.2: `http.server` spans of a trace. `count` counts all of them; `first` reads the attrs of the one
 * with the smallest (session, order). A non-string method/route and a boolean status read as null;
 * `first` is null when that span has none of the three attributes. No `http.server` span → null.
 */
export function requestSummaryOf(spans: readonly SpanRow[]): RequestSummary | null {
  let first: SpanRow | undefined;
  let count = 0;
  for (const span of spans) {
    if (span.kind !== "http.server") continue;
    count += 1;
    if (first === undefined || compareSessionOrder(span, first) < 0) first = span;
  }
  if (first === undefined) return null;
  const attrs = first.attrs ?? {};
  const method = attrs["http.request.method"];
  const route = attrs["http.route"];
  const status = attrs["http.response.status_code"];
  const summary = {
    method: typeof method === "string" ? method : null,
    route: typeof route === "string" ? route : null,
    status: typeof status === "number" || typeof status === "string" ? status : null
  };
  const empty = summary.method === null && summary.route === null && summary.status === null;
  return { first: empty ? null : summary, count };
}

/**
 * Derived module of a file (spec 4.7): inside `node_modules` the package after the LAST `node_modules/`
 * segment (with its `@scope/`), otherwise the directory (leading `./` ignored), `.` for a file in the root.
 */
export function derivedModule(file: string): string {
  const segments = file.split("/");
  const last = segments.lastIndexOf("node_modules");
  if (last !== -1 && last + 1 < segments.length) {
    const name = segments[last + 1] as string;
    const scoped = name.startsWith("@") && last + 2 < segments.length;
    return scoped ? `${name}/${segments[last + 2] as string}` : name;
  }
  let start = 0;
  while (segments[start] === ".") start += 1;
  const directories = segments.slice(start, -1);
  return directories.length === 0 ? "." : directories.join("/");
}

/** The `(unknown)` area: no `area` and no `location` (spec 4.7). */
export const UNKNOWN_AREA: AreaKey = Object.freeze({ module: null, feature: null, derived: false });

/** Spec 4.7: explicit area if it has a field; else `module = derivedModule(file)` marked derived; else (unknown). */
export function areaKeyOf(span: SpanRow): AreaKey {
  const area = span.area;
  if (area !== undefined && (area.module !== undefined || area.feature !== undefined)) {
    return { module: area.module ?? null, feature: area.feature ?? null, derived: false };
  }
  if (span.location !== undefined) return { module: derivedModule(span.location.file), feature: null, derived: true };
  return UNKNOWN_AREA;
}

/** Stable string id of an area key: explicit `src/cart` and derived `~src/cart` differ. */
export function areaKeyId(key: AreaKey): string {
  return JSON.stringify([key.module, key.feature, key.derived]);
}

function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return compareBytes(a, b);
}

/** Areas panel order: (unknown) last; else by module (null first), feature (null first), explicit before derived. */
function compareAreas(a: AreaKey, b: AreaKey): number {
  const unknownA = a.module === null && a.feature === null ? 1 : 0;
  const unknownB = b.module === null && b.feature === null ? 1 : 0;
  if (unknownA !== unknownB) return unknownA - unknownB;
  return (
    compareNullable(a.module, b.module) ||
    compareNullable(a.feature, b.feature) ||
    Number(a.derived) - Number(b.derived)
  );
}

const EMPTY: readonly SpanRef[] = Object.freeze([]);
const NO_LINKS: readonly LinkView[] = Object.freeze([]);
const ROOT: ParentOf = Object.freeze({ kind: "root" });
const CYCLE: ParentOf = Object.freeze({ kind: "cycle" });
const MISSING: ParentOf = Object.freeze({ kind: "unknown", reason: "missing" });
const AMBIGUOUS: ParentOf = Object.freeze({ kind: "unknown", reason: "ambiguous" });

/** Root classes of spec 4.3: true roots, unknown parents, cycle roots. */
function rootClass(parent: ParentOf): number {
  if (parent.kind === "root") return 0;
  if (parent.kind === "unknown") return 1;
  return 2;
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/**
 * Build the model of one trace. Spans of other traces are ignored; a repeated (trace, session, id) keeps
 * its first occurrence (the validator already refuses duplicates). `links` may contain links of other
 * traces: only ends in this trace are indexed, and `otherName` is null for an end outside this trace or
 * without a span (shown as `missing`, spec 4.12).
 */
export function buildTraceModel(trace: TraceDecl, spans: readonly SpanRow[], links: readonly LinkRow[]): TraceModel {
  const rows: SpanRow[] = [];
  const indexOfKey = new Map<string, number>();
  for (const span of spans) {
    if (span.ref.trace !== trace.id) continue;
    const key = spanKey(span.ref);
    if (indexOfKey.has(key)) continue;
    indexOfKey.set(key, rows.length);
    rows.push(span);
  }
  const size = rows.length;
  const byId = new Map<string, number[]>();
  for (let index = 0; index < size; index += 1) pushTo(byId, (rows[index] as SpanRow).ref.id, index);

  // Rules 1–4: one resolved parent index per span, or -1 with the reason in parentInfo.
  const parentIndex = new Int32Array(size).fill(-1);
  const parentInfo: ParentOf[] = new Array<ParentOf>(size);
  for (let index = 0; index < size; index += 1) {
    const span = rows[index] as SpanRow;
    if (span.parent === null) {
      parentInfo[index] = ROOT;
      continue;
    }
    let found = -1;
    let info: ParentOf = MISSING;
    if (span.parentSession !== undefined) {
      found = indexOfKey.get(spanKey({ trace: trace.id, session: span.parentSession, id: span.parent })) ?? -1;
    } else {
      found = indexOfKey.get(spanKey({ trace: trace.id, session: span.ref.session, id: span.parent })) ?? -1;
      if (found === -1) {
        const others = byId.get(span.parent) ?? [];
        if (others.length === 1) found = others[0] as number;
        else if (others.length > 1) info = AMBIGUOUS;
      }
    }
    parentIndex[index] = found;
    parentInfo[index] = info;
  }

  // Rule 5: walk parent chains iteratively; a chain that meets its own path is a cycle.
  const state = new Uint8Array(size); // 0 unvisited, 1 on the current path, 2 done
  const path: number[] = [];
  for (let start = 0; start < size; start += 1) {
    if (state[start] !== 0) continue;
    path.length = 0;
    let at = start;
    while (at !== -1 && state[at] === 0) {
      state[at] = 1;
      path.push(at);
      at = parentIndex[at] as number;
    }
    if (at !== -1 && state[at] === 1) {
      let min = at;
      for (let position = path.indexOf(at); position < path.length; position += 1) {
        const member = path[position] as number;
        if (compareSessionOrder(rows[member] as SpanRow, rows[min] as SpanRow) < 0) min = member;
      }
      parentIndex[min] = -1;
      parentInfo[min] = CYCLE;
    }
    for (const member of path) state[member] = 2;
  }

  // Children in spec 4.3 order; roots by class then (session, order).
  const childIndexes: number[][] = Array.from({ length: size }, () => []);
  const rootIndexes: number[] = [];
  for (let index = 0; index < size; index += 1) {
    const parent = parentIndex[index] as number;
    if (parent === -1) rootIndexes.push(index);
    else (childIndexes[parent] as number[]).push(index);
  }
  for (let parent = 0; parent < size; parent += 1) {
    const list = childIndexes[parent] as number[];
    if (list.length < 2) continue;
    const session = (rows[parent] as SpanRow).ref.session;
    list.sort((a, b) => {
      const spanA = rows[a] as SpanRow;
      const spanB = rows[b] as SpanRow;
      const groupA = spanA.ref.session === session ? 0 : 1;
      const groupB = spanB.ref.session === session ? 0 : 1;
      if (groupA !== groupB) return groupA - groupB;
      return compareSessionOrder(spanA, spanB);
    });
  }
  rootIndexes.sort(
    (a, b) =>
      rootClass(parentInfo[a] as ParentOf) - rootClass(parentInfo[b] as ParentOf) ||
      compareSessionOrder(rows[a] as SpanRow, rows[b] as SpanRow)
  );

  // Iterative pre-order DFS with depths.
  const depth = new Int32Array(size);
  const dfsIndexes: number[] = [];
  const stack: number[] = [];
  for (let position = rootIndexes.length - 1; position >= 0; position -= 1) stack.push(rootIndexes[position] as number);
  while (stack.length > 0) {
    const index = stack.pop() as number;
    dfsIndexes.push(index);
    const list = childIndexes[index] as number[];
    for (let position = list.length - 1; position >= 0; position -= 1) {
      const child = list[position] as number;
      depth[child] = (depth[index] as number) + 1;
      stack.push(child);
    }
  }

  const refOf = (index: number): SpanRef => (rows[index] as SpanRow).ref;
  const dfsRefs: readonly SpanRef[] = Object.freeze(dfsIndexes.map(refOf));
  const rootRefs: readonly SpanRef[] = Object.freeze(rootIndexes.map(refOf));
  const childRefs = new Map<number, readonly SpanRef[]>();

  // Areas: counts per key and members in DFS order.
  const areaRows = new Map<string, { key: AreaKey; spans: number; errors: number; members: SpanRef[] }>();
  const areaKeys: AreaKey[] = new Array<AreaKey>(size);
  for (const index of dfsIndexes) {
    const span = rows[index] as SpanRow;
    const key = areaKeyOf(span);
    areaKeys[index] = key;
    const id = areaKeyId(key);
    let entry = areaRows.get(id);
    if (entry === undefined) {
      entry = { key, spans: 0, errors: 0, members: [] };
      areaRows.set(id, entry);
    }
    entry.spans += 1;
    if (span.status === "errored") entry.errors += 1;
    entry.members.push(span.ref);
  }
  const areaList: readonly AreaRow[] = Object.freeze(
    [...areaRows.values()]
      .map((entry): AreaRow => ({ ...entry.key, spans: entry.spans, errors: entry.errors }))
      .sort(compareAreas)
  );

  // Links: views keyed by the span they belong to, sorted by the other end, then kind.
  const outgoing = new Map<string, LinkView[]>();
  const incoming = new Map<string, LinkView[]>();
  const linkRows: LinkRow[] = [];
  const nameOf = (ref: SpanRef): string | null => {
    const index = ref.trace === trace.id ? indexOfKey.get(spanKey(ref)) : undefined;
    return index === undefined ? null : (rows[index] as SpanRow).name;
  };
  for (const link of links) {
    if (link.from.trace === trace.id || link.to.trace === trace.id) linkRows.push(link);
    if (link.from.trace === trace.id) {
      pushTo(outgoing, spanKey(link.from), { kind: link.kind, other: link.to, otherName: nameOf(link.to) });
    }
    if (link.to.trace === trace.id) {
      pushTo(incoming, spanKey(link.to), { kind: link.kind, other: link.from, otherName: nameOf(link.from) });
    }
  }
  const frozenLinks: readonly LinkRow[] = Object.freeze(linkRows);
  const compareViews = (a: LinkView, b: LinkView): number =>
    compareBytes(spanKey(a.other), spanKey(b.other)) || compareBytes(a.kind, b.kind);
  for (const list of outgoing.values()) list.sort(compareViews);
  for (const list of incoming.values()) list.sort(compareViews);

  const summary: TraceSummary = {
    id: trace.id,
    name: trace.name,
    spans: size,
    status: traceStatusOf(rows),
    requests: requestSummaryOf(rows)
  };
  const find = (ref: SpanRef): number | undefined =>
    ref.trace === trace.id ? indexOfKey.get(spanKey(ref)) : undefined;

  return {
    trace: summary,
    size,
    get: (ref) => {
      const index = find(ref);
      return index === undefined ? undefined : rows[index];
    },
    roots: () => rootRefs,
    children: (ref) => {
      const index = find(ref);
      if (index === undefined || (childIndexes[index] as number[]).length === 0) return EMPTY;
      let cached = childRefs.get(index);
      if (cached === undefined) {
        cached = Object.freeze((childIndexes[index] as number[]).map(refOf));
        childRefs.set(index, cached);
      }
      return cached;
    },
    parentOf: (ref) => {
      const index = find(ref);
      if (index === undefined) return MISSING;
      const parent = parentIndex[index] as number;
      return parent === -1 ? (parentInfo[index] as ParentOf) : { kind: "resolved", ref: refOf(parent) };
    },
    areaOf: (ref) => {
      const index = find(ref);
      return index === undefined ? UNKNOWN_AREA : (areaKeys[index] as AreaKey);
    },
    areas: () => areaList,
    spansInArea: (key) => areaRows.get(areaKeyId(key))?.members ?? EMPTY,
    links: (ref) => {
      const key = spanKey(ref);
      return { out: outgoing.get(key) ?? NO_LINKS, in: incoming.get(key) ?? NO_LINKS };
    },
    linkRows: () => frozenLinks,
    dfs: () => dfsRefs,
    depthOf: (ref) => {
      const index = find(ref);
      return index === undefined ? 0 : (depth[index] as number);
    }
  };
}
