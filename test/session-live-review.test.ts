/**
 * Live-mode review fixes (30-minute run 8.4 and the B2/backoff review): delta-arrived
 * traces get span rows, canonical pages share the row/detail byte budget, repeated
 * resets back off, reconnect stats stay bounded, the backlog marker clears, the search
 * prompt can be cleared and matches routes, and a seq past the pinned records says so.
 */
import type { CanonicalPageEnvelopeV2 } from "@kosmo-callflow/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonBytes } from "../src/bounds.js";
import { renderFrame } from "../src/render.js";
import { RECONNECT_MAX_MS, RECONNECT_MIN_MS, createSession } from "../src/session.js";
import type { VersionedCanonicalPage } from "../src/source.js";
import { applyAction, initialViewState, reduceDelta, selectedPlaceholder } from "../src/view-state.js";
import { checkoutRecords } from "./replay-records.js";
import {
  DS,
  canonicalPageV2,
  canonicalSpanV2,
  deltaBody,
  flush,
  httpError,
  liveFake,
  snapshotRef,
  spanRow,
  traceRow
} from "./session-fakes.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A v2 page for one trace with `spans` spans, each padded to make pages weigh something. */
function tracePage(traceId: string, spans = 3, pad = 0): CanonicalPageEnvelopeV2 {
  const items = Array.from({ length: spans }, (_, index) => {
    const ref = { ...DS, sessionId: "s-1", traceId, spanId: `${traceId}-s${index}` };
    const item = canonicalSpanV2(
      ref,
      index === 0
        ? {}
        : ({ parent: { state: "known", relation: "same-session", span: { ...ref, spanId: `${traceId}-s0` } } } as never)
    );
    return pad === 0 ? item : { ...item, node: { ...item.node, displayName: "x".repeat(pad) } };
  });
  return canonicalPageV2(items, traceId);
}

/** A live fake whose canonical reads answer trace selections with `tracePage`. */
function canonicalLive(options: Parameters<typeof liveFake>[0] = {}, page = (traceId: string) => tracePage(traceId)) {
  const fake = liveFake(options);
  const reads: string[] = [];
  fake.source.canonical = async (_snapshot, selection) => {
    const traceId =
      selection.kind === "trace" ? selection.ref.traceId : selection.kind === "span" ? selection.ref.traceId : "?";
    reads.push(traceId);
    return {
      version: 2,
      envelope: page(traceId),
      cursor: null,
      truncated: false,
      coverage: { scope: "complete", loaded: 1, total: 1 }
    } as unknown as VersionedCanonicalPage;
  };
  return { ...fake, reads };
}

async function poll(fake: ReturnType<typeof liveFake>, body: Parameters<typeof deltaBody>[0]): Promise<void> {
  await vi.advanceTimersByTimeAsync(250);
  fake.deltaCalls.at(-1)!.resolve(deltaBody(body));
  await flush();
  await vi.advanceTimersByTimeAsync(0);
  await flush();
}

describe("delta-arrived traces get span rows (8.4 finding 1)", () => {
  it("loads the canonical page of a trace that arrives by delta, without r or >", async () => {
    const fake = canonicalLive();
    const session = createSession({ source: fake.source, random: () => 0.5 });
    await session.start();
    await flush();
    expect(session.state().spans.map((row) => row.traceId)).toContain("t-1");
    await poll(fake, { cursor: "c-1", traces: [traceRow("t-2", 5)] });
    expect(fake.reads).toContain("t-2");
    expect(session.state().spans.filter((row) => row.traceId === "t-2")).toHaveLength(3);
    // An updated trace (running -> complete) is read again, bounded to the traces in the frame.
    const before = fake.reads.length;
    await poll(fake, { cursor: "c-2", traces: [{ ...traceRow("t-2", 5), status: "complete" }] });
    expect(fake.reads.slice(before)).toEqual(["t-2"]);
    await session.close();
  });

  it("a reset body reloads span rows for the new baseline", async () => {
    const fake = canonicalLive();
    const session = createSession({ source: fake.source, random: () => 0.5 });
    await session.start();
    await flush();
    await poll(fake, {
      cursor: "c-1",
      reset: true,
      snapshot: snapshotRef({ retentionEpoch: 2 }),
      traces: [traceRow("t-9", 9)]
    });
    expect(session.state().spans.map((row) => row.traceId)).toEqual(["t-9", "t-9", "t-9"]);
    expect(session.state().canonical.map((page) => page.selection?.traceId)).toEqual(["t-9"]);
    await session.close();
  });
});

