/**
 * Architectural depth and focus (task 5.3, spec tui-debugger "Архітектурна глибина
 * через shared mapping", design D14).
 *
 * Every grouping goes through the SHARED v2 depth projector
 * (`projectCanonicalDepthEnvelopeV2`); this module never decides membership itself. The
 * options it passes are exactly the ones the kosmo-callflow daemon/CLI pass for
 * `trace --projection-version 2 --depth <level>`, so the TUI rows and the CLI output of
 * the same envelope agree.
 *
 * Focus is a canonical group identity plus the mapping revision/source it was taken
 * under and its membership: the full span refs the projector put in that group. It is
 * never a `nodeId.startsWith` prefix, so focusing `src/cart` can never pull in
 * `src/cart-admin`.
 *
 * Nest logical modules are used only when a logical mapping comes with the `nest-adapter`
 * capability; otherwise (and for nodes the mapping does not cover) the file-based
 * grouping is used and marked as a fallback. Group durations are SUMS of inclusive span
 * durations and are labelled as such; there is no wall time, and a group without duration
 * evidence says `unavailable(no-duration-evidence)` instead of showing zero.
 */

import {
  projectCanonicalDepthEnvelopeV2,
  type CanonicalDepthGroupProjectionItemV2,
  type CanonicalDepthProjectionOptionsV2,
  type CanonicalLogicalModuleMapping,
  type CanonicalPageEnvelopeV2,
  type CanonicalProjectionRoot,
  type CanonicalSpanProjectionItemV2
} from "@kosmo-callflow/protocol";
import { escapeTerminalControls } from "@kosmo-callflow/trace-artifacts";
import type { DepthLevel } from "./commands.js";
import { spanLabelsV2 } from "./labels.js";
import { durationText } from "./requests.js";
import { spanKey, spanRefOf, type SpanRef } from "./view-state.js";

/** Coarsest first; `-` moves left, `+` moves right. */
export const DEPTH_ORDER: readonly DepthLevel[] = ["app", "feature", "module", "symbol", "call"];

export type GroupDepth = Exclude<DepthLevel, "call">;

export function depthRank(level: DepthLevel): number {
  return DEPTH_ORDER.indexOf(level);
}

export function stepDepth(level: DepthLevel | null, delta: number): DepthLevel {
  const from = depthRank(level ?? "call");
  return DEPTH_ORDER[Math.max(0, Math.min(DEPTH_ORDER.length - 1, from + delta))]!;
}

/** The capability a logical module mapping must come with to be used. */
export const LOGICAL_MAPPING_CAPABILITY = "nest-adapter";

export type DepthMapping = {
  mappingRevision?: string;
  workspaceRoots?: CanonicalProjectionRoot[];
  packageRoots?: CanonicalProjectionRoot[];
  featureRoots?: CanonicalProjectionRoot[];
  /** A producer logical mapping and the capability it was published under. */
  logical?: { mapping: CanonicalLogicalModuleMapping; capability: string };
};

export type DepthFocus = {
  /** Canonical group item id (`depth:v2:<depth>:<group>…`). */
  groupId: string;
  /** The group's node identity (`module:<workspace>/<package>/<path>`, `module:logical/<m>`). */
  groupNode: string;
  depth: GroupDepth;
  mappingRevision: string;
  mappingSource: "logical" | "file";
  /** `spanKey` of every span the shared projector put in the group, sorted. */
  members: string[];
};

/** Why a file-based group is shown where a logical module could have been. */
export type FallbackReason = "no-logical-mapping" | "logical-mapping-needs-nest-adapter" | "unmapped-node";

export type DepthGroupRow = {
  kind: "group";
  id: string;
  groupNode: string;
  label: string;
  depth: GroupDepth;
  mapping: { revision: string; source: "logical" | "file"; fallback: FallbackReason | null };
  spans: number;
  errors: number;
  distinctTraces: number;
  byKind: Array<{ spanKind: string; spans: number }>;
  inclusiveSum: CanonicalDepthGroupProjectionItemV2["metrics"]["inclusiveDuration"];
  wallTime: CanonicalDepthGroupProjectionItemV2["metrics"]["wallTime"];
  coverage: string[];
};

export type DepthCallRow = {
  kind: "call";
  ref: SpanRef;
  key: string;
  label: string;
  nodeId: string;
  lifecycle: CanonicalSpanProjectionItemV2["lifecycle"];
  duration: CanonicalSpanProjectionItemV2["duration"];
};

export type DepthRow = DepthGroupRow | DepthCallRow;

