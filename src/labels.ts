/**
 * Semantic step labels (task 5.2, spec tui-debugger "Request-centric view без хибних
 * діагнозів", design D13).
 *
 * A label is read from the recorded `spanKind` of a canonical v2 item, never from the
 * item discriminator `kind: "span"`, and never guessed: an item without a valid recorded
 * kind is `unavailable(no-span-kind)`, not `function`. Framework metadata is shown in the
 * evidence vocabulary of the projector (`masked`, `not-recorded(reason)`,
 * `unavailable(reason)`), so count-level, masked and missing metadata read differently.
 *
 * Nest interceptors: the synchronous `intercept` call is the invocation (`phase: pre`);
 * every real Observable subscription is its own child span (`phase: stream`). Only a
 * subscription with recorded terminal evidence is shown as `interceptor↩`. An invocation
 * whose exit happens to carry `phase: post` is still the invocation: `↩` is never a
 * synthetic post-span.
 *
 * v1 sources carry no semantic kind; a row that has a legacy runtime kind is labelled
 * from it and marked `(v1)`, and a row without one says so.
 */

import {
  legacyRuntimeKindValues,
  type CanonicalFrameworkEvidence,
  type CanonicalPageEnvelopeV2,
  type CanonicalSpanProjectionItemV2,
  type FrameworkField,
  type FrameworkPayload
} from "@kosmo-callflow/protocol";
import { escapeTerminalControls } from "@kosmo-callflow/trace-artifacts";
import { spanKey, type SpanRef } from "./view-state.js";

/** `↩`, written as a code point so no editor or tool can rewrite it. */
export const RETURN_MARK = String.fromCodePoint(0x21a9);

/** One framework field in evidence vocabulary; a value is present only when recorded. */
export type FieldText =
  | { state: "recorded"; text: string }
  | { state: "masked" }
  | { state: "not-recorded"; reason: string }
  | { state: "unavailable"; reason: string };

export function fieldText(field: FieldText): string {
  switch (field.state) {
    case "recorded":
      return field.text;
    case "masked":
      return "masked";
    case "not-recorded":
      return `not-recorded(${field.reason})`;
    case "unavailable":
      return `unavailable(${field.reason})`;
  }
}

/**
 * One framework field of a span. A field the producer masked is `masked`; a field the
 * recorded metadata simply does not carry is `unavailable(not-recorded-field)`; metadata
 * that is missing, masked as a whole, count-level or invalid keeps the projector's reason.
 */
export function frameworkField(evidence: CanonicalFrameworkEvidence, field: FrameworkField): FieldText {
  switch (evidence.state) {
    case "masked":
      return { state: "masked" };
    case "not-recorded":
      return { state: "not-recorded", reason: evidence.reason };
    case "unavailable":
      return { state: "unavailable", reason: evidence.reason };
    case "recorded": {
      if (evidence.maskedFields.includes(field)) return { state: "masked" };
      const value = (evidence.value as Record<string, unknown>)[field];
      if (value === undefined) return { state: "unavailable", reason: "not-recorded-field" };
      return {
        state: "recorded",
        text: escapeTerminalControls(typeof value === "string" ? value : JSON.stringify(value))
      };
    }
  }
}

/** The whole framework evidence in one short phrase. */
export function frameworkSummary(evidence: CanonicalFrameworkEvidence): string {
  switch (evidence.state) {
    case "masked":
      return "framework: masked";
    case "not-recorded":
      return `framework: not-recorded(${evidence.reason})`;
    case "unavailable":
      return `framework: unavailable(${evidence.reason})`;
    case "recorded": {
      const value = evidence.value;
      const parts: string[] = [value.name];
      const who = [value.class, value.handler].filter((part): part is string => part !== undefined).join(".");
      if (who.length > 0) parts.push(who);
      if (value.component !== undefined) parts.push(value.component);
      for (const field of ["method", "route", "status", "phase", "completion"] as const) {
        if (value[field] !== undefined) parts.push(`${field}=${String(value[field])}`);
      }
      // Next-specific fields: without them an action and a prefetch of the same route (or
      // an edge rewrite/redirect) read identically in the one-line summary.
      if (value.requestType !== undefined) parts.push(`requestType=${value.requestType}`);
      if (value.actionId !== undefined) parts.push(`actionId=${value.actionId}`);
      if (value.cache !== undefined) {
        parts.push(`cache=${value.cache.status}${value.cache.reason !== undefined ? `/${value.cache.reason}` : ""}`);
      }
      if (value.rewrite !== undefined) parts.push(`rewrite=${value.rewrite}`);
      if (value.redirect !== undefined) parts.push(`redirect=${value.redirect}`);
      for (const field of evidence.maskedFields) parts.push(`${field}=masked`);
      return `framework: ${escapeTerminalControls(parts.join(" "))}`;
    }
  }
}

