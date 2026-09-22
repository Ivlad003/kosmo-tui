/** Ported from kosmo-callflow tests/unit/cli-connect-detail.test.ts. */
import { describe, expect, it } from "vitest";
import { spanDetailFromEvents, spanRowsFromEvents } from "../src/detail.js";
import { renderDetailPane } from "../src/render.js";
import { applyAction, applyDelta, initialViewState, type SpanDetail } from "../src/view-state.js";
import { SCOPE, event, ref, span } from "./view-fixtures.js";

function paneFor(detail: SpanDetail | null, dsl: "lisp" | "tab" = "lisp"): string {
  const state = { ...initialViewState({ dsl }), detail };
  return renderDetailPane(detail!, state, 120, 20).join("\n");
}

describe("span details", () => {
  it("reads args, return value, duration and the recorded code anchor", () => {
    const events = [
      event({
        seq: 1,
        spanId: "root",
        type: "enter",
        ts: 100,
        payload: { args: [7, "x"], filePath: "src/checkout.ts", location: { line: 42, column: 3 } }
      }),
      event({ seq: 2, spanId: "root", type: "exit", ts: 112, payload: { ret: { ok: false } } })
    ];

    const detail = spanDetailFromEvents(events, ref("t-1", "root"), null)!;

    expect(detail.args).toEqual({ state: "recorded", text: '[7,"x"]' });
    expect(detail.ret).toEqual({ state: "recorded", text: '{"ok":false}' });
    expect(detail.duration).toEqual({ state: "recorded", ms: 12 });
    expect(detail.anchor).toEqual({ file: "src/checkout.ts", symbol: "run", line: 42 });
    expect(detail.status).toBe("complete");
  });

  it("marks a masked argument as masked instead of printing what was recorded in its place", () => {
    const events = [event({ seq: 1, spanId: "root", type: "enter", payload: { args: [{ password: "[masked]" }] } })];

    const detail = spanDetailFromEvents(events, ref("t-1", "root"), null)!;

    expect(detail.args).toEqual({ state: "masked" });
    expect(paneFor(detail)).toContain("args: [masked]");
    expect(paneFor(detail)).not.toContain("password");
  });

  it("says a value was not recorded rather than showing a plausible default", () => {
    const events = [event({ seq: 1, spanId: "root", type: "enter", payload: {} })];

    const detail = spanDetailFromEvents(events, ref("t-1", "root"), null)!;

    expect(detail.args).toEqual({ state: "not-recorded" });
    const pane = paneFor(detail);
    expect(pane).toContain("args: not recorded");
    expect(pane).toContain("ret: unavailable (no exit record)");
    expect(pane).toContain("duration: unavailable (no exit recorded yet)");
  });

  it("falls back to the node id for the anchor and admits it has no line", () => {
    const events = [event({ seq: 1, spanId: "root", type: "enter", nodeId: "src/b.ts#fail", payload: {} })];

    const detail = spanDetailFromEvents(events, ref("t-1", "root"), null)!;

    expect(detail.anchor).toEqual({ file: "src/b.ts", symbol: "fail", line: null });
    expect(paneFor(detail)).toContain("anchor: src/b.ts#fail (line unavailable)");
  });

  it("says the projection is unavailable rather than rendering a half-built document", () => {
    const events = [event({ seq: 1, spanId: "root", type: "enter" })];
    const detail = spanDetailFromEvents(events, ref("t-1", "root"), null)!;

    expect(paneFor(detail, "tab")).toContain("tab: unavailable (no projection for this span)");
  });

  it("reports an errored span as errored and shows the recorded message", () => {
    const events = [
      event({ seq: 1, spanId: "root", type: "enter" }),
      event({ seq: 2, spanId: "root", type: "error", payload: { message: "boom" } })
    ];

    const detail = spanDetailFromEvents(events, ref("t-1", "root"), null)!;

    expect(detail.status).toBe("errored");
    expect(paneFor(detail)).toContain("error: boom");
  });

  it("builds the span tree from the recorded parent chain", () => {
    const rows = spanRowsFromEvents(
      [
        event({ seq: 1, spanId: "root", type: "enter" }),
        event({ seq: 2, spanId: "child", parentSpanId: "root", type: "enter" }),
        event({ seq: 3, spanId: "grandchild", parentSpanId: "child", type: "error" }),
        event({ seq: 4, spanId: "orphan", parentSpanId: "gone", type: "enter" })
      ],
      SCOPE
    );

    expect(rows.map((row) => [row.spanId, row.depth, row.errored])).toEqual([
      ["root", 0, false],
      ["child", 1, false],
      ["grandchild", 2, true],
      ["orphan", 0, false]
    ]);
    expect(rows.find((row) => row.spanId === "orphan")!.parentSpanId).toBeNull();
    expect(rows.find((row) => row.spanId === "child")!.parentSpanId).toBe("root");
  });

  it("escapes control sequences and masks secrets in recorded values through the shared sanitizer", () => {
    const events = [
      event({ seq: 1, spanId: "root", type: "enter", payload: { args: ["\u001b[31mred\u001b[0m"] } }),
      event({ seq: 2, spanId: "root", type: "error", payload: { message: "token=abcdefghijklmnopqrstuvwx1234" } })
    ];

    const detail = spanDetailFromEvents(events, ref("t-1", "root"), null)!;
    const pane = paneFor(detail);

    expect(pane).not.toContain("\u001b");
    expect(pane).toContain("\\u001b[31mred");
    expect(pane).not.toContain("abcdefghijklmnopqrstuvwx1234");
  });
});

describe("search prompt", () => {
  it("opens, edits and applies a search without moving the selection", () => {
    let state = initialViewState();
    state = applyDelta(state, {
      kind: "spans",
      rows: [
        span("t-1", "a", { nodeId: "src/checkout.ts#applyDiscount", errored: true }),
        span("t-1", "b", { nodeId: "src/auth.ts#signIn" })
      ]
    });
    state = applyAction(state, { kind: "move", delta: 0 });
    const selected = state.selection;

    state = applyAction(state, { kind: "search" });
    expect(state.searchInput).toBe("");
    for (const char of "auth") state = applyAction(state, { kind: "searchInput", text: char });
    state = applyAction(state, { kind: "searchBackspace" });
    expect(state.searchInput).toBe("aut");
    state = applyAction(state, { kind: "searchCommit" });

    expect(state.searchInput).toBeNull();
    expect(state.filters.search).toBe("aut");
    expect(state.selection).toEqual(selected);
    expect(state.selectionAbsence).toBe("filter");
  });

  it("cancels without touching the active filter", () => {
    let state = applyAction(initialViewState(), { kind: "search" });
    state = applyAction(state, { kind: "searchInput", text: "x" });
    state = applyAction(state, { kind: "searchCancel" });

    expect(state.searchInput).toBeNull();
    expect(state.filters.search).toBeNull();
  });

  it("clears the filter when an empty search is applied", () => {
    let state = initialViewState({ filters: { errorsOnly: false, search: "auth" } });
    state = applyAction(state, { kind: "search" });
    expect(state.searchInput).toBe("auth");
    for (let i = 0; i < 4; i += 1) state = applyAction(state, { kind: "searchBackspace" });
    state = applyAction(state, { kind: "searchCommit" });

    expect(state.filters.search).toBeNull();
  });
});
