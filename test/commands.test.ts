/**
 * Task 5b.1: `:` command semantics. View actions change view state and answer with a
 * receipt, never spans; queries return typed results over the loaded scope with
 * coverage. "no-path" (both endpoints known, the recorded graph proves none) and
 * "unknown-path" (an endpoint or a link is missing) are different answers; static
 * callers are labelled possible and never counted as recorded; `:find` runs in a worker
 * with a deadline, so a catastrophic regex returns deadline-exceeded instead of hanging.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { Capabilities } from "../src/capabilities.js";
import {
  FIND_DEADLINE_MS,
  localGraphSelectors,
  runCommandLine,
  runRegexInWorker,
  type CommandOutcome,
  type CommandResult,
  type GraphSelectors
} from "../src/commands.js";
import { commandResultLines } from "../src/panes.js";
import {
  applyAction,
  applyDelta,
  initialViewState,
  type ReplaySession,
  type SpanRow,
  type ViewState
} from "../src/view-state.js";
import { connected, ref, span, trace } from "./view-fixtures.js";

function caps(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    projectionVersions: [1, 2],
    projection: { available: true },
    follow: { available: true },
    replay: { available: true },
    values: { available: true, level: "full" },
    probes: { available: true },
    staticGraph: { available: true },
    sql: { available: true },
    reload: { available: true },
    review: { available: true },
    localEval: { available: true },
    interactive: { available: true },
    ...overrides
  };
}

/**
 * root -> mid -> leaf, root -> sib in t-1 (session s-1), plus t-2 and a second session
 * s-2 whose trace reuses the id t-1 and the span ids root/mid.
 */
function rows(): SpanRow[] {
  return [
    span("t-1", "root", { nodeId: "src/api.ts#handle" }),
    span("t-1", "mid", { parentSpanId: "root", depth: 1, nodeId: "src/svc.ts#run" }),
    span("t-1", "leaf", { parentSpanId: "mid", depth: 2, nodeId: "src/db.ts#query" }),
    span("t-1", "sib", { parentSpanId: "root", depth: 1, nodeId: "src/db.ts#query", errored: true }),
    span("t-2", "root", { nodeId: "src/api.ts#handle" }),
    span("t-2", "leaf", { parentSpanId: "root", depth: 1, nodeId: "src/db.ts#query" }),
    { ...span("t-1", "root", { nodeId: "src/other.ts#main" }), sessionId: "s-2" },
    { ...span("t-1", "mid", { parentSpanId: "root", depth: 1, nodeId: "src/svc.ts#run" }), sessionId: "s-2" }
  ];
}

function seeded(overrides: Partial<ViewState> = {}, spans: SpanRow[] = rows()): ViewState {
  let state = initialViewState({ caps: caps(), ...overrides });
  state = applyDelta(state, connected());
  state = applyDelta(state, {
    kind: "traces",
    rows: [trace("t-1", 2), trace("t-2", 1), trace("t-1", 3, "complete", "s-2")]
  });
  state = applyDelta(state, { kind: "spans", rows: spans });
  return { ...state, selection: ref("t-1", "leaf") };
}

async function run(state: ViewState, line: string, deps = {}): Promise<CommandOutcome> {
  const outcome = await runCommandLine(state, line, deps);
  if (outcome === null) throw new Error("blank line");
  return outcome;
}

async function result(state: ViewState, line: string, deps = {}): Promise<CommandResult> {
  return (await run(state, line, deps)).result;
}

function applyOutcome(state: ViewState, outcome: CommandOutcome): ViewState {
  let next = state;
  for (const action of outcome.actions) next = applyAction(next, action);
  return applyAction(next, { kind: "commandResult", result: outcome.result });
}

function replaySession(): ReplaySession {
  const frame = (seq: number, spanIds: string[]) => ({
    seq,
    sessionId: "s-1",
    clockDomain: null,
    granularity: "per-call" as const,
    state: { traces: [trace("t-1", 1)], spans: spanIds.map((id) => span("t-1", id)) }
  });
  return {
    timeline: {
      frames: [frame(10, ["a"]), frame(20, ["a", "b"]), frame(30, ["a", "b", "c"])],
      missingSeqs: [],
      alignment: { kind: "unaligned", reason: "test" },
      windowOnly: false
    },
    schedule: { mode: "manual" },
    index: 0
  };
}

