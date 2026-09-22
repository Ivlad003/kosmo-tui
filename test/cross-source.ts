/**
 * Cross-source facts (task 4.5, KT half). The same reduction kosmo-callflow's
 * tests/support/cross-source.ts applies, over pages read through kosmo-tui's own sources:
 * a canonical v2 page becomes the sanitized facts every source must agree on (identity
 * within the namespace, kinds, parents, errors, framework metadata, value redaction). The
 * source metadata — namespace, provenance, retention, capabilities — is kept NEXT TO the
 * facts, never folded into them, and a comparison only runs after an explicit identity
 * mapping.
 */
import type { CanonicalPageEnvelopeV2 } from "@kosmo-callflow/protocol";

type SpanItem = Extract<CanonicalPageEnvelopeV2["items"][number], { kind: "span" }>;
type Evidence = SpanItem["args"];

export type SourceName = "live" | "sqlite" | "export" | "stream-v2" | "stream-v1";

export type SourceMeta = {
  source: SourceName;
  datasetId: string;
  projectId: string;
  provenance: "live" | "imported";
  watermarkSeq: number;
  retentionEpoch: number;
  capabilities: "canonical" | "summary-only";
};

export type SpanFact = {
  sessionId: string;
  traceId: string;
  spanId: string;
  parent:
    { state: "root" } | { state: "known"; relation: string; spanId: string } | { state: "unknown"; reason: string };
  spanKind: string | null;
  nodeId: string;
  lifecycle: string;
  error: unknown;
  framework: unknown;
  args: unknown;
  ret: unknown;
};

function evidence(value: Evidence): unknown {
  switch (value.state) {
    case "recorded":
    case "truncated":
      return { state: value.state, value: value.value, ...(value.partiallyMasked ? { partiallyMasked: true } : {}) };
    case "masked":
      return { state: "masked" };
    default:
      return { state: value.state, reason: value.reason };
  }
}

export function spanFacts(page: CanonicalPageEnvelopeV2): SpanFact[] {
  return page.items
    .filter((item): item is SpanItem => item.kind === "span")
    .map((item) => ({
      sessionId: item.span.sessionId,
      traceId: item.span.traceId,
      spanId: item.span.spanId,
      parent:
        item.parent.state === "known"
          ? { state: "known" as const, relation: item.parent.relation, spanId: item.parent.span.spanId }
          : item.parent.state === "unknown"
            ? { state: "unknown" as const, reason: item.parent.reason }
            : { state: "root" as const },
      spanKind: item.spanKind,
      nodeId: item.node.nodeId,
      lifecycle: item.lifecycle,
      error: evidence(item.error),
      framework:
        item.framework.state === "recorded"
          ? { state: "recorded", value: item.framework.value, maskedFields: item.framework.maskedFields }
          : item.framework,
      args: evidence(item.args),
      ret: evidence(item.ret)
    }))
    .sort((left, right) => left.spanId.localeCompare(right.spanId));
}

export function sourceMeta(source: SourceName, page: CanonicalPageEnvelopeV2): SourceMeta {
  return {
    source,
    datasetId: page.dataset.datasetId,
    projectId: page.dataset.projectId,
    provenance: page.dataset.source,
    watermarkSeq: page.dataset.watermarkSeq,
    retentionEpoch: page.dataset.retentionEpoch,
    capabilities: "canonical"
  };
}

export type IdentityMapping = { projectId: string; datasets: Partial<Record<SourceName, string>> };

export type Comparison =
  | { verdict: "equal"; exportRedacted: string[] }
  | { verdict: "different"; differences: string[] }
  | { verdict: "not-comparable"; reason: string };

