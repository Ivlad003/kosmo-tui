/**
 * `:` commands (spec 6.6). A line becomes one reducer Action or an error text; nothing here
 * evaluates anything. Queries (`:ancestors`, `:path`, `:callers`, `:find`) read the open
 * TraceModel as it is at submit time and return a `showResults` action (or a one-line verdict
 * banner); view commands return the reducer action they stand for.
 *
 * Every text that carries data (names, files, ids) is raw here; the renderer escapes it.
 */

import { tokenize, type Token } from "../command-line.js";
import type { AreaKey, AreaRow, TraceModel } from "../format/model.js";
import type { SpanRef, SpanRow } from "../format/types.js";
import { formatSpanRef, regexFromLiteral, resolveSpanRef, spanRefFromToken, type SpanRefInput } from "./refs.js";
import { ancestorsOf, type Action, type ViewState } from "./state.js";

export const COMMAND_NAMES = [
  "trace",
  "ancestors",
  "path",
  "callers",
  "find",
  "filter",
  "area",
  "bookmark",
  "root",
  "q"
] as const;

type CommandError = { readonly error: string };
type Outcome = Action | CommandError;

const AVAILABLE = COMMAND_NAMES.map((name) => `:${name}`).join(" ");
const KNOWN: ReadonlySet<string> = new Set(COMMAND_NAMES);
/** Spec 6.6: a `/` at the start of a token marks a regex only in `:find`, `:filter name` and `:area`. */
const REGEX_COMMANDS: ReadonlySet<string> = new Set(["find", "filter", "area"]);

export function parseCommandLine(state: ViewState, line: string): Action | { readonly error: string } {
  const body = (line.startsWith(":") ? line.slice(1) : line).replace(/^[ \t]+/, "");
  // The command name is the first bare word: it decides how the rest is tokenized.
  const name = /^[^ \t]*/.exec(body)![0];
  // An empty line is not an error: the prompt simply closes.
  if (name === "") return { type: "promptCancel" };
  if (!KNOWN.has(name)) return { error: `unknown command :${name}; available: ${AVAILABLE}` };
  const rest = body.slice(name.length);
  const tokenized = tokenize(REGEX_COMMANDS.has(name) ? rest : literalSlashes(rest));
  if (!tokenized.ok) return { error: tokenized.error };
  const args = tokenized.tokens;
  switch (name) {
    case "q":
      return args.length === 0 ? { type: "quit" } : usage("q");
    case "trace":
      if (args.length !== 1 || args[0]!.regex !== undefined) return usage("trace <trace>");
      return { type: "openTrace", id: args[0]!.text };
    case "root":
      if (args.length === 0) return { type: "showBanner", level: "info", text: `root: ${state.root}` };
      return args.length === 1 ? { type: "setRoot", dir: args[0]!.text } : usage("root [<dir>]");
    case "ancestors":
    case "path":
    case "callers":
    case "find":
    case "filter":
    case "area":
    case "bookmark": {
      const model = state.trace;
      if (state.screen !== "trace" || model === null) return { error: `:${name} needs an open trace` };
      return traceCommand(name, args, state, model);
    }
    default:
      return { error: `unknown command :${name}; available: ${AVAILABLE}` };
  }
}

function usage(text: string): CommandError {
  return { error: `usage: :${text}` };
}

/**
 * Outside `:find`, `:filter` and `:area` a leading `/` is an ordinary character (`:root /abs/dir`,
 * `:trace /t`), but the shared tokenizer reads every token that starts with `/` as a regex literal.
 * So each unquoted token-leading `/` is escaped first; quotes and `\` escapes follow the tokenizer's rules.
 */
function literalSlashes(text: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  let tokenStart = true;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote !== null) {
      out += char;
      if (quote === '"' && char === "\\" && index + 1 < text.length) {
        out += text[index + 1]!;
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === " " || char === "\t") {
      out += char;
      tokenStart = true;
      continue;
    }
    if (char === "/" && tokenStart) {
      out += "\\/";
    } else if (char === "\\" && index + 1 < text.length) {
      out += char + text[index + 1]!;
      index += 1;
    } else {
      if (char === "'" || char === '"') quote = char;
      out += char;
    }
    tokenStart = false;
  }
  return out;
}