export type DepthView = {
  level: DepthLevel;
  rows: DepthRow[];
  focus: (DepthFocus & { stale: boolean; currentRevision: string }) | null;
  /** The grouped envelopes the rows were read from (one per dataset), for parity and copy. */
  pages: CanonicalPageEnvelopeV2[];
};

function logicalActive(mapping: DepthMapping): CanonicalLogicalModuleMapping | undefined {
  return mapping.logical?.capability === LOGICAL_MAPPING_CAPABILITY ? mapping.logical.mapping : undefined;
}

/**
 * Projector options for one level: the same keys the daemon passes for
 * `trace --projection-version 2 --depth`.
 */
export function depthOptions(level: DepthLevel, mapping: DepthMapping = {}): CanonicalDepthProjectionOptionsV2 {
  const logical = logicalActive(mapping);
  return {
    depth: level,
    mappingRevision: mapping.mappingRevision ?? "default",
    ...(mapping.workspaceRoots ? { workspaceRoots: mapping.workspaceRoots } : {}),
    ...(mapping.packageRoots ? { packageRoots: mapping.packageRoots } : {}),
    ...(mapping.featureRoots ? { featureRoots: mapping.featureRoots } : {}),
    ...(logical ? { logicalMapping: logical } : {})
  };
}

/** The revision a group taken now would carry (the projector's own precedence). */
export function currentMappingRevision(mapping: DepthMapping = {}): string {
  return logicalActive(mapping)?.revision ?? mapping.mappingRevision ?? "default";
}

function isSpan(item: CanonicalPageEnvelopeV2["items"][number]): item is CanonicalSpanProjectionItemV2 {
  return item.kind === "span";
}

/**
 * One call-level envelope per dataset: pages of the same dataset are concatenated so a
 * group counts spans across the loaded traces; datasets are never mixed.
 */
export function mergePages(pages: readonly CanonicalPageEnvelopeV2[]): CanonicalPageEnvelopeV2[] {
  const byDataset = new Map<string, CanonicalPageEnvelopeV2>();
  for (const page of pages) {
    const key = JSON.stringify([page.dataset.datasetId, page.dataset.projectId]);
    const current = byDataset.get(key);
    if (current === undefined) {
      byDataset.set(key, page);
      continue;
    }
    const seen = new Set(current.items.filter(isSpan).map((item) => spanKey(item.span)));
    const extra = page.items.filter((item) => !isSpan(item) || !seen.has(spanKey(item.span)));
    byDataset.set(key, {
      ...current,
      items: [...current.items, ...extra].slice(0, 1000),
      truncated: current.truncated || page.truncated || current.items.length + extra.length > 1000
    });
  }
  return [...byDataset.values()];
}

function restrictTo(page: CanonicalPageEnvelopeV2, members: ReadonlySet<string> | null): CanonicalPageEnvelopeV2 {
  if (members === null) return page;
  return { ...page, items: page.items.filter((item) => isSpan(item) && members.has(spanKey(item.span))) };
}

/**
 * The shared projector's membership of one group: each span is placed by the projector
 * itself (projected on its own), so the TUI holds no grouping rule of its own.
 */
export function membershipOf(
  page: CanonicalPageEnvelopeV2,
  level: GroupDepth,
  mapping: DepthMapping,
  groupId: string
): string[] {
  const options = depthOptions(level, mapping);
  const members: string[] = [];
  for (const item of page.items.filter(isSpan)) {
    const placed = projectCanonicalDepthEnvelopeV2({ ...page, items: [item] }, options).items[0];
    if (placed?.kind === "group" && placed.id === groupId) members.push(spanKey(item.span));
  }
  return members.sort();
}

/** Focus the group `groupId` at `level`; null when no loaded page holds that group. */
export function focusOn(
  pages: readonly CanonicalPageEnvelopeV2[],
  level: GroupDepth,
  mapping: DepthMapping,
  groupId: string,
  within: DepthFocus | null = null
): DepthFocus | null {
  const scope = within === null ? null : new Set(within.members);
  for (const page of mergePages(pages)) {
    const restricted = restrictTo(page, scope);
    const grouped = projectCanonicalDepthEnvelopeV2(restricted, depthOptions(level, mapping));
    const group = grouped.items.find(
      (item): item is CanonicalDepthGroupProjectionItemV2 => item.kind === "group" && item.id === groupId
    );
    if (group === undefined) continue;
    return {
      groupId,
      groupNode: group.node.nodeId,
      depth: level,
      mappingRevision: group.mapping.revision,
      mappingSource: group.mapping.source,
      members: membershipOf(restricted, level, mapping, groupId)
    };
  }
  return null;
}