/** A summary-only side has no spans: it is `not-comparable`, never `equal`. */
export function compareSourceFacts(
  mapping: IdentityMapping,
  left: { meta: SourceMeta; facts: SpanFact[] | null },
  right: { meta: SourceMeta; facts: SpanFact[] | null }
): Comparison {
  for (const side of [left, right]) {
    if (side.meta.capabilities === "summary-only" || side.facts === null) {
      return {
        verdict: "not-comparable",
        reason: `${side.meta.source} is summary-only: it carries trace summaries, not spans`
      };
    }
    if (side.meta.projectId !== mapping.projectId) {
      return { verdict: "not-comparable", reason: `${side.meta.source} belongs to project ${side.meta.projectId}` };
    }
    const expected = mapping.datasets[side.meta.source];
    if (expected === undefined || expected !== side.meta.datasetId) {
      return {
        verdict: "not-comparable",
        reason: `${side.meta.source} namespace ${side.meta.datasetId} is not mapped to this recording`
      };
    }
  }
  const differences: string[] = [];
  const exportRedacted: string[] = [];
  const rightById = new Map(right.facts!.map((fact) => [fact.spanId, fact]));
  for (const fact of left.facts!) {
    const other = rightById.get(fact.spanId);
    if (other === undefined) differences.push(`${fact.spanId}: missing in ${right.meta.source}`);
    else {
      const expected = right.meta.provenance === "imported" ? withExportRedaction(fact, other, exportRedacted) : fact;
      if (JSON.stringify(expected) !== JSON.stringify(other))
        differences.push(`${fact.spanId}: ${JSON.stringify(expected)} != ${JSON.stringify(other)}`);
    }
    rightById.delete(fact.spanId);
  }
  for (const spanId of rightById.keys()) differences.push(`${spanId}: missing in ${left.meta.source}`);
  return differences.length === 0 ? { verdict: "equal", exportRedacted } : { verdict: "different", differences };
}

type FrameworkFact = { state: "recorded"; value: Record<string, unknown>; maskedFields: string[] };

/** The export's additional redaction, accounted for per field instead of ignored. */
function withExportRedaction(fact: SpanFact, imported: SpanFact, redacted: string[]): SpanFact {
  const live = fact.framework as FrameworkFact;
  const other = imported.framework as FrameworkFact;
  if (live?.state !== "recorded" || other?.state !== "recorded") return fact;
  const added = other.maskedFields.filter((field) => !live.maskedFields.includes(field) && field in live.value);
  if (added.length === 0) return fact;
  const value = Object.fromEntries(Object.entries(live.value).filter(([key]) => !added.includes(key)));
  for (const field of added) redacted.push(`${fact.spanId}.framework.${field}`);
  return { ...fact, framework: { state: "recorded", value, maskedFields: [...live.maskedFields, ...added].sort() } };
}

/** Recording-independent facts: ids become ordinals, exactly as in kosmo-callflow's golden. */
export function normalizeFacts(traces: Record<string, SpanFact[]>, order: string[]): unknown {
  const spanLabel = new Map<string, string>();
  order.forEach((traceId, traceIndex) => {
    const facts = traces[traceId] ?? [];
    const depth = (fact: SpanFact): number => {
      let level = 0;
      let current: SpanFact | undefined = fact;
      while (current && current.parent.state === "known" && level < 64) {
        const parentId: string = current.parent.spanId;
        current = facts.find((candidate) => candidate.spanId === parentId);
        level += 1;
      }
      return level;
    };
    [...facts]
      .sort(
        (a, b) =>
          depth(a) - depth(b) ||
          a.nodeId.localeCompare(b.nodeId) ||
          String(a.spanKind).localeCompare(String(b.spanKind)) ||
          JSON.stringify([a.args, a.ret]).localeCompare(JSON.stringify([b.args, b.ret]))
      )
      .forEach((fact, index) => spanLabel.set(`${traceId}\0${fact.spanId}`, `t${traceIndex}.s${index}`));
  });
  return Object.fromEntries(
    order.map((traceId, traceIndex) => [
      `t${traceIndex}`,
      (traces[traceId] ?? [])
        .map((fact) => ({
          ...fact,
          traceId: `t${traceIndex}`,
          spanId: spanLabel.get(`${traceId}\0${fact.spanId}`),
          parent:
            fact.parent.state === "known"
              ? { ...fact.parent, spanId: spanLabel.get(`${traceId}\0${fact.parent.spanId}`) }
              : fact.parent
        }))
        .sort((a, b) => String(a.spanId).localeCompare(String(b.spanId), "en", { numeric: true }))
    ])
  );
}
