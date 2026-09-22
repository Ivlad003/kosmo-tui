/**
 * `:` commands (design D12; trace-programmable-access "Scope, identity і семантика graph
 * queries" and "Тип результату визначає формат").
 *
 * A submitted line is run against the view state AS IT WAS at submit time: that state
 * is the pinned snapshot every query reads, so a delta arriving while `:find` runs in
 * its worker cannot change the answer half way through.
 *
 * Two families, never mixed:
 *  - view actions (`:seq`, `:depth`, `:trace`, `:q`, `:filter`, `:bookmark`) return
 *    reducer actions plus a one-line receipt. They never produce spans or documents.
 *  - query commands (`:ancestors`, `:path`, `:callers`, `:find`) return a typed result
 *    (a projection of spans that already exist in the loaded scope, a path verdict, or a
 *    table) with scope/coverage/truncation/missing-data metadata, shown in a pane.
 *
 * Graph questions go through the `GraphSelectors` port. `localGraphSelectors` is the
 * current adapter over stack.ts; the shared selectors of `@kosmo-callflow/query` (KC
 * task 1.8) replace it without touching the commands.
 *
 * `:find` runs the regex in a worker thread with a deadline (FIND_DEADLINE_MS, 2 s per
 * the spec). A catastrophic pattern such as `/(a+)+$/` on a long subject is terminated
 * and reported as `deadline-exceeded`; the UI thread never runs user regexes.
 */

import { Worker } from "node:worker_threads";
import { isBookmarked } from "./bookmarks.js";
import { checkCommand, type Command } from "./capabilities.js";
import {
  parseCommandLine,
  parseCount,
  parseSpanRef,
  parseTraceRef,
  type ParsedCommand,
  type SpanRefSpec,
  type Token
} from "./command-line.js";
import type { TraceSqlResult } from "@kosmo-callflow/query/sql";
import type { PairComparison } from "./compare.js";
import type { EvalEnvelope } from "./eval.js";
import type { SqlOutcome } from "./sql.js";
import type { ValueMatchResult } from "./values.js";
import { DEFAULT_STACK_DEPTH, ancestorChain, stopText, type AncestorChain, type StackOptions } from "./stack.js";
import {
  replaySeekIndex,
  spanKey,
  spanRefOf,
  traceKey,
  type Action,
  type Filters,
  type LoadedScope,
  type SpanRef,
  type SpanRow,
  type TraceRef,
  type ViewState
} from "./view-state.js";

/* ---------------------------------------------------------------- graph selectors */

export type RecordedCaller = { nodeId: string; calls: number };

export type RecordedCallers = {
  /** Direct recorded parents of spans of the node, by full parent ref; sorted by nodeId. */
  callers: RecordedCaller[];
  /** Spans of the node whose recorded parent is not loaded: counted nowhere, reported. */
  unknownParents: number;
};

/** Possible callers from the static graph. They were never observed and never counted. */
export type StaticCallers =
  { available: true; callers: Array<{ nodeId: string; provenance: string }> } | { available: false; reason: string };

export type UnknownPathReason = "retention" | "not-loaded" | "ambiguous" | "cycle" | "depth-limit";

export type PathOutcome =
  | { status: "found"; spans: SpanRow[] }
  /** Both endpoints are loaded and the recorded edges prove there is no path. */
  | { status: "no-path"; reason: "different-trace" | "not-an-ancestor" }
  /** The walk could not decide: data is missing or inconsistent. */
  | { status: "unknown-path"; reason: UnknownPathReason; at: SpanRef | null };

/**
 * The graph selectors the commands depend on. Recorded edges only, identity by full ref,
 * cycle and depth guards inside every walk.
 */
export interface GraphSelectors {
  ancestors(
    spans: readonly SpanRow[],
    target: SpanRef,
    options: StackOptions,
    targetRow: SpanRow | null
  ): AncestorChain | null;
  /** Directed causal path from `from` down to `to` over recorded parent edges. */
  path(spans: readonly SpanRow[], from: SpanRow, to: SpanRow, options: StackOptions): PathOutcome;
  recordedCallers(spans: readonly SpanRow[], nodeId: string): RecordedCallers;
  staticCallers(nodeId: string): StaticCallers;
}

/**
 * Local adapter until the shared selectors land in `@kosmo-callflow/query`: ancestors
 * and path walk stack.ts's recorded chain, recorded callers count full-ref parent edges,
 * and static callers are unavailable because no static-graph selector is exported yet.
 */