describe("parser front door", () => {
  it("(eval ...) is an unknown command, never evaluated, and the answer lists available commands", async () => {
    const answer = await result(seeded(), "(eval (process.exit))");
    expect(answer).toMatchObject({ kind: "error", code: "unknown-command" });
    if (answer.kind !== "error") return;
    expect(answer.available).toContain("ancestors");
    expect(answer.notice).toContain(":path");
  });

  it("the available list follows the capabilities", async () => {
    const state = seeded({ caps: caps({ replay: { available: false, reason: "no-replay-records" } }) });
    const answer = await result(state, "nope");
    if (answer.kind !== "error") throw new Error("expected error");
    expect(answer.available).not.toContain("seq");
    expect(answer.available).toContain("find");
  });

  it("a parse error is reported, not guessed around", async () => {
    expect(await result(seeded(), "path 'a b")).toMatchObject({ kind: "error", code: "parse" });
  });

  it("a blank line does nothing", async () => {
    expect(await runCommandLine(seeded(), "  ")).toBeNull();
  });

  it("commands whose capability is missing answer unavailable(reason) via checkCommand", async () => {
    const state = seeded({ caps: caps({ replay: { available: false, reason: "no-replay-records" } }) });
    expect(await result(state, "seq 3")).toEqual({
      kind: "unavailable",
      command: "seq",
      reason: "no-replay-records",
      notice: ":seq: unavailable(no-replay-records)"
    });
    const noProjection = seeded({ caps: caps({ projection: { available: false, reason: "v1-summary-stream" } }) });
    expect(await result(noProjection, "depth feature")).toMatchObject({
      kind: "unavailable",
      reason: "v1-summary-stream"
    });
  });
});

describe("view actions: receipts, never spans", () => {
  it(":seq N seeks the replay to the last frame at or before N", async () => {
    const state = seeded({ replay: replaySession() });
    const outcome = await run(state, "seq 25");
    expect(outcome.result).toEqual({
      kind: "receipt",
      command: "seq",
      notice: "seq <= 25: frame 2/3 (recorded seq 20)"
    });
    const next = applyOutcome(state, outcome);
    expect(next.replay?.index).toBe(1);
    expect(next.spans.map((row) => row.spanId)).toEqual(["a", "b"]);
    expect(next.commandResult).toBeNull();
    expect(next.notice).toBe("seq <= 25: frame 2/3 (recorded seq 20)");
  });

  it(":seq before the first frame, without replay, or with a bad number is refused", async () => {
    expect(await result(seeded({ replay: replaySession() }), "seq 5")).toMatchObject({ kind: "error" });
    expect(await result(seeded(), "seq 5")).toMatchObject({ kind: "unavailable", reason: "no-replay-session" });
    // A host that pins replay from live (the session) gets the seek action instead.
    expect(await run(seeded(), "seq 5", { liveSeek: true })).toMatchObject({
      actions: [{ kind: "replaySeek", seq: 5 }],
      result: { kind: "receipt" }
    });
    expect(await result(seeded({ replay: replaySession() }), "seq -1")).toMatchObject({ code: "usage" });
    expect(await result(seeded({ replay: replaySession() }), "seq 1e3")).toMatchObject({ code: "usage" });
  });

  it(":depth sets the view level; unknown levels and v1-only sources are refused", async () => {
    const state = seeded();
    const outcome = await run(state, "depth feature");
    expect(outcome.result).toMatchObject({ kind: "receipt", notice: "depth: feature" });
    expect(applyOutcome(state, outcome).depth).toBe("feature");
    expect(await result(state, "depth galaxy")).toMatchObject({ code: "usage" });
    expect(await result(seeded({ caps: caps({ projectionVersions: [1] }) }), "depth module")).toMatchObject({
      kind: "unavailable",
      reason: "depth-needs-projection-v2"
    });
  });

  it(":trace selects the trace root by full ref; a shared trace id needs a qualified ref", async () => {
    const state = { ...seeded(), selection: null };
    // t-1 exists in two sessions, so with nothing selected the short form is ambiguous.
    expect(await result(state, "trace t-1")).toMatchObject({ kind: "error", code: "ambiguous-ref" });
    const outcome = await run(state, "trace s-2:t-1");
    const next = applyOutcome(state, outcome);
    expect(next.selection).toEqual({ ...ref("t-1", "root"), sessionId: "s-2" });
    expect(next.notice).toBe("trace t-1: selected src/other.ts#main");
    expect(await result(state, "trace s-1:t-404")).toMatchObject({ code: "unknown-ref" });
  });

  it(":filter changes filters with a receipt naming the loaded scope", async () => {
    const state = seeded();
    let next = applyOutcome(state, await run(state, "filter errors"));
    expect(next.filters.errorsOnly).toBe(true);
    expect(next.notice).toBe("filter: errors-only (over the loaded scope)");
    next = applyOutcome(next, await run(next, "filter node 'src/db.ts#query'"));
    expect(next.filters).toMatchObject({ errorsOnly: true, nodeId: "src/db.ts#query" });
    next = applyOutcome(next, await run(next, "filter clear"));
    expect(next.filters).toMatchObject({ errorsOnly: false, nodeId: null, spanKind: null, search: null });
    expect(next.notice).toBe("filter: none");
    expect(await result(state, "filter bogus")).toMatchObject({ code: "usage" });
  });

  it(":bookmark toggles the selection and :bookmark list opens the jump list", async () => {
    const state = seeded();
    let next = applyOutcome(state, await run(state, "bookmark"));
    expect(next.bookmarks.map((bookmark) => bookmark.ref)).toEqual([ref("t-1", "leaf")]);
    expect(next.notice).toBe("bookmark set");
    next = applyOutcome(next, await run(next, "bookmark list"));
    expect(next.bookmarkList).toEqual({ index: 0 });
    next = applyOutcome({ ...next, bookmarkList: null }, await run(next, "bookmark"));
    expect(next.bookmarks).toEqual([]);
    expect(next.notice).toBe("bookmark removed");
  });

  it(":q returns the quit action", async () => {
    expect((await run(seeded(), "q")).actions).toEqual([{ kind: "quit" }]);
  });

  it("no view action ever yields spans or opens the result pane", async () => {
    const state = seeded({ replay: replaySession() });
    for (const line of ["seq 30", "depth app", "trace t-2", "filter errors", "bookmark", "q"]) {
      const outcome = await run(state, line);
      expect(outcome.result.kind, line).toBe("receipt");
      expect(applyOutcome(state, outcome).commandResult, line).toBeNull();
    }
  });
});

