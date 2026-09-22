/**
 * Task 2.5: capabilities come from the open result and the source's actual read API,
 * then the session policy narrows them. Footer hints and key handling use the result,
 * and an explicit command without its capability answers `unavailable(reason)`.
 */
import { describe, expect, it } from "vitest";
import {
  applySessionPolicy,
  checkCommand,
  effectiveCapabilities,
  sourceCapabilities,
  type Capabilities
} from "../src/capabilities.js";
import { decodeKey } from "../src/keys.js";
import { renderFrame } from "../src/render.js";
import { applyAction, applyDelta, initialViewState, type ViewState } from "../src/view-state.js";
import { startViewer } from "../src/viewer.js";
import { createFakeSource } from "./source-fake.js";
import { connected, ref, span, trace } from "./view-fixtures.js";
import { fakeTimers, fakeViewerTerminal } from "./viewer-fakes.js";

const NO_POLICY = { readOnly: false, noEval: false, print: false };
const signal = new AbortController().signal;

async function capsOf(options: Parameters<typeof createFakeSource>[0], policy = NO_POLICY): Promise<Capabilities> {
  const source = createFakeSource(options);
  return effectiveCapabilities(await source.open(signal), source, policy);
}

function footer(state: ViewState): string {
  return renderFrame(state, 200, 24).at(-1)!;
}

function seeded(caps: Capabilities): ViewState {
  let state = initialViewState({ caps });
  state = applyDelta(state, connected());
  state = applyDelta(state, { kind: "traces", rows: [trace("t-1", 1)] });
  state = applyDelta(state, { kind: "spans", rows: [span("t-1", "a")] });
  return { ...state, selection: ref("t-1", "a") };
}

describe("capabilities from the open result", () => {
  it("a legacy v1 summary stream has no projection, replay, values, probes or follow", async () => {
    const caps = await capsOf({
      kind: "stream",
      offers: {
        projectionVersions: [],
        projectionReason: "v1-summary-stream",
        follow: { available: false, reason: "producer-did-not-declare-follow" },
        replay: { available: false, reason: "v1-summary-stream" },
        values: { level: "none", reason: "v1-summary-stream" },
        probes: { available: false, reason: "v1-summary-stream" },
        staticGraph: { available: false, reason: "v1-summary-stream" },
        sql: { available: false, reason: "v1-summary-stream" }
      }
    });
    expect(caps.projectionVersions).toEqual([]);
    expect(caps.projection).toEqual({ available: false, reason: "v1-summary-stream" });
    expect(caps.replay).toEqual({ available: false, reason: "v1-summary-stream" });
    expect(caps.values).toEqual({ available: false, reason: "v1-summary-stream", level: "none" });
    expect(caps.probes.available).toBe(false);
    expect(caps.follow).toEqual({ available: false, reason: "producer-did-not-declare-follow" });
    // Review is a session capability, independent of the source.
    expect(caps.review).toEqual({ available: true });
    expect(checkCommand(caps, "compare")).toMatchObject({
      ok: false,
      notice: "compare: unavailable(v1-summary-stream)"
    });
  });

  it("values at count level is readable but promises no payload", async () => {
    const caps = await capsOf({ offers: { values: { level: "count" } }, implement: { details: true } });
    expect(caps.values).toEqual({ available: true, level: "count" });
    expect(caps.values.level).not.toBe("full");
  });

  it("a declared offer without the read API behind it is unavailable with its own reason", async () => {
    // The open result claims replay/probes/projection, but the source implements none.
    const caps = await capsOf({ implement: {} });
    expect(caps.replay).toEqual({ available: false, reason: "no-replay-records" });
    expect(caps.probes).toEqual({ available: false, reason: "no-probe-api" });
    expect(caps.projection).toEqual({ available: false, reason: "no-projection-api" });
    expect(caps.follow).toEqual({ available: false, reason: "no-delta-api" });
    expect(caps.values).toEqual({ available: false, reason: "no-details-api", level: "none" });

    const full = await capsOf({
      implement: { records: true, probes: true, canonical: true, deltas: true, details: true }
    });
    expect([full.replay, full.probes, full.projection, full.follow].every((cap) => cap.available)).toBe(true);
    expect(full.projectionVersions).toEqual([1, 2]);
  });

  it("an export without records keeps its own reason for missing replay", async () => {
    const caps = await capsOf({
      offers: {
        replay: { available: false, reason: "no-replay-records" },
        probes: { available: false, reason: "no-probe-records" }
      },
      implement: { records: true, probes: true, canonical: true }
    });
    expect(caps.replay).toEqual({ available: false, reason: "no-replay-records" });
    expect(caps.probes).toEqual({ available: false, reason: "no-probe-records" });
    expect(caps.projection.available).toBe(true);
  });
});