export const localGraphSelectors: GraphSelectors = {
  ancestors: (spans, target, options, targetRow) => ancestorChain(spans, target, options, targetRow),
  path(spans, from, to, options) {
    // Recorded parent edges never leave a trace; equal spanIds in another trace or
    // session are a coincidence, not an edge.
    if (traceKey(from) !== traceKey(to)) return { status: "no-path", reason: "different-trace" };
    const chain = ancestorChain(spans, to, options, to);
    if (chain === null) return { status: "unknown-path", reason: "not-loaded", at: spanRefOf(to) };
    const fromKey = spanKey(from);
    const index = chain.frames.findIndex((frame) => spanKey(frame) === fromKey);
    if (index !== -1) return { status: "found", spans: chain.frames.slice(0, index + 1).reverse() };
    const stop = chain.stop;
    switch (stop.kind) {
      case "root":
        return { status: "no-path", reason: "not-an-ancestor" };
      case "unknown":
        return { status: "unknown-path", reason: stop.reason, at: stop.parent };
      case "ambiguous":
        return { status: "unknown-path", reason: "ambiguous", at: stop.parent };
      case "cycle":
        return { status: "unknown-path", reason: "cycle", at: stop.at };
      case "depth-limit":
        return { status: "unknown-path", reason: "depth-limit", at: null };
    }
  },
  recordedCallers(spans, nodeId) {
    const byKey = new Map<string, SpanRow>();
    for (const row of spans) byKey.set(spanKey(row), row);
    const counts = new Map<string, number>();
    let unknownParents = 0;
    for (const row of byKey.values()) {
      if (row.nodeId !== nodeId || row.parentSpanId === null) continue;
      const parent = byKey.get(spanKey({ ...row, spanId: row.parentSpanId }));
      if (!parent) {
        unknownParents += 1;
        continue;
      }
      counts.set(parent.nodeId, (counts.get(parent.nodeId) ?? 0) + 1);
    }
    const callers = [...counts.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([caller, calls]) => ({ nodeId: caller, calls }));
    return { callers, unknownParents };
  },
  staticCallers: () => ({ available: false, reason: "no-static-graph-selector" })
};

/* ---------------------------------------------------------------- results */

export const DEPTH_LEVELS = ["app", "feature", "module", "symbol", "call"] as const;
export type DepthLevel = (typeof DEPTH_LEVELS)[number];

export type ResultMeta = {
  version: 1;
  /** What the query read: the loaded scope at submit time, not the whole dataset. */
  scope: { spans: number; traces: number; loaded: LoadedScope | null; retentionGap: boolean };
  coverage: "complete" | "partial";
  truncated: boolean;
  /** Why coverage is partial, in words; null when nothing is missing. */
  missing: string | null;
};

export type CommandErrorCode =
  "parse" | "unknown-command" | "usage" | "ambiguous-ref" | "unknown-ref" | "invalid-regex" | "sql";

export type CommandResult =
  | { kind: "receipt"; command: string; notice: string }
  | { kind: "unavailable"; command: string; reason: string; notice: string }
  | {
      kind: "error";
      command: string | null;
      code: CommandErrorCode;
      notice: string;
      available?: string[];
      /** An ambiguous short ref: the loaded refs it matched, as qualified refs. */
      candidates?: string[];
    }
  | { kind: "deadline-exceeded"; command: "find"; deadlineMs: number; notice: string }
  | {
      kind: "projection";
      command: "ancestors" | "find";
      title: string;
      /** Rows that exist in the loaded scope; nothing here is synthesised. */
      spans: SpanRow[];
      note: string | null;
      meta: ResultMeta;
    }
  | {
      kind: "path";
      status: "found";
      from: string;
      to: string;
      spans: SpanRow[];
      meta: ResultMeta;
    }
  | {
      kind: "path";
      status: "no-path";
      from: string;
      to: string;
      reason: "different-trace" | "not-an-ancestor";
      meta: ResultMeta;
    }
  | {
      kind: "path";
      status: "unknown-path";
      from: string;
      to: string;
      reason: UnknownPathReason;
      /** Which endpoint is unknown, or null when both are loaded and the walk stopped. */
      endpoint: "from" | "to" | null;
      at: SpanRef | null;
      meta: ResultMeta;
    }
  | {
      kind: "table";
      command: "callers";
      nodeId: string;
      recorded: RecordedCaller[];
      /** Only with `--static`; kept apart so possible edges never add to recorded counts. */
      static: StaticCallers | null;
      meta: ResultMeta;
    }
  /** `w`: equal-value candidates (values.ts); never presented as lineage. */
  | { kind: "values"; command: "values"; result: ValueMatchResult }
  /** `=`: explicit A/B pair comparison through the shared diffTraces (compare.ts). */
  | { kind: "compare"; command: "compare"; result: PairComparison }
  /** `:sql`: the shared runner's typed table (rows, never spans), with its own scope/coverage. */
  | { kind: "sql"; command: "sql"; query: string; result: TraceSqlResult }
  /** `:js`: a computed-local value from the trusted local eval child (eval.ts); never evidence. */
  | { kind: "value"; command: "js"; envelope: EvalEnvelope };

export type CommandOutcome = { actions: Action[]; result: CommandResult };

/* ---------------------------------------------------------------- :find worker */

