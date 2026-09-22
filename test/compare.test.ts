/**
 * Task 5.7: explicit A/B pair comparison through the shared diffTraces. Source revision
 * or node mismatch is called out, masked/incomplete evidence is inconclusive, and a
 * duration difference alone is never a behaviour regression.
 */
import { describe, expect, it } from "vitest";
import type { CanonicalSpanProjectionItemV2 } from "@kosmo-callflow/protocol";
import { diffTraces } from "@kosmo-callflow/trace-diff";
import { compareSpanPair, comparisonLines } from "../src/compare.js";
import { applyAction, initialViewState } from "../src/view-state.js";
import { decodeKey } from "../src/keys.js";
import { canonicalSpanV2, spanRow } from "./session-fakes.js";

const ref = (spanId: string) => ({ datasetId: "local", projectId: "p", sessionId: "s-1", traceId: "t-1", spanId });

/** Two calls of the same node: `a` and `b` are spans, the node is shared. */
function call(spanId: string, overrides: Partial<CanonicalSpanProjectionItemV2> = {}): CanonicalSpanProjectionItemV2 {
  const base = canonicalSpanV2(ref(spanId));
  return canonicalSpanV2(ref(spanId), {
    node: { ...base.node, nodeId: "src/cart.ts#total", graphRevision: "rev-42" },
    args: { state: "recorded", value: [{ sku: "a" }, 2] },
    ret: { state: "recorded", value: 10 },
    ...overrides
  });
}

