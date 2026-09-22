/**
 * Task 7.6: finite frame queue (1,000 frames / 8 MiB) and cache (64 MiB) with explicit
 * gap/truncated markers; a slow consumer is held to both count and byte bounds, and the
 * selected-ref placeholder does not pin an unbounded payload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BoundedQueue,
  ByteLru,
  CACHE_MAX_BYTES,
  FRAME_QUEUE_MAX_BYTES,
  FRAME_QUEUE_MAX_FRAMES,
  jsonBytes
} from "../src/bounds.js";
import { renderFrame } from "../src/render.js";
import { DETAIL_VALUE_MAX_BYTES, createSession } from "../src/session.js";
import { selectedPlaceholder } from "../src/view-state.js";
import { deltaBody, evidence, flush, liveFake, spanRow, traceRow } from "./session-fakes.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("bounded containers", () => {
  it("ships the design caps", () => {
    expect(FRAME_QUEUE_MAX_FRAMES).toBe(1_000);
    expect(FRAME_QUEUE_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(CACHE_MAX_BYTES).toBe(64 * 1024 * 1024);
  });

  it("the queue refuses rather than overwrites, by count and by bytes", () => {
    const queue = new BoundedQueue<string>({ maxItems: 3, maxBytes: 100 });
    expect(queue.push("a", 10)).toBe(true);
    expect(queue.push("b", 10)).toBe(true);
    expect(queue.push("c", 90)).toBe(false);
    expect(queue.push("c", 10)).toBe(true);
    expect(queue.push("d", 1)).toBe(false);
    expect([queue.size, queue.bytes, queue.overflowed]).toEqual([3, 30, 2]);
    expect(queue.drain()).toEqual(["a", "b", "c"]);
    expect(queue.overflowed).toBe(2);
    queue.reset();
    expect(queue.overflowed).toBe(0);
  });

  it("the LRU evicts oldest first, names what it evicted and never exceeds its budget", () => {
    const cache = new ByteLru<string, string>(100);
    cache.set("a", "x", 40);
    cache.set("b", "x", 40);
    cache.get("a");
    expect(cache.set("c", "x", 40)).toEqual(["b"]);
    expect(cache.keys()).toEqual(["a", "c"]);
    expect(cache.set("huge", "x", 101)).toEqual(["huge"]);
    expect(cache.bytes).toBe(80);
    expect(jsonBytes({ text: "日本" })).toBe(Buffer.byteLength('{"text":"日本"}'));
  });
});

async function pausedLiveSession(frame: (index: number) => Parameters<typeof deltaBody>[0]) {
  const fake = liveFake({ opens: [{ traces: [traceRow("t-1")] }, { traces: [traceRow("t-after")] }] });
  const session = createSession({ source: fake.source });
  await session.start();
  session.press("p");
  expect(session.state().paused).toBe(true);
  return {
    fake,
    session,
    /** Answer `count` polls while paused: the consumer (the view) does not keep up. */
    async feed(count: number) {
      for (let index = 0; index < count; index += 1) {
        await vi.advanceTimersByTimeAsync(250);
        fake.deltaCalls.at(-1)!.resolve(deltaBody({ cursor: `c-${index}`, ...frame(index) }));
        await flush();
      }
    }
  };
}

describe("slow consumer", () => {
  it("parks at most 1,000 frames, marks the gap and reloads a baseline on resume", async () => {
    const { fake, session, feed } = await pausedLiveSession((index) => ({ traces: [traceRow(`t-${index}`, index)] }));
    await feed(1_200);
    const stats = session.stats();
    expect(stats.queueFrames).toBe(1_000);
    expect(stats.queueRefused).toBe(200);
    expect(stats.queueBytes).toBeLessThanOrEqual(FRAME_QUEUE_MAX_BYTES);
    expect(stats.maxDeltaInFlight).toBe(1);
    // Frozen view: nothing parked was applied, and the gap is visible.
    expect(session.state().traces.map((row) => row.traceId)).toEqual(["t-1"]);
    const header = renderFrame(session.state(), 160, 24)[0]!;
    expect(header).toContain("backlog overflow");
    expect(header).toContain("retention gap");

    session.press("p");
    await flush();
    expect(fake.opens()).toBe(2);
    expect(session.state().traces.map((row) => row.traceId)).toEqual(["t-after"]);
    expect(session.state().notice).toContain("frame queue overflow: 200 frame(s) refused");
    expect(session.stats().queueFrames).toBe(0);
    await session.close();
  });

  it("holds the 8 MiB byte bound before the count bound with large frames", async () => {
    const big = "x".repeat(100 * 1024);
    const { session, feed } = await pausedLiveSession((index) => ({
      spans: [spanRow("t-1", `s-${index}`, { nodeId: `${big}${index}` })]
    }));
    await feed(120);
    const stats = session.stats();
    expect(stats.queueBytes).toBeLessThanOrEqual(FRAME_QUEUE_MAX_BYTES);
    expect(stats.queueFrames).toBeLessThan(FRAME_QUEUE_MAX_FRAMES);
    expect(stats.queueFrames).toBeGreaterThan(70);
    expect(stats.queueRefused).toBe(120 - stats.queueFrames);
    await session.close();
  });

  it("applies a queue without overflow in order on resume", async () => {
    const { fake, session, feed } = await pausedLiveSession((index) => ({
      traces: [traceRow(`t-${index}`, index + 2)]
    }));
    await feed(3);
    expect(session.state().traces.map((row) => row.traceId)).toEqual(["t-1"]);
    session.press("p");
    await flush();
    expect(fake.opens()).toBe(1);
    // t-1 from the queue replaces the baseline row with the same full ref.
    expect(session.state().traces.map((row) => [row.traceId, row.startedAt])).toEqual([
      ["t-2", 4],
      ["t-1", 3],
      ["t-0", 2]
    ]);
    await session.close();
  });
});