function traceCommand(name: string, args: readonly Token[], state: ViewState, model: TraceModel): Outcome {
  switch (name) {
    case "ancestors":
      return args.length <= 1 ? ancestors(state, model, args[0]) : usage("ancestors [span-ref]");
    case "path":
      return args.length === 2 ? path(state, model, args[0]!, args[1]!) : usage("path <from> <to>");
    case "callers":
      return args.length <= 1 ? callers(state, model, args[0]) : usage("callers [span-ref]");
    case "find":
      return args.length === 1 ? find(model, args[0]!) : usage("find /regex/[imsu]");
    case "filter":
      return filter(model, args);
    case "area": {
      if (args.length !== 1) return usage("area <x> | module:<x> | feature:<x> | /regex/");
      const key = areaFrom(model, args[0]!);
      return "error" in key ? key : { type: "setFilter", patch: { area: key } };
    }
    default:
      if (args.length === 0) return { type: "toggleBookmark" };
      if (args.length === 1 && args[0]!.text === "list") return { type: "openPane", pane: "bookmarks" };
      return usage("bookmark [list]");
  }
}

/* ---------------------------------------------------------------- refs */

function target(state: ViewState, model: TraceModel, token: Token | undefined): { ref: SpanRef } | CommandError {
  const input: SpanRefInput | CommandError = token === undefined ? { kind: "selected" } : spanRefFromToken(token);
  if ("error" in input) return input;
  const resolved = resolveSpanRef(model, state.selected, input);
  if (resolved.ok) return { ref: resolved.ref };
  const text = token?.text ?? ".";
  switch (resolved.reason) {
    case "no-selection":
      return { error: "nothing selected (give a span ref)" };
    case "not-found":
      return { error: `span ${text} not found in trace ${model.trace.id}` };
    case "ambiguous":
      return { error: `ambiguous ref ${text}: ${resolved.candidates.map(formatSpanRef).join(", ")}` };
  }
}

function label(model: TraceModel, ref: SpanRef): string {
  return `${model.get(ref)?.name ?? ref.id} (${formatSpanRef(ref)})`;
}

function stopText(stop: ReturnType<typeof ancestorsOf>["stop"]): string {
  switch (stop.kind) {
    case "root":
      return "root reached";
    case "unknown":
      return `parent unknown(${stop.reason})`;
    case "cycle":
      return "cycle: parent edge dropped";
    case "resolved":
      return "walk stopped";
  }
}

/* ---------------------------------------------------------------- queries */

function ancestors(state: ViewState, model: TraceModel, token: Token | undefined): Outcome {
  const found = target(state, model, token);
  if ("error" in found) return found;
  const walk = ancestorsOf(model, found.ref);
  return {
    type: "showResults",
    results: {
      kind: "ancestors",
      title: `ancestors of ${label(model, found.ref)}: ${walk.frames.length - 1}`,
      refs: walk.frames,
      labels: walk.frames.map(() => null),
      footer: stopText(walk.stop)
    }
  };
}

/**
 * Spec 6.6 `:path`: `found` when one span is an ancestor of the other over resolved parents;
 * a ref into another trace is `no-path`; a chain that ends in `unknown(…)` or a dropped cycle
 * edge is `unknown-path(<reason>)`.
 */