/** Spec deadline for `:find`: 2 s wall time, enforced by terminating the worker. */
export const FIND_DEADLINE_MS = 2_000;
export const FIND_PATTERN_MAX = 256;
/** Rows searched at most; beyond this the result says it is truncated. */
export const FIND_INPUT_MAX_ROWS = 20_000;
/** Subjects longer than this are skipped (and counted) rather than cut, which could fake a match. */
export const FIND_SUBJECT_MAX = 4_096;
export const FIND_RESULT_MAX = 200;
/** Stateless flags only: `g`/`y` make `test` depend on the previous call. */
const FIND_FLAGS = /^[imsu]*$/;

export type FindRequest = { source: string; flags: string; subjects: string[]; deadlineMs: number };
export type FindRun =
  { status: "ok"; matches: number[] } | { status: "deadline-exceeded" } | { status: "error"; message: string };
export type FindRunner = (request: FindRequest) => Promise<FindRun>;

/**
 * The worker is an ES module loaded from a `data:` URL, so it behaves the same from the
 * TypeScript sources and from `dist` regardless of the host package's module type.
 */
const FIND_WORKER_SOURCE = `
import { parentPort, workerData } from "node:worker_threads";
try {
  const re = new RegExp(workerData.source, workerData.flags);
  const matches = [];
  for (let i = 0; i < workerData.subjects.length; i++) {
    if (re.test(workerData.subjects[i])) matches.push(i);
  }
  parentPort.postMessage({ status: "ok", matches });
} catch (error) {
  parentPort.postMessage({ status: "error", message: String((error && error.message) || error) });
}
`;
const FIND_WORKER_URL = new URL(`data:text/javascript,${encodeURIComponent(FIND_WORKER_SOURCE)}`);

/** Run the regex off the UI thread; past the deadline the worker is terminated mid-match. */
export function runRegexInWorker(request: FindRequest): Promise<FindRun> {
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(FIND_WORKER_URL, {
      workerData: { source: request.source, flags: request.flags, subjects: request.subjects },
      resourceLimits: { maxOldGenerationSizeMb: 64 }
    });
    const finish = (run: FindRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(run);
    };
    const timer = setTimeout(() => finish({ status: "deadline-exceeded" }), request.deadlineMs);
    worker.once("message", (message: FindRun) => finish(message));
    worker.once("error", (error: Error) => finish({ status: "error", message: error.message }));
    worker.once("exit", (code: number) => finish({ status: "error", message: `find worker exited (${code})` }));
  });
}

/* ---------------------------------------------------------------- dispatch */

export type CommandDeps = {
  selectors?: GraphSelectors;
  find?: FindRunner;
  findDeadlineMs?: number;
  maxDepth?: number;
  /**
   * The host can pin a replay from live at a seq cutoff (session.ts does). Without it,
   * `:seq` outside a replay session is refused rather than answered with a receipt for
   * a seek nothing will perform.
   */
  liveSeek?: boolean;
  /**
   * `:sql` over the pinned SQLite snapshot (sql.ts `sqlPortForSource`). Only a sqlite
   * source provides it; without it `:sql` is unavailable instead of opening another DB.
   */
  sql?: (query: string) => Promise<SqlOutcome>;
};

type Context = {
  state: ViewState;
  command: ParsedCommand;
  selectors: GraphSelectors;
  deps: CommandDeps;
};

type CommandSpec = {
  usage: string;
  /** Capability-gated command this one needs, checked with checkCommand. */
  requires: Command;
  run(context: Context): CommandOutcome | Promise<CommandOutcome>;
};

const COMMANDS: Record<string, CommandSpec> = {
  seq: { usage: ":seq <n>", requires: "seek", run: runSeq },
  depth: { usage: `:depth <${DEPTH_LEVELS.join("|")}>`, requires: "depth", run: runDepth },
  trace: { usage: ":trace <trace-ref>", requires: "commandLine", run: runTrace },
  q: {
    usage: ":q",
    requires: "commandLine",
    run: () => ({ actions: [{ kind: "quit" }], result: receipt("q", "quit") })
  },
  ancestors: { usage: ":ancestors [span-ref]", requires: "commandLine", run: runAncestors },
  path: { usage: ":path <from-ref> <to-ref>", requires: "commandLine", run: runPath },
  callers: { usage: ":callers [nodeId] [--static]", requires: "commandLine", run: runCallers },
  find: { usage: ":find /regex/[imsu]", requires: "commandLine", run: runFind },
  filter: {
    usage: ":filter errors [on|off] | node <id> | kind <kind> | clear",
    requires: "commandLine",
    run: runFilter
  },
  bookmark: { usage: ":bookmark [list]", requires: "bookmark", run: runBookmark },
  // The query is taken verbatim by runCommandLine before tokenizing (see rawSqlQuery).
  sql: { usage: ":sql <select statement>", requires: "sql", run: () => usage("sql") }
};

export const COMMAND_NAMES = Object.keys(COMMANDS);

/** Command names the session can serve now, for the unknown-command answer. */
export function availableCommands(state: ViewState): string[] {
  return COMMAND_NAMES.filter((name) => state.caps === null || checkCommand(state.caps, COMMANDS[name]!.requires).ok);
}

