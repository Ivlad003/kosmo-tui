/**
 * Ported from kosmo-callflow tests/unit/cli-connect-view.test.ts. The assertions are
 * unchanged; selections are written as full refs and widths are measured with the
 * grapheme-aware visibleWidth instead of string.length.
 */
import { describe, expect, it } from "vitest";
import { visibleWidth } from "../src/ansi.js";
import { decodeKey } from "../src/keys.js";
import { connectionLine, renderFrame, selectionBanner } from "../src/render.js";
import {
  applyAction,
  applyDelta,
  initialViewState,
  selectionIndex,
  spanKey,
  visibleSpans,
  type ViewState
} from "../src/view-state.js";
import { connected, ref, span, trace } from "./view-fixtures.js";

function seeded(): ViewState {
  let state = initialViewState();
  state = applyDelta(state, connected());
  state = applyDelta(state, { kind: "traces", rows: [trace("t-1", 100), trace("t-2", 200)] });
  state = applyDelta(state, { kind: "spans", rows: [span("t-1", "s-1"), span("t-2", "s-2")] });
  return state;
}

describe("view state", () => {
  it("keeps the selected span on the same screen row when fifty rows sort in above it", () => {
    let state = initialViewState({ viewportHeight: 20 });
    state = applyDelta(state, connected());
    const existing = Array.from({ length: 100 }, (_, i) => span("t", `m-${String(i).padStart(3, "0")}`));
    state = applyDelta(state, { kind: "spans", rows: existing });
    state = { ...state, selection: ref("t", "m-050") };
    state = applyAction(state, { kind: "move", delta: 0 });

    const before = renderFrame(state, 80, 24);
    const rowBefore = before.findIndex((line) => line.startsWith(">"));
    expect(rowBefore).toBeGreaterThanOrEqual(0);
    expect(before[rowBefore]).toContain("m-050");

    const arrivals = Array.from({ length: 50 }, (_, i) => span("t", `a-${String(i).padStart(3, "0")}`));
    state = applyDelta(state, { kind: "spans", rows: arrivals });

    const after = renderFrame(state, 80, 24);
    const rowAfter = after.findIndex((line) => line.startsWith(">"));

    expect(state.selection).toEqual(ref("t", "m-050"));
    expect(state.selectionAbsence).toBeNull();
    expect(after[rowAfter]).toContain("m-050");
    expect(rowAfter).toBe(rowBefore);
  });

  it("honours the user's scroll position instead of recentring the list", () => {
    let state = initialViewState({ viewportHeight: 20 });
    state = applyDelta(state, connected());
    state = applyDelta(state, {
      kind: "spans",
      rows: Array.from({ length: 100 }, (_, i) => span("t", `m-${String(i).padStart(3, "0")}`))
    });
    state = applyAction(state, { kind: "moveTo", edge: "first" });
    for (let i = 0; i < 25; i += 1) state = applyAction(state, { kind: "move", delta: 1 });

    expect(selectionIndex(state)).toBe(25);
    expect(state.scrollTop).toBe(6);

    const frame = renderFrame(state, 80, 24);
    const marked = frame.findIndex((line) => line.startsWith(">"));
    const body = frame.slice(2, frame.length - 2);
    expect(frame[marked]).toContain("m-025");
    expect(marked - 2).toBe(body.length - 1);
  });

  it("renders different frames for different scroll positions", () => {
    let state = initialViewState({ viewportHeight: 20 });
    state = applyDelta(state, connected());
    state = applyDelta(state, {
      kind: "spans",
      rows: Array.from({ length: 100 }, (_, i) => span("t", `m-${String(i).padStart(3, "0")}`))
    });
    state = { ...state, selection: ref("t", "m-050") };

    const top = renderFrame({ ...state, scrollTop: 0 }, 80, 24);
    const scrolled = renderFrame({ ...state, scrollTop: 40 }, 80, 24);
    expect(top).not.toEqual(scrolled);
    expect(top.join("\n")).toContain("m-000");
    expect(scrolled.join("\n")).toContain("m-040");
    expect(scrolled.join("\n")).not.toContain("m-000");
  });

  it("keeps a selection near the list tail visible and correctly identified", () => {
    let state = seeded();
    state = { ...state, selection: ref("t-1", "s-1") };
    state = applyAction(state, { kind: "move", delta: 0 });

    const arrivals = Array.from({ length: 50 }, (_, i) => span(`new-${i}`, `ns-${String(i).padStart(3, "0")}`));
    state = applyDelta(state, {
      kind: "traces",
      rows: Array.from({ length: 50 }, (_, i) => trace(`new-${i}`, 1_000 + i))
    });
    state = applyDelta(state, { kind: "spans", rows: arrivals });

    expect(state.selection).toEqual(ref("t-1", "s-1"));
    expect(state.selectionAbsence).toBeNull();
    const marked = renderFrame(state, 80, 24).find((line) => line.startsWith(">"));
    expect(marked).toBeDefined();
    expect(marked).toContain("s-1");
  });

  it("pins the selection and explains it when retention drops the trace", () => {
    let state = seeded();
    state = { ...state, selection: ref("t-1", "s-1") };
    state = applyDelta(state, { kind: "spans", rows: [] });
    state = applyDelta(state, { kind: "retention", dropped: [trace("t-1", 100)] });

    expect(state.selection).toEqual(ref("t-1", "s-1"));
    expect(state.selectionAbsence).toBe("retention");
    expect(selectionBanner(state)).toContain("aged out of retention");
    expect(renderFrame(state, 80, 24).join("\n")).toContain("aged out of retention");
  });

  it("pins the selection and explains it when a filter hides the span", () => {
    let state = seeded();
    state = { ...state, selection: ref("t-1", "s-1") };
    state = applyAction(state, { kind: "filterErrorsOnly" });

    expect(state.selection).toEqual(ref("t-1", "s-1"));
    expect(state.selectionAbsence).toBe("filter");
    expect(selectionBanner(state)).toContain("hidden by the current filter");
  });

  it("clears the selection only on an explicit user action", () => {
    let state = seeded();
    state = { ...state, selection: ref("t-1", "s-1") };
    state = applyAction(state, { kind: "clearSelection" });
    expect(state.selection).toBeNull();
    expect(state.selectionAbsence).toBeNull();
  });

  it("freezes only the view while paused and applies the backlog on resume", () => {
    let state = seeded();
    state = applyAction(state, { kind: "togglePause" });
    state = applyDelta(state, { kind: "traces", rows: [trace("t-3", 300)] });
    state = applyDelta(state, { kind: "spans", rows: [span("t-3", "s-3")] });

    expect(state.traces.map((row) => row.traceId)).toEqual(["t-2", "t-1"]);
    expect(state.backlog).toHaveLength(2);

    state = applyAction(state, { kind: "togglePause" });
    expect(state.paused).toBe(false);
    expect(state.backlog).toHaveLength(0);
    expect(state.traces.map((row) => row.traceId)).toEqual(["t-3", "t-2", "t-1"]);
  });

  it("records a gap instead of dropping silently when the paused backlog overflows", () => {
    let state = { ...seeded(), paused: true, backlogCap: 2 };
    state = applyDelta(state, { kind: "traces", rows: [trace("a", 1)] });
    state = applyDelta(state, { kind: "traces", rows: [trace("b", 2)] });
    state = applyDelta(state, { kind: "traces", rows: [trace("c", 3)] });

    expect(state.backlog).toHaveLength(2);
    expect(state.backlogOverflowed).toBe(true);
    expect(state.retentionGap).toBe(true);
    expect(connectionLine(state)).toContain("backlog overflow");
  });

  it("distinguishes the three no-data states", () => {
    const disconnected = initialViewState({ connection: { kind: "disconnected", reason: "ECONNREFUSED" } });
    const noSdk = initialViewState({ connection: { kind: "connected", sdk: "absent" } });
    const noEvents = initialViewState({ connection: { kind: "connected", sdk: "present", events: "none" } });

    expect(renderFrame(disconnected, 80, 10).join("\n")).toContain("daemon unreachable");
    expect(renderFrame(noSdk, 80, 10).join("\n")).toContain("SDK not attached");
    expect(renderFrame(noEvents, 80, 10).join("\n")).toContain("nothing recorded yet");

    const messages = new Set([connectionLine(disconnected), connectionLine(noSdk), connectionLine(noEvents)]);
    expect(messages.size).toBe(3);
  });

  it("keeps expansion keyed by full span ref across new arrivals", () => {
    let state = seeded();
    state = applyDelta(state, { kind: "spans", rows: [span("t-1", "child", { parentSpanId: "s-1", depth: 1 })] });
    state = { ...state, selection: ref("t-1", "s-1") };
    state = applyAction(state, { kind: "toggleExpand" });
    expect(visibleSpans(state).some((row) => row.spanId === "child")).toBe(true);

    state = applyDelta(state, { kind: "traces", rows: [trace("zzz", 9_999)] });
    expect(state.expanded.has(spanKey(ref("t-1", "s-1")))).toBe(true);
    expect(visibleSpans(state).some((row) => row.spanId === "child")).toBe(true);
  });
});

