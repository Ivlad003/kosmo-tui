/**
 * Task 14: view state. Spec 5.4 (screens), 6.1–6.3 (start, traces, tree), 6.5 (areas), 6.7 (keys'
 * actions), 4.3 (DFS order, identity by full ref), review focus 1 (50 000-deep chain), 5.2 (cache bound).
 */
import { describe, expect, it } from "vitest";
import { CACHE_MAX_BYTES, jsonBytes } from "../../src/bounds.js";
import type { TraceModel } from "../../src/format/model.js";
import type { SpanValues, TraceSummary } from "../../src/format/types.js";
import type { Snippet } from "../../src/code/snippet.js";
import { renderKosmoText } from "../../src/output/kosmo-text.js";
import {
  EMPTY_FILTER,
  ancestorsOf,
  initialState,
  rowIndex,
  update,
  visibleRows,
  type Action,
  type DatasetView,
  type Effect,
  type ViewState
} from "../../src/ui/state.js";
import { chain, model, ref, span } from "./model-fixtures.js";

function run(state: ViewState, ...actions: Action[]): { state: ViewState; effects: Effect[] } {
  let current = state;
  const effects: Effect[] = [];
  for (const action of actions) {
    const [next, produced] = update(current, action);
    current = next;
    effects.push(...produced);
  }
  return { state: current, effects };
}

function summary(id: string, name: string | null = null): TraceSummary {
  return { id, name, spans: 1, status: "complete", requests: null };
}

function dataset(traces: TraceSummary[], overrides: Partial<DatasetView> = {}): DatasetView {
  return {
    info: { id: "ds_1" },
    kind: "json",
    origin: { path: "/work/x.kosmo-trace.json" },
    traces,
    hasMore: false,
    notices: [],
    reloadable: true,
    ...overrides
  };
}

const VALUES: SpanValues = {
  args: { state: "recorded", value: [1] },
  return: { state: "not-recorded" },
  error: { state: "not-recorded" }
};

/**
 *   req (s1, browser)
 *   ├─ a (s1)            location src/a.ts:1, errored
 *   │  └─ a1 (s1)
 *   ├─ b (s1)            kind nest.guard
 *   └─ act (n1, node)    parent from another session → separator
 *      └─ sp_1 (n1)
 *   sp_1 (s1) is a root of its own: the same id as n1:sp_1, a different span.
 */
function multiSession(): TraceModel {
  return model([
    span({ id: "req", order: 0, runtime: "browser", values: VALUES }),
    span({
      id: "a",
      parent: "req",
      order: 1,
      runtime: "browser",
      status: "errored",
      location: { file: "src/a.ts", line: 1 },
      values: VALUES
    }),
    span({ id: "a1", parent: "a", order: 2, runtime: "browser", values: VALUES }),
    span({ id: "b", parent: "req", order: 3, runtime: "browser", kind: "nest.guard", values: VALUES }),
    span({ id: "act", session: "n1", parent: "req", parentSession: "s1", order: 0, runtime: "node", values: VALUES }),
    span({ id: "sp_1", session: "n1", parent: "act", order: 1, runtime: "node", values: VALUES }),
    span({ id: "sp_1", order: 4, runtime: "browser", values: VALUES })
  ]);
}

function onTrace(trace: TraceModel, overrides: Partial<ViewState> = {}): ViewState {
  const opened = run(
    initialState({ root: "/work", readOnly: false }),
    { type: "datasetOpened", dataset: dataset([summary(trace.trace.id), summary("t9")]) },
    { type: "traceLoaded", model: trace }
  ).state;
  return { ...opened, ...overrides };
}

function keys(rows: ReturnType<typeof visibleRows>): string[] {
  return rows.map(
    (row) => `${"  ".repeat(row.depth)}${row.ref.session}:${row.ref.id}${row.context ? " (context)" : ""}`
  );
}

describe("initialState", () => {
  it("starts on the start screen with nothing open", () => {
    const state = initialState({ root: "/work", readOnly: true });
    expect(state.screen).toBe("start");
    expect(state.dataset).toBeNull();
    expect(state.trace).toBeNull();
    expect(state.filter).toEqual(EMPTY_FILTER);
    expect(state.readOnly).toBe(true);
    expect(state.root).toBe("/work");
    expect(visibleRows(state)).toEqual([]);
  });
});