/**
 * Run one submitted `:` line against `state`. Resolves to null for a blank line. Never
 * throws for user input: every refusal is a typed result with a notice.
 */
export async function runCommandLine(
  state: ViewState,
  line: string,
  deps: CommandDeps = {}
): Promise<CommandOutcome | null> {
  const sqlQuery = rawSqlQuery(line);
  if (sqlQuery !== null) return runSqlLine(state, sqlQuery, deps);
  const parsed = parseCommandLine(line);
  if (parsed.ok === "empty") return null;
  if (!parsed.ok) return fail(null, "parse", `parse error: ${parsed.error}`);
  const { command } = parsed;
  const spec = Object.prototype.hasOwnProperty.call(COMMANDS, command.name) ? COMMANDS[command.name] : undefined;
  if (!spec) {
    const available = availableCommands(state);
    return {
      actions: [],
      result: {
        kind: "error",
        command: command.name,
        code: "unknown-command",
        available,
        notice: `unknown command: ${command.name}; available: ${available.map((name) => `:${name}`).join(" ")}`
      }
    };
  }
  if (state.caps !== null) {
    const check = checkCommand(state.caps, spec.requires);
    if (!check.ok) return unavailable(command.name, check.reason);
  }
  return spec.run({ state, command, selectors: deps.selectors ?? localGraphSelectors, deps });
}

/**
 * `:sql` takes the rest of the line verbatim: SQL quotes, `;` inside literals and `--`
 * comments are SQL syntax, not command-line quoting or flags. Null for any other line.
 */
function rawSqlQuery(line: string): string | null {
  const match = /^\s*:?\s*sql(?:[ \t]+([\s\S]*))?$/.exec(line);
  return match ? (match[1] ?? "").trim() : null;
}

async function runSqlLine(state: ViewState, query: string, deps: CommandDeps): Promise<CommandOutcome> {
  if (state.caps !== null) {
    const check = checkCommand(state.caps, "sql");
    if (!check.ok) return unavailable("sql", check.reason);
  }
  if (query === "") return usage("sql");
  if (deps.sql === undefined) return unavailable("sql", "sql-needs-sqlite-source");
  const outcome = await deps.sql(query);
  if (!outcome.ok) {
    const reason = outcome.reason === undefined ? "" : `(${outcome.reason})`;
    return fail("sql", "sql", `sql: ${outcome.code}${reason}: ${outcome.message}`);
  }
  return { actions: [], result: { kind: "sql", command: "sql", query, result: outcome.result } };
}

/* ---------------------------------------------------------------- view actions */

function runSeq({ state, command, deps }: Context): CommandOutcome {
  const [arg] = command.args;
  const seq = arg ? parseCount(arg.text) : null;
  if (seq === null) return usage("seq");
  const session = state.replay;
  if (session === null) {
    if (!deps.liveSeek) return unavailable("seq", "no-replay-session");
    return {
      actions: [{ kind: "replaySeek", seq }],
      result: receipt("seq", `seq <= ${seq}: pinning the recorded state at cutoff ${seq}`)
    };
  }
  const index = replaySeekIndex(session.timeline, seq);
  if (index === -1) {
    const first = session.timeline.frames[0];
    return fail(
      "seq",
      "usage",
      first ? `seq ${seq}: precedes the first recorded frame (seq ${first.seq})` : `seq ${seq}: no recorded frames`
    );
  }
  const frame = session.timeline.frames[index]!;
  return {
    actions: [{ kind: "replaySeek", seq }],
    result: receipt(
      "seq",
      `seq <= ${seq}: frame ${index + 1}/${session.timeline.frames.length} (recorded seq ${frame.seq})`
    )
  };
}

function runDepth({ state, command }: Context): CommandOutcome {
  const level = command.args[0]?.text;
  if (!level || !(DEPTH_LEVELS as readonly string[]).includes(level)) return usage("depth");
  // Depth levels are a projection-v2 concept; a v1-only source has nothing to group by.
  if (state.caps !== null && !state.caps.projectionVersions.includes(2)) {
    return unavailable("depth", "depth-needs-projection-v2");
  }
  return {
    actions: [{ kind: "setDepth", level: level as DepthLevel }],
    result: receipt("depth", `depth: ${level}`)
  };
}