describe(":ancestors", () => {
  it("defaults to the selection and walks recorded parents to the root", async () => {
    const answer = await result(seeded(), "ancestors");
    if (answer.kind !== "projection") throw new Error(answer.kind);
    expect(answer.spans.map((row) => row.spanId)).toEqual(["leaf", "mid", "root"]);
    expect(answer.meta).toMatchObject({ coverage: "complete", truncated: false, missing: null });
    expect(answer.meta.scope).toMatchObject({ spans: 8, traces: 3 });
  });

  it("never links a same-id parent from another session", async () => {
    const answer = await result(seeded(), "ancestors s-2:t-1:mid");
    if (answer.kind !== "projection") throw new Error(answer.kind);
    expect(answer.spans.map((row) => `${row.sessionId}/${row.spanId}`)).toEqual(["s-2/mid", "s-2/root"]);
    expect(answer.spans[1]!.nodeId).toBe("src/other.ts#main");
  });

  it("a parent lost to retention makes coverage partial and says why", async () => {
    // R-L4: a unique cross-session "mid" would be a valid parent; drop it from every session.
    const spans = rows().filter((row) => !(row.traceId === "t-1" && row.spanId === "mid"));
    const answer = await result(seeded({}, spans), "ancestors");
    const state = applyDelta(seeded({}, spans), { kind: "retention", dropped: [] });
    const withGap = await result(state, "ancestors");
    if (answer.kind !== "projection" || withGap.kind !== "projection") throw new Error("expected projection");
    expect(answer.meta.coverage).toBe("partial");
    expect(answer.meta.missing).toContain("unknown(not-loaded)");
    expect(withGap.meta.missing).toContain("unknown(retention)");
    expect(withGap.meta.scope.retentionGap).toBe(true);
  });
});