describe("visibleRows", () => {
  it("is the model's DFS in spec 4.3 order, with a separator before a cross-session child", () => {
    const state = onTrace(multiSession());
    expect(keys(visibleRows(state))).toEqual([
      "s1:req",
      "  s1:a",
      "    s1:a1",
      "  s1:b",
      "  n1:act",
      "    n1:sp_1",
      "s1:sp_1"
    ]);
    const act = visibleRows(state).find((row) => row.ref.id === "act")!;
    expect(act.separator).toBe("┄┄ browser → node · n1 ┄┄");
    expect(visibleRows(state).filter((row) => row.separator !== undefined)).toHaveLength(1);
  });

  it("collapses by full ref: s1:sp_1 and n1:sp_1 are different spans", () => {
    const base = onTrace(multiSession());
    const collapsedAct = run(base, { type: "selectRef", ref: ref("act", "n1") }, { type: "collapse" }).state;
    expect(keys(visibleRows(collapsedAct))).not.toContain("    n1:sp_1");
    expect(keys(visibleRows(collapsedAct))).toContain("s1:sp_1");
    const expanded = run(collapsedAct, { type: "expand" }).state;
    expect(keys(visibleRows(expanded))).toContain("    n1:sp_1");
  });

  it("filters keep matches with their ancestors as dimmed context", () => {
    const base = onTrace(multiSession());
    const errors = run(base, { type: "toggleErrors" }).state;
    expect(keys(visibleRows(errors))).toEqual(["s1:req (context)", "  s1:a"]);
    const kind = run(base, { type: "setFilter", patch: { kindGlob: "nest.*" } }).state;
    expect(keys(visibleRows(kind))).toEqual(["s1:req (context)", "  s1:b"]);
    const name = run(base, { type: "setFilter", patch: { name: "/^sp_/" } }).state;
    expect(keys(visibleRows(name))).toEqual(["s1:req (context)", "  n1:act (context)", "    n1:sp_1", "s1:sp_1"]);
    // `/` search: substring of name or location.file, case-insensitive.
    const search = run(base, { type: "setFilter", patch: { search: "SRC/A" } }).state;
    expect(keys(visibleRows(search))).toEqual(["s1:req (context)", "  s1:a"]);
    const area = run(base, {
      type: "setFilter",
      patch: { area: { module: "src", feature: null, derived: true } }
    }).state;
    expect(keys(visibleRows(area))).toEqual(["s1:req (context)", "  s1:a"]);
    expect(visibleRows(run(errors, { type: "escape" }).state)).toHaveLength(7);
  });

  it("walks a 50 000-deep chain without recursion (review focus 1)", () => {
    const deep = model(chain(50_000));
    const state = onTrace(deep);
    const rows = visibleRows(state);
    expect(rows).toHaveLength(50_000);
    expect(rows[49_999]).toEqual({ ref: ref("c49999"), depth: 49_999, context: false });
    const filtered = run(state, { type: "setFilter", patch: { name: "/^c49999$/" } }).state;
    expect(visibleRows(filtered)).toHaveLength(50_000);
    expect(visibleRows(filtered)[0]!.context).toBe(true);
    expect(ancestorsOf(deep, ref("c49999")).frames).toHaveLength(50_000);
    const last = run(state, { type: "moveTo", edge: "last" }).state;
    expect(last.selected).toEqual(ref("c49999"));
    expect(rowIndex(last, last.selected)).toBe(49_999);
  });

  it("memoises the ancestor walk for the last 4 spans used: a hit counts as a use", () => {
    const deep = model(chain(10));
    const walks = ["c1", "c2", "c3", "c4"].map((id) => ancestorsOf(deep, ref(id)));
    expect(ancestorsOf(deep, ref("c1"))).toBe(walks[0]); // a hit: c1 is now the most recent
    ancestorsOf(deep, ref("c5")); // evicts the least recently used, c2, not c1
    expect(ancestorsOf(deep, ref("c1"))).toBe(walks[0]);
    expect(ancestorsOf(deep, ref("c3"))).toBe(walks[2]);
    expect(ancestorsOf(deep, ref("c4"))).toBe(walks[3]);
    const again = ancestorsOf(deep, ref("c2"));
    expect(again).not.toBe(walks[1]);
    expect(again).toEqual(walks[1]);
  });

  it("memoises rows per model: two traces rendered in turn keep their own rows", () => {
    const one = onTrace(multiSession());
    const two = onTrace(model(chain(3)));
    const rowsOne = visibleRows(one);
    const rowsTwo = visibleRows(two);
    expect(visibleRows(one)).toBe(rowsOne);
    expect(visibleRows(two)).toBe(rowsTwo);
    // Moving the selection keeps the rows; a new filter or collapse set is a new answer, not a stale one.
    const moved = run(one, { type: "move", delta: 1 }).state;
    expect(visibleRows(moved)).toBe(rowsOne);
    const filtered = run(one, { type: "toggleErrors" }).state;
    expect(keys(visibleRows(filtered))).toEqual(["s1:req (context)", "  s1:a"]);
    expect(keys(visibleRows(one))).toEqual(keys(rowsOne));
  });
});