describe("frame rendering", () => {
  it("emits exactly the requested number of rows and never exceeds the width", () => {
    const state = seeded();
    for (const [cols, rows] of [
      [80, 24],
      [40, 10],
      [24, 6],
      [200, 50]
    ] as const) {
      const frame = renderFrame(state, cols, rows);
      expect(frame).toHaveLength(rows);
      for (const line of frame) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
      }
    }
  });

  it("truncates a long node id in a narrow terminal instead of wrapping", () => {
    let state = seeded();
    state = applyDelta(state, {
      kind: "spans",
      rows: [span("t-1", "s-1", { nodeId: `src/${"very-long-".repeat(20)}.ts#run` })]
    });
    const frame = renderFrame(state, 30, 12);
    expect(frame.every((line) => visibleWidth(line) <= 30)).toBe(true);
    expect(frame.some((line) => line.endsWith("…"))).toBe(true);
  });

  it("emits no ANSI escapes, leaving styling to the terminal layer", () => {
    const frame = renderFrame(seeded(), 80, 24).join("\n");
    expect(/\u001b\[/.test(frame)).toBe(false);
  });

  it("is a pure function of its inputs", () => {
    const state = seeded();
    expect(renderFrame(state, 80, 24)).toEqual(renderFrame(state, 80, 24));
  });
});

