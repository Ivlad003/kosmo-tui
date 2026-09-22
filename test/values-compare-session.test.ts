/**
 * Tasks 5.4/5.7 in the session: `w` reads the selected trace's v2 projection and shows
 * equal-value candidates in the result pane; `=` on A then B compares the pair through
 * the shared diff. Both refuse visibly without typed v2 evidence or on a replay frame.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalSpanProjectionItemV2 } from "@kosmo-callflow/protocol";
import { renderFrame } from "../src/render.js";
import { createSession } from "../src/session.js";
import type { TraceSelection, VersionedCanonicalPage } from "../src/source.js";
import type { SpanRef } from "../src/view-state.js";
import { checkoutRecords } from "./replay-records.js";
import { canonicalPageV2, canonicalSpanV2, deltaBody, flush, liveFake, spanRow, traceRow } from "./session-fakes.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const ref = (spanId: string): SpanRef => ({
  datasetId: "local",
  projectId: "p",
  sessionId: "s-1",
  traceId: "t-1",
  spanId
});

function item(spanId: string, seq: number, ret: unknown, ms = 4): CanonicalSpanProjectionItemV2 {
  const base = canonicalSpanV2(ref(spanId));
  return canonicalSpanV2(ref(spanId), {
    node: { ...base.node, nodeId: "src/cart.ts#total", graphRevision: "rev-42" },
    sequence: { firstSeq: seq, lastSeq: seq + 1 },
    ret: { state: "recorded", value: ret },
    duration: { state: "recorded", ms, source: "recorded-duration", domain: "monotonic" }
  });
}

const ITEMS = [item("a", 1, -5, 4), item("b", 3, -5, 90), item("c", 5, -5)];

async function session(options: { versions?: Array<1 | 2>; records?: boolean } = {}) {
  const fake = liveFake({
    offers: { projectionVersions: options.versions ?? [1, 2] },
    ...(options.records ? { records: checkoutRecords() } : {})
  });
  const selections: TraceSelection[] = [];
  fake.source.canonical = async (_snapshot, selection) => {
    selections.push(selection);
    const items =
      selection.kind === "span" ? ITEMS.filter((entry) => entry.span.spanId === selection.ref.spanId) : ITEMS;
    return {
      version: 2,
      envelope: canonicalPageV2(items),
      coverage: { scope: "complete", loaded: items.length, total: items.length },
      truncated: false,
      cursor: null
    } satisfies VersionedCanonicalPage;
  };
  const s = createSession({ source: fake.source });
  await s.start();
  await vi.advanceTimersByTimeAsync(250);
  fake.deltaCalls[0]!.resolve(
    deltaBody({ traces: [traceRow("t-1")], spans: [spanRow("t-1", "a"), spanRow("t-1", "b"), spanRow("t-1", "c")] })
  );
  await flush();
  return { s, selections };
}

describe("w in the session", () => {
  it("shows equal-value candidates up to the selected value, over the selected trace", async () => {
    const { s, selections } = await session();
    s.press("G"); // c
    expect(s.state().selection?.spanId).toBe("c");
    const before = selections.length;
    s.press("w");
    await flush();
    expect(selections.slice(before)).toEqual([
      { kind: "trace", ref: { datasetId: "local", projectId: "p", sessionId: "s-1", traceId: "t-1" } }
    ]);
    const result = s.state().commandResult;
    expect(result?.kind).toBe("values");
    const frame = renderFrame(s.state(), 120, 40).join("\n");
    expect(frame).toContain("candidates (equal values), not lineage");
    expect(frame).toContain("ret @seq 6: 2 candidate(s) at or before seq 6");
    expect(frame).toContain("3 of 3 loaded spans searched; coverage complete");
    await s.close();
  });

  it("without projection v2 it says why instead of guessing from display text", async () => {
    const { s } = await session({ versions: [1] });
    s.press("j");
    s.press("w");
    await flush();
    expect(s.state().commandResult).toBeNull();
    expect(s.state().notice).toBe("values: unavailable(value matching needs typed value evidence (projection v2))");
    await s.close();
  });
});

describe("= in the session", () => {
  it("marks A, then B, and compares through diffTraces; duration stays apart from the verdict", async () => {
    const { s, selections } = await session();
    s.press("j"); // a
    s.press("=");
    expect(s.state().notice).toBe("compare: A marked; select B and press =");
    s.press("j"); // b
    const before = selections.length;
    s.press("=");
    await flush();
    expect(selections.slice(before)).toEqual([
      { kind: "span", ref: ref("a") },
      { kind: "span", ref: ref("b") }
    ]);
    const result = s.state().commandResult;
    expect(result?.kind).toBe("compare");
    if (result?.kind !== "compare") return;
    expect(result.result.verdict).toBe("equivalent");
    expect(result.result.duration.deltaMs).toBe(86);
    const frame = renderFrame(s.state(), 140, 40).join("\n");
    expect(frame).toContain("behavior: equivalent (shared diffTraces, scope spans)");
    expect(frame).toContain("delta +86ms");
    await s.close();
  });

  it("on a pinned replay frame both refuse visibly", async () => {
    const { s } = await session({ records: true });
    await s.enterReplay({});
    s.press("j");
    s.press("w");
    await flush();
    expect(s.state().notice).toMatch(/^values: unavailable\(replay frame/);
    s.seek(19);
    s.press("g"); // sp-1
    s.press("l"); // expand it so its child is visible
    s.press("=");
    s.press("j"); // sp-2
    expect(s.state().selection?.spanId).toBe("sp-2");
    s.press("=");
    await flush();
    expect(s.state().commandResult).toBeNull();
    expect(s.state().notice).toMatch(/^compare: A unavailable\(replay frame/);
    await s.close();
  });
});
