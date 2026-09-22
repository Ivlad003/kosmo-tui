/**
 * Ported from kosmo-callflow tests/unit/cli-connect-replay.test.ts; the contract under
 * test is src/replay-clock.md. The `runConnect` flag cases (INVALID_ARGUMENT before any
 * I/O) stay in kosmo-callflow with the CLI command they exercise.
 */
import { describe, expect, it } from "vitest";
import type { TraceEventView } from "../src/detail.js";
import { decodeKey } from "../src/keys.js";
import { connectionLine } from "../src/render.js";
import {
  REPLAY_PROPOSED_STEP_MS,
  buildReplayTimeline,
  framesFromEvents,
  parseReplaySpeed,
  parseReplayStepInterval,
  planReplaySchedule,
  type ReplayFrameInput
} from "../src/replay.js";
import { applyAction, initialViewState, type ReplaySession, type ViewState } from "../src/view-state.js";
import { startViewer } from "../src/viewer.js";
import { SCOPE, ref, span, trace } from "./view-fixtures.js";
import { fakeTimers, fakeViewerTerminal } from "./viewer-fakes.js";

function frame(seq: number, overrides: Partial<ReplayFrameInput> = {}): ReplayFrameInput {
  return {
    seq,
    sessionId: "s-1",
    clock: { domain: "monotonic", value: seq * 1_000 },
    state: {
      traces: [trace(`t-${seq}`, seq)],
      spans: [span(`t-${seq}`, `sp-${seq}`, { nodeId: `src/a.ts#f${seq}` })]
    },
    ...overrides
  };
}

function session(overrides: Partial<ReplaySession> = {}): ReplaySession {
  const timeline = buildReplayTimeline({ frames: [frame(1), frame(2), frame(3)] });
  return { timeline, schedule: { mode: "manual" }, index: 0, ...overrides };
}

describe("replay flag validation", () => {
  it("accepts the inclusive 0.1..10 range and rejects everything outside it", () => {
    for (const good of ["0.1", "1", "2.5", "10"]) {
      expect(parseReplaySpeed(good), good).toMatchObject({ ok: true });
    }
    for (const bad of [
      "0.09",
      "10.1",
      "0",
      "-1",
      "-0.5",
      "100",
      "NaN",
      "Infinity",
      "-Infinity",
      "",
      " ",
      "fast",
      "1e400"
    ]) {
      const parsed = parseReplaySpeed(bad);
      expect(parsed.ok, bad).toBe(false);
      expect(parsed.ok === false && parsed.error.code, bad).toBe("INVALID_ARGUMENT");
    }
  });

  it("parses a step interval as a duration, separately from the speed multiplier", () => {
    expect(parseReplayStepInterval("300ms")).toMatchObject({ ok: true, value: 300 });
    expect(parseReplayStepInterval("2s")).toMatchObject({ ok: true, value: 2_000 });
    for (const bad of ["0", "1ms", "10m", "abc", "0.5s"]) {
      expect(parseReplayStepInterval(bad).ok, bad).toBe(false);
    }
  });
});