function runTrace({ state, command }: Context): CommandOutcome {
  const [arg] = command.args;
  if (!arg) return usage("trace");
  const parsed = parseTraceRef(arg);
  if (!parsed.ok) return fail("trace", "usage", `trace: ${parsed.error}`);
  const matched = matchLoaded(state, parsed.spec, null);
  if (matched.kind === "ambiguous") {
    return ambiguous(
      "trace",
      `trace ${arg.text}`,
      matched.candidates.map((row) => qualifiedTrace(row, matched.candidates))
    );
  }
  if (matched.kind === "none") {
    return fail(
      "trace",
      "unknown-ref",
      `trace ${arg.text}: unknown(${state.retentionGap ? "retention" : "not-loaded"})`
    );
  }
  const ref = matched.ref;
  const key = traceKey(ref);
  const spans = state.spans.filter((row) => traceKey(row) === key);
  if (spans.length === 0) return fail("trace", "unknown-ref", `trace ${arg.text}: no spans loaded for this trace`);
  const root = [...spans].sort(
    (left, right) =>
      Number(left.parentSpanId !== null) - Number(right.parentSpanId !== null) ||
      left.depth - right.depth ||
      left.spanId.localeCompare(right.spanId)
  )[0]!;
  return {
    actions: [{ kind: "selectRef", ref: spanRefOf(root) }],
    result: receipt("trace", `trace ${ref.traceId}: selected ${root.nodeId}`)
  };
}

function runFilter({ state, command }: Context): CommandOutcome {
  const [sub, value] = command.args.map((token) => token.text);
  let action: Extract<Action, { kind: "setFilter" }>;
  switch (sub) {
    case "errors": {
      if (value !== undefined && value !== "on" && value !== "off") return usage("filter");
      action = { kind: "setFilter", errorsOnly: value !== "off" };
      break;
    }
    case "node":
      action = { kind: "setFilter", nodeId: value ?? null };
      break;
    case "kind":
      action = { kind: "setFilter", spanKind: value ?? null };
      break;
    case "clear":
      action = { kind: "setFilter", errorsOnly: false, nodeId: null, spanKind: null, search: null };
      break;
    default:
      return usage("filter");
  }
  const next: Filters = {
    ...state.filters,
    ...(action.errorsOnly !== undefined ? { errorsOnly: action.errorsOnly } : {}),
    ...(action.nodeId !== undefined ? { nodeId: action.nodeId || null } : {}),
    ...(action.spanKind !== undefined ? { spanKind: action.spanKind || null } : {}),
    ...(action.search !== undefined ? { search: action.search || null } : {})
  };
  const parts = [
    next.errorsOnly ? "errors-only" : null,
    next.search ? `search="${next.search}"` : null,
    next.nodeId ? `node=${next.nodeId}` : null,
    next.spanKind ? `kind=${next.spanKind}` : null
  ].filter((part): part is string => part !== null);
  const text = parts.length === 0 ? "filter: none" : `filter: ${parts.join(" ")} (over the loaded scope)`;
  return { actions: [action], result: receipt("filter", text) };
}

function runBookmark({ state, command }: Context): CommandOutcome {
  const sub = command.args[0]?.text;
  if (sub === "list") {
    if (state.bookmarks.length === 0)
      return fail("bookmark", "usage", "bookmarks: none yet (:bookmark marks the selection)");
    return {
      actions: [{ kind: "openBookmarks" }],
      result: receipt("bookmark", `bookmarks: ${state.bookmarks.length} (j/k move, enter jump)`)
    };
  }
  if (sub !== undefined) return usage("bookmark");
  if (!state.selection) return fail("bookmark", "usage", "bookmark: nothing selected");
  const row = loadedRowOrLastKnown(state, state.selection);
  if (!row) return fail("bookmark", "unknown-ref", "bookmark: selected span is not loaded");
  const marked = isBookmarked(state.bookmarks, row);
  return {
    actions: [{ kind: "bookmark" }],
    result: receipt("bookmark", marked ? "bookmark removed" : "bookmark set")
  };
}

/* ---------------------------------------------------------------- queries */

function runAncestors({ state, command, selectors, deps }: Context): CommandOutcome {
  const [arg] = command.args;
  const resolved = resolveSpan(state, arg ? parseSpanRef(arg) : { ok: true, spec: { kind: "selection" } }, arg);
  if (resolved.kind === "error") return failRef("ancestors", resolved);
  const ref = resolved.kind === "loaded" ? spanRefOf(resolved.row) : resolved.ref;
  const targetRow = resolved.kind === "loaded" ? resolved.row : loadedRowOrLastKnown(state, ref);
  const chain = selectors.ancestors(
    state.spans,
    ref,
    { retentionGap: state.retentionGap, maxDepth: deps.maxDepth ?? DEFAULT_STACK_DEPTH },
    targetRow
  );
  if (chain === null) {
    const reason = resolved.kind === "unknown" ? resolved.reason : "not-loaded";
    return {
      actions: [],
      result: {
        kind: "projection",
        command: "ancestors",
        title: `ancestors of ${ref.spanId}: target unknown(${reason})`,
        spans: [],
        note: null,
        meta: meta(state, "partial", false, `target span unknown(${reason})`)
      }
    };
  }
  const partial = chain.coverage === "partial";
  return {
    actions: [],
    result: {
      kind: "projection",
      command: "ancestors",
      title: `ancestors of ${chain.frames[0]!.nodeId} (recorded parent edges, target first)`,
      spans: chain.frames,
      note: stopText(chain.stop),
      meta: meta(state, chain.coverage, chain.stop.kind === "depth-limit", partial ? stopText(chain.stop) : null)
    }
  };
}

