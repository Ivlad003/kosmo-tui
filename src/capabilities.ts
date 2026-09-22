/**
 * Effective capabilities (design D3): what the opened source can read, narrowed by the
 * session policy. The source kind is only an upper bound; a legacy live API may lack a
 * replay endpoint, an export may lack records, and a v1 NDJSON stream only carries
 * summaries. A capability is the ability to read, never a promise that data exists:
 * `values` at `count` level does not promise any payload.
 *
 * Footer hints and key dispatch both read the same effective set, and an explicit
 * command whose capability is missing yields a visible `unavailable(reason)` notice
 * rather than a silent no-op.
 */

import type { Offer, ProjectionVersion, SourceOpenResult, TraceSource } from "./source.js";

export type Capability = Offer;

export type Capabilities = {
  projectionVersions: ProjectionVersion[];
  projection: Capability;
  follow: Capability;
  replay: Capability;
  values: Capability & { level: "full" | "count" | "none" };
  probes: Capability;
  staticGraph: Capability;
  sql: Capability;
  /** An explicit re-read of the source (a new snapshot); a stdin stream cannot be re-read. */
  reload: Capability;
  /** Session capabilities: independent of the source. */
  review: Capability;
  localEval: Capability;
  interactive: Capability;
};

export type CapabilityName = Exclude<keyof Capabilities, "projectionVersions">;

export type SessionPolicy = {
  /** `-r`: no review writes and no local eval. */
  readOnly: boolean;
  /** `--no-eval`: no local eval. */
  noEval: boolean;
  /** `--print`: one-shot output, so no review and no interactive actions. */
  print: boolean;
};

const AVAILABLE: Capability = { available: true };

function unavailable(reason: string): Capability {
  return { available: false, reason };
}

/** A declared offer is only real when the source also implements the read it needs. */
function backed(offer: Offer, implemented: boolean, missing: string): Capability {
  if (!offer.available) return offer;
  return implemented ? AVAILABLE : unavailable(missing);
}

type SourceMethods = Pick<TraceSource, "canonical" | "details" | "records" | "probes" | "deltas">;

/** Capabilities read from the open result; session capabilities start available. */
export function sourceCapabilities(open: SourceOpenResult, source: SourceMethods): Capabilities {
  const { offers } = open;
  const projection =
    offers.projectionVersions.length === 0
      ? unavailable(offers.projectionReason ?? "no-span-projection")
      : backed(AVAILABLE, source.canonical !== undefined, "no-projection-api");
  const valuesBase: Capability =
    offers.values.level === "none"
      ? unavailable(offers.values.reason ?? "no-values")
      : backed(AVAILABLE, source.details !== undefined, "no-details-api");
  return {
    projectionVersions: projection.available ? [...offers.projectionVersions] : [],
    projection,
    follow: backed(offers.follow, source.deltas !== undefined, "no-delta-api"),
    replay: backed(offers.replay, source.records !== undefined, "no-replay-records"),
    values: { ...valuesBase, level: valuesBase.available ? offers.values.level : "none" },
    probes: backed(offers.probes, source.probes !== undefined, "no-probe-api"),
    staticGraph: offers.staticGraph,
    sql: offers.sql,
    reload: offers.reload ?? AVAILABLE,
    review: AVAILABLE,
    localEval: AVAILABLE,
    interactive: AVAILABLE
  };
}

/** Narrow capabilities by the session flags. Policy only ever removes. */
export function applySessionPolicy(caps: Capabilities, policy: SessionPolicy): Capabilities {
  const next: Capabilities = { ...caps };
  if (policy.noEval) next.localEval = unavailable("eval-disabled(--no-eval)");
  if (policy.readOnly) {
    next.review = unavailable("read-only(-r)");
    next.localEval = unavailable("read-only(-r)");
  }
  if (policy.print) {
    next.review = unavailable("one-shot(--print)");
    next.interactive = unavailable("one-shot(--print)");
  }
  return next;
}

export function effectiveCapabilities(
  open: SourceOpenResult,
  source: SourceMethods,
  policy: SessionPolicy
): Capabilities {
  return applySessionPolicy(sourceCapabilities(open, source), policy);
}

/** Explicit user commands and the capabilities each one needs, checked in order. */
export const COMMAND_REQUIREMENTS = {
  replayStep: ["interactive", "replay"],
  seek: ["interactive", "replay"],
  returnToLive: ["interactive", "replay"],
  pause: ["interactive", "follow"],
  probes: ["interactive", "probes"],
  values: ["interactive", "values"],
  sql: ["sql"],
  eval: ["localEval"],
  finding: ["interactive", "review"],
  todo: ["interactive", "review"],
  finalizeReview: ["interactive", "review"],
  bookmark: ["interactive"],
  bookmarkList: ["interactive"],
  stack: ["interactive"],
  compare: ["interactive", "projection"],
  yank: ["interactive"],
  commandLine: ["interactive"],
  /** `>`: the next page of the pinned snapshot (the cursor itself is checked by the session). */
  loadMore: ["interactive"],
  /** `r`: a new snapshot; earlier cursors and pages stop being valid. */
  reload: ["interactive", "reload"],
  /** `:depth`: the shared canonical depth projection. */
  depth: ["interactive", "projection"],
  /** `:callers --static`: possible edges from the static graph, labelled as such. */
  staticCallers: ["staticGraph"]
} as const satisfies Record<string, readonly CapabilityName[]>;

export type Command = keyof typeof COMMAND_REQUIREMENTS;

export type CommandCheck = { ok: true } | { ok: false; capability: CapabilityName; reason: string; notice: string };

export function checkCommand(caps: Capabilities, command: Command): CommandCheck {
  for (const name of COMMAND_REQUIREMENTS[command] as readonly CapabilityName[]) {
    const capability = caps[name];
    if (!capability.available) {
      return {
        ok: false,
        capability: name,
        reason: capability.reason,
        notice: `${command}: unavailable(${capability.reason})`
      };
    }
  }
  return { ok: true };
}

export function isAvailable(caps: Capabilities, command: Command): boolean {
  return checkCommand(caps, command).ok;
}
