/**
 * Full-identity semantics (spec "Повна identity та стабільний вибір", task 3.1).
 *
 * New in kosmo-tui: kosmo-callflow's viewer keyed selection, expansion and retention by
 * bare traceId/spanId, so two sessions that reuse ids were one row. Here every one of
 * those is keyed by `(datasetId, projectId, sessionId, traceId, spanId)`.
 */
import { replaySpanKey } from "@kosmo-callflow/replay";
import { describe, expect, it } from "vitest";
import { spanDetailFromEvents, spanRowsFromEvents } from "../src/detail.js";
import { renderFrame } from "../src/render.js";
import { buildReplayTimeline, framesFromEvents } from "../src/replay.js";
import {
  applyAction,
  applyDelta,
  initialViewState,
  spanKey,
  visibleSpans,
  type SpanRow,
  type ViewState
} from "../src/view-state.js";
import { SCOPE, connected, event, ref, span, trace } from "./view-fixtures.js";

/** Two sessions that both recorded trace "t" with root span "root" and a child "c". */
function twoSessions(): ViewState {
  let state = initialViewState();
  state = applyDelta(state, connected());
  state = applyDelta(state, {
    kind: "traces",
    rows: [trace("t", 100, "complete", "s-1"), trace("t", 200, "errored", "s-2")]
  });
  const rows: SpanRow[] = [
    span("t", "root", { sessionId: "s-1", nodeId: "src/a.ts#handle" }),
    span("t", "c", { sessionId: "s-1", parentSpanId: "root", depth: 1, nodeId: "src/a.ts#child" }),
    span("t", "root", { sessionId: "s-2", nodeId: "src/a.ts#handle", errored: true }),
    span("t", "c", { sessionId: "s-2", parentSpanId: "root", depth: 1, nodeId: "src/a.ts#child" })
  ];
  return applyDelta(state, { kind: "spans", rows });
}