describe("tree navigation and selection", () => {
  it("selects by ref, clamps at the ends and asks for lazy values and the snippet once", () => {
    const lazy = model([
      span({ id: "r", order: 0 }),
      span({ id: "x", parent: "r", order: 1, location: { file: "src/x.ts", line: 3 } })
    ]);
    const loaded = run(
      initialState({ root: "/work", readOnly: false }),
      { type: "datasetOpened", dataset: dataset([summary("t1")], { kind: "sqlite" }) },
      { type: "traceLoaded", model: lazy }
    );
    expect(loaded.state.selected).toEqual(ref("r"));
    expect(loaded.effects).toEqual([
      { kind: "loadTrace", id: "t1" },
      { kind: "loadValues", ref: ref("r") }
    ]);
    const down = run(loaded.state, { type: "move", delta: 1 });
    expect(down.state.selected).toEqual(ref("x"));
    expect(down.effects).toEqual([
      { kind: "loadValues", ref: ref("x") },
      { kind: "loadSnippet", ref: ref("x"), location: { file: "src/x.ts", line: 3 } }
    ]);
    expect(down.state.values.get(JSON.stringify(["t1", "s1", "x"]))).toBe("loading");
    const again = run(down.state, { type: "move", delta: -1 }, { type: "move", delta: 5 });
    expect(again.state.selected).toEqual(ref("x"));
    expect(again.effects).toEqual([]);
    const answered = run(again.state, { type: "valuesLoaded", ref: ref("x"), values: VALUES }).state;
    expect(answered.values.get(JSON.stringify(["t1", "s1", "x"]))).toEqual(VALUES);
  });

  it("values and snippets stay within CACHE_MAX_BYTES; an evicted span is asked for again (spec 5.2)", () => {
    const lazy = model([
      span({ id: "r", order: 0 }),
      span({ id: "a", parent: "r", order: 1, location: { file: "src/a.ts", line: 1 } }),
      span({ id: "b", parent: "r", order: 2, location: { file: "src/b.ts", line: 1 } })
    ]);
    // Two snippets of half the budget each no longer fit together with anything else.
    const half = "x".repeat(CACHE_MAX_BYTES / 2);
    const big = (file: string): Snippet => ({ state: "ok", file, lines: [{ n: 1, text: half }], target: 1 });
    const first = run(
      initialState({ root: "/work", readOnly: false }),
      { type: "datasetOpened", dataset: dataset([summary("t1"), summary("t9")], { kind: "sqlite" }) },
      { type: "traceLoaded", model: lazy },
      { type: "selectRef", ref: ref("a") },
      { type: "valuesLoaded", ref: ref("a"), values: VALUES },
      { type: "snippetLoaded", ref: ref("a"), snippet: big("src/a.ts") }
    ).state;
    expect(first.cacheBytes).toBe(jsonBytes(VALUES) + jsonBytes(big("src/a.ts")));
    const second = run(
      first,
      { type: "selectRef", ref: ref("b") },
      { type: "valuesLoaded", ref: ref("b"), values: VALUES },
      { type: "snippetLoaded", ref: ref("b"), snippet: big("src/b.ts") }
    ).state;
    const a = JSON.stringify(["t1", "s1", "a"]);
    const b = JSON.stringify(["t1", "s1", "b"]);
    // a is the oldest loaded span: its value and snippet go together; b is selected and stays.
    expect(second.values.has(a)).toBe(false);
    expect(second.snippets.has(a)).toBe(false);
    expect(second.values.get(b)).toEqual(VALUES);
    expect(second.snippets.get(b)).toEqual(big("src/b.ts"));
    expect(second.cacheBytes).toBe(jsonBytes(VALUES) + jsonBytes(big("src/b.ts")));
    expect(second.cacheBytes).toBeLessThanOrEqual(CACHE_MAX_BYTES);
    // r never got an answer: a request in flight is not evicted and not asked twice.
    expect(second.values.get(JSON.stringify(["t1", "s1", "r"]))).toBe("loading");
    expect(run(second, { type: "selectRef", ref: ref("r") }).effects).toEqual([]);
    expect(run(second, { type: "selectRef", ref: ref("a") }).effects).toEqual([
      { kind: "loadValues", ref: ref("a") },
      { kind: "loadSnippet", ref: ref("a"), location: { file: "src/a.ts", line: 1 } }
    ]);
    // :root drops every snippet; the sum follows.
    expect(run(second, { type: "rootChanged", root: "/other" }).state.cacheBytes).toBe(jsonBytes(VALUES));
  });

  it("without a code root no snippet is asked for; a root brings the request back (spec 4.8)", () => {
    const traced = onTrace(multiSession());
    const unset = run(traced, { type: "rootChanged", root: null, unset: "home" });
    expect(unset.state.root).toBeNull();
    expect(unset.state.rootUnset).toBe("home");
    expect(unset.state.banner).toEqual({
      level: "info",
      text: "code root not set: cwd is the home directory or above it; use :root or --root"
    });
    const selected = run(unset.state, { type: "selectRef", ref: ref("a") });
    expect(selected.effects.filter((effect) => effect.kind === "loadSnippet")).toEqual([]);
    expect(selected.state.snippets.size).toBe(0);
    const rooted = run(selected.state, { type: "rootChanged", root: "/p" });
    expect(rooted.state.rootUnset).toBeNull();
    expect(rooted.effects).toContainEqual({
      kind: "loadSnippet",
      ref: ref("a"),
      location: { file: "src/a.ts", line: 1 }
    });
  });

  it("h on a leaf goes to the parent row; Space toggles", () => {
    const state = run(onTrace(multiSession()), { type: "selectRef", ref: ref("a1") }, { type: "collapse" }).state;
    expect(state.selected).toEqual(ref("a"));
    const toggled = run(state, { type: "toggleExpand" }).state;
    expect(keys(visibleRows(toggled))).not.toContain("    s1:a1");
    expect(keys(visibleRows(run(toggled, { type: "toggleExpand" }).state))).toContain("    s1:a1");
  });

  it("a filter that hides the selection keeps it; moving then starts from the top", () => {
    const state = run(onTrace(multiSession()), { type: "selectRef", ref: ref("b") }, { type: "toggleErrors" }).state;
    expect(state.selected).toEqual(ref("b"));
    expect(rowIndex(state, state.selected)).toBe(-1);
    expect(run(state, { type: "move", delta: 1 }).state.selected).toEqual(ref("req"));
  });

  it("selectRef expands collapsed ancestors", () => {
    const collapsed = run(onTrace(multiSession()), { type: "collapse" }).state;
    expect(keys(visibleRows(collapsed))).toEqual(["s1:req", "s1:sp_1"]);
    const jumped = run(collapsed, { type: "selectRef", ref: ref("sp_1", "n1") }).state;
    expect(jumped.selected).toEqual(ref("sp_1", "n1"));
    expect(rowIndex(jumped, jumped.selected)).toBe(5);
  });
});

