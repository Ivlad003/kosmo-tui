/**
 * Task 5.1: request selector keyed by the inbound full ref; two requests of one
 * distributed trace, browser ancestors as causal context, legacy trace-summary fallback,
 * pending vs retained-incomplete vs observed abort, and no false unhandled/context-loss.
 */
import { describe, expect, it } from "vitest";
import { fieldText } from "../src/labels.js";
import { renderFrame } from "../src/render.js";
import { formatSelectorRow, requestRowsFromPage, selectorRows, stateText, type RequestRow } from "../src/requests.js";
import { applyDelta, initialViewState, spanKey, type TraceRow } from "../src/view-state.js";
import { connected } from "./view-fixtures.js";
import { DATASET, PROJECT, distributedTrace, event, openRequest, project } from "./request-fixtures.js";

function traceRow(traceId: string, sessionId = "s-api"): TraceRow {
  return { datasetId: DATASET, projectId: PROJECT, sessionId, traceId, status: "complete", startedAt: 1, spanCount: 3 };
}

function only(rows: RequestRow[]): RequestRow {
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe("request rows from a distributed trace", () => {
  const page = distributedTrace();
  const rows = requestRowsFromPage(page);

  it("yields one row per inbound request with its own ref, status and duration", () => {
    expect(rows.map((row) => row.ref.spanId)).toEqual(["r1", "r2"]);
    // Same traceId, different identities: the key is the full span ref, not the trace.
    expect(new Set(rows.map((row) => row.ref.traceId))).toEqual(new Set(["t-dist"]));
    expect(rows[0]!.key).toBe(spanKey(rows[0]!.ref));
    expect(rows[0]!.key).not.toBe(rows[1]!.key);
    expect(rows.map((row) => fieldText(row.status))).toEqual(["200", "201"]);
    expect(rows.map((row) => fieldText(row.method))).toEqual(["GET", "POST"]);
    expect(rows.map((row) => fieldText(row.route))).toEqual(["/cart/:id", "/orders"]);
    expect(rows.map((row) => (row.duration.state === "recorded" ? row.duration.ms : null))).toEqual([12, 30]);
    expect(rows.every((row) => row.runtime === "node")).toBe(true);
  });

  it("keeps the browser fetch and click as causal context", () => {
    const [first] = rows;
    expect(
      first!.causalContext.map((ancestor) => [ancestor.ref.sessionId, ancestor.ref.spanId, ancestor.runtime])
    ).toEqual([
      ["s-web", "f1", "browser"],
      ["s-web", "click", "browser"]
    ]);
    expect(formatSelectorRow(first!)).toContain("via browser:fetch src/ui/api.ts#getCart");
  });

  it("does not turn the browser fetches into request rows", () => {
    const selector = selectorRows([page], [traceRow("t-dist", "s-api"), traceRow("t-dist", "s-web")]);
    expect(selector.filter((row) => row.mode === "request")).toHaveLength(2);
    // Both trace refs of the distributed trace are covered (the browser one as causal
    // context), so neither becomes a trace-summary row.
    expect(selector.filter((row) => row.mode === "trace-summary")).toEqual([]);
    // An unrelated trace without a page still gets its summary row.
    const withOther = selectorRows([page], [traceRow("t-dist", "s-web"), traceRow("t-other")]);
    expect(withOther.filter((row) => row.mode === "trace-summary").map((row) => row.ref.traceId)).toEqual(["t-other"]);
  });
});

describe("request states", () => {
  it("an open enter while recording is live is pending, not no-response", () => {
    const row = only(requestRowsFromPage(openRequest("t-open")));
    expect(stateText(row.state)).toBe("pending");
    expect(fieldText(row.status)).toBe("unavailable(pending)");
    expect(row.duration).toEqual({ state: "unavailable", reason: "pending" });
    expect(formatSelectorRow(row)).not.toMatch(/no-response/);
  });

  it("a retention gap is unknown(retention) with no invented status or duration", () => {
    const row = only(requestRowsFromPage(openRequest("t-ret", { retentionEpoch: 1 })));
    expect(stateText(row.state)).toBe("unknown(retention)");
    expect(fieldText(row.status)).toBe("unavailable(retention)");
    expect(row.duration).toEqual({ state: "unavailable", reason: "retention" });
    expect(formatSelectorRow(row)).not.toMatch(/no-response|200|0ms/);
  });

  it("an imported record without exit is unknown(incomplete); a loss range is unknown(loss)", () => {
    expect(stateText(only(requestRowsFromPage(openRequest("t-imp", { source: "imported" }))).state)).toBe(
      "unknown(incomplete)"
    );
    const lost = openRequest("t-loss", { lossRanges: [{ sessionId: "s-api", fromLocalSeq: 2, toLocalSeq: 4 }] });
    expect(stateText(only(requestRowsFromPage(lost)).state)).toBe("unknown(loss)");
  });

  it("an observed abort is its own state, with the evidence that proves it", () => {
    const t = "t-abort";
    const page = project(t, [
      event({
        seq: 1,
        sessionId: "s-api",
        traceId: t,
        spanId: "req",
        parentSpanId: null,
        type: "enter",
        kind: "http",
        payload: { framework: { name: "express", role: "request", method: "GET" } }
      }),
      event({
        seq: 2,
        sessionId: "s-api",
        traceId: t,
        spanId: "req",
        parentSpanId: null,
        type: "exit",
        kind: "http",
        payload: { framework: { name: "express", completion: "aborted" } },
        flags: {
          lifecycleIssue: [{ code: "response-aborted", source: { sessionId: "s-api", traceId: t, spanId: "req" } }]
        }
      })
    ]);
    const row = only(requestRowsFromPage(page));
    expect(row.state).toEqual({ kind: "aborted", evidence: ["completion-aborted", "response-aborted"] });
    expect(stateText(row.state)).toBe("aborted(completion-aborted+response-aborted)");
    // A completed request is never shown as aborted.
    const done = only(requestRowsFromPage(distributedTrace()).slice(0, 1));
    expect(done.state.kind).toBe("complete");
  });

  it("pending, retained-incomplete and aborted are three different labels", () => {
    const labels = new Set([
      stateText(only(requestRowsFromPage(openRequest("a"))).state),
      stateText(only(requestRowsFromPage(openRequest("b", { retentionEpoch: 1 }))).state),
      "aborted(completion-aborted)"
    ]);
    expect(labels.size).toBe(3);
  });
});

describe("diagnostics come only from producer lifecycle issues", () => {
  const t = "t-err";
  const s = { sessionId: "s-api", traceId: t } as const;
  const base = [
    event({
      ...s,
      seq: 1,
      spanId: "req",
      parentSpanId: null,
      type: "enter",
      kind: "http",
      payload: { framework: { name: "express", role: "request", method: "GET" } }
    }),
    // An errored handler with NO filter ancestor anywhere.
    event({
      ...s,
      seq: 2,
      spanId: "h",
      parentSpanId: "req",
      type: "enter",
      kind: "handler",
      nodeId: "src/users.ts#get"
    }),
    event({
      ...s,
      seq: 3,
      spanId: "h",
      parentSpanId: "req",
      type: "error",
      kind: "handler",
      nodeId: "src/users.ts#get",
      payload: { error: { message: "boom" } }
    }),
    // A span whose parent was never recorded: parent unknown, not context loss.
    event({
      ...s,
      seq: 4,
      spanId: "orphan",
      parentSpanId: "ghost",
      type: "enter",
      kind: "function",
      nodeId: "src/jobs.ts#tick"
    })
  ];

  it("an error without a filter ancestor and an unknown parent produce no diagnosis", () => {
    const page = project(t, [
      ...base,
      event({
        ...s,
        seq: 5,
        spanId: "req",
        parentSpanId: null,
        type: "exit",
        kind: "http",
        payload: { framework: { name: "express", status: 500 } }
      })
    ]);
    const orphan = page.items.find((item) => item.kind === "span" && item.span.spanId === "orphan");
    expect(orphan && orphan.kind === "span" ? orphan.parent.state : null).toBe("unknown");
    const row = only(requestRowsFromPage(page));
    expect(row.diagnostics).toEqual([]);
    const text = formatSelectorRow(row);
    expect(text).not.toContain("error-unhandled");
    expect(text).not.toContain("async-context-lost");
    expect(text).toContain("500");
  });

  it("a producer lifecycleIssue is shown with its code (positive control)", () => {
    const page = project(t, [
      ...base,
      event({
        ...s,
        seq: 5,
        spanId: "req",
        parentSpanId: null,
        type: "exit",
        kind: "http",
        payload: { framework: { name: "express", status: 500 } },
        flags: {
          lifecycleIssue: [
            { code: "error-unhandled", source: { sessionId: "s-api", traceId: t, spanId: "h" }, causeLocalSeq: 3 }
          ]
        }
      })
    ]);
    const row = only(requestRowsFromPage(page));
    expect(row.diagnostics).toEqual(["error-unhandled"]);
    expect(formatSelectorRow(row)).toContain("issues=error-unhandled");
  });
});

describe("legacy and metadata-free fallback", () => {
  it("without any v2 page every trace is a trace-summary row", () => {
    const rows = selectorRows([], [traceRow("t-1"), traceRow("t-2")]);
    expect(rows.map((row) => [row.mode, row.mode === "trace-summary" ? row.reason : null])).toEqual([
      ["trace-summary", "no-projection-v2"],
      ["trace-summary", "no-projection-v2"]
    ]);
    expect(formatSelectorRow(rows[0]!)).toContain("[trace summary: no-projection-v2]");
  });

  it("a v2 page without request metadata is a trace summary, not one HTTP request", () => {
    const t = "t-plain";
    const page = project(t, [
      event({
        seq: 1,
        sessionId: "s-api",
        traceId: t,
        spanId: "a",
        parentSpanId: null,
        type: "enter",
        kind: "function"
      }),
      event({ seq: 2, sessionId: "s-api", traceId: t, spanId: "a", parentSpanId: null, type: "exit", kind: "function" })
    ]);
    const rows = selectorRows([page], [traceRow(t)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mode).toBe("trace-summary");
    expect(rows[0]!.mode === "trace-summary" && rows[0]!.reason).toBe("no-request-metadata");
  });
});

describe("the viewer shows request rows once v2 pages are loaded", () => {
  it("replaces the trace list with two request lines for the distributed trace", () => {
    let state = applyDelta(initialViewState(), connected());
    state = applyDelta(state, { kind: "traces", rows: [traceRow("t-dist", "s-api")] });
    const before = renderFrame(state, 160, 30).join("\n");
    expect(before).not.toContain("#4 GET");
    state = applyDelta(state, { kind: "canonical", pages: [distributedTrace()] });
    const frame = renderFrame(state, 160, 30);
    const lines = frame.filter((line) => /#\d+ (GET|POST)/.test(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("#4 GET /cart/:id 200 12ms node complete");
    expect(lines[1]).toContain("#5 POST /orders 201 30ms node complete");
  });
});