describe("compareSpanPair", () => {
  it("same behaviour with a different duration is equivalent; duration is shown apart", () => {
    const result = compareSpanPair(
      call("a", { duration: { state: "recorded", ms: 4, source: "recorded-duration", domain: "monotonic" } }),
      call("b", { duration: { state: "recorded", ms: 400, source: "recorded-duration", domain: "monotonic" } })
    );
    expect(result.verdict).toBe("equivalent");
    expect(result.diff?.scope).toBe("spans");
    expect(result.duration).toEqual({ a: 4, b: 400, deltaMs: 396, reason: null });
    const text = comparisonLines(result).join("\n");
    expect(text).toContain("behavior: equivalent");
    expect(text).toContain("duration (separate from behavior; not a regression verdict): A 4ms, B 400ms, delta +396ms");
    expect(text).not.toContain("changed");
  });

  it("a different recorded return value is changed, with the shared finding", () => {
    const result = compareSpanPair(call("a"), call("b", { ret: { state: "recorded", value: 11 } }));
    expect(result.verdict).toBe("changed");
    expect(result.diff?.findings.map((finding) => finding.code)).toContain("value-changed");
    expect(comparisonLines(result).join("\n")).toContain("value-changed: return value differs");
  });

  it("different source revision is inconclusive with an explicit note, even when values differ", () => {
    const base = call("b");
    const result = compareSpanPair(
      call("a"),
      call("b", { node: { ...base.node, graphRevision: "rev-43" }, ret: { state: "recorded", value: 99 } })
    );
    expect(result.verdict).toBe("inconclusive");
    expect(result.diff).toBeNull();
    expect(result.notes[0]).toContain("different source revision/node");
    expect(result.notes[0]).toContain("revision rev-42 vs rev-43");
    expect(comparisonLines(result).join("\n")).toContain("revision rev-42 / rev-43");
  });

  it("different node is inconclusive with the same note", () => {
    const base = call("b");
    const result = compareSpanPair(call("a"), call("b", { node: { ...base.node, nodeId: "src/cart.ts#tax" } }));
    expect(result.verdict).toBe("inconclusive");
    expect(result.notes[0]).toMatch(
      /different source revision\/node \(node src\/cart\.ts#total vs src\/cart\.ts#tax\)/
    );
  });

  it("masked evidence is inconclusive although the shared diff alone would call it equivalent", () => {
    const a = call("a", { ret: { state: "masked" } });
    const b = call("b", { ret: { state: "masked" } });
    // Guard for why the TUI gates masked itself: diffTraces counts "masked" as complete.
    expect(
      diffTraces({
        scope: "spans",
        base: [
          {
            traceId: "t",
            spanId: "a",
            parentSpanId: null,
            nodeId: "n",
            kind: "function",
            ordinal: 0,
            depth: 0,
            seq: 1,
            status: "masked"
          }
        ],
        head: [
          {
            traceId: "t",
            spanId: "b",
            parentSpanId: null,
            nodeId: "n",
            kind: "function",
            ordinal: 0,
            depth: 0,
            seq: 2,
            status: "masked"
          }
        ]
      }).verdict
    ).toBe("equivalent");
    const result = compareSpanPair(a, b);
    expect(result.verdict).toBe("inconclusive");
    expect(result.notes[0]).toContain("A ret masked");
    expect(comparisonLines(result).join("\n")).toContain('neither "same" nor "different" can be claimed');
  });

  it("truncated, partially masked, sampled, not-recorded and running evidence is inconclusive", () => {
    const cases: Array<Partial<CanonicalSpanProjectionItemV2>> = [
      { ret: { state: "truncated", value: 10 } },
      { ret: { state: "recorded", value: 10, partiallyMasked: true } },
      { coverage: { states: ["sampled"] } },
      { args: { state: "not-recorded", reason: "count-level" } },
      { lifecycle: "running", ret: { state: "unavailable", reason: "pending" } }
    ];
    for (const overrides of cases) {
      const result = compareSpanPair(call("a"), call("b", overrides));
      expect(result.verdict, JSON.stringify(overrides)).toBe("inconclusive");
      expect(result.notes[0]).toMatch(/^evidence incomplete: B /);
    }
  });

  it("two spans that threw the same error compare equivalent; no ret is not a gap then", () => {
    const threw = {
      lifecycle: "errored" as const,
      ret: { state: "not-recorded" as const, reason: "not-captured" as const },
      error: { state: "recorded" as const, value: { name: "RangeError", message: "qty < 0" } }
    };
    expect(compareSpanPair(call("a", threw), call("b", threw)).verdict).toBe("equivalent");
    const other = { ...threw, error: { state: "recorded" as const, value: { name: "TypeError", message: "x" } } };
    const changed = compareSpanPair(call("a", threw), call("b", other));
    expect(changed.verdict).toBe("changed");
    expect(changed.diff?.findings.map((finding) => finding.code)).toContain("error-changed");
  });

  it("the same span twice is refused", () => {
    expect(compareSpanPair(call("a"), call("a")).notes[0]).toContain("same span");
  });

  it("duration across clock domains is not subtracted", () => {
    const result = compareSpanPair(
      call("a", { duration: { state: "recorded", ms: 4, source: "clock-readings", domain: "monotonic" } }),
      call("b", { duration: { state: "recorded", ms: 9, source: "clock-readings", domain: "wall" } })
    );
    expect(result.verdict).toBe("equivalent");
    expect(result.duration.deltaMs).toBeNull();
    expect(comparisonLines(result).join("\n")).toContain("delta unavailable(clock domains not comparable)");
  });
});

describe("= marks A then B in the reducer", () => {
  const rows = [spanRow("t-1", "a"), spanRow("t-1", "b")];

  it("marks by full ref, unmarks A, and starts a new pair after B", () => {
    expect(decodeKey("=")).toEqual({ kind: "command", command: "compare" });
    let state = initialViewState({ spans: rows });
    state = applyAction(state, decodeKey("=")!);
    expect(state.notice).toBe("compare: nothing selected");
    state = applyAction(state, { kind: "move", delta: 1 });
    state = applyAction(state, decodeKey("=")!);
    expect(state.compareRefs).toEqual([ref("a")]);
    expect(state.notice).toBe("compare: A marked; select B and press =");
    state = applyAction(state, decodeKey("=")!);
    expect(state.compareRefs).toEqual([]);
    expect(state.notice).toBe("compare: A cleared");
    state = applyAction(state, decodeKey("=")!);
    state = applyAction(state, { kind: "move", delta: 1 });
    state = applyAction(state, decodeKey("=")!);
    expect(state.compareRefs).toEqual([ref("a"), ref("b")]);
    state = applyAction(state, decodeKey("=")!);
    expect(state.compareRefs).toEqual([ref("b")]);
  });
});