function fallbackOf(
  group: CanonicalDepthGroupProjectionItemV2,
  mapping: DepthMapping,
  level: GroupDepth
): FallbackReason | null {
  if (group.mapping.source === "logical") return null;
  // Logical modules exist only at module/feature depth; app and symbol are file-based by nature.
  if (level !== "module" && level !== "feature") return null;
  if (mapping.logical === undefined) return "no-logical-mapping";
  if (logicalActive(mapping) === undefined) return "logical-mapping-needs-nest-adapter";
  return "unmapped-node";
}

function groupRow(group: CanonicalDepthGroupProjectionItemV2, mapping: DepthMapping): DepthGroupRow {
  return {
    kind: "group",
    id: group.id,
    groupNode: group.node.nodeId,
    label: escapeTerminalControls(group.node.displayName),
    depth: group.depth,
    mapping: {
      revision: group.mapping.revision,
      source: group.mapping.source,
      fallback: fallbackOf(group, mapping, group.depth)
    },
    spans: group.metrics.spans,
    errors: group.metrics.errors,
    distinctTraces: group.metrics.distinctTraces,
    byKind: group.metrics.byKind.map((bucket) => ({ spanKind: bucket.spanKind, spans: bucket.spans })),
    inclusiveSum: group.metrics.inclusiveDuration,
    wallTime: group.metrics.wallTime,
    coverage: [...group.coverage.states]
  };
}

/** The rows for `level`, restricted to the focus membership when there is one. */
export function depthView(
  pages: readonly CanonicalPageEnvelopeV2[],
  level: DepthLevel,
  mapping: DepthMapping = {},
  focus: DepthFocus | null = null
): DepthView {
  // A focus only narrows levels finer than its own; at its level or coarser it is moot.
  const active = focus !== null && depthRank(level) > depthRank(focus.depth) ? focus : null;
  const members = active === null ? null : new Set(active.members);
  const merged = mergePages(pages).map((page) => restrictTo(page, members));
  const grouped = merged.map((page) => projectCanonicalDepthEnvelopeV2(page, depthOptions(level, mapping)));
  const rows: DepthRow[] = [];
  grouped.forEach((page, index) => {
    if (level === "call") {
      const labels = spanLabelsV2(merged[index]!);
      for (const item of page.items.filter(isSpan)) {
        const key = spanKey(item.span);
        rows.push({
          kind: "call",
          ref: spanRefOf(item.span),
          key,
          label: labels.get(key)?.text ?? "unavailable(no-span-kind)",
          nodeId: escapeTerminalControls(item.node.nodeId),
          lifecycle: item.lifecycle,
          duration: item.duration
        });
      }
      return;
    }
    for (const item of page.items) if (item.kind === "group") rows.push(groupRow(item, mapping));
  });
  const currentRevision = currentMappingRevision(mapping);
  return {
    level,
    rows,
    focus: active === null ? null : { ...active, stale: active.mappingRevision !== currentRevision, currentRevision },
    pages: grouped
  };
}

export function inclusiveSumText(sum: DepthGroupRow["inclusiveSum"]): string {
  if (sum.state === "unavailable") return `sum(inclusive)=unavailable(${sum.reason})`;
  const ms = Math.round(sum.sumMs * 1000) / 1000;
  return `sum(inclusive)=${ms}ms over ${sum.samples} span(s)${sum.partial ? ", partial" : ""}`;
}

export function formatDepthRow(row: DepthRow): string {
  if (row.kind === "call") {
    return `${row.label} ${row.nodeId} ${row.lifecycle} ${durationText(row.duration)}`;
  }
  const mapping =
    row.mapping.fallback === null
      ? `${row.mapping.source}@${row.mapping.revision}`
      : `file-fallback(${row.mapping.fallback})@${row.mapping.revision}`;
  const kinds = row.byKind.map((bucket) => `${bucket.spanKind}:${bucket.spans}`).join(" ");
  const coverage = row.coverage.filter((state) => state !== "full");
  return [
    `[${row.depth}] ${row.label}`,
    `spans=${row.spans}`,
    `errors=${row.errors}`,
    `traces=${row.distinctTraces}`,
    `kinds{${kinds}}`,
    inclusiveSumText(row.inclusiveSum),
    `wall=unavailable(${row.wallTime.reason})`,
    mapping,
    ...(coverage.length > 0 ? [`coverage=${coverage.join(",")}`] : [])
  ].join(" ");
}

export function focusText(focus: NonNullable<DepthView["focus"]>): string {
  const stale = focus.stale
    ? `, mapping now ${focus.currentRevision}: membership kept from ${focus.mappingRevision}`
    : "";
  return `focus ${escapeTerminalControls(focus.groupNode)} (${focus.members.length} spans, ${focus.mappingSource}@${focus.mappingRevision}${stale})`;
}