describe(":path — no-path vs unknown-path", () => {
  it("finds a directed recorded path", async () => {
    const answer = await result(seeded(), "path root leaf");
    expect(answer).toMatchObject({ kind: "path", status: "found" });
    if (answer.kind !== "path" || answer.status !== "found") return;
    expect(answer.spans.map((row) => row.spanId)).toEqual(["root", "mid", "leaf"]);
  });

  it("both endpoints loaded and the chain complete: no-path", async () => {
    // sib is not an ancestor of leaf, and the direction matters: leaf -> root is no-path too.
    expect(await result(seeded(), "path sib leaf")).toMatchObject({
      kind: "path",
      status: "no-path",
      reason: "not-an-ancestor",
      meta: { coverage: "complete" }
    });
    expect(await result(seeded(), "path leaf root")).toMatchObject({ status: "no-path" });
  });

  it("different traces are never connected by matching span ids", async () => {
    expect(await result(seeded(), "path t-2:root t-1:leaf")).toMatchObject({
      status: "no-path",
      reason: "different-trace"
    });
    // Same trace id and span ids, other session: still a different trace ref.
    expect(await result(seeded(), "path s-2:t-1:root s-1:t-1:leaf")).toMatchObject({
      status: "no-path",
      reason: "different-trace"
    });
  });

  it("an unknown endpoint is unknown-path, not no-path", async () => {
    expect(await result(seeded(), "path root gone")).toMatchObject({
      status: "unknown-path",
      reason: "not-loaded",
      endpoint: "to",
      meta: { coverage: "partial" }
    });
    const aged = { ...seeded(), retentionGap: true };
    expect(await result(aged, "path local:p:s-9:t-9:x leaf")).toMatchObject({
      status: "unknown-path",
      reason: "retention",
      endpoint: "from"
    });
  });

  it("a missing link in the chain is unknown-path(retention|not-loaded)", async () => {
    // R-L4: a unique cross-session "mid" would be a valid parent; drop it from every session.
    const spans = rows().filter((row) => !(row.traceId === "t-1" && row.spanId === "mid"));
    expect(await result(seeded({}, spans), "path root leaf")).toMatchObject({
      status: "unknown-path",
      reason: "not-loaded",
      endpoint: null
    });
    expect(await result({ ...seeded({}, spans), retentionGap: true }, "path root leaf")).toMatchObject({
      status: "unknown-path",
      reason: "retention"
    });
  });

  it("conflicting parent records give unknown-path(ambiguous); a cycle stops with unknown-path(cycle)", async () => {
    // Two rows for one key cannot coexist in view state (merge keeps one), so the
    // conflicting records are handed to the selector directly.
    const raw = [
      span("t-1", "root"),
      span("t-1", "mid", { parentSpanId: "root", depth: 1 }),
      span("t-1", "mid", { parentSpanId: "zzz", depth: 1 }),
      span("t-1", "leaf", { parentSpanId: "mid", depth: 2 })
    ];
    expect(localGraphSelectors.path(raw, raw[0]!, raw[3]!, {})).toMatchObject({
      status: "unknown-path",
      reason: "ambiguous"
    });

    const cyclic = seeded({}, [
      span("t-1", "x", { parentSpanId: "y", depth: 1 }),
      span("t-1", "y", { parentSpanId: "x", depth: 1 }),
      span("t-1", "leaf", { parentSpanId: "x", depth: 2 }),
      span("t-1", "root")
    ]);
    expect(await result(cyclic, "path root leaf")).toMatchObject({ status: "unknown-path", reason: "cycle" });
  });

  it("a short ref matches loaded rows on the fields it gives, not only the selected session (review)", async () => {
    // Selection is in s-1; t-3 is loaded only in s-2, so a short ref must still find it.
    const extra = [...rows(), { ...span("t-3", "only", { nodeId: "src/x.ts#only" }), sessionId: "s-2" }];
    const state = seeded({}, extra);
    const traced = applyOutcome(state, await run(state, "trace t-3"));
    expect(traced.selection).toEqual({ ...ref("t-3", "only"), sessionId: "s-2" });
    expect(await result(state, "ancestors only")).toMatchObject({ kind: "projection", spans: [{ spanId: "only" }] });
    expect(await result(state, "ancestors t-3:only")).toMatchObject({ kind: "projection" });
    // Several matches outside the current trace: ambiguous, with the candidates named.
    const noSelection = { ...state, selection: null };
    const ambiguous = await result(noSelection, "ancestors mid");
    expect(ambiguous).toMatchObject({
      kind: "error",
      code: "ambiguous-ref",
      candidates: ["s-1:t-1:mid", "s-2:t-1:mid"]
    });
    expect(ambiguous.kind === "error" && ambiguous.notice).toContain("s-2:t-1:mid");
    expect(await result(noSelection, "trace t-1")).toMatchObject({
      code: "ambiguous-ref",
      candidates: ["s-1:t-1", "s-2:t-1"]
    });
    // Inside the selected trace a short ref still prefers that trace's row.
    const inTrace = await result(state, "ancestors mid");
    expect(inTrace.kind === "projection" && inTrace.spans[0]).toMatchObject({ sessionId: "s-1", spanId: "mid" });
    // Nothing loaded matches: not-loaded, or retention after a retention gap.
    expect(await result(noSelection, "trace t-404")).toMatchObject({ code: "unknown-ref" });
    expect((await result(noSelection, "trace t-404")).kind === "error").toBe(true);
    expect(await result(noSelection, "ancestors nope")).toMatchObject({ code: "unknown-ref" });
    const gone = await result({ ...noSelection, retentionGap: true }, "trace t-404");
    expect(gone).toMatchObject({ code: "unknown-ref" });
    expect(gone.kind === "error" && gone.notice).toContain("unknown(retention)");
    expect(await result(state, "ancestors t-404:x")).toMatchObject({
      kind: "projection",
      title: expect.stringContaining("unknown(not-loaded)")
    });
  });

  it("a short ref is resolved only inside the current trace; without one it must be qualified", async () => {
    const noSelection = { ...seeded(), selection: null };
    expect(await result(noSelection, "path root leaf")).toMatchObject({ kind: "error", code: "ambiguous-ref" });
    expect(await result(noSelection, "path s-1:t-1:root s-1:t-1:leaf")).toMatchObject({ status: "found" });
  });

  it("renders no-path and unknown-path differently", async () => {
    const noPath = commandResultLines(await result(seeded(), "path sib leaf")).join("\n");
    const unknown = commandResultLines(await result(seeded(), "path root gone")).join("\n");
    expect(noPath).toMatch(/^no-path: sib -> leaf/);
    expect(unknown).toMatch(/^unknown-path\(not-loaded\): root -> gone \(to endpoint not in the loaded scope\)/);
  });
});

