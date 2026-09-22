/** Ported from kosmo-callflow tests/unit/cli-connect-viewer.test.ts. */
import { describe, expect, it, vi } from "vitest";
import type { Delta } from "../src/view-state.js";
import { CONNECT_PROPOSED_REFRESH_MS, parseRefreshMs, startViewer } from "../src/viewer.js";
import { trace } from "./view-fixtures.js";
import { fakeTimers, fakeViewerTerminal } from "./viewer-fakes.js";

describe("viewer loop", () => {
  it("paints an initial frame before any poll", () => {
    const t = fakeViewerTerminal();
    startViewer({
      terminal: t.terminal,
      timers: fakeTimers().timers,
      poll: async () => [],
      initial: [{ kind: "traces", rows: [trace("t-1", 1)] }]
    });

    expect(t.painted).toHaveLength(1);
    expect(t.painted[0]!.join("\n")).toContain("t-1");
  });

  it("uses the proposed 250ms refresh by default and honours an override", () => {
    const a = fakeTimers();
    startViewer({ terminal: fakeViewerTerminal().terminal, timers: a.timers, poll: async () => [] });
    expect(a.interval()).toBe(CONNECT_PROPOSED_REFRESH_MS);

    const b = fakeTimers();
    startViewer({ terminal: fakeViewerTerminal().terminal, timers: b.timers, poll: async () => [], refreshMs: 500 });
    expect(b.interval()).toBe(500);
  });

  it("folds polled deltas into the view and repaints", async () => {
    const t = fakeViewerTerminal();
    const poll = vi
      .fn<() => Promise<Delta[]>>()
      .mockResolvedValueOnce([{ kind: "traces", rows: [trace("t-2", 5)] }])
      .mockResolvedValue([]);
    const viewer = startViewer({ terminal: t.terminal, timers: fakeTimers().timers, poll });

    await viewer.tick();

    expect(poll).toHaveBeenCalledTimes(1);
    expect(viewer.state().traces.map((r) => r.traceId)).toEqual(["t-2"]);
    expect(t.painted.length).toBeGreaterThan(1);
  });

  it("keeps polling while paused and applies the backlog on resume, never dropping data", async () => {
    const t = fakeViewerTerminal();
    const viewer = startViewer({
      terminal: t.terminal,
      timers: fakeTimers().timers,
      poll: async () => [{ kind: "traces", rows: [trace("late", 9)] }]
    });

    t.press("p");
    expect(viewer.state().paused).toBe(true);

    await viewer.tick();
    expect(viewer.state().traces.map((r) => r.traceId)).toEqual([]);
    expect(viewer.state().backlog.length).toBe(1);

    t.press("p");
    expect(viewer.state().paused).toBe(false);
    expect(viewer.state().traces.map((r) => r.traceId)).toEqual(["late"]);
  });

  it("recomputes the viewport on resize", () => {
    const t = fakeViewerTerminal(24);
    const viewer = startViewer({ terminal: t.terminal, timers: fakeTimers().timers, poll: async () => [] });
    expect(viewer.state().viewportHeight).toBe(20);

    t.resize({ cols: 80, rows: 40 });
    expect(viewer.state().viewportHeight).toBe(36);
  });

  it("quits on q, clearing the interval and restoring the terminal exactly once", () => {
    const t = fakeViewerTerminal();
    const timers = fakeTimers();
    const onExit = vi.fn();
    startViewer({ terminal: t.terminal, timers: timers.timers, poll: async () => [], onExit });

    t.press("q");
    t.press("q");

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(timers.cleared()).toBe(1);
    expect(t.closeCount()).toBe(1);
  });

  it("stops painting and polling after close", async () => {
    const t = fakeViewerTerminal();
    const poll = vi.fn<() => Promise<Delta[]>>().mockResolvedValue([]);
    const viewer = startViewer({ terminal: t.terminal, timers: fakeTimers().timers, poll });
    const before = t.painted.length;

    viewer.close();
    await viewer.tick();

    expect(poll).not.toHaveBeenCalled();
    expect(t.painted).toHaveLength(before);
  });

  it("ignores keys it does not recognise rather than guessing", () => {
    const t = fakeViewerTerminal();
    const viewer = startViewer({ terminal: t.terminal, timers: fakeTimers().timers, poll: async () => [] });
    const before = viewer.state();

    t.press("\u001b[Z");
    t.press("Z");

    expect(viewer.state()).toBe(before);
  });
});

describe("refresh interval parsing", () => {
  it("accepts plain milliseconds and second suffixes", () => {
    expect(parseRefreshMs("250")).toBe(250);
    expect(parseRefreshMs("250ms")).toBe(250);
    expect(parseRefreshMs("2s")).toBe(2_000);
    expect(parseRefreshMs(" 500ms ")).toBe(500);
  });

  it("rejects values that are not a usable redraw rate", () => {
    for (const bad of ["0", "-1", "abc", "", "1ms", "120s", "NaN", "1.5", "10m"]) {
      expect(parseRefreshMs(bad), bad).toBeUndefined();
    }
  });
});
