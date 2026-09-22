/**
 * Task 4.6: snapshot/cursor pagination (`>` load more), explicit reload (`r`) and cache
 * eviction, checked for EVERY effective capability set a source can open with — live,
 * sqlite, export, stream v1 and stream v2. For each: the footer advertises only what the
 * set can serve, an unavailable key answers `unavailable(reason)`, and a selected ref
 * that was evicted renders a placeholder whose hint follows the same capabilities.
 */
import { describe, expect, it } from "vitest";
import { renderFrame } from "../src/render.js";
import { createSession, type SessionTimers } from "../src/session.js";
import type { SnapshotRef, SourceKind, SourceOffers, SourceOpenResult, TraceSource } from "../src/source.js";
import { applyAction, applyDelta, selectedPlaceholder, spanRefOf, type ViewState } from "../src/view-state.js";
import { flush, spanRow, traceRow } from "./session-fakes.js";
import { createFakeSource, FULL_OFFERS } from "./source-fake.js";

/** Timers that never fire: no poll, redraw or debounce runs behind the test's back. */
const frozen: SessionTimers = { setTimeout: () => ({}), clearTimeout: () => undefined };

type CapabilitySet = {
  name: string;
  kind: SourceKind;
  offers: Partial<SourceOffers>;
  implement: Partial<Record<"canonical" | "details" | "records" | "probes" | "deltas", boolean>>;
  /** `p` (pause live updates): null when it works, else the unavailable reason. */
  pause: string | null;
  /** `r`: null when a reload works, else the unavailable reason. */
  reload: string | null;
};

const SETS: CapabilitySet[] = [
  {
    name: "live",
    kind: "live",
    offers: { sql: { available: false, reason: "sql-reads-offline-snapshots" } },
    implement: { canonical: true, details: true, records: true, deltas: true },
    pause: null,
    reload: null
  },
  {
    name: "sqlite",
    kind: "sqlite",
    offers: { follow: { available: false, reason: "static-snapshot" } },
    implement: { canonical: true, details: true, records: true },
    pause: "static-snapshot",
    reload: null
  },
  {
    name: "export",
    kind: "export",
    offers: {
      follow: { available: false, reason: "static-snapshot" },
      sql: { available: false, reason: "sql-needs-sqlite-source" }
    },
    implement: { canonical: true, details: true, records: true },
    pause: "static-snapshot",
    reload: null
  },
  {
    name: "stream v1",
    kind: "stream",
    offers: {
      projectionVersions: [],
      projectionReason: "summary-only-stream",
      follow: { available: false, reason: "finite-stream" },
      replay: { available: false, reason: "no-replay-records" },
      values: { level: "none", reason: "summary-only-stream" },
      probes: { available: false, reason: "summary-only-stream" },
      sql: { available: false, reason: "stream-not-queryable" },
      reload: { available: false, reason: "stdin-stream-not-rereadable" }
    },
    implement: {},
    pause: "finite-stream",
    reload: "stdin-stream-not-rereadable"
  },
  {
    name: "stream v2",
    kind: "stream",
    offers: {
      projectionVersions: [2],
      follow: { available: false, reason: "finite-stream" },
      replay: { available: false, reason: "no-replay-records" },
      probes: { available: false, reason: "no-probe-records" },
      sql: { available: false, reason: "stream-not-queryable" },
      reload: { available: false, reason: "stdin-stream-not-rereadable" }
    },
    implement: { canonical: true, details: true },
    pause: "finite-stream",
    reload: "stdin-stream-not-rereadable"
  }
];

const TRACES = [traceRow("t-1", 3), traceRow("t-2", 2), traceRow("t-3", 1)];

async function started(set: CapabilitySet) {
  const source = createFakeSource({
    kind: set.kind,
    offers: set.offers,
    implement: set.implement,
    traces: TRACES,
    pageSize: 2
  });
  const session = createSession({ source, timers: frozen });
  await session.start();
  await flush();
  return { session, source };
}

function footer(state: ViewState): string {
  return renderFrame(state, 240, 24).at(-1)!;
}

/** The selected span evicted from the loaded scope, rendered with the session's caps. */
function evictedSelection(state: ViewState): ViewState {
  const row = spanRow("t-1", "a");
  let next = applyDelta(state, { kind: "spans", rows: [row] });
  next = applyAction({ ...next, selection: spanRefOf(row) }, { kind: "move", delta: 0 });
  return applyDelta(next, { kind: "evict", spans: [row] });
}

