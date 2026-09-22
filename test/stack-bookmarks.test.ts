/**
 * Task 5.6: the recorded ancestor chain and session bookmarks, both on full refs.
 */
import { describe, expect, it } from "vitest";
import { resolveBookmarks, toggleBookmark } from "../src/bookmarks.js";
import { decodeBookmarkKey, decodeKey } from "../src/keys.js";
import { renderFrame } from "../src/render.js";
import { ancestorChain } from "../src/stack.js";
import { applyAction, applyDelta, initialViewState, type SpanRow, type ViewState } from "../src/view-state.js";
import { connected, ref, span, trace } from "./view-fixtures.js";

function chainIds(spans: SpanRow[], target = ref("t", "c")): string[] {
  return ancestorChain(spans, target)!.frames.map((frame) => frame.spanId);
}

describe("ancestor chain", () => {
  const root = span("t", "a");
  const mid = span("t", "b", { parentSpanId: "a", depth: 1 });
  const leaf = span("t", "c", { parentSpanId: "b", depth: 2 });

  it("walks recorded parent edges to the root with complete coverage", () => {
    const chain = ancestorChain([leaf, root, mid], ref("t", "c"))!;
    expect(chain.frames.map((frame) => frame.spanId)).toEqual(["c", "b", "a"]);
    expect(chain.stop).toEqual({ kind: "root" });
    expect(chain.coverage).toBe("complete");
  });

  it("never links the same parent spanId from another session", () => {
    const otherSessionParent = span("t", "b", { sessionId: "s-2" });
    const chain = ancestorChain([leaf, otherSessionParent], ref("t", "c"))!;
    expect(chain.frames.map((frame) => frame.spanId)).toEqual(["c"]);
    expect(chain.stop).toEqual({ kind: "unknown", parent: ref("t", "b"), reason: "not-loaded" });
    expect(chain.coverage).toBe("partial");
    // And the other session's own chain is its own.
    expect(ancestorChain([leaf, otherSessionParent], ref("t", "b", "s-2"))!.frames).toEqual([otherSessionParent]);
  });

  it("attributes a missing parent to retention when the view has a retention gap", () => {
    const chain = ancestorChain([leaf, mid], ref("t", "c"), { retentionGap: true })!;
    expect(chainIds([leaf, mid])).toEqual(["c", "b"]);
    expect(chain.stop).toEqual({ kind: "unknown", parent: ref("t", "a"), reason: "retention" });
  });

  it("stops on an ambiguous parent whose records disagree", () => {
    const conflicting = span("t", "b", { parentSpanId: "x", depth: 1 });
    const chain = ancestorChain([leaf, mid, conflicting, root], ref("t", "c"))!;
    expect(chain.frames.map((frame) => frame.spanId)).toEqual(["c"]);
    expect(chain.stop).toEqual({ kind: "ambiguous", parent: ref("t", "b"), candidates: 2 });
    expect(chain.coverage).toBe("partial");
  });

  it("guards against cycles and runaway depth", () => {
    const x = span("t", "x", { parentSpanId: "y" });
    const y = span("t", "y", { parentSpanId: "x" });
    const cycle = ancestorChain([x, y], ref("t", "x"))!;
    expect(cycle.frames.map((frame) => frame.spanId)).toEqual(["x", "y"]);
    expect(cycle.stop).toEqual({ kind: "cycle", at: ref("t", "x") });

    const long = Array.from({ length: 10 }, (_, i) =>
      span("t", `n${i}`, { parentSpanId: i === 0 ? null : `n${i - 1}` })
    );
    const guarded = ancestorChain(long, ref("t", "n9"), { maxDepth: 4 })!;
    expect(guarded.frames).toHaveLength(4);
    expect(guarded.stop).toEqual({ kind: "depth-limit", limit: 4 });
  });

  it("uses the last known row for an evicted target, and has no chain without one", () => {
    expect(ancestorChain([root], ref("t", "c"))).toBeNull();
    const chain = ancestorChain([root, mid], ref("t", "c"), {}, leaf)!;
    expect(chain.frames.map((frame) => frame.spanId)).toEqual(["c", "b", "a"]);
  });
});

function twoSessions(): ViewState {
  let state = initialViewState({ viewportHeight: 10 });
  state = applyDelta(state, connected());
  state = applyDelta(state, { kind: "traces", rows: [trace("t", 1), trace("t", 2, "complete", "s-2")] });
  state = applyDelta(state, {
    kind: "spans",
    rows: [
      span("t", "root", { nodeId: "src/a.ts#handle" }),
      span("t", "leaf", { parentSpanId: "root", depth: 1, nodeId: "src/a.ts#leaf" }),
      span("t", "root", { sessionId: "s-2", nodeId: "src/a.ts#handle" }),
      span("t", "leaf", { sessionId: "s-2", parentSpanId: "root", depth: 1, nodeId: "src/a.ts#leaf" })
    ]
  });
  return state;
}