function runPath({ state, command, selectors, deps }: Context): CommandOutcome {
  const [fromToken, toToken] = command.args;
  if (!fromToken || !toToken || command.args.length > 2) return usage("path");
  const from = resolveSpan(state, parseSpanRef(fromToken), fromToken);
  if (from.kind === "error") return failRef("path", from);
  const to = resolveSpan(state, parseSpanRef(toToken), toToken);
  if (to.kind === "error") return failRef("path", to);
  const texts = { from: fromToken.text, to: toToken.text };
  // An endpoint that is not loaded makes the question undecidable, never "no path".
  for (const [endpoint, side] of [
    ["from", from],
    ["to", to]
  ] as const) {
    if (side.kind === "unknown") {
      return {
        actions: [],
        result: {
          kind: "path",
          status: "unknown-path",
          ...texts,
          reason: side.reason,
          endpoint,
          at: side.ref,
          meta: meta(state, "partial", false, `${endpoint} endpoint unknown(${side.reason})`)
        }
      };
    }
  }
  if (from.kind !== "loaded" || to.kind !== "loaded") throw new Error("unreachable");
  const outcome = selectors.path(state.spans, from.row, to.row, {
    retentionGap: state.retentionGap,
    maxDepth: deps.maxDepth ?? DEFAULT_STACK_DEPTH
  });
  switch (outcome.status) {
    case "found":
      return {
        actions: [],
        result: {
          kind: "path",
          status: "found",
          ...texts,
          spans: outcome.spans,
          meta: meta(state, "complete", false, null)
        }
      };
    case "no-path":
      return {
        actions: [],
        result: {
          kind: "path",
          status: "no-path",
          ...texts,
          reason: outcome.reason,
          meta: meta(state, "complete", false, null)
        }
      };
    case "unknown-path":
      return {
        actions: [],
        result: {
          kind: "path",
          status: "unknown-path",
          ...texts,
          reason: outcome.reason,
          endpoint: null,
          at: outcome.at,
          meta: meta(state, "partial", outcome.reason === "depth-limit", `walk stopped: ${outcome.reason}`)
        }
      };
  }
}

function runCallers({ state, command, selectors }: Context): CommandOutcome {
  const unknownFlag = [...command.flags].find((flag) => flag !== "static");
  if (unknownFlag !== undefined || command.args.length > 1) return usage("callers");
  const wantStatic = command.flags.has("static");
  if (wantStatic && state.caps !== null) {
    const check = checkCommand(state.caps, "staticCallers");
    if (!check.ok) return unavailable("callers --static", check.reason);
  }
  const [arg] = command.args;
  let nodeId: string;
  if (arg && !(arg.text === "." && !arg.quoted)) {
    nodeId = arg.text;
  } else {
    const row = state.selection ? loadedRowOrLastKnown(state, state.selection) : null;
    if (!row) return fail("callers", "usage", "callers: nothing selected; give a nodeId");
    nodeId = row.nodeId;
  }
  const recorded = selectors.recordedCallers(state.spans, nodeId);
  const partial = recorded.unknownParents > 0 || state.retentionGap;
  const missing =
    recorded.unknownParents > 0
      ? `${recorded.unknownParents} call(s) of ${nodeId} have a parent that is not loaded`
      : state.retentionGap
        ? "retention dropped data from this view"
        : null;
  return {
    actions: [],
    result: {
      kind: "table",
      command: "callers",
      nodeId,
      recorded: recorded.callers,
      static: wantStatic ? selectors.staticCallers(nodeId) : null,
      meta: meta(state, partial ? "partial" : "complete", false, missing)
    }
  };
}