describe("detail focus", () => {
  it("Enter focuses detail; scrolling stays >= 0; Tab returns; moving resets the scroll", () => {
    const focused = run(onTrace(multiSession()), { type: "activate" }).state;
    expect(focused.pane).toBe("detail");
    const scrolled = run(focused, { type: "scrollDetail", delta: 10 }, { type: "scrollDetail", delta: -3 }).state;
    expect(scrolled.detailScroll).toBe(7);
    expect(run(scrolled, { type: "scrollDetail", delta: -100 }).state.detailScroll).toBe(0);
    expect(run(scrolled, { type: "scrollDetailTo", edge: "first" }).state.detailScroll).toBe(0);
    const back = run(scrolled, { type: "focusTree" }).state;
    expect(back.pane).toBe("tree");
    expect(run(back, { type: "move", delta: 1 }).state.detailScroll).toBe(0);
  });
});

describe("start and traces screens", () => {
  const rows = [
    { path: "traces/a.kosmo-trace.json", size: 10, mtimeMs: 0, source: "found" as const, missing: false },
    { path: "/tmp/gone.kosmo-trace.ndjson", size: null, mtimeMs: null, source: "recent" as const, missing: true }
  ];

  it("opens the file under the cursor; a missing recent file says file-not-found", () => {
    const start = initialState({ root: "/work", readOnly: false, start: rows });
    const opened = run(start, { type: "activate" });
    expect(opened.effects).toEqual([{ kind: "open", origin: { path: "traces/a.kosmo-trace.json" } }]);
    expect(opened.state.fromStart).toBe(true);
    const missing = run(start, { type: "move", delta: 1 }, { type: "activate" });
    expect(missing.effects).toEqual([]);
    expect(missing.state.banner).toEqual({ level: "error", text: "file-not-found: /tmp/gone.kosmo-trace.ndjson" });
  });

  it("a failed open from the start screen stays there with the reason (spec 5.4)", () => {
    const start = initialState({ root: "/work", readOnly: false, start: rows });
    const failed = run(
      start,
      { type: "activate" },
      {
        type: "datasetFailed",
        error: { code: "not-a-kosmo-trace", message: "format is not kosmo-trace" }
      }
    ).state;
    expect(failed.screen).toBe("start");
    expect(failed.banner).toEqual({ level: "error", text: "not-a-kosmo-trace: format is not kosmo-trace" });
  });

  it("lists traces, filters them with /, opens with Enter, pages with > and goes back with Esc", () => {
    const start = initialState({ root: "/work", readOnly: false, start: rows });
    const listed = run(
      start,
      { type: "activate" },
      {
        type: "datasetOpened",
        dataset: dataset([summary("t_a", "GET /cart"), summary("t_b", "POST /pay")], { kind: "sqlite", hasMore: true })
      }
    ).state;
    expect(listed.screen).toBe("traces");
    const filtered = run(
      listed,
      { type: "openPrompt", kind: "search" },
      { type: "promptInput", text: "pay" },
      { type: "promptSubmit" }
    );
    expect(filtered.state.traceList).toEqual({ cursor: 0, filter: "pay" });
    expect(run(filtered.state, { type: "activate" }).effects).toEqual([{ kind: "loadTrace", id: "t_b" }]);
    const more = run(listed, { type: "loadMore" });
    expect(more.effects).toEqual([{ kind: "loadMoreTraces" }]);
    const paged = run(more.state, { type: "tracesPage", page: { items: [summary("t_c")], hasMore: false } }).state;
    expect(paged.dataset!.traces.map((trace) => trace.id)).toEqual(["t_a", "t_b", "t_c"]);
    expect(run(paged, { type: "loadMore" }).state.banner).toEqual({ level: "info", text: "no more traces" });
    const cleared = run(filtered.state, { type: "escape" }).state;
    expect(cleared.traceList.filter).toBe("");
    const back = run(cleared, { type: "escape" }).state;
    expect(back.screen).toBe("start");
    expect(back.dataset).toBeNull();
  });

  it("a dataset with one trace opens it directly (spec 5.4)", () => {
    const opened = run(initialState({ root: "/work", readOnly: false }), {
      type: "datasetOpened",
      dataset: dataset([summary("t1")])
    });
    expect(opened.effects).toEqual([{ kind: "loadTrace", id: "t1" }]);
    const trace = run(opened.state, { type: "traceLoaded", model: multiSession() }).state;
    expect(trace.screen).toBe("trace");
    expect(trace.selected).toEqual(ref("req"));
  });

  it("T / Backspace goes back to the trace list with the cursor on that trace", () => {
    const state = onTrace(multiSession());
    const back = run(state, { type: "back" }).state;
    expect(back.screen).toBe("traces");
    expect(back.trace).toBeNull();
    expect(back.traceList.cursor).toBe(0);
  });
});