export type InterceptorRole = "invocation" | "subscription";

export type SpanLabel = {
  /** The recorded semantic kind, or null when none was recorded. */
  spanKind: string | null;
  /** What the step list shows. */
  text: string;
  source: "span-kind" | "legacy-kind" | "unavailable";
  /** Nest interceptor role, only for `spanKind: interceptor`. */
  interceptor?: { role: InterceptorRole; terminal: boolean };
  framework: string;
};

function recordedFramework(item: CanonicalSpanProjectionItemV2): FrameworkPayload | null {
  return item.framework.state === "recorded" ? item.framework.value : null;
}

function hasTerminalEvidence(item: CanonicalSpanProjectionItemV2): boolean {
  return item.lifecycle === "complete" || item.lifecycle === "errored";
}

/**
 * Whether an interceptor span is a subscription rather than the `intercept` invocation.
 * Evidence only: the recorded `phase: stream`, or a finished child whose parent is the
 * `phase: pre` invocation of the same interceptor (the terminal record may carry
 * `post`/`finalize`). A nested interceptor's own invocation runs inside the outer
 * subscription, so a parent that is merely an interceptor proves nothing.
 */
export function interceptorRole(
  item: CanonicalSpanProjectionItemV2,
  parent: CanonicalSpanProjectionItemV2 | undefined
): InterceptorRole {
  const own = recordedFramework(item);
  if (own?.phase === "stream") return "subscription";
  if (own?.phase !== "post" && own?.phase !== "finalize") return "invocation";
  if (parent === undefined || parent.spanKind !== "interceptor") return "invocation";
  const outer = recordedFramework(parent);
  if (outer?.phase !== "pre") return "invocation";
  if (own.component !== undefined && outer.component !== undefined && own.component !== outer.component) {
    return "invocation";
  }
  return "subscription";
}

function pendingText(item: CanonicalSpanProjectionItemV2): string {
  if (item.lifecycle === "unknown") return `unknown(${item.lifecycleReason ?? "incomplete"})`;
  return item.lifecycle === "suspended" ? "suspended" : "pending";
}

/** Label of one v2 span; `parent` is the recorded parent item when the page holds it. */
export function spanLabelV2(item: CanonicalSpanProjectionItemV2, parent?: CanonicalSpanProjectionItemV2): SpanLabel {
  const framework = frameworkSummary(item.framework);
  if (item.spanKind === null) {
    return { spanKind: null, text: "unavailable(no-span-kind)", source: "unavailable", framework };
  }
  if (item.spanKind !== "interceptor") {
    return { spanKind: item.spanKind, text: item.spanKind, source: "span-kind", framework };
  }
  const role = interceptorRole(item, parent);
  const terminal = hasTerminalEvidence(item);
  const text =
    role === "invocation"
      ? "interceptor"
      : terminal
        ? `interceptor${RETURN_MARK}`
        : `interceptor(stream, ${pendingText(item)})`;
  return { spanKind: "interceptor", text, source: "span-kind", interceptor: { role, terminal }, framework };
}

function isSpan(item: CanonicalPageEnvelopeV2["items"][number]): item is CanonicalSpanProjectionItemV2 {
  return item.kind === "span";
}

/** Labels of every span on a page, keyed by the full span ref. */
export function spanLabelsV2(page: CanonicalPageEnvelopeV2): Map<string, SpanLabel> {
  const spans = page.items.filter(isSpan);
  const byKey = new Map(spans.map((item) => [spanKey(item.span), item]));
  const labels = new Map<string, SpanLabel>();
  for (const item of spans) {
    const parent = item.parent.state === "known" ? byKey.get(spanKey(item.parent.span)) : undefined;
    labels.set(spanKey(item.span), spanLabelV2(item, parent));
  }
  return labels;
}

/** v1 fallback: a legacy runtime kind when the row has one, otherwise an explicit gap. */
export function legacySpanLabel(row: SpanRef & { spanKind?: string }): SpanLabel {
  const kind = row.spanKind;
  if (kind !== undefined && (legacyRuntimeKindValues as readonly string[]).includes(kind)) {
    return {
      spanKind: kind,
      text: `${kind} (v1)`,
      source: "legacy-kind",
      framework: "framework: unavailable(projection-v1)"
    };
  }
  if (kind !== undefined) {
    return {
      spanKind: kind,
      text: escapeTerminalControls(kind),
      source: "span-kind",
      framework: "framework: unavailable(projection-v1)"
    };
  }
  return {
    spanKind: null,
    text: "unavailable(v1-no-span-kind)",
    source: "unavailable",
    framework: "framework: unavailable(projection-v1)"
  };
}