describe("bookmarks", () => {
  it("are keyed by full ref: marking one session's span does not mark the other", () => {
    const one = span("t", "a");
    const two = span("t", "a", { sessionId: "s-2" });
    let marks = toggleBookmark([], one);
    expect(resolveBookmarks(marks, [one, two], [trace("t", 1), trace("t", 1, "complete", "s-2")])).toEqual([
      { bookmark: { ref: ref("t", "a"), nodeId: one.nodeId }, state: "loaded", row: one }
    ]);
    marks = toggleBookmark(marks, two);
    expect(marks.map((mark) => mark.ref.sessionId)).toEqual(["s-1", "s-2"]);
    marks = toggleBookmark(marks, one);
    expect(marks.map((mark) => mark.ref.sessionId)).toEqual(["s-2"]);
  });

  it("are bounded, dropping the oldest", () => {
    let marks = toggleBookmark([], span("t", "a"), 2);
    marks = toggleBookmark(marks, span("t", "b"), 2);
    marks = toggleBookmark(marks, span("t", "c"), 2);
    expect(marks.map((mark) => mark.ref.spanId)).toEqual(["b", "c"]);
  });

  it("m marks, ' lists, and a jump lands on the same session's span", () => {
    let state = twoSessions();
    // Select session s-2's leaf explicitly, then mark it.
    state = { ...state, selection: ref("t", "leaf", "s-2") };
    state = applyAction(state, decodeKey("m")!);
    expect(state.notice).toBe("bookmark set");
    expect(state.bookmarks.map((mark) => mark.ref)).toEqual([ref("t", "leaf", "s-2")]);

    // Move somewhere else, then jump back through the list.
    state = applyAction(state, { kind: "clearSelection" });
    state = applyAction(state, decodeKey("'")!);
    expect(state.bookmarkList).toEqual({ index: 0 });
    expect(renderFrame(state, 100, 24).join("\n")).toContain("bookmarks (1)");
    state = applyAction(state, decodeBookmarkKey("\r")!);
    expect(state.bookmarkList).toBeNull();
    expect(state.selection).toEqual(ref("t", "leaf", "s-2"));
    // Its ancestors were expanded so the jump target is actually on screen.
    expect(state.selectionAbsence).toBeNull();
    const selectedLine = renderFrame(state, 100, 24).find((line) => line.startsWith(">") && line.includes(".ts#"))!;
    expect(selectedLine).toContain("src/a.ts#leaf @s-2");
  });

  it("survive retention as placeholders, and jumping pins the selection with the reason", () => {
    let state = twoSessions();
    state = { ...state, selection: ref("t", "leaf") };
    state = applyAction(state, { kind: "bookmark" });
    state = applyAction(state, { kind: "clearSelection" });
    state = applyDelta(state, {
      kind: "retention",
      dropped: [{ datasetId: "local", projectId: "p", sessionId: "s-1", traceId: "t" }]
    });

    expect(resolveBookmarks(state.bookmarks, state.spans, state.traces)[0]).toMatchObject({
      state: "placeholder",
      reason: "retention"
    });
    state = applyAction(state, { kind: "openBookmarks" });
    expect(renderFrame(state, 120, 24).join("\n")).toContain("(placeholder: aged out of retention)");
    state = applyAction(state, { kind: "bookmarkJump" });
    expect(state.selection).toEqual(ref("t", "leaf"));
    expect(state.selectionAbsence).toBe("retention");
    // The other session's identical ids are untouched and not selected.
    expect(state.spans.filter((row) => row.sessionId === "s-2")).toHaveLength(2);
  });

  it("an evicted bookmark stays listed with its own reason", () => {
    let state = twoSessions();
    state = { ...state, selection: ref("t", "leaf") };
    state = applyAction(state, { kind: "bookmark" });
    state = applyDelta(state, { kind: "evict", spans: [ref("t", "leaf")] });
    expect(resolveBookmarks(state.bookmarks, state.spans, state.traces)[0]).toMatchObject({
      state: "placeholder",
      reason: "evicted"
    });
    state = applyAction(state, { kind: "openBookmarks" });
    expect(renderFrame(state, 120, 24).join("\n")).toContain("(placeholder: evicted from the loaded scope)");
  });

  it("' with no bookmarks says so instead of doing nothing", () => {
    const state = applyAction(twoSessions(), decodeKey("'")!);
    expect(state.bookmarkList).toBeNull();
    expect(state.notice).toContain("none yet");
  });
});

describe("stack pane", () => {
  it("s toggles the recorded ancestors of the selection, naming the session", () => {
    let state = twoSessions();
    state = { ...state, selection: ref("t", "leaf", "s-2") };
    state = applyAction(state, decodeKey("s")!);
    expect(state.stackOpen).toBe(true);
    const frame = renderFrame(state, 100, 30).join("\n");
    expect(frame).toContain("stack (recorded ancestors, not a live JS stack)");
    expect(frame).toContain("#0 src/a.ts#leaf @s-2");
    expect(frame).toContain("#1 src/a.ts#handle @s-2");
    expect(frame).toContain("root reached (coverage complete)");
    expect(renderFrame(state, 100, 30)).toHaveLength(30);

    state = applyAction(state, decodeKey("s")!);
    expect(renderFrame(state, 100, 30).join("\n")).not.toContain("recorded ancestors");
  });

  it("shows an unknown(retention) stop when the parent aged out", () => {
    let state = initialViewState();
    state = applyDelta(state, connected());
    state = applyDelta(state, { kind: "traces", rows: [trace("t", 1)] });
    state = applyDelta(state, { kind: "spans", rows: [span("t", "leaf", { parentSpanId: "gone", depth: 1 })] });
    state = { ...state, retentionGap: true, selection: ref("t", "leaf"), stackOpen: true };
    expect(renderFrame(state, 100, 30).join("\n")).toContain("parent gone unknown(retention) (coverage partial)");
  });
});