describe(":callers — recorded vs static", () => {
  it("counts direct recorded callers by full parent ref, defaulting to the selected node", async () => {
    const answer = await result(seeded(), "callers");
    if (answer.kind !== "table") throw new Error(answer.kind);
    expect(answer.nodeId).toBe("src/db.ts#query");
    expect(answer.recorded).toEqual([
      { nodeId: "src/api.ts#handle", calls: 2 },
      { nodeId: "src/svc.ts#run", calls: 1 }
    ]);
    expect(answer.static).toBeNull();
    expect(answer.meta.coverage).toBe("complete");
  });

  it("--static adds labelled possible callers without touching recorded counts", async () => {
    const selectors: GraphSelectors = {
      ...localGraphSelectors,
      staticCallers: () => ({
        available: true,
        callers: [{ nodeId: "src/cron.ts#nightly", provenance: "analyzer import edge" }]
      })
    };
    const plain = await result(seeded(), "callers src/db.ts#query", { selectors });
    const withStatic = await result(seeded(), "callers src/db.ts#query --static", { selectors });
    if (plain.kind !== "table" || withStatic.kind !== "table") throw new Error("expected tables");
    expect(withStatic.recorded).toEqual(plain.recorded);
    expect(withStatic.recorded.some((row) => row.nodeId === "src/cron.ts#nightly")).toBe(false);
    expect(withStatic.static).toEqual({
      available: true,
      callers: [{ nodeId: "src/cron.ts#nightly", provenance: "analyzer import edge" }]
    });
    const text = commandResultLines(withStatic).join("\n");
    expect(text).toContain("static/possible callers (not observed; not counted above)");
    expect(text).toContain("possible  src/cron.ts#nightly  [analyzer import edge]");
    expect(text).toContain("2x  src/api.ts#handle");
  });

  it("the local adapter has no static selector and says so; a source without a static graph is unavailable", async () => {
    const answer = await result(seeded(), "callers --static");
    if (answer.kind !== "table") throw new Error(answer.kind);
    expect(answer.static).toEqual({ available: false, reason: "no-static-graph-selector" });
    const noGraph = seeded({ caps: caps({ staticGraph: { available: false, reason: "no-analyzer-graph" } }) });
    expect(await result(noGraph, "callers --static")).toMatchObject({
      kind: "unavailable",
      reason: "no-analyzer-graph"
    });
    expect(await result(noGraph, "callers")).toMatchObject({ kind: "table" });
  });

  it("calls whose parent is not loaded are reported, not attributed", async () => {
    const spans = rows().filter((row) => !(row.traceId === "t-2" && row.spanId === "root"));
    const answer = await result(seeded({}, spans), "callers src/db.ts#query");
    if (answer.kind !== "table") throw new Error(answer.kind);
    expect(answer.recorded.find((row) => row.nodeId === "src/api.ts#handle")?.calls).toBe(1);
    expect(answer.meta).toMatchObject({ coverage: "partial" });
    expect(answer.meta.missing).toContain("1 call(s)");
  });

  it("rejects unknown flags", async () => {
    expect(await result(seeded(), "callers x --dynamic")).toMatchObject({ code: "usage" });
  });
});