describe("Q20 timeline semantics", () => {
  it("orders frames by observation seq and breaks ties by session and localSeq", () => {
    const timeline = buildReplayTimeline({
      frames: [frame(7, { sessionId: "s-b", localSeq: 2 }), frame(7, { sessionId: "s-a", localSeq: 9 }), frame(3)]
    });
    expect(timeline.frames.map((f) => `${f.seq}:${f.sessionId}`)).toEqual(["3:s-1", "7:s-a", "7:s-b"]);
  });

  it("does not treat a hole in the seq numbers as a missing frame", () => {
    const timeline = buildReplayTimeline({ frames: [frame(1), frame(5)] });
    expect(timeline.missingSeqs).toEqual([]);
  });

  it("reports a declared seq that the recording does not hold, instead of skipping it", () => {
    const timeline = buildReplayTimeline({ frames: [frame(1), frame(3)], requestedSeqs: [1, 2, 3] });
    expect(timeline.missingSeqs).toEqual([2]);

    const state = { ...initialViewState(), replay: session({ timeline }) };
    expect(connectionLine(state)).toContain("missing seq: 2");
  });

  it("falls back honestly when the frames span unsynced clock domains", () => {
    const timeline = buildReplayTimeline({
      frames: [frame(1, { sessionId: "s-a" }), frame(2, { sessionId: "s-b" })]
    });
    expect(timeline.alignment).toMatchObject({ kind: "unaligned" });

    const schedule = planReplaySchedule(timeline, { speed: 4 });
    expect(schedule).toMatchObject({ mode: "speed-fallback", speed: 4, intervalMs: REPLAY_PROPOSED_STEP_MS });
    expect(schedule.mode === "speed-fallback" && schedule.reason).toContain("unsynced clock domains");

    const line = connectionLine({ ...initialViewState(), replay: session({ timeline, schedule }) });
    expect(line).toContain("speed x4 unavailable");
    expect(line).toContain("unsynced clock domains");
  });

  it("falls back when the recording carries no source clock, rather than using arrival order as time", () => {
    const timeline = buildReplayTimeline({ frames: [frame(1, { clock: null }), frame(2, { clock: null })] });
    const schedule = planReplaySchedule(timeline, { speed: 2 });
    expect(schedule).toMatchObject({ mode: "speed-fallback" });
    expect(schedule.mode === "speed-fallback" && schedule.reason).toContain("no source clock");
  });

  it("scales same-domain intervals by the multiplier and never turns a seq delta into a duration", () => {
    const timeline = buildReplayTimeline({
      frames: [
        frame(1, { clock: { domain: "monotonic", value: 0 } }),
        frame(9, { clock: { domain: "monotonic", value: 400 } }),
        frame(10, { clock: { domain: "monotonic", value: 1_000 } })
      ]
    });
    const schedule = planReplaySchedule(timeline, { speed: 2 });
    expect(schedule).toMatchObject({ mode: "speed", delaysMs: [0, 200, 300] });

    const line = connectionLine({ ...initialViewState(), replay: session({ timeline, schedule, index: 1 }) });
    expect(line).toContain("seq=9");
    expect(line).not.toMatch(/seq[^|]*\d+\s*ms/);
  });

  it("marks an aggregate range as window-level replay with no per-call ordering", () => {
    const timeline = buildReplayTimeline({ frames: [frame(1), frame(2, { granularity: "aggregate-window" })] });
    expect(timeline.windowOnly).toBe(true);

    const line = connectionLine({ ...initialViewState(), replay: session({ timeline }) });
    expect(line).toContain("window-level replay only");
    expect(line).toContain("per-call order unavailable");
  });

  it("derives aggregate granularity from the capture policy the events were recorded under", () => {
    const events: TraceEventView[] = [
      {
        seq: 1,
        sessionId: "s-1",
        traceId: "t",
        spanId: "a",
        parentSpanId: null,
        type: "enter",
        nodeId: "src/a.ts#f",
        ts: 1,
        capture: { mode: "aggregate" }
      }
    ];
    expect(buildReplayTimeline({ frames: framesFromEvents(events, SCOPE) }).windowOnly).toBe(true);
  });
});