describe("canonical pages count against the cache budget (B2)", () => {
  it("a long live session keeps rows + pages + details within the byte cap and drops evicted pages", async () => {
    const cacheBytes = 256 * 1024;
    const fake = canonicalLive({}, (traceId) => tracePage(traceId, 4, 2_000));
    const session = createSession({ source: fake.source, random: () => 0.5, limits: { cacheBytes } });
    await session.start();
    await flush();
    session.press("j");
    const selected = session.state().selection;
    expect(selected?.traceId).toBe("t-1");
    for (let index = 0; index < 150; index += 1) {
      await poll(fake, { cursor: `c-${index}`, traces: [traceRow(`t-live-${index}`, 10 + index)] });
      expect(session.stats().cacheBytes).toBeLessThanOrEqual(cacheBytes);
    }
    const state = session.state();
    // Pages were evicted with their rows: what is kept fits the budget and matches the rows.
    expect(jsonBytes(state.canonical)).toBeLessThanOrEqual(cacheBytes);
    expect(state.canonical.length).toBeLessThan(150);
    const traced = new Set(state.traces.map((row) => row.traceId));
    for (const page of state.canonical) expect(traced.has(page.selection!.traceId!)).toBe(true);
    // The newest trace still has its rows; the old selection is an explained placeholder.
    expect(state.spans.some((row) => row.traceId === "t-live-149")).toBe(true);
    expect(selectedPlaceholder(state)).toMatchObject({ ref: { spanId: selected!.spanId } });
    await session.close();
  });
});