describe("session policy", () => {
  const base = (): Capabilities =>
    sourceCapabilities(
      {
        snapshot: { datasetId: "d", projectId: "p", revision: "r", watermark: 1, retentionEpoch: 1, snapshotId: "s" },
        offers: {
          projectionVersions: [2],
          follow: { available: true },
          replay: { available: true },
          values: { level: "full" },
          probes: { available: true },
          staticGraph: { available: true },
          sql: { available: true }
        },
        firstPage: { items: [], coverage: { scope: "complete", loaded: 0, total: 0 }, truncated: false, cursor: null },
        stableDataset: true
      },
      { records: async () => Promise.reject(new Error("x")) }
    );

  it("-r removes review and local eval", () => {
    const caps = applySessionPolicy(base(), { readOnly: true, noEval: false, print: false });
    expect(caps.review).toEqual({ available: false, reason: "read-only(-r)" });
    expect(caps.localEval).toEqual({ available: false, reason: "read-only(-r)" });
    expect(caps.interactive.available).toBe(true);
    expect(checkCommand(caps, "finding")).toMatchObject({ ok: false, notice: "finding: unavailable(read-only(-r))" });
    expect(checkCommand(caps, "eval")).toMatchObject({ ok: false, notice: "eval: unavailable(read-only(-r))" });
  });

  it("--no-eval removes only local eval", () => {
    const caps = applySessionPolicy(base(), { readOnly: false, noEval: true, print: false });
    expect(caps.localEval).toEqual({ available: false, reason: "eval-disabled(--no-eval)" });
    expect(caps.review.available).toBe(true);
    expect(checkCommand(caps, "todo")).toEqual({ ok: true });
  });

  it("--print removes review and every interactive action", () => {
    const caps = applySessionPolicy(base(), { readOnly: false, noEval: false, print: true });
    expect(caps.review).toEqual({ available: false, reason: "one-shot(--print)" });
    for (const command of ["bookmark", "stack", "replayStep", "yank", "compare"] as const) {
      expect(checkCommand(caps, command)).toMatchObject({
        ok: false,
        notice: `${command}: unavailable(one-shot(--print))`
      });
    }
    // Reads that one-shot output uses stay available.
    expect(checkCommand(caps, "sql")).toEqual({ ok: true });
  });

  it("policy never adds a capability the source lacks", () => {
    const caps = applySessionPolicy(
      { ...base(), replay: { available: false, reason: "no-replay-records" } },
      { readOnly: false, noEval: false, print: false }
    );
    expect(caps.replay).toEqual({ available: false, reason: "no-replay-records" });
  });
});

describe("effective caps in keys and footer", () => {
  const staticExport = (): Promise<Capabilities> =>
    capsOf(
      {
        offers: {
          follow: { available: false, reason: "static-snapshot" },
          replay: { available: false, reason: "no-replay-records" }
        },
        implement: { canonical: true, details: true }
      },
      { readOnly: true, noEval: false, print: false }
    );

  it("each explicit command without its capability shows its own unavailable notice", async () => {
    const state = seeded(await staticExport());
    const cases: Array<[string, string]> = [
      ["n", "replayStep: unavailable(no-replay-records)"],
      ["b", "replayStep: unavailable(no-replay-records)"],
      ["L", "returnToLive: unavailable(no-replay-records)"],
      ["p", "pause: unavailable(static-snapshot)"],
      ["f", "finding: unavailable(read-only(-r))"],
      ["t", "todo: unavailable(read-only(-r))"],
      ["R", "finalizeReview: unavailable(read-only(-r))"]
    ];
    for (const [key, notice] of cases) {
      const next = applyAction(state, decodeKey(key)!);
      expect(next.notice, key).toBe(notice);
      expect(footer(next), key).toContain(`! ${notice}`);
      // Nothing else changed: the gate is not a partial execution.
      expect({ ...next, notice: null }).toEqual(state);
    }
  });

  it("the notice is cleared by the next action and never changes the frame height", async () => {
    let state = seeded(await staticExport());
    state = applyAction(state, decodeKey("p")!);
    expect(renderFrame(state, 80, 24)).toHaveLength(24);
    state = applyAction(state, decodeKey("j")!);
    expect(state.notice).toBeNull();
    expect(state.paused).toBe(false);
  });

  it("footer hints advertise only what the effective caps allow", async () => {
    const readOnly = footer(seeded(await staticExport()));
    expect(readOnly).not.toContain("p pause");
    expect(readOnly).not.toContain("f/t review");
    expect(readOnly).toContain("m mark");
    expect(readOnly).toContain("s stack");

    const live = footer(
      seeded(await capsOf({ implement: { records: true, deltas: true, canonical: true, details: true, probes: true } }))
    );
    expect(live).toContain("p pause");
    expect(live).toContain("f/t review");
  });

  it("without capabilities the legacy footer and ungated keys stay exactly as before", () => {
    let state = initialViewState();
    state = applyDelta(state, connected());
    expect(footer(state)).toContain("j/k move  space expand  p pause  v view  d dsl  e errors  / search  q quit");
    state = applyAction(state, decodeKey("p")!);
    expect(state.paused).toBe(true);
    expect(state.notice).toBeNull();
  });

  it("reserved keys decode and, when their capability exists, say they are not built yet", async () => {
    const caps = await capsOf({ implement: { canonical: true, details: true, records: true, deltas: true } });
    for (const key of ["=", "y", "f"]) {
      const action = decodeKey(key);
      expect(action?.kind, key).toBe("command");
      const next = applyAction(seeded(caps), action!);
      expect(next.notice, key).toMatch(/: not available in this build yet$/);
    }
    // `:` is no longer reserved: with its capability it opens the command line (5b.1).
    const opened = applyAction(seeded(caps), decodeKey(":")!);
    expect(opened.notice).toBeNull();
    expect(opened.commandLine).toEqual({ text: "", historyIndex: null, draft: "" });
  });

  it("the viewer loop routes keys through the effective caps", async () => {
    const term = fakeViewerTerminal();
    const timers = fakeTimers();
    const viewer = startViewer({
      terminal: term.terminal,
      poll: async () => [],
      timers: timers.timers,
      capabilities: await staticExport(),
      initial: [connected(), { kind: "traces", rows: [trace("t-1", 1)] }, { kind: "spans", rows: [span("t-1", "a")] }]
    });
    term.press("n");
    expect(term.last()).toContain("! replayStep: unavailable(no-replay-records)");
    term.press("p");
    expect(viewer.state().paused).toBe(false);
    expect(term.last()).toContain("! pause: unavailable(static-snapshot)");
    viewer.close();
  });
});
