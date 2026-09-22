/**
 * Task 7.5: debounced details with generation/snapshot checks, one in-flight poll, auth
 * stop, 409 baseline replacement, reconnect backoff, static sources never poll, close.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyFailure, createSession, reconnectDelayMs, type SessionOptions } from "../src/session.js";
import { renderFrame } from "../src/render.js";
import { spanKey } from "../src/view-state.js";
import { fakeViewerTerminal } from "./viewer-fakes.js";
import { deltaBody, evidence, flush, httpError, liveFake, snapshotRef, spanRow, traceRow } from "./session-fakes.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const A = spanRow("t-1", "a");
const B = spanRow("t-1", "b");

/** A started live session with spans a and b loaded through one delta. */
async function started(extra: Parameters<typeof liveFake>[0] = {}, options: Partial<SessionOptions> = {}) {
  const fake = liveFake(extra);
  const session = createSession({ source: fake.source, random: () => 0.5, ...options });
  await session.start();
  await vi.advanceTimersByTimeAsync(250);
  fake.deltaCalls[0]!.resolve(deltaBody({ spans: [A, B] }));
  await flush();
  return { fake, session };
}

function frameText(session: ReturnType<typeof createSession>): string {
  return renderFrame(session.state(), 120, 30).join("\n");
}

describe("detail loader", () => {
  it("debounces selection changes by 50 ms and reads only the final selection", async () => {
    const { fake, session } = await started();
    session.press("j");
    await vi.advanceTimersByTimeAsync(20);
    session.press("j");
    await vi.advanceTimersByTimeAsync(49);
    expect(fake.detailCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.detailCalls.map((call) => call.ref.spanId)).toEqual(["b"]);
    await session.close();
  });

  it("drops a late response A after B even when the transport ignored abort", async () => {
    const { fake, session } = await started();
    session.press("j"); // a
    await vi.advanceTimersByTimeAsync(50);
    session.press("j"); // b
    await vi.advanceTimersByTimeAsync(50);
    const [callA, callB] = fake.detailCalls;
    expect(callA!.ref.spanId).toBe("a");
    expect(callB!.ref.spanId).toBe("b");
    // The session aborted A's read; this transport did not honour it.
    expect(callA!.signal.aborted).toBe(true);
    callB!.resolve(evidence(B, "value-of-b"));
    await flush();
    callA!.resolve(evidence(A, "value-of-a"));
    await flush();
    expect(session.state().detail?.spanId).toBe("b");
    expect(session.state().detail?.args).toEqual({ state: "recorded", text: "value-of-b" });
    expect(session.stats().staleDetailsIgnored).toBe(1);
    expect(frameText(session)).not.toContain("value-of-a");
    await session.close();
  });

  it("ignores a detail that answers after a retention reset", async () => {
    const { fake, session } = await started();
    session.press("j");
    await vi.advanceTimersByTimeAsync(50);
    const pending = fake.detailCalls[0]!;
    await vi.advanceTimersByTimeAsync(250);
    fake.deltaCalls[1]!.resolve(
      deltaBody({ reset: true, snapshot: snapshotRef({ retentionEpoch: 2, snapshotId: "snap-2" }), spans: [A] })
    );
    await flush();
    pending.resolve(evidence(A, "from-epoch-1"));
    await flush();
    expect(session.state().detail?.args).not.toEqual({ state: "recorded", text: "from-epoch-1" });
    expect(session.stats().staleDetailsIgnored).toBe(1);
    await session.close();
  });
});

