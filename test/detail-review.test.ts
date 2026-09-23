/**
 * Review fixes on span details:
 *  - R-L11: the v1 span document is chosen by full ref (session/project), never by
 *    traceId+spanId alone; two items with the same full ref are `ambiguous`;
 *  - R-L15: a late error (after completion) never turns the span errored; it is shown as
 *    late-error evidence.
 */
import { projectCanonicalPage, snapshotFromPortableExport } from "@kosmo-callflow/query/snapshot";
import { describe, expect, it } from "vitest";
import { spanDetailFromEvents, spanDocumentFor, spanRowsFromEvents } from "../src/detail.js";
import { renderDetailPane } from "../src/render.js";
import { initialViewState } from "../src/view-state.js";
import { portableExport } from "./source-fixtures.js";
import { event as record } from "./replay-records.js";
import { SCOPE, event, ref } from "./view-fixtures.js";

function twoSessionPage() {
  const records = [
    record({ seq: 10, type: "enter", sessionId: "s-1", nodeId: "src/a.ts#fromSessionOne" }),
    record({ seq: 11, type: "exit", sessionId: "s-1", nodeId: "src/a.ts#fromSessionOne" }),
    record({ seq: 12, type: "enter", sessionId: "s-2", nodeId: "src/b.ts#fromSessionTwo" }),
    record({ seq: 13, type: "exit", sessionId: "s-2", nodeId: "src/b.ts#fromSessionTwo" })
  ];
  return projectCanonicalPage(snapshotFromPortableExport(portableExport(records)), {
    projectionVersion: 1,
    traceId: "t-1"
  });
}

describe("R-L11 spanDocumentFor selects by full ref", () => {
  it("returns only the selected session's span when another session reuses the ids", () => {
    const page = twoSessionPage();
    const second = spanDocumentFor(page, { projectId: "p", sessionId: "s-2", traceId: "t-1", spanId: "sp-1" });
    if (second === null || second === "ambiguous") throw new Error(`expected a document, got ${String(second)}`);
    expect(second.items).toHaveLength(1);
    expect(JSON.stringify(second)).toContain("fromSessionTwo");
    expect(JSON.stringify(second)).not.toContain("fromSessionOne");
    expect(spanDocumentFor(page, { projectId: "p", sessionId: "s-9", traceId: "t-1", spanId: "sp-1" })).toBeNull();
    expect(spanDocumentFor(page, { projectId: "other", sessionId: "s-2", traceId: "t-1", spanId: "sp-1" })).toBeNull();
  });

  it("says ambiguous for two page items with the same full ref", () => {
    const page = twoSessionPage();
    const item = page.items.find((candidate) => candidate.kind === "span" && candidate.span.sessionId === "s-2")!;
    const duplicated = { ...page, items: [...page.items, { ...item, id: `${item.id}-dup` }] };
    expect(spanDocumentFor(duplicated, { projectId: "p", sessionId: "s-2", traceId: "t-1", spanId: "sp-1" })).toBe(
      "ambiguous"
    );
  });
});

describe("R-L15 a late error is evidence, not the span's status", () => {
  const events = [
    event({ seq: 1, spanId: "sp-1", type: "enter", payload: { args: [1] } }),
    event({ seq: 2, spanId: "sp-1", type: "exit", payload: { ret: 2 } }),
    {
      ...event({ seq: 3, spanId: "sp-1", type: "error", payload: { message: "socket hang up after response" } }),
      lifecycle: "late-error"
    }
  ];

  it("keeps the span complete and shows a late-error marker", () => {
    const detail = spanDetailFromEvents(events, ref("t-1", "sp-1"), null)!;
    expect(detail.status).toBe("complete");
    expect(detail.error).toEqual({ state: "not-recorded" });
    expect(detail.lateError).toEqual({ state: "recorded", text: "socket hang up after response" });
    expect(spanRowsFromEvents(events, SCOPE)[0]!.errored).toBe(false);
    const pane = renderDetailPane(detail, initialViewState(), 120, 20).join("\n");
    expect(pane).toContain("[complete]");
    expect(pane).toContain("late-error (after completion): socket hang up after response");
  });

  it("still marks an error before completion as errored", () => {
    const errored = [
      events[0]!,
      { ...event({ seq: 2, spanId: "sp-1", type: "error", payload: { message: "boom" } }), lifecycle: "errored" }
    ];
    const detail = spanDetailFromEvents(errored, ref("t-1", "sp-1"), null)!;
    expect(detail.status).toBe("errored");
    expect(detail.lateError).toBeUndefined();
    expect(spanRowsFromEvents(errored, SCOPE)[0]!.errored).toBe(true);
  });
});