describe("full span identity", () => {
  it("uses the shared replay key, so viewer and replay reducer agree on identity", () => {
    expect(spanKey(ref("t", "root", "s-2"))).toBe(replaySpanKey(ref("t", "root", "s-2")));
    expect(spanKey(ref("t", "root", "s-1"))).not.toBe(spanKey(ref("t", "root", "s-2")));
  });

  it("keeps two sessions with identical traceId/spanId as two distinct rows", () => {
    const state = twoSessions();
    expect(state.traces).toHaveLength(2);
    const roots = visibleSpans(state).filter((row) => row.spanId === "root");
    expect(roots.map((row) => row.sessionId)).toEqual(["s-1", "s-2"]);
  });

  it("does not switch the selection to the other session when moving onto an identical id", () => {
    let state = twoSessions();
    state = applyAction(state, { kind: "moveTo", edge: "first" });
    expect(state.selection).toEqual(ref("t", "root", "s-1"));

    state = applyAction(state, { kind: "move", delta: 1 });
    expect(state.selection).toEqual(ref("t", "root", "s-2"));
    // Moving back lands on s-1 again, not on "the first row named root".
    state = applyAction(state, { kind: "move", delta: -1 });
    expect(state.selection).toEqual(ref("t", "root", "s-1"));
  });

  it("keeps the selection on its own session when the other session's row is updated", () => {
    let state = twoSessions();
    state = { ...state, selection: ref("t", "root", "s-2") };
    state = applyAction(state, { kind: "move", delta: 0 });
    state = applyDelta(state, {
      kind: "spans",
      rows: [span("t", "root", { sessionId: "s-1", nodeId: "src/a.ts#renamed" })]
    });

    expect(state.selection).toEqual(ref("t", "root", "s-2"));
    expect(state.lastKnownSpan?.sessionId).toBe("s-2");
    expect(state.lastKnownSpan?.nodeId).toBe("src/a.ts#handle");
  });

  it("expands only the selected session's span", () => {
    let state = twoSessions();
    state = { ...state, selection: ref("t", "root", "s-1") };
    state = applyAction(state, { kind: "toggleExpand" });

    const children = visibleSpans(state).filter((row) => row.spanId === "c");
    expect(children.map((row) => row.sessionId)).toEqual(["s-1"]);
  });

  it("drops only the retained-out session's trace and pins a selection in it", () => {
    let state = twoSessions();
    state = { ...state, selection: ref("t", "root", "s-1") };
    state = applyDelta(state, { kind: "retention", dropped: [trace("t", 100, "complete", "s-1")] });

    expect(state.traces.map((row) => row.sessionId)).toEqual(["s-2"]);
    expect(state.spans.every((row) => row.sessionId === "s-2")).toBe(true);
    // The other session still holds "t"/"root", but that is not the selected span.
    expect(state.selection).toEqual(ref("t", "root", "s-1"));
    expect(state.selectionAbsence).toBe("retention");
  });

  it("distinguishes identical ids across datasets and projects, not only sessions", () => {
    let state = initialViewState();
    state = applyDelta(state, {
      kind: "spans",
      rows: [span("t", "root"), span("t", "root", { projectId: "other" }), span("t", "root", { datasetId: "import" })]
    });
    expect(state.spans).toHaveLength(3);
    state = { ...state, selection: { ...ref("t", "root"), projectId: "other" } };
    state = applyAction(state, { kind: "move", delta: 0 });
    expect(state.selection?.projectId).toBe("other");
    expect(state.selectionAbsence).toBeNull();
  });

  it("names the session in the frame only where bare ids collide", () => {
    const frame = renderFrame(twoSessions(), 80, 24).join("\n");
    expect(frame).toContain("t @s-1");
    expect(frame).toContain("t @s-2");
    expect(frame).toContain("src/a.ts#handle @s-1");
    expect(frame).toContain("src/a.ts#handle @s-2");

    let single = initialViewState();
    single = applyDelta(single, { kind: "traces", rows: [trace("t", 1)] });
    single = applyDelta(single, { kind: "spans", rows: [span("t", "root")] });
    expect(renderFrame(single, 80, 24).join("\n")).not.toContain("@");
  });

  it("marks only the selected session's trace in the trace list", () => {
    let state = twoSessions();
    state = { ...state, selection: ref("t", "root", "s-2") };
    const traceLines = renderFrame(state, 80, 24).filter((line) => /^[> ][!~ ] t @/.test(line));
    expect(traceLines).toHaveLength(2);
    expect(traceLines.find((line) => line.includes("@s-2"))!.startsWith(">")).toBe(true);
    expect(traceLines.find((line) => line.includes("@s-1"))!.startsWith(" ")).toBe(true);
  });

  it("builds rows and parent links from events per session, never across sessions", () => {
    const rows = spanRowsFromEvents(
      [
        event({ seq: 1, sessionId: "s-1", spanId: "root", type: "enter" }),
        event({ seq: 2, sessionId: "s-2", spanId: "root", type: "enter" }),
        // s-2's child names parent "p", which exists only in s-1: it must be re-rooted.
        event({ seq: 3, sessionId: "s-1", spanId: "p", type: "enter" }),
        event({ seq: 4, sessionId: "s-2", spanId: "c", parentSpanId: "p", type: "error" })
      ],
      SCOPE
    );
    expect(rows).toHaveLength(4);
    const orphan = rows.find((row) => row.sessionId === "s-2" && row.spanId === "c")!;
    expect(orphan.parentSpanId).toBeNull();
    expect(orphan.depth).toBe(0);
    expect(rows.find((row) => row.sessionId === "s-1" && row.spanId === "root")!.errored).toBe(false);
  });

  it("reads detail for the selected session only", () => {
    const events = [
      event({ seq: 1, sessionId: "s-1", spanId: "root", type: "enter", payload: { args: ["one"] } }),
      event({ seq: 2, sessionId: "s-2", spanId: "root", type: "enter", payload: { args: ["two"] } }),
      event({ seq: 3, sessionId: "s-2", spanId: "root", type: "error", payload: { message: "boom" } })
    ];
    const one = spanDetailFromEvents(events, ref("t-1", "root", "s-1"), null)!;
    const two = spanDetailFromEvents(events, ref("t-1", "root", "s-2"), null)!;

    expect(one.args).toEqual({ state: "recorded", text: '["one"]' });
    expect(one.status).toBe("running");
    expect(two.args).toEqual({ state: "recorded", text: '["two"]' });
    expect(two.status).toBe("errored");
    expect(two.sessionId).toBe("s-2");
  });

  it("keeps a replay selection on its own session across frames that hold both", () => {
    const frames = framesFromEvents(
      [
        event({ seq: 1, sessionId: "s-1", spanId: "root", type: "enter" }),
        event({ seq: 2, sessionId: "s-2", spanId: "root", type: "enter" }),
        event({ seq: 3, sessionId: "s-2", spanId: "root", type: "exit" })
      ],
      SCOPE
    );
    expect(
      frames
        .at(-1)!
        .state.traces.map((row) => row.sessionId)
        .sort()
    ).toEqual(["s-1", "s-2"]);

    let state: ViewState = {
      ...initialViewState(),
      replay: { timeline: buildReplayTimeline({ frames }), schedule: { mode: "manual" }, index: -1 },
      selection: ref("t-1", "root", "s-2")
    };
    state = applyAction(state, { kind: "replayStep", delta: 1 });
    // Frame 1 holds only s-1's "root": the s-2 selection is pinned, not retargeted.
    expect(state.selection).toEqual(ref("t-1", "root", "s-2"));
    expect(state.selectionAbsence).toBe("retention");

    state = applyAction(state, { kind: "replayStep", delta: 1 });
    expect(state.selectionAbsence).toBeNull();
    expect(state.lastKnownSpan?.sessionId).toBe("s-2");
  });
});
