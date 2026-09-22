/**
 * Ported from kosmo-callflow tests/unit/cli-connect-refresh.test.ts.
 *
 * The `runConnect` cases (flag validation before I/O, read-only GETs while paused) stay
 * in kosmo-callflow: they exercise the CLI command and its HTTP transport, which are not
 * part of kosmo-tui. What moves is everything the viewer itself owns.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { connectionLine } from "../src/render.js";
import { applyDelta, initialViewState, type Delta } from "../src/view-state.js";
import { CONNECT_PROPOSED_REFRESH_MS, startViewer, type ViewerTimers } from "../src/viewer.js";
import { ref, trace } from "./view-fixtures.js";
import { fakeViewerTerminal } from "./viewer-fakes.js";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

describe("refresh cadence", () => {
  it("drives the viewer interval from an accepted value", () => {
    const seen: number[] = [];
    const timers: ViewerTimers = {
      setInterval: (_fn, ms) => {
        seen.push(ms);
        return "h";
      },
      clearInterval: () => undefined
    };
    startViewer({ terminal: fakeViewerTerminal().terminal, timers, poll: async () => [], refreshMs: 2_000 });
    expect(seen).toEqual([2_000]);
  });

  it("keeps 250ms labelled a proposed default and never promises a latency", () => {
    expect(CONNECT_PROPOSED_REFRESH_MS).toBe(250);
    const sources = ["viewer.ts", "replay.ts"].map((file) => readFileSync(path.join(srcDir, file), "utf8"));
    for (const source of sources) {
      expect(source).toMatch(/PROPOSED default|proposed default/);
      expect(source).toMatch(/not a latency guarantee|pending calibration/);
      expect(source).not.toMatch(/latency SLA|guaranteed latency|guarantees .{0,20}ms/);
    }
  });
});

describe("pause freezes the view only", () => {
  it("keeps polling while paused, parks the data and applies it on resume", async () => {
    const term = fakeViewerTerminal(24, 100);
    let polls = 0;
    const viewer = startViewer({
      terminal: term.terminal,
      timers: { setInterval: () => "h", clearInterval: () => undefined },
      poll: async () => {
        polls += 1;
        return [{ kind: "traces", rows: [trace(`t-${polls}`, polls)] }] as Delta[];
      }
    });

    await viewer.tick();
    expect(viewer.state().traces).toHaveLength(1);

    term.press("p");
    expect(viewer.state().paused).toBe(true);

    await viewer.tick();
    await viewer.tick();
    expect(polls).toBe(3);
    expect(viewer.state().traces).toHaveLength(1);
    expect(viewer.state().backlog).toHaveLength(2);

    term.press("p");
    expect(viewer.state().paused).toBe(false);
    expect(viewer.state().traces.map((row) => row.traceId)).toEqual(["t-3", "t-2", "t-1"]);
  });

  it("states how far behind live a paused view is, and bounds the backlog", () => {
    let state = { ...initialViewState(), paused: true, backlogCap: 2 };
    state = applyDelta(state, { kind: "traces", rows: [trace("a", 1)] });
    expect(connectionLine(state)).toContain("behind live by 1 parked update(s)");

    state = applyDelta(state, { kind: "traces", rows: [trace("b", 2)] });
    state = applyDelta(state, { kind: "traces", rows: [trace("c", 3)] });
    expect(state.backlog).toHaveLength(2);
    expect(state.backlogOverflowed).toBe(true);
    const line = connectionLine(state);
    expect(line).toContain("backlog overflow");
    expect(line).toContain("retention gap");
  });

  it("keeps the evidence already on screen while paused", () => {
    let state = initialViewState();
    state = applyDelta(state, { kind: "traces", rows: [trace("kept", 1)] });
    state = applyDelta(state, {
      kind: "detail",
      detail: {
        ...ref("kept", "root"),
        nodeId: "src/a.ts#f",
        status: "errored",
        args: { state: "recorded", text: "[7]" },
        ret: { state: "not-recorded" },
        error: { state: "recorded", text: "boom" },
        duration: { state: "recorded", ms: 4 },
        anchor: { file: "src/a.ts", symbol: "f", line: 1 },
        document: null
      }
    });

    const paused = applyDelta({ ...state, paused: true }, { kind: "traces", rows: [trace("new", 2)] });

    expect(paused.detail?.args).toEqual({ state: "recorded", text: "[7]" });
    expect(paused.traces.map((row) => row.traceId)).toEqual(["kept"]);
  });
});