function path(state: ViewState, model: TraceModel, fromToken: Token, toToken: Token): Outcome {
  const fromInput = spanRefFromToken(fromToken);
  const toInput = spanRefFromToken(toToken);
  if ("error" in fromInput) return fromInput;
  if ("error" in toInput) return toInput;
  const verdict = `${fromToken.text} → ${toToken.text}`;
  for (const input of [fromInput, toInput]) {
    if (input.kind === "full" && input.trace !== model.trace.id) {
      return { type: "showBanner", level: "info", text: `no-path: ${verdict} (different traces)` };
    }
  }
  const from = target(state, model, fromToken);
  if ("error" in from) return from;
  const to = target(state, model, toToken);
  if ("error" in to) return to;
  const down = ancestorsOf(model, to.ref);
  const up = ancestorsOf(model, from.ref);
  const inDown = down.frames.findIndex((ref) => sameKey(ref, from.ref));
  const inUp = up.frames.findIndex((ref) => sameKey(ref, to.ref));
  const chain = inDown !== -1 ? down.frames.slice(0, inDown + 1) : inUp !== -1 ? up.frames.slice(0, inUp + 1) : null;
  if (chain !== null) {
    const refs = [...chain].reverse();
    return {
      type: "showResults",
      results: {
        kind: "path",
        title: `path ${verdict}: found, ${refs.length - 1} edge(s)`,
        refs,
        labels: refs.map(() => null),
        footer: null
      }
    };
  }
  for (const walk of [down, up]) {
    if (walk.stop.kind === "unknown") {
      return { type: "showBanner", level: "info", text: `unknown-path(${walk.stop.reason}): ${verdict}` };
    }
    if (walk.stop.kind === "cycle") {
      return { type: "showBanner", level: "info", text: `unknown-path(cycle): ${verdict}` };
    }
  }
  return { type: "showBanner", level: "info", text: `no-path: ${verdict}` };
}

function sameKey(a: SpanRef, b: SpanRef): boolean {
  return a.trace === b.trace && a.session === b.session && a.id === b.id;
}

function where(span: SpanRow): string {
  return span.location === undefined ? "(no location)" : `${span.location.file}:${span.location.line}`;
}

/**
 * Spec 6.6 `:callers`: every span of the trace at the same `(location.file, location.line)` as
 * the ref (without a location: the same `name`). Their parents are grouped by `(name, file:line)`
 * of the parent with a count; parents that cannot be resolved are `(unknown parent)`, a true root
 * is `(root)`. Enter on a group jumps to its first parent (or its first call for the two markers).
 */
function callers(state: ViewState, model: TraceModel, token: Token | undefined): Outcome {
  const found = target(state, model, token);
  if ("error" in found) return found;
  const subject = model.get(found.ref)!;
  const location = subject.location;
  const calls: SpanRow[] = [];
  for (const ref of model.dfs()) {
    const span = model.get(ref);
    if (span === undefined) continue;
    const same =
      location === undefined
        ? span.name === subject.name
        : span.location !== undefined && span.location.file === location.file && span.location.line === location.line;
    if (same) calls.push(span);
  }
  const groups = new Map<string, { label: string; ref: SpanRef; count: number; first: number }>();
  calls.forEach((call, position) => {
    const parent = model.parentOf(call.ref);
    const parentSpan = parent.kind === "resolved" ? model.get(parent.ref) : undefined;
    const key =
      parentSpan !== undefined
        ? JSON.stringify([parentSpan.name, where(parentSpan)])
        : parent.kind === "root"
          ? "(root)"
          : "(unknown parent)";
    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      return;
    }
    groups.set(key, {
      label: parentSpan !== undefined ? `${parentSpan.name}  ${where(parentSpan)}` : key,
      ref: parentSpan !== undefined ? parentSpan.ref : call.ref,
      count: 1,
      first: position
    });
  });
  const sorted = [...groups.values()].sort((a, b) => b.count - a.count || a.first - b.first);
  return {
    type: "showResults",
    results: {
      kind: "callers",
      title: `callers of ${subject.name} at ${where(subject)}: ${calls.length} call(s), ${sorted.length} caller(s)`,
      refs: sorted.map((group) => group.ref),
      labels: sorted.map((group) => `${group.count}×  ${group.label}`),
      footer: null
    }
  };
}