describe.each(SETS)("pagination and placeholders: $name", (set) => {
  it("the footer advertises exactly what the capability set serves", async () => {
    const { session } = await started(set);
    const text = footer(session.state());
    expect(text).toContain("> more");
    if (set.reload === null) expect(text).toContain("r reload");
    else expect(text).not.toContain("r reload");
    if (set.pause === null) expect(text).toContain("p pause");
    else expect(text).not.toContain("p pause");
    // No review port was given: review keys are not advertised.
    expect(text).not.toContain("f/t review");
    await session.close();
  });

  it("> loads the next page of the SAME snapshot until the cursor ends, then says why", async () => {
    const { session } = await started(set);
    expect(session.state().traces.map((row) => row.traceId)).toEqual(["t-1", "t-2"]);
    expect(session.state().scope).toMatchObject({ loaded: 2, total: 3, truncated: true });

    session.press(">");
    await flush();
    expect(
      session
        .state()
        .traces.map((row) => row.traceId)
        .sort()
    ).toEqual(["t-1", "t-2", "t-3"]);
    expect(session.state().notice).toBe("loaded 1 more trace(s): 3/3 (all loaded)");
    expect(session.state().scope).toMatchObject({ loaded: 3, total: 3, truncated: false });
    expect(session.snapshot()?.snapshotId).toBe("snap-1");
    expect(footer(session.state())).not.toContain("> more");

    session.press(">");
    await flush();
    expect(session.state().notice).toBe("loadMore: unavailable(no-more-pages)");
    await session.close();
  });

  it("r reloads a new snapshot where the source can be re-read, and refuses with its reason otherwise", async () => {
    const { session } = await started(set);
    session.press(">");
    await flush();
    session.press("r");
    await flush();
    if (set.reload === null) {
      expect(session.state().notice).toBe("reloaded: snapshot snap-1 unchanged");
      // A reload starts over at the first page: the old cursor is gone.
      expect(session.state().traces).toHaveLength(2);
      expect(session.state().morePages).toBe(true);
    } else {
      expect(session.state().notice).toBe(`reload: unavailable(${set.reload})`);
      expect(session.state().traces).toHaveLength(3);
    }
    await session.close();
  });

  it("p answers with the capability's reason where live updates do not exist", async () => {
    const { session } = await started(set);
    session.press("p");
    if (set.pause === null) {
      expect(session.state().paused).toBe(true);
      expect(session.state().notice).toBeNull();
    } else {
      expect(session.state().paused).toBe(false);
      expect(session.state().notice).toBe(`pause: unavailable(${set.pause})`);
    }
    await session.close();
  });

  it("an evicted selection is a placeholder whose hint follows the capabilities", async () => {
    const { session } = await started(set);
    const state = evictedSelection(session.state());
    expect(selectedPlaceholder(state)).toMatchObject({ ref: { spanId: "a" }, reason: "evicted" });
    const frame = renderFrame(state, 240, 24).join("\n");
    expect(frame).toContain("selected span src/a.ts#a evicted from the loaded scope");
    if (set.reload === null) expect(frame).toContain("(reload to fetch it)");
    else expect(frame).toContain(`(reload unavailable(${set.reload}))`);
    await session.close();
  });
});

describe("cache eviction and reload identity", () => {
  it("loading more past the cache cap evicts rows and says so in the header", async () => {
    const source = createFakeSource({
      kind: "export",
      offers: { follow: { available: false, reason: "static-snapshot" } },
      traces: Array.from({ length: 12 }, (_, index) => traceRow(`t-${index}`, 100 - index)),
      pageSize: 4
    });
    const session = createSession({ source, timers: frozen, limits: { cacheBytes: 1_200 } });
    await session.start();
    session.press(">");
    await flush();
    session.press(">");
    await flush();
    const stats = session.stats();
    expect(stats.cacheBytes).toBeLessThanOrEqual(1_200);
    expect(stats.evictedRows).toBeGreaterThan(0);
    expect(session.state().traces.length).toBeLessThan(12);
    expect(renderFrame(session.state(), 240, 24)[0]).toMatch(/truncated: cache cap 1200 bytes, \d+ row\(s\) evicted/);
    await session.close();
  });

  it("a reload that crosses a retention epoch replaces the snapshot and marks the gap", async () => {
    const base = createFakeSource({
      kind: "sqlite",
      offers: { follow: { available: false, reason: "static-snapshot" } },
      traces: TRACES,
      pageSize: 2
    });
    let opens = 0;
    const next: SnapshotRef = {
      datasetId: "local",
      projectId: "p",
      revision: "r2",
      watermark: 20,
      retentionEpoch: 2,
      snapshotId: "snap-2"
    };
    const source: TraceSource = {
      ...base,
      async open(signal): Promise<SourceOpenResult> {
        opens += 1;
        const opened = await base.open(signal);
        return opens === 1 ? opened : { ...opened, snapshot: next, firstPage: { ...opened.firstPage, cursor: null } };
      },
      traces: base.traces,
      close: base.close
    };
    const session = createSession({ source, timers: frozen });
    await session.start();
    expect(session.state().retentionGap).toBe(false);
    session.press("r");
    await flush();
    expect(session.snapshot()?.snapshotId).toBe("snap-2");
    expect(session.state().notice).toBe("reloaded: snapshot snap-1 -> snap-2 (retention gap)");
    expect(session.state().retentionGap).toBe(true);
    expect(renderFrame(session.state(), 240, 24)[0]).toContain("retention gap");
    // The new snapshot has no further page: `>` says so instead of reusing the old cursor.
    session.press(">");
    await flush();
    expect(session.state().notice).toBe("loadMore: unavailable(no-more-pages)");
    await session.close();
  });

  it("FULL_OFFERS stays reloadable: reload availability is an explicit offer, not a kind check", () => {
    expect(FULL_OFFERS.reload).toBeUndefined();
  });
});
