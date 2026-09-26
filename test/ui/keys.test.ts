/**
 * Task 16: spec 6.7 key map of stage 1 and its precedence (prompt → focused pane → global).
 */
import { describe, expect, it } from "vitest";
import { decodeKey } from "../../src/ui/keys.js";
import { initialState, update, type ViewState } from "../../src/ui/state.js";
import { model, span } from "./model-fixtures.js";

const ESC = "\u001b";

function traceState(overrides: Partial<ViewState> = {}): ViewState {
  let state = initialState({ root: "/work", readOnly: false });
  [state] = update(state, {
    type: "datasetOpened",
    dataset: {
      info: { id: "ds" },
      kind: "json",
      origin: { path: "/work/a.kosmo-trace.json" },
      traces: [{ id: "t1", name: null, spans: 2, status: "complete", requests: null }],
      hasMore: false,
      notices: [],
      reloadable: true
    }
  });
  [state] = update(state, {
    type: "traceLoaded",
    model: model([span({ id: "r", order: 0 }), span({ id: "c", parent: "r", order: 1 })])
  });
  return { ...state, ...overrides };
}

describe("global keys of stage 1", () => {
  const state = traceState();

  it("navigation: j k arrows PgUp PgDn g G Home End", () => {
    expect(decodeKey(state, "j")).toEqual({ type: "move", delta: 1 });
    expect(decodeKey(state, "k")).toEqual({ type: "move", delta: -1 });
    expect(decodeKey(state, `${ESC}[B`)).toEqual({ type: "move", delta: 1 });
    expect(decodeKey(state, `${ESC}[A`)).toEqual({ type: "move", delta: -1 });
    expect(decodeKey(state, `${ESC}OB`)).toEqual({ type: "move", delta: 1 });
    expect(decodeKey(state, `${ESC}[6~`)).toEqual({ type: "move", delta: 10 });
    expect(decodeKey(state, `${ESC}[5~`)).toEqual({ type: "move", delta: -10 });
    expect(decodeKey(state, "g")).toEqual({ type: "moveTo", edge: "first" });
    expect(decodeKey(state, "G")).toEqual({ type: "moveTo", edge: "last" });
    expect(decodeKey(state, `${ESC}[H`)).toEqual({ type: "moveTo", edge: "first" });
    expect(decodeKey(state, `${ESC}[F`)).toEqual({ type: "moveTo", edge: "last" });
    expect(decodeKey(state, `${ESC}[1~`)).toEqual({ type: "moveTo", edge: "first" });
    expect(decodeKey(state, `${ESC}[4~`)).toEqual({ type: "moveTo", edge: "last" });
  });

  it("tree, focus, screens, views, filters, panes, copy, paging, reload, prompt, quit", () => {
    expect(decodeKey(state, "h")).toEqual({ type: "collapse" });
    expect(decodeKey(state, "l")).toEqual({ type: "expand" });
    expect(decodeKey(state, " ")).toEqual({ type: "toggleExpand" });
    expect(decodeKey(state, "\r")).toEqual({ type: "activate" });
    expect(decodeKey(state, "\t")).toEqual({ type: "focusTree" });
    expect(decodeKey(state, ESC)).toEqual({ type: "escape" });
    expect(decodeKey(state, "T")).toEqual({ type: "back" });
    expect(decodeKey(state, "\u007f")).toEqual({ type: "back" });
    expect(decodeKey(state, "v")).toEqual({ type: "toggleTable" });
    expect(decodeKey(state, "d")).toEqual({ type: "toggleText" });
    expect(decodeKey(state, "/")).toEqual({ type: "openPrompt", kind: "search" });
    expect(decodeKey(state, "e")).toEqual({ type: "toggleErrors" });
    expect(decodeKey(state, "a")).toEqual({ type: "openPane", pane: "areas" });
    expect(decodeKey(state, "s")).toEqual({ type: "openPane", pane: "stack" });
    expect(decodeKey(state, "m")).toEqual({ type: "toggleBookmark" });
    expect(decodeKey(state, "'")).toEqual({ type: "openPane", pane: "bookmarks" });
    expect(decodeKey(state, "y")).toEqual({ type: "copySubtree" });
    expect(decodeKey(state, ">")).toEqual({ type: "loadMore" });
    expect(decodeKey(state, "r")).toEqual({ type: "reload" });
    expect(decodeKey(state, ":")).toEqual({ type: "openPrompt", kind: "command" });
    expect(decodeKey(state, "q")).toEqual({ type: "quit" });
    expect(decodeKey(state, "\u0003")).toEqual({ type: "quit" });
  });

  it("keys freed in stage 1 stay unbound; stage 2 binds A b B H P", () => {
    for (const key of ["L", "p", "=", "w", "t", "-", "+", "n", "c", "o", "f", "R"]) {
      expect(decodeKey(state, key), key).toBeUndefined();
    }
    expect(decodeKey(state, "A")).toEqual({ type: "debug", action: { type: "openTargets" } });
    expect(decodeKey(state, "b")).toEqual({ type: "debug", action: { type: "togglePoint", kind: "tp" } });
    expect(decodeKey(state, "B")).toEqual({ type: "debug", action: { type: "togglePoint", kind: "bp" } });
    expect(decodeKey(state, "H")).toEqual({ type: "debug", action: { type: "openHits" } });
    expect(decodeKey(state, "P")).toEqual({ type: "debug", action: { type: "openPaused" } });
  });

  it("Tab means nothing outside the trace screen", () => {
    expect(decodeKey(initialState({ root: "/", readOnly: false }), "\t")).toBeUndefined();
  });
});