async function runFind({ state, command, deps }: Context): Promise<CommandOutcome> {
  const [arg] = command.args;
  if (!arg?.regex || command.args.length > 1) return usage("find");
  const { source, flags } = arg.regex;
  if (source.length === 0 || source.length > FIND_PATTERN_MAX) {
    return fail("find", "usage", `find: pattern must be 1..${FIND_PATTERN_MAX} characters`);
  }
  if (!FIND_FLAGS.test(flags)) return fail("find", "usage", `find: unsupported flags "${flags}" (allowed: i m s u)`);
  try {
    new RegExp(source, flags);
  } catch (error) {
    return fail("find", "invalid-regex", `find: invalid regex: ${(error as Error).message}`);
  }
  const ordered = [...state.spans].sort(
    (left, right) =>
      traceKey(left).localeCompare(traceKey(right)) ||
      left.depth - right.depth ||
      spanKey(left).localeCompare(spanKey(right))
  );
  const inputTruncated = ordered.length > FIND_INPUT_MAX_ROWS;
  const candidates = ordered.slice(0, FIND_INPUT_MAX_ROWS);
  const searched = candidates.filter((row) => row.nodeId.length <= FIND_SUBJECT_MAX);
  const skipped = candidates.length - searched.length;
  const deadlineMs = deps.findDeadlineMs ?? FIND_DEADLINE_MS;
  const run = await (deps.find ?? runRegexInWorker)({
    source,
    flags,
    subjects: searched.map((row) => row.nodeId),
    deadlineMs
  });
  if (run.status === "deadline-exceeded") {
    return {
      actions: [],
      result: {
        kind: "deadline-exceeded",
        command: "find",
        deadlineMs,
        notice: `find ${arg.text}: deadline-exceeded(${deadlineMs}ms); no partial matches shown`
      }
    };
  }
  if (run.status === "error") return fail("find", "invalid-regex", `find: ${run.message}`);
  const matched = run.matches.map((index) => searched[index]!).filter(Boolean);
  const shown = matched.slice(0, FIND_RESULT_MAX);
  const truncated = inputTruncated || matched.length > shown.length;
  const missing = [
    inputTruncated ? `only the first ${FIND_INPUT_MAX_ROWS} loaded spans were searched` : null,
    skipped > 0 ? `${skipped} span(s) with a nodeId over ${FIND_SUBJECT_MAX} chars skipped` : null
  ].filter((part): part is string => part !== null);
  return {
    actions: [],
    result: {
      kind: "projection",
      command: "find",
      title: `find ${arg.text} on nodeId: ${matched.length} match(es) in ${searched.length} loaded span(s)`,
      spans: shown,
      note: matched.length > shown.length ? `showing the first ${shown.length}` : null,
      meta: meta(
        state,
        missing.length > 0 ? "partial" : "complete",
        truncated,
        missing.length > 0 ? missing.join("; ") : null
      )
    }
  };
}

/* ---------------------------------------------------------------- refs */

type Resolved =
  | { kind: "loaded"; row: SpanRow }
  | { kind: "unknown"; ref: SpanRef; reason: "retention" | "not-loaded" }
  | { kind: "error"; code: CommandErrorCode; message: string; candidates?: string[] };

const IDENTITY_FIELDS = ["datasetId", "projectId", "sessionId", "traceId"] as const;

/**
 * The current context for short refs: the selected span's trace, or failing that, any
 * field every loaded row agrees on. A field with more than one loaded value is left
 * out, so a short ref over it is refused rather than guessed.
 */
function contextOf(state: ViewState): Partial<TraceRef> {
  if (state.selection) {
    const { datasetId, projectId, sessionId, traceId } = state.selection;
    return { datasetId, projectId, sessionId, traceId };
  }
  const rows: TraceRef[] = [...state.traces, ...state.spans];
  const context: Partial<TraceRef> = {};
  for (const field of IDENTITY_FIELDS) {
    const values = new Set(rows.map((row) => row[field]));
    if (values.size === 1) context[field] = [...values][0]!;
  }
  return context;
}

function firstMissing(ref: Partial<TraceRef>): string | null {
  for (const field of IDENTITY_FIELDS) if (ref[field] === undefined) return field.replace(/Id$/, "");
  return null;
}

function resolveSpan(
  state: ViewState,
  parsed: { ok: true; spec: SpanRefSpec } | { ok: false; error: string },
  token: Token | undefined
): Resolved {
  if (!parsed.ok) return { kind: "error", code: "usage", message: parsed.error };
  const { spec } = parsed;
  if (spec.kind === "selection") {
    if (!state.selection) return { kind: "error", code: "usage", message: "nothing selected; give a span ref" };
    return lookup(state, spanRefOf(state.selection));
  }
  const given = {
    datasetId: spec.datasetId,
    projectId: spec.projectId,
    sessionId: spec.sessionId,
    traceId: spec.traceId
  };
  if (firstMissing(given) === null) return lookup(state, { ...(given as TraceRef), spanId: spec.spanId });
  const matched = matchLoaded(state, given, spec.spanId);
  if (matched.kind === "ambiguous") {
    const text = token?.text ?? spec.spanId;
    const candidates = matched.candidates.map((row) => `${qualifiedTrace(row, matched.candidates)}:${spec.spanId}`);
    return {
      kind: "error",
      code: "ambiguous-ref",
      message: `ref ${text} matches ${candidates.length} loaded spans (${candidates.join(", ")}); qualify it as session:trace:span or dataset:project:session:trace:span`,
      candidates
    };
  }
  if (matched.kind === "one") return lookup(state, { ...matched.ref, spanId: spec.spanId });
  // Nothing loaded matches. Inside a known context the ref names a concrete span that is
  // not loaded (or gone to retention); without one it cannot even be named.
  const context = contextOf(state);
  const full = {
    datasetId: given.datasetId ?? context.datasetId,
    projectId: given.projectId ?? context.projectId,
    sessionId: given.sessionId ?? context.sessionId,
    traceId: given.traceId ?? context.traceId
  };
  if (firstMissing(full) === null) return lookup(state, { ...(full as TraceRef), spanId: spec.spanId });
  return {
    kind: "error",
    code: "unknown-ref",
    message: `ref ${token?.text ?? spec.spanId}: unknown(${state.retentionGap ? "retention" : "not-loaded"})`
  };
}

