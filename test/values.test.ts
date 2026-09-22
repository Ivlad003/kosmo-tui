/**
 * Task 5.4: equal-value candidates up to the selected value's seq. Structural equality
 * of full recorded values, independent equal values listed but never called a source,
 * masked/truncated/not-recorded values unavailable and never matched, and the searched
 * part of the loaded scope stated.
 */
import { describe, expect, it } from "vitest";
import type { CanonicalSpanProjectionItemV2 } from "@kosmo-callflow/protocol";
import { VALUE_MATCH_LABEL, findValueCandidates, structurallyEqual, valueMatchLines } from "../src/values.js";
import type { SpanRef } from "../src/view-state.js";
import { canonicalSpanV2 } from "./session-fakes.js";

const ref = (spanId: string, overrides: Partial<SpanRef> = {}): SpanRef => ({
  datasetId: "local",
  projectId: "p",
  sessionId: "s-1",
  traceId: "t-1",
  spanId,
  ...overrides
});

function span(
  spanId: string,
  firstSeq: number,
  lastSeq: number,
  values: Partial<Pick<CanonicalSpanProjectionItemV2, "args" | "ret">>,
  refOverrides: Partial<SpanRef> = {}
): CanonicalSpanProjectionItemV2 {
  return canonicalSpanV2(ref(spanId, refOverrides), {
    sequence: { firstSeq, lastSeq },
    args: { state: "recorded", value: [] },
    ret: { state: "recorded", value: null },
    ...values
  });
}

function searched(result: ReturnType<typeof findValueCandidates>) {
  if (result.state !== "searched") throw new Error(`expected a search, got ${JSON.stringify(result)}`);
  return result;
}

function retSlot(result: ReturnType<typeof findValueCandidates>) {
  const slot = searched(result).slots.find((entry) => entry.slot.kind === "ret");
  if (!slot || slot.state !== "searched") throw new Error(`ret slot not searched: ${JSON.stringify(slot)}`);
  return slot;
}

