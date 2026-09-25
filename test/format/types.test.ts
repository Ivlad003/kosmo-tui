import { describe, expect, it } from "vitest";
import { NOT_RECORDED, sameRef, spanKey } from "../../src/format/types.js";

describe("span identity (spec 4.3)", () => {
  it("spanKey is JSON of the triple, so ids with separators never collide", () => {
    expect(spanKey({ trace: "t", session: "s1", id: "sp_3" })).toBe('["t","s1","sp_3"]');
    expect(spanKey({ trace: "a", session: "b:c", id: "d" })).not.toBe(spanKey({ trace: "a", session: "b", id: "c:d" }));
  });

  it("the same id in two sessions is two spans", () => {
    const node = { trace: "t", session: "node", id: "1" };
    const browser = { trace: "t", session: "browser", id: "1" };
    expect(sameRef(node, browser)).toBe(false);
    expect(sameRef(node, { ...node })).toBe(true);
    expect(spanKey(node)).not.toBe(spanKey(browser));
  });

  it("NOT_RECORDED is the frozen not-recorded state", () => {
    expect(NOT_RECORDED).toEqual({ state: "not-recorded" });
    expect(Object.isFrozen(NOT_RECORDED)).toBe(true);
  });
});