describe(":find — regex in a worker with a deadline", () => {
  it("the spec deadline is 2 s", () => {
    expect(FIND_DEADLINE_MS).toBe(2_000);
  });

  it("matches node ids over the loaded scope in a worker", async () => {
    const answer = await result(seeded(), "find /db\\.ts#q/");
    if (answer.kind !== "projection") throw new Error(answer.kind);
    expect(answer.spans.map((row) => `${row.traceId}/${row.spanId}`).sort()).toEqual([
      "t-1/leaf",
      "t-1/sib",
      "t-2/leaf"
    ]);
    expect(answer.title).toContain("3 match(es) in 8 loaded span(s)");
    expect(answer.meta.coverage).toBe("complete");
  });

  it("invalid regexes and stateful flags are refused before anything runs", async () => {
    expect(await result(seeded(), "find /(/")).toMatchObject({ code: "invalid-regex" });
    expect(await result(seeded(), "find /a/g")).toMatchObject({ code: "usage" });
    expect(await result(seeded(), "find plain")).toMatchObject({ code: "usage" });
  });

  it("a catastrophic regex returns deadline-exceeded instead of hanging, and the UI thread stays live", async () => {
    const evil = span("t-1", "evil", { parentSpanId: "root", depth: 1, nodeId: `${"a".repeat(40)}!` });
    const state = seeded({}, [...rows(), evil]);
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 10);
    const started = Date.now();
    const answer = await result(state, "find /(a+)+$/", { findDeadlineMs: 200 });
    const elapsed = Date.now() - started;
    clearInterval(ticker);
    expect(answer).toMatchObject({ kind: "deadline-exceeded", deadlineMs: 200 });
    expect(answer.kind === "deadline-exceeded" && answer.notice).toBe(
      "find /(a+)+$/: deadline-exceeded(200ms); no partial matches shown"
    );
    expect(elapsed).toBeLessThan(1_500);
    // The event loop kept running while the worker was stuck in the regex.
    expect(ticks).toBeGreaterThan(5);
  });

  it("the worker runner itself terminates at the deadline", async () => {
    const run = await runRegexInWorker({
      source: "(a+)+$",
      flags: "",
      subjects: [`${"a".repeat(40)}!`],
      deadlineMs: 150
    });
    expect(run).toEqual({ status: "deadline-exceeded" });
    expect(await runRegexInWorker({ source: "b", flags: "i", subjects: ["a", "B"], deadlineMs: 1_000 })).toEqual({
      status: "ok",
      matches: [1]
    });
  });

  it("the built worker runs from dist as well (ESM package, no require)", async () => {
    // `npm test` builds first; the worker source must load outside the vitest transform.
    const built = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/commands.js")).href;
    const mod = (await import(built)) as { runRegexInWorker: typeof runRegexInWorker };
    expect(await mod.runRegexInWorker({ source: "b", flags: "", subjects: ["a", "b"], deadlineMs: 1_000 })).toEqual({
      status: "ok",
      matches: [1]
    });
    expect(
      await mod.runRegexInWorker({ source: "(a+)+$", flags: "", subjects: [`${"a".repeat(40)}!`], deadlineMs: 100 })
    ).toEqual({ status: "deadline-exceeded" });
  });

  it("deadline-exceeded is a notice, not a result pane", async () => {
    const state = seeded();
    const outcome = await run(state, "find /x/", {
      find: async () => ({ status: "deadline-exceeded" as const }),
      findDeadlineMs: 50
    });
    const next = applyOutcome(state, outcome);
    expect(next.commandResult).toBeNull();
    expect(next.notice).toContain("deadline-exceeded(50ms)");
  });
});
