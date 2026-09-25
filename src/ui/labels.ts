/**
 * Display text of one span (spec 6.3, 4.13): status, location, area, duration and the special
 * forms of known framework kinds. Viewer-side only: nothing is inferred beyond what the span and
 * its `attrs` say, and no diagnosis is ever invented (a `running` middleware is just
 * `running (at capture)`).
 *
 * Every function returns text that is already escaped with `escapeTerminalControls`, so the
 * callers may wrap and fit it directly.
 */

import { maskAttrs } from "../format/kinds.js";
import type { WideRootRejection } from "../code/root.js";
import type { AreaKey, ParentOf } from "../format/model.js";
import type { Attrs, SpanRow, SpanStatus, SpanValues } from "../format/types.js";
import { escapeTerminalControls } from "../sanitize.js";

export const STATUS_GLYPH: Readonly<Record<SpanStatus, string>> = {
  complete: "✓",
  errored: "✗",
  running: "…",
  suspended: "⏸",
  unknown: "?"
};
/** Error-path glyph for `express.error-handler` and `nest.filter`. */
export const ERROR_PATH_GLYPH = "⤳";
export const STRICT_MARK = "⧉strict";
export const DENIED_TEXT = "→ false (denied)";

export function statusText(span: SpanRow): string {
  switch (span.status) {
    case "running":
      return "running (at capture)";
    case "unknown":
      return `unknown(${escapeTerminalControls(span.statusReason ?? "unspecified")})`;
    default:
      return span.status;
  }
}

/**
 * Why there is no code root. A reason: spec 4.8 rule 4 was rejected, the current directory is too
 * wide. null: no dataset is open yet, so nothing failed; the root is chosen when a trace opens.
 */
export function rootUnsetText(reason: WideRootRejection | null): string {
  switch (reason) {
    case "filesystem-root":
      return "code root not set: cwd is the filesystem root; use :root or --root";
    case "home":
      return "code root not set: cwd is the home directory or above it; use :root or --root";
    case null:
      return "code root: chosen when a trace opens; set one with :root or --root";
  }
}

/** `~module` (derived), `module · feature`, `module`, `· feature`, or `(unknown)`. */
export function areaText(key: AreaKey): string {
  const module = key.module === null ? null : escapeTerminalControls(key.module);
  const feature = key.feature === null ? null : escapeTerminalControls(key.feature);
  if (key.derived) return `~${module ?? ""}`;
  if (module !== null && feature !== null) return `${module} · ${feature}`;
  if (module !== null) return module;
  return feature !== null ? `· ${feature}` : "(unknown)";
}

export function locationText(span: SpanRow): string {
  if (span.location !== undefined) return `${escapeTerminalControls(span.location.file)}:${span.location.line}`;
  return span.marks.includes("invalid-location") ? "(invalid-location)" : "(no location)";
}

export function durationText(span: SpanRow): string {
  return span.durationMs === undefined ? "-" : `${span.durationMs.toFixed(1)}ms`;
}

function attrText(attrs: Attrs, key: string): string | null {
  const value = attrs[key];
  return value === undefined ? null : escapeTerminalControls(String(value));
}

/**
 * `http.server` rows: `METHOD route → status` from OTel attrs, then `next.request.type`
 * (spec 6.3). Missing parts are `-`; null when the span carries none of them. The attrs are
 * masked first (spec 8.3, the same `maskAttrs` as detail and --print): `?token=…` never shows.
 */
export function httpText(span: SpanRow): string | null {
  if (span.kind !== "http.server" || span.attrs === undefined) return null;
  const attrs = maskAttrs(span.attrs);
  const method = attrText(attrs, "http.request.method");
  const route = attrText(attrs, "http.route");
  const status = attrText(attrs, "http.response.status_code");
  const type = attrText(attrs, "next.request.type");
  const parts: string[] = [];
  if (method !== null || route !== null || status !== null)
    parts.push(`${method ?? "-"} ${route ?? "-"} → ${status ?? "-"}`);
  if (type !== null) parts.push(type);
  return parts.length === 0 ? null : parts.join(" · ");
}

export function isErrorPathKind(kind: string): boolean {
  return kind === "express.error-handler" || kind === "nest.filter";
}

/** `nest.guard` whose recorded `return` is exactly `false`. Unloaded or other values say nothing. */
export function isDenied(span: SpanRow, values: SpanValues | undefined): boolean {
  if (span.kind !== "nest.guard" || values === undefined) return false;
  return values.return.state === "recorded" && values.return.value === false;
}

/** The producer's claim `react.strict_mode.duplicate = true`; the viewer never looks for duplicates. */
export function isStrictDuplicate(span: SpanRow): boolean {
  return span.attrs?.["react.strict_mode.duplicate"] === true;
}

export function parentMark(parent: ParentOf): string | null {
  if (parent.kind === "unknown") return `parent=unknown(${parent.reason})`;
  return parent.kind === "cycle" ? "cycle" : null;
}