type Matched = { kind: "one"; ref: TraceRef } | { kind: "ambiguous"; candidates: TraceRef[] } | { kind: "none" };

/**
 * A short ref is matched against the LOADED rows on only the fields it gives: exactly one
 * matching trace resolves it, whatever session is selected. When several match, the
 * current context (the selected trace) breaks the tie if it leaves exactly one; otherwise
 * the ref is ambiguous and the matches are named. `spanId` restricts the match to traces
 * holding that span; null matches trace rows and span rows alike.
 */
function matchLoaded(state: ViewState, given: Partial<TraceRef>, spanId: string | null): Matched {
  const fits = (row: TraceRef): boolean =>
    IDENTITY_FIELDS.every((field) => given[field] === undefined || row[field] === given[field]);
  const found = new Map<string, TraceRef>();
  const add = (row: TraceRef): void => {
    if (!fits(row)) return;
    const key = traceKey(row);
    if (!found.has(key)) {
      const { datasetId, projectId, sessionId, traceId } = row;
      found.set(key, { datasetId, projectId, sessionId, traceId });
    }
  };
  for (const row of state.spans) if (spanId === null || row.spanId === spanId) add(row);
  if (spanId === null) for (const row of state.traces) add(row);
  const all = [...found.values()];
  if (all.length === 0) return { kind: "none" };
  if (all.length === 1) return { kind: "one", ref: all[0]! };
  const context = contextOf(state);
  const preferred = all.filter((row) =>
    IDENTITY_FIELDS.every(
      (field) => given[field] !== undefined || context[field] === undefined || row[field] === context[field]
    )
  );
  if (preferred.length === 1) return { kind: "one", ref: preferred[0]! };
  const candidates = all.sort((left, right) => traceKey(left).localeCompare(traceKey(right)));
  return { kind: "ambiguous", candidates };
}

/** `session:trace`, or the full `dataset:project:session:trace` when the candidates span datasets/projects. */
function qualifiedTrace(row: TraceRef, among: TraceRef[]): string {
  const mixed = among.some((other) => other.datasetId !== row.datasetId || other.projectId !== row.projectId);
  return mixed
    ? `${row.datasetId}:${row.projectId}:${row.sessionId}:${row.traceId}`
    : `${row.sessionId}:${row.traceId}`;
}

function ambiguous(command: string, subject: string, candidates: string[]): CommandOutcome {
  return {
    actions: [],
    result: {
      kind: "error",
      command,
      code: "ambiguous-ref",
      notice: `${subject} matches ${candidates.length} loaded refs (${candidates.join(", ")}); qualify it as session:trace or dataset:project:session:trace`,
      candidates
    }
  };
}

function lookup(state: ViewState, ref: SpanRef): Resolved {
  const key = spanKey(ref);
  const row = state.spans.find((candidate) => spanKey(candidate) === key);
  if (row) return { kind: "loaded", row };
  const trace = traceKey(ref);
  const traceLoaded = state.traces.some((candidate) => traceKey(candidate) === trace);
  // A trace still loaded without the span means the row was evicted: not loaded now.
  return { kind: "unknown", ref, reason: !traceLoaded && state.retentionGap ? "retention" : "not-loaded" };
}

function loadedRowOrLastKnown(state: ViewState, ref: SpanRef): SpanRow | null {
  const key = spanKey(ref);
  return (
    state.spans.find((candidate) => spanKey(candidate) === key) ??
    (state.lastKnownSpan && spanKey(state.lastKnownSpan) === key ? state.lastKnownSpan : null)
  );
}

/* ---------------------------------------------------------------- helpers */

function meta(
  state: ViewState,
  coverage: ResultMeta["coverage"],
  truncated: boolean,
  missing: string | null
): ResultMeta {
  const traces = new Set([...state.traces, ...state.spans].map(traceKey)).size;
  return {
    version: 1,
    scope: { spans: state.spans.length, traces, loaded: state.scope, retentionGap: state.retentionGap },
    coverage,
    truncated: truncated || (state.scope?.truncated ?? false),
    missing
  };
}

function receipt(command: string, notice: string): CommandResult {
  return { kind: "receipt", command, notice };
}

function unavailable(command: string, reason: string): CommandOutcome {
  return {
    actions: [],
    result: { kind: "unavailable", command, reason, notice: `:${command}: unavailable(${reason})` }
  };
}

function fail(command: string | null, code: CommandErrorCode, notice: string): CommandOutcome {
  return { actions: [], result: { kind: "error", command, code, notice } };
}

function failRef(command: string, resolved: Extract<Resolved, { kind: "error" }>): CommandOutcome {
  const outcome = fail(command, resolved.code, `${command}: ${resolved.message}`);
  if (resolved.candidates !== undefined && outcome.result.kind === "error")
    outcome.result.candidates = resolved.candidates;
  return outcome;
}

function usage(name: string): CommandOutcome {
  return fail(name, "usage", `usage: ${COMMANDS[name]!.usage}`);
}