describe("dataset lifecycle", () => {
  const rows = [{ path: "a.kosmo-trace.json", size: 1, mtimeMs: 0, source: "found" as const, missing: false }];

  function listedFromStart(): ViewState {
    return run(
      initialState({ root: "/work", readOnly: false, start: rows }),
      { type: "activate" },
      { type: "datasetOpened", dataset: dataset([summary("t1"), summary("t2")]) }
    ).state;
  }

  it("Esc from the trace list back to the start screen emits closeDataset", () => {
    const back = run(listedFromStart(), { type: "escape" });
    expect(back.state.screen).toBe("start");
    expect(back.state.dataset).toBeNull();
    expect(back.effects).toEqual([{ kind: "closeDataset" }]);
    // Esc on the start screen afterwards has nothing to close.
    expect(run(back.state, { type: "escape" }).effects).toEqual([]);
  });

  it("rootReset (the session after closeDataset): the dataset's root and its reason go, silently", () => {
    const listed = listedFromStart();
    const unset = run(listed, { type: "rootChanged", root: null, unset: "home" }).state;
    const back = run(unset, { type: "escape" }).state;
    const reset = run(back, { type: "rootReset", root: null });
    expect(reset.state.root).toBeNull();
    expect(reset.state.rootUnset).toBeNull();
    expect(reset.state.banner).toBe(back.banner);
    expect(reset.effects).toEqual([]);
    const flagged = run(run(listed, { type: "rootChanged", root: "/p" }).state, { type: "escape" }).state;
    const toFlag = run(flagged, { type: "rootReset", root: "/flag" }).state;
    expect(toFlag.root).toBe("/flag");
    expect(toFlag.rootUnset).toBeNull();
    expect(toFlag.snippets.size).toBe(0);
  });

  it("a traceLoaded without a dataset is a no-op", () => {
    const back = run(listedFromStart(), { type: "escape" }).state;
    const late = update(back, { type: "traceLoaded", model: multiSession() });
    expect(late[0]).toBe(back);
    expect(late[1]).toEqual([]);
  });

  it("switching to another trace drops the old trace's values and snippets", () => {
    const one = model([span({ id: "r", order: 0, location: { file: "src/r.ts", line: 1 } })]);
    const two = model([span({ id: "q", trace: "t2", order: 0, location: { file: "src/q.ts", line: 1 } })]);
    const snippet: Snippet = { state: "ok", file: "src/r.ts", lines: [{ n: 1, text: "r" }], target: 1 };
    const first = run(
      listedFromStart(),
      { type: "traceLoaded", model: one },
      { type: "valuesLoaded", ref: ref("r"), values: VALUES },
      { type: "snippetLoaded", ref: ref("r"), snippet }
    ).state;
    expect(first.cacheBytes).toBe(jsonBytes(VALUES) + jsonBytes(snippet));
    const switched = run(first, { type: "openTrace", id: "t2" }, { type: "traceLoaded", model: two });
    const q = JSON.stringify(["t2", "s1", "q"]);
    expect([...switched.state.values.keys()]).toEqual([q]);
    expect([...switched.state.snippets.keys()]).toEqual([q]);
    expect(switched.state.values.get(q)).toBe("loading");
    expect(switched.state.cacheBytes).toBe(0);
    expect(switched.effects).toEqual([
      { kind: "loadTrace", id: "t2" },
      { kind: "loadValues", ref: ref("q", "s1", "t2") },
      { kind: "loadSnippet", ref: ref("q", "s1", "t2"), location: { file: "src/q.ts", line: 1 } }
    ]);
    // The same trace loaded again keeps what it already has.
    const same = run(first, { type: "traceLoaded", model: one }).state;
    expect(same.values.get(JSON.stringify(["t1", "s1", "r"]))).toEqual(VALUES);
    expect(same.cacheBytes).toBe(first.cacheBytes);
  });

  it("a late reply for the previous trace, or one nobody asked for, is not stored", () => {
    const one = model([span({ id: "r", order: 0, location: { file: "src/r.ts", line: 1 } })]);
    const two = model([span({ id: "q", trace: "t2", order: 0, location: { file: "src/q.ts", line: 1 } })]);
    const snippet: Snippet = { state: "ok", file: "src/r.ts", lines: [{ n: 1, text: "r" }], target: 1 };
    const asked = run(listedFromStart(), { type: "traceLoaded", model: one }).state;
    expect(asked.values.get(JSON.stringify(["t1", "s1", "r"]))).toBe("loading");
    const switched = run(asked, { type: "openTrace", id: "t2" }, { type: "traceLoaded", model: two }).state;
    const late = run(
      switched,
      { type: "valuesLoaded", ref: ref("r"), values: VALUES },
      { type: "valuesFailed", ref: ref("r"), reason: "gone" },
      { type: "snippetLoaded", ref: ref("r"), snippet }
    ).state;
    expect(late).toBe(switched);
    expect([...late.values.keys()]).toEqual([JSON.stringify(["t2", "s1", "q"])]);
    expect([...late.snippets.keys()]).toEqual([JSON.stringify(["t2", "s1", "q"])]);
    expect(late.cacheBytes).toBe(0);
    // In the current trace too: only a key in flight takes an answer, and only once.
    const unasked = update(switched, { type: "valuesLoaded", ref: ref("x", "s1", "t2"), values: VALUES })[0];
    expect(unasked).toBe(switched);
    const answered = run(
      switched,
      { type: "valuesLoaded", ref: ref("q", "s1", "t2"), values: VALUES },
      { type: "snippetLoaded", ref: ref("q", "s1", "t2"), snippet }
    ).state;
    expect(answered.values.get(JSON.stringify(["t2", "s1", "q"]))).toEqual(VALUES);
    expect(answered.snippets.get(JSON.stringify(["t2", "s1", "q"]))).toEqual(snippet);
    expect(answered.cacheBytes).toBe(jsonBytes(VALUES) + jsonBytes(snippet));
    const twice = update(answered, { type: "valuesFailed", ref: ref("q", "s1", "t2"), reason: "late" })[0];
    expect(twice).toBe(answered);
  });
});

