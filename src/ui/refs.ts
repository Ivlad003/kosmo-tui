/**
 * Refs in `:` commands (spec 6.6).
 *
 *   span-ref:  `.` (the selection) | `<id>` | `<session>:<id>` | `<trace>:<session>:<id>`
 *   trace-ref: `<trace>`
 *
 * Only UNQUOTED colons separate parts, so an id that contains a colon is written quoted:
 * `"a:b"` or `s1:"a:b"`. The tokenizer is the one from `src/command-line.ts`. The first three
 * span-ref forms resolve in the current trace. An ambiguous short id is never guessed: the
 * caller gets every candidate back and shows them.
 *
 * A token that starts with `/` is a regex literal `/source/flags`. It is allowed only where
 * spec 6.6 says so (`:find`, `:filter name`, `:area`); `regexFromLiteral` checks the flags.
 */

import { tokenize, type Token } from "../command-line.js";
import type { TraceModel } from "../format/model.js";
import type { SpanRef } from "../format/types.js";

export type SpanRefInput =
  | { kind: "selected" }
  | { kind: "id"; id: string }
  | { kind: "session-id"; session: string; id: string }
  | { kind: "full"; trace: string; session: string; id: string };

export type ResolvedSpanRef =
  | { ok: true; ref: SpanRef }
  | { ok: false; reason: "not-found" | "no-selection" }
  | { ok: false; reason: "ambiguous"; candidates: SpanRef[] };

const SPAN_REF_FORMS = ". | <id> | <session>:<id> | <trace>:<session>:<id>";

/** Flags a user regex may carry. `g` and `y` make `test()` stateful, `d` and `v` add nothing here. */
export const REGEX_FLAGS = "imsu";

/** One already tokenized argument as a span ref. */
export function spanRefFromToken(token: Token): SpanRefInput | { error: string } {
  if (token.regex !== undefined) return { error: `a regex is not a span ref: ${token.text}` };
  if (!token.quoted && token.text === ".") return { kind: "selected" };
  const { parts } = token;
  if (parts.some((part) => part.length === 0)) return { error: `empty part in ref ${token.text}` };
  switch (parts.length) {
    case 1:
      return { kind: "id", id: parts[0]! };
    case 2:
      return { kind: "session-id", session: parts[0]!, id: parts[1]! };
    case 3:
      return { kind: "full", trace: parts[0]!, session: parts[1]!, id: parts[2]! };
    default:
      return { error: `bad span ref ${token.text}; expected ${SPAN_REF_FORMS}` };
  }
}

/** A span ref typed as text: exactly one token. */
export function parseSpanRef(token: string): SpanRefInput | { error: string } {
  const tokenized = tokenize(token);
  if (!tokenized.ok) return { error: tokenized.error };
  if (tokenized.tokens.length !== 1) return { error: `expected one span ref, got ${tokenized.tokens.length} tokens` };
  return spanRefFromToken(tokenized.tokens[0]!);
}

/**
 * Resolve inside the current trace. `<id>` looks at every session: exactly one span with that
 * id resolves, two or more are `ambiguous` with all candidates in DFS order.
 */
export function resolveSpanRef(model: TraceModel, selected: SpanRef | null, input: SpanRefInput): ResolvedSpanRef {
  const trace = model.trace.id;
  switch (input.kind) {
    case "selected":
      if (selected === null) return { ok: false, reason: "no-selection" };
      return selected.trace === trace && model.get(selected) !== undefined
        ? { ok: true, ref: selected }
        : { ok: false, reason: "not-found" };
    case "id": {
      const candidates = model.dfs().filter((ref) => ref.id === input.id);
      if (candidates.length === 0) return { ok: false, reason: "not-found" };
      if (candidates.length === 1) return { ok: true, ref: candidates[0]! };
      return { ok: false, reason: "ambiguous", candidates: [...candidates] };
    }
    case "session-id":
    case "full": {
      if (input.kind === "full" && input.trace !== trace) return { ok: false, reason: "not-found" };
      const row = model.get({ trace, session: input.session, id: input.id });
      return row === undefined ? { ok: false, reason: "not-found" } : { ok: true, ref: row.ref };
    }
  }
}

/** A ref part as the user would type it: quoted when it holds a colon, a quote, a backslash or a space. */
function refPart(part: string): string {
  return /^[^\s:'"\\]+$/.test(part) ? part : JSON.stringify(part);
}

/** `<session>:<id>`, the shortest form that is unique inside one trace. Raw text: escape before painting. */
export function formatSpanRef(ref: SpanRef): string {
  return `${refPart(ref.session)}:${refPart(ref.id)}`;
}

/** `/source/flags` → RegExp. Flags outside {@link REGEX_FLAGS} and invalid sources are errors, never thrown. */
export function regexFromLiteral(text: string): RegExp | { error: string } {
  const match = /^\/(.*)\/([a-z]*)$/s.exec(text);
  if (match === null) return { error: `expected /regex/flags, got ${text}` };
  const [, source, flags] = match as unknown as [string, string, string];
  for (const flag of flags) {
    if (!REGEX_FLAGS.includes(flag)) return { error: `regex flag ${flag} is not allowed (use ${REGEX_FLAGS})` };
  }
  if (new Set(flags).size !== flags.length) return { error: `repeated regex flag in ${text}` };
  try {
    return new RegExp(source, flags);
  } catch (error) {
    return { error: `invalid regex ${text}: ${(error as Error).message}` };
  }
}