describe("live polling", () => {
  it("keeps at most one delta read in flight however long it takes", async () => {
    const fake = liveFake();
    const session = createSession({ source: fake.source, refreshMs: 16 });
    await session.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.deltaCalls).toHaveLength(1);
    expect(session.stats().maxDeltaInFlight).toBe(1);
    fake.deltaCalls[0]!.resolve(deltaBody({ cursor: "c-2" }));
    await flush();
    await vi.advanceTimersByTimeAsync(249);
    expect(fake.deltaCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.deltaCalls).toHaveLength(2);
    // The next read continues from the cursor the previous answer returned.
    expect(fake.deltaCalls.map((call) => call.cursor)).toEqual(["cursor-1", "c-2"]);
    await session.close();
  });

  it("--refresh changes the redraw rate, not the read rate", async () => {
    const reads: number[] = [];
    const paints: number[] = [];
    for (const refreshMs of [16, 1_000]) {
      const fake = liveFake();
      const screen = fakeViewerTerminal();
      const session = createSession({ source: fake.source, terminal: screen.terminal, refreshMs });
      await session.start();
      for (let tick = 0; tick < 8; tick += 1) {
        await vi.advanceTimersByTimeAsync(250);
        fake.deltaCalls.at(-1)?.resolve(deltaBody({ traces: [traceRow(`t-${tick}`, tick)] }));
        await flush();
      }
      await vi.advanceTimersByTimeAsync(1);
      reads.push(fake.deltaCalls.length);
      paints.push(screen.painted.length);
      await session.close();
    }
    expect(reads[0]).toBe(reads[1]);
    expect(reads[0]).toBeLessThanOrEqual(8);
    expect(paints[0]).toBeGreaterThan(paints[1]!);
  });

  it("stops polling on 401/403 with a visible notice and no reconnect loop", async () => {
    for (const status of [401, 403]) {
      const fake = liveFake();
      const session = createSession({ source: fake.source });
      await session.start();
      await vi.advanceTimersByTimeAsync(250);
      fake.deltaCalls[0]!.reject(httpError(status));
      await flush();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fake.deltaCalls).toHaveLength(1);
      expect(session.stats().polling).toEqual({ state: "stopped", reason: `auth failed (${status})` });
      expect(frameText(session)).toContain(`auth failed (${status})`);
      await session.close();
    }
  });

  it("reconnects network and 5xx failures after 1..10 s with jitter", async () => {
    const fake = liveFake();
    const session = createSession({ source: fake.source, random: () => 1 });
    await session.start();
    await vi.advanceTimersByTimeAsync(250);
    const failures = [
      new TypeError("fetch failed"),
      httpError(503),
      httpError(500),
      httpError(502),
      httpError(504),
      httpError(503)
    ];
    for (const failure of failures) {
      fake.deltaCalls.at(-1)!.reject(failure);
      await flush();
      await vi.advanceTimersByTimeAsync(10_000);
    }
    const delays = session.stats().reconnectDelays;
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
    expect(fake.deltaCalls).toHaveLength(failures.length + 1);
    expect(session.state().connection).toMatchObject({ kind: "disconnected" });
    await session.close();
  });

  it("jitters inside the bounds", () => {
    for (let attempt = 1; attempt < 12; attempt += 1) {
      for (const r of [0, 0.3, 0.999]) {
        const delay = reconnectDelayMs(attempt, () => r);
        expect(delay).toBeGreaterThanOrEqual(1_000);
        expect(delay).toBeLessThanOrEqual(10_000);
      }
    }
    expect(reconnectDelayMs(4, () => 0)).toBeLessThan(reconnectDelayMs(4, () => 0.99));
    expect(classifyFailure(Object.assign(new Error("x"), { name: "AbortError" }))).toEqual({ kind: "aborted" });
    expect(classifyFailure(httpError(404))).toMatchObject({ kind: "fatal", status: 404 });
  });

  it("409 replaces the baseline atomically: stale rows go, the selection becomes a placeholder", async () => {
    const { fake, session } = await started({
      opens: [{ traces: [traceRow("t-1")] }, { snapshot: { retentionEpoch: 2 }, traces: [traceRow("t-new", 9)] }]
    });
    session.press("j");
    expect(session.state().selection?.spanId).toBe("a");
    await vi.advanceTimersByTimeAsync(250);
    fake.deltaCalls[1]!.reject(httpError(409));
    await flush();
    const state = session.state();
    expect(fake.opens()).toBe(2);
    expect(state.traces.map((row) => row.traceId)).toEqual(["t-new"]);
    expect(state.spans).toEqual([]);
    expect(state.retentionGap).toBe(true);
    expect(state.selection?.spanId).toBe("a");
    expect(state.selectionAbsence).toBe("retention");
    expect(state.notice).toContain("baseline replaced");
    // Polling continues from the new baseline's cursor.
    await vi.advanceTimersByTimeAsync(250);
    expect(fake.deltaCalls.at(-1)!.cursor).toBe("cursor-2");
    await session.close();
  });

  it("a reset body swaps every row in one step", async () => {
    const { fake, session } = await started();
    await vi.advanceTimersByTimeAsync(250);
    const C = spanRow("t-2", "c");
    fake.deltaCalls[1]!.resolve(
      deltaBody({ reset: true, snapshot: snapshotRef({ retentionEpoch: 3 }), traces: [traceRow("t-2")], spans: [C] })
    );
    await flush();
    expect(session.state().spans.map(spanKey)).toEqual([spanKey(C)]);
    expect(session.state().traces.map((row) => row.traceId)).toEqual(["t-2"]);
    expect(session.state().retentionGap).toBe(true);
    await session.close();
  });

  it("never polls export or sqlite sources, even when follow is offered", async () => {
    for (const kind of ["export", "sqlite"] as const) {
      const fake = liveFake({ kind });
      const session = createSession({ source: fake.source });
      await session.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fake.deltaCalls).toHaveLength(0);
      expect(session.stats().polling.state).toBe("off");
      await session.close();
    }
  });
});

describe("close()", () => {
  it("cancels timers and requests, restores the terminal once, and is idempotent", async () => {
    const { fake, session } = await started({}, { terminal: fakeViewerTerminal().terminal });
    session.press("j");
    await vi.advanceTimersByTimeAsync(250);
    const inFlight = fake.deltaCalls.at(-1)!;
    const closing = session.close();
    const again = session.close();
    await Promise.all([closing, again]);
    await session.close();
    expect(inFlight.signal.aborted).toBe(true);
    expect(fake.detailCalls.every((call) => call.signal.aborted)).toBe(true);
    expect(fake.closes()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    // A late answer after close changes nothing and schedules nothing.
    inFlight.resolve(deltaBody({ traces: [traceRow("late")] }));
    await flush();
    expect(session.state().traces.some((row) => row.traceId === "late")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes the terminal exactly once through q", async () => {
    const screen = fakeViewerTerminal();
    const onExit = vi.fn();
    const fake = liveFake();
    const session = createSession({ source: fake.source, terminal: screen.terminal, onExit });
    await session.start();
    screen.press("q");
    screen.press("q");
    await flush();
    await session.close();
    expect(screen.closeCount()).toBe(1);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(fake.closes()).toBe(1);
  });
});