/** Spec 6.6 `:find /re/[imsu]`: matches of `name` or `location.file`, in DFS order. */
function find(model: TraceModel, token: Token): Outcome {
  if (token.regex === undefined) return usage("find /regex/[imsu]");
  const regex = regexFromLiteral(token.text);
  if (!(regex instanceof RegExp)) return regex;
  const refs = model.dfs().filter((ref) => {
    const span = model.get(ref);
    return (
      span !== undefined && (regex.test(span.name) || (span.location !== undefined && regex.test(span.location.file)))
    );
  });
  return {
    type: "showResults",
    results: {
      kind: "find",
      title: `find ${token.text}: ${refs.length} match(es)`,
      refs,
      labels: refs.map(() => null),
      footer: refs.length === 0 ? "no matches" : null
    }
  };
}

/* ---------------------------------------------------------------- filters and areas */

function filter(model: TraceModel, args: readonly Token[]): Outcome {
  const [what, value, ...rest] = args;
  const usageText = "filter errors [on|off] | name /re/ | kind <glob> | area <x> | clear";
  if (what === undefined || rest.length > 0) return usage(usageText);
  switch (what.text) {
    case "errors":
      if (value === undefined) return { type: "toggleErrors" };
      if (value.text === "on") return { type: "setFilter", patch: { errorsOnly: true } };
      if (value.text === "off") return { type: "setFilter", patch: { errorsOnly: false } };
      return usage(usageText);
    case "name": {
      if (value === undefined || value.regex === undefined) return usage("filter name /re/");
      const regex = regexFromLiteral(value.text);
      return regex instanceof RegExp ? { type: "setFilter", patch: { name: value.text } } : regex;
    }
    case "kind":
      if (value === undefined || value.regex !== undefined) return usage("filter kind <glob>");
      return { type: "setFilter", patch: { kindGlob: value.text } };
    case "area": {
      if (value === undefined) return usage("filter area <x>");
      const key = areaFrom(model, value);
      return "error" in key ? key : { type: "setFilter", patch: { area: key } };
    }
    case "clear":
      return value === undefined ? { type: "clearFilters" } : usage(usageText);
    default:
      return usage(usageText);
  }
}

/** Same spelling as the Areas pane: `~module`, `module · feature`, `module`, `· feature`, `(unknown)`. */
function areaName(row: AreaKey): string {
  if (row.derived) return `~${row.module ?? ""}`;
  if (row.module !== null && row.feature !== null) return `${row.module} · ${row.feature}`;
  if (row.module !== null) return row.module;
  return row.feature !== null ? `· ${row.feature}` : "(unknown)";
}

/**
 * Spec 6.6 `:area <x>`: `feature` first, then `module`; `module:<x>` / `feature:<x>` pick the
 * field; `/re/` matches the same way. Several areas are not guessed between.
 */
function areaFrom(model: TraceModel, token: Token): AreaKey | CommandError {
  const rows = model.areas();
  let field: "feature" | "module" | null = null;
  let text = token.text;
  if (
    token.regex === undefined &&
    token.parts.length === 2 &&
    (token.parts[0] === "module" || token.parts[0] === "feature")
  ) {
    field = token.parts[0];
    text = token.parts[1]!;
  }
  let test: (value: string | null) => boolean;
  if (token.regex !== undefined) {
    const regex = regexFromLiteral(token.text);
    if (!(regex instanceof RegExp)) return regex;
    test = (value) => value !== null && regex.test(value);
  } else {
    test = (value) => value === text;
  }
  const byFeature = field === "module" ? [] : rows.filter((row) => test(row.feature));
  const matches = byFeature.length > 0 || field === "feature" ? byFeature : rows.filter((row) => test(row.module));
  if (matches.length === 0) return { error: `no area matches ${token.text}` };
  if (matches.length > 1) {
    return { error: `area ${token.text} matches ${matches.length} areas: ${matches.map(areaName).join(", ")}` };
  }
  const row: AreaRow = matches[0]!;
  return { module: row.module, feature: row.feature, derived: row.derived };
}
