/**
 * Task 5.8: filters and search run over the explicitly labelled loaded scope; a hidden
 * or evicted selection keeps a placeholder with its reason; new rows move neither the
 * selection nor the viewport anchor.
 */
import { describe, expect, it } from "vitest";
import { renderFrame, selectionBanner } from "../src/render.js";
import {
  applyAction,
  applyDelta,
  initialViewState,
  selectedPlaceholder,
  visibleSpans,
  type ViewState
} from "../src/view-state.js";
import { connected, ref, span, trace } from "./view-fixtures.js";

const pad = (i: number): string => String(i).padStart(3, "0");

function loaded(count = 60): ViewState {
  let state = initialViewState({ viewportHeight: 10 });
  state = applyDelta(state, connected());
  state = applyDelta(state, { kind: "traces", rows: [trace("t", 1)] });
  state = applyDelta(state, {
    kind: "spans",
    rows: Array.from({ length: count }, (_, i) =>
      span("t", `m-${pad(i)}`, { errored: i % 3 === 0, spanKind: i % 2 === 0 ? "http.route" : "function" })
    )
  });
  return state;
}

function body(state: ViewState, cols = 120, rows = 16): string[] {
  const frame = renderFrame(state, cols, rows);
  return frame.slice(2, frame.length - 2);
}

/** The first span row on screen: the viewport anchor as the user sees it. */
function topSpanLine(state: ViewState): string {
  return body(state).find((line) => line.includes(".ts#run"))!;
}

describe("filters over the loaded scope", () => {
  it("filter by node id and span kind, and label the loaded scope", () => {
    let state = loaded(6);
    state = applyDelta(state, { kind: "scope", scope: { loaded: 6, total: 40, truncated: true } });
    state = applyAction(state, { kind: "setFilter", spanKind: "http.route" });
    expect(visibleSpans(state).map((row) => row.spanId)).toEqual(["m-000", "m-002", "m-004"]);
    state = applyAction(state, { kind: "setFilter", nodeId: "src/m-002.ts#run" });
    expect(visibleSpans(state).map((row) => row.spanId)).toEqual(["m-002"]);

    const footer = renderFrame(state, 200, 24).at(-1)!;
    expect(footer).toContain("[node=src/m-002.ts#run kind=http.route over loaded 6/40 rows, truncated]");

    state = applyAction(state, { kind: "setFilter", nodeId: null, spanKind: null });
    expect(visibleSpans(state)).toHaveLength(6);
  });

  it("rows without a span kind never match a kind filter", () => {
    let state = initialViewState();
    state = applyDelta(state, { kind: "spans", rows: [span("t", "a")] });
    state = applyAction(state, { kind: "setFilter", spanKind: "function" });
    expect(visibleSpans(state)).toEqual([]);
    state = applyDelta(state, connected());
    expect(body(state).join("\n")).toContain("no rows match the current filter");
  });
});