describe("reload", () => {
  it("stdin cannot be re-read: reload: unavailable(stdin-stream)", () => {
    const state = run(initialState({ root: "/work", readOnly: false }), {
      type: "datasetOpened",
      dataset: dataset([summary("t1"), summary("t2")], { origin: "stdin", kind: "ndjson", reloadable: false })
    }).state;
    const refused = run(state, { type: "reload" });
    expect(refused.effects).toEqual([]);
    expect(refused.state.banner).toEqual({ level: "error", text: "reload: unavailable(stdin-stream)" });
  });

  it("re-reading a file keeps the open trace and the selected span", () => {
    const state = run(onTrace(multiSession()), { type: "selectRef", ref: ref("sp_1", "n1") }).state;
    const asked = run(state, { type: "reload" });
    expect(asked.effects).toEqual([{ kind: "reload" }]);
    const reopened = run(asked.state, { type: "datasetOpened", dataset: dataset([summary("t1"), summary("t9")]) });
    expect(reopened.effects).toEqual([{ kind: "loadTrace", id: "t1" }]);
    const reloaded = run(reopened.state, { type: "traceLoaded", model: multiSession() }).state;
    expect(reloaded.selected).toEqual(ref("sp_1", "n1"));
  });
});

describe("panes", () => {
  it("areas: Enter filters the tree to the area, Esc on the tree clears the filter", () => {
    const state = run(onTrace(multiSession()), { type: "openPane", pane: "areas" }).state;
    expect(state.pane).toBe("areas");
    const areas = state.trace!.areas();
    const index = areas.findIndex((row) => row.module === "src" && row.derived);
    const applied = run(state, { type: "paneMove", delta: index }, { type: "paneActivate" }).state;
    expect(applied.pane).toBe("tree");
    expect(applied.filter.area).toEqual({ module: "src", feature: null, derived: true });
    expect(run(applied, { type: "escape" }).state.filter).toEqual(EMPTY_FILTER);
  });

  it("stack lists recorded ancestors and Enter selects one", () => {
    const state = run(onTrace(multiSession()), { type: "selectRef", ref: ref("sp_1", "n1") }).state;
    expect(ancestorsOf(state.trace!, state.selected!)).toEqual({
      frames: [ref("sp_1", "n1"), ref("act", "n1"), ref("req")],
      stop: { kind: "root" }
    });
    const jumped = run(
      state,
      { type: "openPane", pane: "stack" },
      { type: "paneMoveTo", edge: "last" },
      {
        type: "paneActivate"
      }
    ).state;
    expect(jumped.selected).toEqual(ref("req"));
    expect(jumped.pane).toBe("tree");
  });

  it("bookmarks: m toggles by full ref, ' lists them, Enter jumps; another trace is loaded first", () => {
    const empty = run(onTrace(multiSession()), { type: "openPane", pane: "bookmarks" }).state;
    expect(empty.pane).toBe("tree");
    expect(empty.banner).toEqual({ level: "info", text: "bookmarks: none yet (m marks the selected span)" });
    const marked = run(
      onTrace(multiSession()),
      { type: "selectRef", ref: ref("sp_1", "n1") },
      { type: "toggleBookmark" }
    ).state;
    expect(marked.bookmarks).toEqual([{ ref: ref("sp_1", "n1"), name: "sp_1" }]);
    const jumped = run(
      marked,
      { type: "selectRef", ref: ref("req") },
      { type: "openPane", pane: "bookmarks" },
      {
        type: "paneActivate"
      }
    ).state;
    expect(jumped.selected).toEqual(ref("sp_1", "n1"));
    const elsewhere = run(
      { ...marked, bookmarks: [{ ref: ref("x", "s1", "t9"), name: "x" }] },
      {
        type: "openPane",
        pane: "bookmarks"
      },
      { type: "paneActivate" }
    );
    expect(elsewhere.effects).toEqual([{ kind: "loadTrace", id: "t9" }]);
    expect(elsewhere.state.pendingSelect).toEqual(ref("x", "s1", "t9"));
  });

  it("results: Enter selects the entry and keeps the pane open", () => {
    const state = run(onTrace(multiSession()), {
      type: "showResults",
      results: {
        kind: "find",
        title: "find /sp/: 2",
        refs: [ref("sp_1", "n1"), ref("sp_1")],
        labels: [null, null],
        footer: null
      }
    }).state;
    expect(state.pane).toBe("results");
    const second = run(state, { type: "paneMove", delta: 1 }, { type: "paneActivate" }).state;
    expect(second.selected).toEqual(ref("sp_1"));
    expect(second.pane).toBe("results");
    expect(run(second, { type: "closePane" }).state.pane).toBe("tree");
  });
});