describe("precedence: prompt, then focused pane, then global", () => {
  it("while the prompt is open, letters are text and Enter submits", () => {
    const search = traceState({ prompt: { kind: "search", text: "ca" } });
    expect(decodeKey(search, "q")).toEqual({ type: "promptInput", text: "q" });
    expect(decodeKey(search, "j")).toEqual({ type: "promptInput", text: "j" });
    expect(decodeKey(search, "\r")).toEqual({ type: "promptSubmit" });
    expect(decodeKey(search, ESC)).toEqual({ type: "promptCancel" });
    expect(decodeKey(search, "\u007f")).toEqual({ type: "promptBackspace" });
    expect(decodeKey(search, "\u0015")).toEqual({ type: "promptClear" });
    expect(decodeKey(search, `${ESC}[A`)).toBeUndefined();
    // A pasted chunk loses its control characters (C0, DEL, C1).
    expect(decodeKey(search, "a\u0007b\u009bc")).toEqual({ type: "promptInput", text: "abc" });
    expect(decodeKey(search, "\u0003")).toEqual({ type: "quit" });
  });

  it("Enter in the : prompt parses the line", () => {
    const command = traceState({ prompt: { kind: "command", text: "q" } });
    expect(decodeKey(command, "\r")).toEqual({ type: "runCommand", result: { type: "quit" } });
    const unknown = traceState({ prompt: { kind: "command", text: "nope" } });
    expect(decodeKey(unknown, "\r")).toEqual({
      type: "runCommand",
      result: {
        error:
          "unknown command :nope; available: :trace :ancestors :path :callers :find :filter :area :bookmark :root :q :attach :detach :tp :untp :tp-cap :bp :unbp :max-pause :attach-browser :reload-armed :launch-browser"
      }
    });
  });

  it("the focused detail scrolls with the navigation keys; Tab and Esc return to the tree", () => {
    const detail = traceState({ pane: "detail" });
    expect(decodeKey(detail, "j")).toEqual({ type: "scrollDetail", delta: 1 });
    expect(decodeKey(detail, `${ESC}[6~`)).toEqual({ type: "scrollDetail", delta: 10 });
    expect(decodeKey(detail, "G")).toEqual({ type: "scrollDetailTo", edge: "last" });
    expect(decodeKey(detail, "\t")).toEqual({ type: "focusTree" });
    expect(decodeKey(detail, ESC)).toEqual({ type: "focusTree" });
    expect(decodeKey(detail, "\r")).toBeUndefined();
    expect(decodeKey(detail, "e")).toEqual({ type: "toggleErrors" });
  });

  it("an aux pane takes navigation, Enter, Esc and Tab", () => {
    for (const pane of ["areas", "stack", "bookmarks", "results"] as const) {
      const state = traceState({ pane });
      expect(decodeKey(state, "j"), pane).toEqual({ type: "paneMove", delta: 1 });
      expect(decodeKey(state, "g"), pane).toEqual({ type: "paneMoveTo", edge: "first" });
      expect(decodeKey(state, "\r"), pane).toEqual({ type: "paneActivate" });
      expect(decodeKey(state, ESC), pane).toEqual({ type: "closePane" });
      expect(decodeKey(state, "\t"), pane).toEqual({ type: "closePane" });
      expect(decodeKey(state, "q"), pane).toEqual({ type: "quit" });
    }
  });

  it("decoded keys drive update end to end", () => {
    let state = traceState();
    for (const key of ["j", "\r", "j"]) {
      const action = decodeKey(state, key);
      if (action !== undefined) [state] = update(state, action);
    }
    expect(state.selected).toEqual({ trace: "t1", session: "s1", id: "c" });
    expect(state.pane).toBe("detail");
    expect(state.detailScroll).toBe(1);
  });
});