describe("key decoding", () => {
  it("maps arrow keys and vi keys to the same movement actions", () => {
    expect(decodeKey("\u001b[A")).toEqual({ kind: "move", delta: -1 });
    expect(decodeKey("\u001b[B")).toEqual({ kind: "move", delta: 1 });
    expect(decodeKey("k")).toEqual({ kind: "move", delta: -1 });
    expect(decodeKey("j")).toEqual({ kind: "move", delta: 1 });
  });

  it("maps page and home/end sequences", () => {
    expect(decodeKey("\u001b[5~")).toEqual({ kind: "move", delta: -10 });
    expect(decodeKey("\u001b[6~")).toEqual({ kind: "move", delta: 10 });
    expect(decodeKey("\u001b[H")).toEqual({ kind: "moveTo", edge: "first" });
    expect(decodeKey("\u001b[F")).toEqual({ kind: "moveTo", edge: "last" });
  });

  it("treats ctrl-c and q as quit, and escape as clear selection", () => {
    expect(decodeKey("\u0003")).toEqual({ kind: "quit" });
    expect(decodeKey("q")).toEqual({ kind: "quit" });
    expect(decodeKey("\u001b")).toEqual({ kind: "clearSelection" });
  });

  it("ignores unknown input rather than guessing", () => {
    expect(decodeKey("\u001b[Z")).toBeUndefined();
    expect(decodeKey("Z")).toBeUndefined();
    expect(decodeKey("")).toBeUndefined();
  });
});