describe("prompt, commands, banner", () => {
  it("/ prefills the active search; backspace removes one code point", () => {
    const state = run(
      onTrace(multiSession()),
      { type: "setFilter", patch: { search: "a" } },
      {
        type: "openPrompt",
        kind: "search"
      }
    ).state;
    expect(state.prompt).toEqual({ kind: "search", text: "a" });
    const typed = run(state, { type: "promptInput", text: "😀" }, { type: "promptBackspace" }).state;
    expect(typed.prompt).toEqual({ kind: "search", text: "a" });
    const cleared = run(typed, { type: "promptClear" }, { type: "promptSubmit" }).state;
    expect(cleared.prompt).toBeNull();
    expect(cleared.filter.search).toBeNull();
  });

  it("runCommand closes the prompt and applies the action or shows the error", () => {
    const state = run(onTrace(multiSession()), { type: "openPrompt", kind: "command" }).state;
    const failed = run(state, { type: "runCommand", result: { error: "unknown command :x" } }).state;
    expect(failed.prompt).toBeNull();
    expect(failed.banner).toEqual({ level: "error", text: "unknown command :x" });
    const quit = run(state, { type: "runCommand", result: { type: "quit" } });
    expect(quit.effects).toEqual([{ kind: "quit" }]);
  });

  it("a banner answers one user action; session answers keep it", () => {
    const state = run(onTrace(multiSession()), { type: "showBanner", level: "info", text: "hello" }).state;
    const kept = run(state, { type: "readingProgress", spans: 3 }).state;
    expect(kept.banner).toEqual({ level: "info", text: "hello" });
    expect(run(kept, { type: "move", delta: 1 }).state.banner).toBeNull();
  });

  it("y copies the selected subtree as kosmo-text/v1 with --detail 0", () => {
    const trace = multiSession();
    const copied = run(onTrace(trace), { type: "selectRef", ref: ref("a") }, { type: "copySubtree" });
    const text = renderKosmoText(trace, { detail: 0, values: () => undefined, subtree: ref("a") });
    expect(copied.effects.at(-1)).toEqual({ kind: "copy", text });
  });

  it(":root changes the root, clears snippets and reloads the selected snippet", () => {
    const snippet: Snippet = { state: "ok", file: "src/a.ts", lines: [{ n: 1, text: "x" }], target: 1 };
    const state = run(
      onTrace(multiSession()),
      { type: "selectRef", ref: ref("a") },
      {
        type: "snippetLoaded",
        ref: ref("a"),
        snippet
      }
    ).state;
    expect(run(state, { type: "setRoot", dir: "../other" }).effects).toEqual([{ kind: "setRoot", dir: "../other" }]);
    const changed = run(state, { type: "rootChanged", root: "/other" });
    expect(changed.state.root).toBe("/other");
    expect(changed.effects).toEqual([{ kind: "loadSnippet", ref: ref("a"), location: { file: "src/a.ts", line: 1 } }]);
  });

  it("a failed lazy read shows read-error instead of a value", () => {
    // The answer to a request in flight: the selected span of a lazy (SQLite) trace.
    const lazy = model([span({ id: "a", order: 0 })]);
    const asked = onTrace(lazy);
    expect(asked.values.get(JSON.stringify(["t1", "s1", "a"]))).toBe("loading");
    const state = run(asked, { type: "valuesFailed", ref: ref("a"), reason: "disk I/O error" }).state;
    expect(state.values.get(JSON.stringify(["t1", "s1", "a"]))).toEqual({
      args: { state: "not-recorded", reason: "read-error: disk I/O error" },
      return: { state: "not-recorded", reason: "read-error: disk I/O error" },
      error: { state: "not-recorded", reason: "read-error: disk I/O error" }
    });
  });
});