describe("resets and reconnects stay bounded (review)", () => {
  it("a second consecutive 409 waits a jittered 1..10 s backoff instead of reloading at once", async () => {
    const fake = liveFake({ opens: [{ traces: [traceRow("t-1")] }] });
    const session = createSession({ source: fake.source, random: () => 0.5 });
    await session.start();
    await vi.advanceTimersByTimeAsync(250);
    fake.deltaCalls.at(-1)!.reject(httpError(409));
    await flush();
    expect(fake.opens()).toBe(2);
    await vi.advanceTimersByTimeAsync(250);
    fake.deltaCalls.at(-1)!.reject(httpError(409));
    await flush();
    // Not reloaded immediately: a backoff delay is scheduled first.
    expect(fake.opens()).toBe(2);
    const delay = session.stats().reconnectDelays.at(-1)!;
    expect(delay).toBeGreaterThanOrEqual(RECONNECT_MIN_MS);
    expect(delay).toBeLessThanOrEqual(RECONNECT_MAX_MS);
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(fake.opens()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(fake.opens()).toBe(3);
    // A successful read ends the run of resets: the next 409 reloads at once again.
    await vi.advanceTimersByTimeAsync(250);
    fake.deltaCalls.at(-1)!.resolve(deltaBody({ cursor: "ok" }));
    await flush();
    await vi.advanceTimersByTimeAsync(250);
    fake.deltaCalls.at(-1)!.reject(httpError(409));
    await flush();
    expect(fake.opens()).toBe(4);
    await session.close();
  });

  it("a reload that itself answers 409 backs off rather than looping", async () => {
    const fake = liveFake({ opens: [{ traces: [traceRow("t-1")] }] });
    let opens = 0;
    const open = fake.source.open.bind(fake.source);
    fake.source.open = async (signal) => {
      opens += 1;
      if (opens > 1) throw httpError(409);
      return open(signal);
    };
    const session = createSession({ source: fake.source, random: () => 0.5 });
    await session.start();
    await vi.advanceTimersByTimeAsync(250);
    fake.deltaCalls.at(-1)!.reject(httpError(409));
    await flush();
    await flush();
    expect(opens).toBe(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(opens).toBe(2);
    await session.close();
  });

  it("keeps only the last 32 reconnect delays", async () => {
    const fake = liveFake();
    const session = createSession({ source: fake.source, random: () => 0.5 });
    await session.start();
    for (let index = 0; index < 60; index += 1) {
      await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS);
      fake.deltaCalls.at(-1)!.reject(httpError(503));
      await flush();
    }
    expect(session.stats().reconnectDelays.length).toBe(32);
    await session.close();
  });
});

describe("the backlog overflow marker clears once a baseline replaces the backlog (8.4 finding 5)", () => {
  it("is gone after resume reloads the baseline, and after r", async () => {
    const fake = liveFake({ opens: [{ traces: [traceRow("t-1")] }, { traces: [traceRow("t-after")] }] });
    const session = createSession({ source: fake.source, limits: { queueFrames: 2 } });
    await session.start();
    session.press("p");
    for (let index = 0; index < 4; index += 1)
      await poll(fake, { cursor: `c-${index}`, traces: [traceRow(`t-${index}`)] });
    expect(renderFrame(session.state(), 160, 24)[0]).toContain("backlog overflow");
    session.press("p");
    await flush();
    expect(fake.opens()).toBe(2);
    expect(session.state().backlogOverflowed).toBe(false);
    expect(renderFrame(session.state(), 160, 24)[0]).not.toContain("backlog overflow");

    // The same marker set by the view's own backlog cap is cleared by an explicit reload.
    session.press("p");
    for (let index = 0; index < 4; index += 1)
      await poll(fake, { cursor: `d-${index}`, traces: [traceRow(`u-${index}`)] });
    expect(session.state().backlogOverflowed).toBe(true);
    session.press("p");
    await flush();
    session.press("r");
    await flush();
    expect(session.state().backlogOverflowed).toBe(false);
    await session.close();
  });
});

describe("search prompt and matching (8.4 findings 2 and 3)", () => {
  it("the prefilled search is refined by typing and cleared whole by one backspace", () => {
    let state = initialViewState({ filters: { errorsOnly: false, search: "orders" } });
    state = applyAction(state, { kind: "search" });
    expect(state.searchInput).toBe("orders");
    expect(state.searchSelected).toBe(true);
    expect(renderFrame(state, 160, 24).at(-1)).toContain("backspace clears");
    // "/ Enter" re-applies the active search (it is what the prompt shows)...
    state = applyAction(state, { kind: "searchCommit" });
    expect(state.filters.search).toBe("orders");
    // ...and "/ Backspace Enter" clears it.
    state = applyAction(state, { kind: "search" });
    state = applyAction(state, { kind: "searchBackspace" });
    expect(state.searchInput).toBe("");
    state = applyAction(state, { kind: "searchCommit" });
    expect(state.filters.search).toBeNull();
    expect(renderFrame(state, 160, 24).at(-1)).not.toContain("search=");

    // Typing refines the prefill; after an edit, backspace removes one character.
    state = applyAction(initialViewState({ filters: { errorsOnly: false, search: "ord" } }), { kind: "search" });
    state = applyAction(state, { kind: "searchInput", text: "ers" });
    expect(state.searchInput).toBe("orders");
    state = applyAction(state, { kind: "searchBackspace" });
    expect(state.searchInput).toBe("order");
    // The right arrow keeps the prefill for character edits.
    state = applyAction(initialViewState({ filters: { errorsOnly: false, search: "ord" } }), { kind: "search" });
    state = applyAction(state, { kind: "searchKeep" });
    state = applyAction(state, { kind: "searchBackspace" });
    expect(state.searchInput).toBe("or");
  });

  it("matches the recorded route and display name as well as the node id", () => {
    const handler = spanRow("t-1", "h", { nodeId: "express:handler:createOrder#2", route: "/orders/:orderId" });
    const other = spanRow("t-1", "o", { nodeId: "src/cart.ts#load" });
    let state = reduceDelta(initialViewState(), { kind: "spans", rows: [handler, other] });
    state = { ...state, filters: { errorsOnly: false, search: "orders" } };
    state = applyAction(state, { kind: "move", delta: 0 });
    const rows = renderFrame(state, 160, 24).join("\n");
    expect(rows).toContain("createOrder");
    expect(rows).not.toContain("cart.ts#load");
  });
});

describe("a seq past the pinned records says so (8.4 finding 4)", () => {
  it("names the last pinned record and keeps saying it when a reset notice arrives", async () => {
    const fake = liveFake({
      records: checkoutRecords(),
      opens: [{ snapshot: { watermark: 30 }, traces: [traceRow("t-1")] }]
    });
    const session = createSession({ source: fake.source, random: () => 0.5 });
    await session.start();
    await session.enterReplay({ seq: 28 });
    const notice = session.state().notice!;
    expect(notice).toContain("seq 28");
    expect(notice).toContain("no pinned record after seq 25");
    await vi.advanceTimersByTimeAsync(250);
    fake.deltaCalls.at(-1)!.resolve(deltaBody({ reset: true, snapshot: snapshotRef({ retentionEpoch: 2 }) }));
    await flush();
    expect(session.state().notice).toContain("no pinned record after seq 25");
    expect(session.state().notice).toContain("retention reset on the live source");
    await session.close();
  });
});