describe("manual stepping between recorded projection states", () => {
  it("steps forward and back through the recorded states", () => {
    let state: ViewState = { ...initialViewState(), replay: session() };
    state = applyAction(state, { kind: "replayStep", delta: 1 });
    expect(state.replay!.index).toBe(1);
    expect(state.traces.map((t) => t.traceId)).toEqual(["t-2"]);

    state = applyAction(state, { kind: "replayStep", delta: 1 });
    expect(state.spans.map((s) => s.spanId)).toEqual(["sp-3"]);

    state = applyAction(state, { kind: "replayStep", delta: -1 });
    expect(state.replay!.index).toBe(1);
    expect(state.traces.map((t) => t.traceId)).toEqual(["t-2"]);
  });

  it("parks at the ends of the recording instead of wrapping or rejoining live", () => {
    let state: ViewState = { ...initialViewState(), replay: session({ index: 2 }) };
    state = applyAction(state, { kind: "replayStep", delta: 1 });
    expect(state.replay!.index).toBe(2);
    expect(state.replay).not.toBeNull();

    state = applyAction(state, { kind: "replayStep", delta: -1 });
    state = applyAction(state, { kind: "replayStep", delta: -1 });
    state = applyAction(state, { kind: "replayStep", delta: -1 });
    expect(state.replay!.index).toBe(0);
    expect(state.replay).not.toBeNull();
  });

  it("keeps a selection that is absent from the stepped-to state pinned and explained", () => {
    let state: ViewState = { ...initialViewState(), replay: session(), selection: ref("t-1", "sp-1") };
    state = applyAction(state, { kind: "replayStep", delta: 1 });

    expect(state.selection).toEqual(ref("t-1", "sp-1"));
    expect(state.selectionAbsence).toBe("retention");
  });

  it("returns to live only on the explicit action", () => {
    const state: ViewState = { ...initialViewState(), replay: session({ index: 2 }) };
    expect(applyAction(state, { kind: "replayStep", delta: 1 }).replay).not.toBeNull();
    expect(applyAction(state, { kind: "move", delta: 1 }).replay).not.toBeNull();
    expect(applyAction(state, { kind: "togglePause" }).replay).not.toBeNull();

    expect(applyAction(state, { kind: "returnToLive" }).replay).toBeNull();
  });

  it("binds n, b and L to stepping and to the explicit return to live", () => {
    expect(decodeKey("n")).toEqual({ kind: "replayStep", delta: 1 });
    expect(decodeKey("b")).toEqual({ kind: "replayStep", delta: -1 });
    expect(decodeKey("L")).toEqual({ kind: "returnToLive" });
  });
});

describe("scheduled replay stepping runs on a fake clock", () => {
  it("advances one recorded state per step interval and never past the end", async () => {
    let now = 0;
    const timeline = buildReplayTimeline({ frames: [frame(1), frame(2), frame(3)] });
    const viewer = startViewer({
      terminal: fakeViewerTerminal().terminal,
      timers: fakeTimers().timers,
      poll: async () => [],
      now: () => now,
      replay: { timeline, schedule: { mode: "step-interval", intervalMs: 300 }, index: 0 }
    });

    now = 299;
    await viewer.tick();
    expect(viewer.state().replay!.index).toBe(0);

    now = 300;
    await viewer.tick();
    expect(viewer.state().replay!.index).toBe(1);

    now = 900;
    await viewer.tick();
    now = 1_500;
    await viewer.tick();
    expect(viewer.state().replay!.index).toBe(2);
    expect(viewer.state().replay).not.toBeNull();
  });

  it("uses the per-frame source-clock delay under --speed", async () => {
    let now = 0;
    const timeline = buildReplayTimeline({
      frames: [
        frame(1, { clock: { domain: "monotonic", value: 0 } }),
        frame(2, { clock: { domain: "monotonic", value: 1_000 } })
      ]
    });
    const schedule = planReplaySchedule(timeline, { speed: 10 });
    const viewer = startViewer({
      terminal: fakeViewerTerminal().terminal,
      timers: fakeTimers().timers,
      poll: async () => [],
      now: () => now,
      replay: { timeline, schedule, index: 0 }
    });

    now = 99;
    await viewer.tick();
    expect(viewer.state().replay!.index).toBe(0);

    now = 100;
    await viewer.tick();
    expect(viewer.state().replay!.index).toBe(1);
  });

  it("does not advance by itself in manual mode", async () => {
    let now = 0;
    const term = fakeViewerTerminal();
    const viewer = startViewer({
      terminal: term.terminal,
      timers: fakeTimers().timers,
      poll: async () => [],
      now: () => now,
      replay: session()
    });

    now = 10_000;
    await viewer.tick();
    expect(viewer.state().replay!.index).toBe(0);

    term.press("n");
    expect(viewer.state().replay!.index).toBe(1);
  });
});
