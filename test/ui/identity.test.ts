/**
 * Task 24: full span identity (spec 4.3, 13.2), ported from test/identity.test.ts onto the new
 * path reader → TraceModel → view state: the same id in two sessions is two spans for rows,
 * selection, bookmarks, filters and the tab/text output. Parents across sessions (the old
 * R-L4) are pinned by test/format/model.test.ts (task 5).
 */
import { describe, expect, it } from "vitest";
import { spanKey } from "../../src/format/types.js";
import { renderSpansTab } from "../../src/output/tab.js";
import { openTarget } from "../../src/readers/open.js";
import { initialState, update, visibleRows, type Action, type ViewState } from "../../src/ui/state.js";
import { dataset } from "../trace-builder.js";
import { toJsonText } from "../trace-writers.js";
import { memoryFs } from "../readers/reader-fakes.js";

const DOC = dataset("ds_identity")
  .trace("t", "two sessions")
  .span("root", "handle", { session: "s-1" })
  .span("c", "child", { session: "s-1", parent: "root" })
  .span("root", "handle", { session: "s-2", status: "errored" })
  .span("c", "child", { session: "s-2", parent: "root" })
  .build();

async function opened(): Promise<ViewState> {
  const result = await openTarget(
    { path: "x.json" },
    { fs: memoryFs({ "x.json": toJsonText(DOC) }) },
    new AbortController().signal
  );
  if (!result.ok) throw new Error(result.error.message);
  const trace = await result.dataset.loadTrace("t", new AbortController().signal);
  if (!trace.ok) throw new Error(trace.error.message);
  let state = initialState({ root: "/w", readOnly: true });
  const apply = (action: Action) => {
    [state] = update(state, action);
  };
  apply({
    type: "datasetOpened",
    dataset: {
      info: result.dataset.info,
      kind: result.dataset.kind,
      origin: result.dataset.origin,
      traces: result.dataset.traces.items,
      hasMore: false,
      notices: [],
      reloadable: true
    }
  });
  apply({ type: "traceLoaded", model: trace.model });
  return state;
}

const key = (session: string, id: string) => spanKey({ trace: "t", session, id });

describe("full span identity", () => {
  it("two sessions with the same ids are four rows, each under its own root", async () => {
    const state = await opened();
    expect(visibleRows(state).map((row) => [spanKey(row.ref), row.depth])).toEqual([
      [key("s-1", "root"), 0],
      [key("s-1", "c"), 1],
      [key("s-2", "root"), 0],
      [key("s-2", "c"), 1]
    ]);
    expect(renderSpansTab(state.trace!).split("\n").slice(0, 4)).toEqual([
      "s-1\troot\t-\tcomplete\tfunction\t-\thandle",
      "s-1\tc\troot\tcomplete\tfunction\t-\tchild",
      "s-2\troot\t-\terrored\tfunction\t-\thandle",
      "s-2\tc\troot\tcomplete\tfunction\t-\tchild"
    ]);
  });

  it("selection, bookmarks and the errors filter follow the full ref", async () => {
    let state = await opened();
    const apply = (action: Action) => {
      [state] = update(state, action);
    };
    apply({ type: "moveTo", edge: "last" });
    expect(spanKey(state.selected!)).toBe(key("s-2", "c"));
    apply({ type: "toggleBookmark" });
    apply({ type: "move", delta: -2 });
    expect(spanKey(state.selected!)).toBe(key("s-1", "c"));
    expect(state.bookmarks.map((bookmark) => spanKey(bookmark.ref))).toEqual([key("s-2", "c")]);
    apply({ type: "toggleErrors" });
    expect(visibleRows(state).map((row) => spanKey(row.ref))).toEqual([key("s-2", "root")]);
  });
});