describe("cache budget", () => {
  it("evicts rows and details within the byte cap, with a visible truncated marker", async () => {
    const cacheBytes = 64 * 1024;
    const fake = liveFake();
    const session = createSession({ source: fake.source, limits: { cacheBytes } });
    await session.start();
    const payload = "v".repeat(900);
    for (let batch = 0; batch < 20; batch += 1) {
      await vi.advanceTimersByTimeAsync(250);
      const spans = Array.from({ length: 10 }, (_, index) =>
        spanRow("t-1", `b${batch}-${index}`, { nodeId: `src/${payload}.ts#f${batch}_${index}` })
      );
      fake.deltaCalls.at(-1)!.resolve(deltaBody({ spans }));
      await flush();
    }
    const stats = session.stats();
    expect(stats.cacheBytes).toBeLessThanOrEqual(cacheBytes);
    expect(stats.evictedRows).toBeGreaterThan(0);
    expect(session.state().spans.length).toBeLessThan(200);
    expect(session.state().scope).toMatchObject({ truncated: true });
    expect(renderFrame(session.state(), 200, 24)[0]).toContain(`truncated: cache cap ${cacheBytes} bytes`);
    await session.close();
  });

  it("an evicted selection stays a placeholder without pinning its payload", async () => {
    const cacheBytes = 256 * 1024;
    const fake = liveFake();
    const session = createSession({ source: fake.source, limits: { cacheBytes } });
    await session.start();
    await vi.advanceTimersByTimeAsync(250);
    const selected = spanRow("t-1", "a-selected");
    fake.deltaCalls.at(-1)!.resolve(deltaBody({ spans: [selected] }));
    await flush();
    session.press("j");
    await vi.advanceTimersByTimeAsync(50);
    // A 1 MiB value: bigger than the whole cache.
    fake.detailCalls[0]!.resolve(evidence(selected, "p".repeat(1024 * 1024)));
    await flush();
    const detail = session.state().detail!;
    expect(detail.args.state).toBe("recorded");
    const kept = detail.args.state === "recorded" ? detail.args.text : "";
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(DETAIL_VALUE_MAX_BYTES + 64);
    expect(kept).toContain(`[truncated at ${DETAIL_VALUE_MAX_BYTES} bytes]`);

    // Unrelated rows push the selected row out of the cache.
    for (let batch = 0; batch < 40; batch += 1) {
      await vi.advanceTimersByTimeAsync(250);
      const spans = Array.from({ length: 20 }, (_, index) =>
        spanRow("t-1", `z${batch}-${index}`, { nodeId: `src/${"n".repeat(600)}.ts#g${index}` })
      );
      fake.deltaCalls.at(-1)!.resolve(deltaBody({ spans }));
      await flush();
    }
    const state = session.state();
    expect(session.stats().cacheBytes).toBeLessThanOrEqual(cacheBytes);
    expect(state.spans.some((row) => row.spanId === "a-selected")).toBe(false);
    expect(selectedPlaceholder(state)).toMatchObject({ ref: { spanId: "a-selected" }, reason: "evicted" });
    // What the placeholder retains is one row plus one capped detail, not the payload.
    expect(Buffer.byteLength(JSON.stringify(state.lastKnownSpan))).toBeLessThan(1_024);
    expect(Buffer.byteLength(JSON.stringify(state.detail))).toBeLessThan(DETAIL_VALUE_MAX_BYTES + 4_096);
    await session.close();
  });
});