describe("structural equality", () => {
  it("ignores object key order, keeps array order and type", () => {
    expect(structurallyEqual({ a: 1, b: [1, { c: "x" }] }, { b: [1, { c: "x" }], a: 1 })).toBe(true);
    expect(structurallyEqual([1, 2], [2, 1])).toBe(false);
    expect(structurallyEqual("5", 5)).toBe(false);
    expect(structurallyEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(structurallyEqual(null, {})).toBe(false);
    expect(structurallyEqual([], {})).toBe(false);
  });
});

describe("value-match candidates", () => {
  it("two independent -5 returns are both candidates, ordered by seq, and neither is the source", () => {
    const items = [
      span("f", 1, 3, { ret: { state: "recorded", value: -5 } }),
      span("g", 4, 6, { ret: { state: "recorded", value: -5 } }),
      span("h", 7, 9, { ret: { state: "recorded", value: -5 } })
    ];
    const result = findValueCandidates(items, ref("h"));
    const slot = retSlot(result);
    expect(slot.seq).toBe(9);
    expect(slot.candidates.map((candidate) => [candidate.ref.spanId, candidate.seq])).toEqual([
      ["f", 3],
      ["g", 6]
    ]);
    expect(searched(result).label).toBe(VALUE_MATCH_LABEL);
    const text = valueMatchLines(result).join("\n");
    expect(text).toContain("candidates (equal values), not lineage");
    expect(text).toContain("not proof of origin");
    expect(text).not.toMatch(/\bsource of\b|\boriginated\b|\bearliest\b|\bcaused\b/);
  });

  it("never lists a value recorded after the selected value's seq", () => {
    const items = [
      span("early", 1, 2, { ret: { state: "recorded", value: "ok" } }),
      span("sel", 3, 5, { ret: { state: "recorded", value: "ok" } }),
      // Same value, recorded later: the future is not searched.
      span("late", 6, 8, { ret: { state: "recorded", value: "ok" } }),
      // Started before the cutoff, returned after it.
      span("straddle", 4, 7, { ret: { state: "recorded", value: "ok" } })
    ];
    const slot = retSlot(findValueCandidates(items, ref("sel")));
    expect(slot.candidates.map((candidate) => candidate.ref.spanId)).toEqual(["early"]);
  });

  it("matches structurally equal full values across args and ret, not previews", () => {
    const items = [
      span("maker", 1, 2, { ret: { state: "recorded", value: { id: 7, tags: ["a", "b"] } } }),
      span("other", 3, 4, { ret: { state: "recorded", value: { id: 7, tags: ["b", "a"] } } }),
      span("user", 5, 6, { args: { state: "recorded", value: [{ tags: ["a", "b"], id: 7 }, 1] } })
    ];
    const result = searched(findValueCandidates(items, ref("user")));
    const arg0 = result.slots.find((slot) => slot.slot.kind === "args" && slot.slot.index === 0);
    expect(arg0?.state).toBe("searched");
    if (arg0?.state !== "searched") return;
    expect(arg0.candidates).toEqual([
      { ref: ref("maker"), nodeId: "src/maker.ts#maker", slot: { kind: "ret" }, seq: 2 }
    ]);
  });

  it("masked, truncated and not-recorded candidates are counted as unavailable and never matched", () => {
    const items = [
      span("masked", 1, 2, { ret: { state: "masked" } }),
      // The retained partial value equals the selected one: still not a match.
      span("cut", 3, 4, { ret: { state: "truncated", value: "same" } }),
      span("partial", 5, 6, { ret: { state: "recorded", value: "same", partiallyMasked: true } }),
      span("marker", 7, 8, { ret: { state: "recorded", value: ["[masked]"] } }),
      span("none", 9, 10, { ret: { state: "not-recorded", reason: "count-level" } }),
      span("sel", 11, 12, { ret: { state: "recorded", value: "same" } })
    ];
    const result = findValueCandidates(items, ref("sel"));
    expect(retSlot(result).candidates).toEqual([]);
    expect(searched(result).coverage.unavailableValues).toBe(5);
    expect(valueMatchLines(result).join("\n")).toContain("5 value(s) unavailable, not matched");
  });

  it("a masked, truncated or not-recorded selected value is unavailable, not searched", () => {
    for (const ret of [
      { state: "masked" } as const,
      { state: "truncated", value: "x" } as const,
      { state: "not-recorded", reason: "not-captured" } as const
    ]) {
      const items = [span("x", 1, 2, { ret: { state: "recorded", value: "x" } }), span("sel", 3, 4, { ret })];
      const slot = searched(findValueCandidates(items, ref("sel"))).slots.find((entry) => entry.slot.kind === "ret");
      expect(slot?.state).toBe("unavailable");
      expect(valueMatchLines(findValueCandidates(items, ref("sel"))).join("\n")).toMatch(
        /ret: unavailable\(.+\); not matched/
      );
    }
  });

  it("states how much of the loaded trace was searched and whether the page is partial", () => {
    const items = [
      span("a", 1, 2, { ret: { state: "recorded", value: 0 } }),
      span("b", 2, 3, { ret: { state: "recorded", value: 0 } }),
      span("sel", 4, 5, { ret: { state: "recorded", value: 0 } }),
      span("later", 9, 10, { ret: { state: "recorded", value: 0 } })
    ];
    const complete = findValueCandidates(items, ref("sel"));
    expect(searched(complete).coverage).toMatchObject({ searched: 3, loaded: 4, partial: false });
    expect(valueMatchLines(complete).join("\n")).toContain("3 of 4 loaded spans searched; coverage complete");

    const partial = findValueCandidates(items, ref("sel"), { truncated: true, reason: "page cap 1000" });
    expect(valueMatchLines(partial).join("\n")).toContain(
      "3 of 4 loaded spans searched; coverage partial; page cap 1000"
    );
  });

  it("stays inside the trace; another session of the same trace is searched with a clock note", () => {
    const items = [
      span("other-trace", 1, 2, { ret: { state: "recorded", value: true } }, { traceId: "t-2" }),
      span("browser", 3, 4, { ret: { state: "recorded", value: true } }, { sessionId: "s-browser" }),
      span("sel", 5, 6, { ret: { state: "recorded", value: true } })
    ];
    const result = findValueCandidates(items, ref("sel"));
    expect(retSlot(result).candidates.map((candidate) => candidate.ref.sessionId)).toEqual(["s-browser"]);
    expect(searched(result).coverage.loaded).toBe(2);
    expect(searched(result).mixedSessions).toBe(true);
    expect(valueMatchLines(result).join("\n")).toContain("seq is record order across sessions, not program order");
  });

  it("a selection not in the loaded projection is unavailable", () => {
    const result = findValueCandidates([span("a", 1, 2, {})], ref("missing"));
    expect(result).toMatchObject({ state: "unavailable" });
    expect(valueMatchLines(result)[0]).toMatch(/^values: unavailable\(/);
  });

  it("escapes control characters in recorded node ids", () => {
    const items = [
      canonicalSpanV2(ref("a"), {
        sequence: { firstSeq: 1, lastSeq: 2 },
        ret: { state: "recorded", value: 1 },
        node: { ...canonicalSpanV2(ref("a")).node, nodeId: `evil${String.fromCharCode(27)}[2J` }
      }),
      span("sel", 3, 4, { ret: { state: "recorded", value: 1 } })
    ];
    expect(valueMatchLines(findValueCandidates(items, ref("sel"))).join("\n")).not.toContain(String.fromCharCode(27));
  });
});