describe("selected-ref placeholder", () => {
  it("a filter that hides the selection keeps the ref and says why", () => {
    let state = loaded(6);
    state = { ...state, selection: ref("t", "m-001") };
    state = applyAction(state, { kind: "move", delta: 0 });
    state = applyAction(state, { kind: "filterErrorsOnly" });

    expect(state.selection).toEqual(ref("t", "m-001"));
    expect(selectedPlaceholder(state)).toMatchObject({ ref: ref("t", "m-001"), reason: "filter" });
    expect(selectedPlaceholder(state)!.lastKnown?.spanId).toBe("m-001");
    expect(body(state)[0]).toContain("selection hidden by the current filter");

    // Clearing the filter restores the same selection, not a neighbour.
    state = applyAction(state, { kind: "filterErrorsOnly" });
    expect(selectedPlaceholder(state)).toBeNull();
    expect(body(state).find((line) => line.startsWith(">") && line.includes(".ts#"))).toContain("m-001");
  });

  it("an evicted selection keeps a placeholder naming the span, distinct from filter and retention", () => {
    let state = loaded(6);
    state = { ...state, selection: ref("t", "m-004") };
    state = applyAction(state, { kind: "move", delta: 0 });
    state = applyDelta(state, { kind: "evict", spans: [ref("t", "m-004")] });

    expect(state.selection).toEqual(ref("t", "m-004"));
    expect(state.selectionAbsence).toBe("evicted");
    expect(selectedPlaceholder(state)).toMatchObject({ reason: "evicted" });
    expect(selectionBanner(state)).toBe(
      "selected span src/m-004.ts#run evicted from the loaded scope — showing last known values (reload to fetch it)"
    );
    // The row comes back on reload and the pin resolves by full ref.
    state = applyDelta(state, {
      kind: "spans",
      rows: [span("t", "m-004", { errored: false, spanKind: "http.route" })]
    });
    expect(state.selectionAbsence).toBeNull();
  });

  it("a span with the same ids in another session does not satisfy an evicted pin", () => {
    let state = loaded(3);
    state = { ...state, selection: ref("t", "m-001") };
    state = applyDelta(state, { kind: "evict", spans: [ref("t", "m-001")] });
    state = applyDelta(state, { kind: "traces", rows: [trace("t", 1, "complete", "s-2")] });
    state = applyDelta(state, { kind: "spans", rows: [span("t", "m-001", { sessionId: "s-2" })] });
    expect(state.selection).toEqual(ref("t", "m-001"));
    expect(state.selectionAbsence).toBe("evicted");
  });
});

describe("new rows and the viewport anchor", () => {
  it("rows arriving above a visible selection keep it on the same screen line", () => {
    let state = loaded(60);
    state = { ...state, selection: ref("t", "m-030") };
    state = applyAction(state, { kind: "move", delta: 0 });
    const before = body(state).findIndex((line) => line.startsWith(">") && line.includes(".ts#"));
    state = applyDelta(state, {
      kind: "spans",
      rows: Array.from({ length: 12 }, (_, i) => span("t", `a-${pad(i)}`))
    });
    expect(state.selection).toEqual(ref("t", "m-030"));
    expect(body(state).findIndex((line) => line.startsWith(">") && line.includes(".ts#"))).toBe(before);
  });

  it("rows arriving while the selection is hidden do not scroll the viewport", () => {
    let state = loaded(60);
    // Scroll down by moving, then hide the selection behind a filter that keeps rows.
    state = applyAction(state, { kind: "moveTo", edge: "first" });
    for (let i = 0; i < 25; i += 1) state = applyAction(state, { kind: "move", delta: 1 });
    state = applyAction(state, { kind: "setFilter", spanKind: "http.route" });
    expect(state.selectionAbsence).toBe("filter");
    const top = topSpanLine(state);
    expect(top).not.toContain("m-000");

    state = applyDelta(state, {
      kind: "spans",
      rows: Array.from({ length: 8 }, (_, i) => span("t", `a-${pad(i)}`, { spanKind: "http.route" }))
    });
    expect(state.selection).toEqual(ref("t", "m-025"));
    expect(topSpanLine(state)).toBe(top);
  });

  it("rows arriving with no selection keep the top row anchored", () => {
    let state = loaded(60);
    state = { ...state, scrollTop: 20 };
    const top = topSpanLine(state);
    expect(top).toContain("m-020");
    state = applyDelta(state, { kind: "spans", rows: [span("t", "a-000"), span("t", "a-001")] });
    expect(state.selection).toBeNull();
    expect(topSpanLine(state)).toBe(top);
  });

  it("the search filter keeps a still-visible selection on its screen line", () => {
    let state = loaded(60);
    state = { ...state, selection: ref("t", "m-040") };
    state = applyAction(state, { kind: "move", delta: 0 });
    for (const text of ["/", "m-0"]) {
      state = text === "/" ? applyAction(state, { kind: "search" }) : applyAction(state, { kind: "searchInput", text });
    }
    const before = body(state).findIndex((line) => line.startsWith(">") && line.includes(".ts#"));
    state = applyAction(state, { kind: "searchCommit" });
    expect(state.selectionAbsence).toBeNull();
    expect(body(state).findIndex((line) => line.startsWith(">") && line.includes(".ts#"))).toBe(before);
  });
});
