import { describe, expect, it } from "vitest";
import { requestSummaryOf, traceStatusOf } from "../../src/format/model.js";
import type { Attrs, SpanRow, SpanStatus } from "../../src/format/types.js";

function row(
  id: string,
  fields: { session?: string; order?: number; status?: SpanStatus; kind?: string; attrs?: Attrs }
): SpanRow {
  return {
    ref: { trace: "t", session: fields.session ?? "s1", id },
    parent: null,
    order: fields.order ?? 0,
    name: id,
    kind: fields.kind ?? "function",
    status: fields.status ?? "complete",
    droppedAttrs: 0,
    marks: [],
    ...(fields.attrs === undefined ? {} : { attrs: fields.attrs })
  };
}

describe("traceStatusOf (spec 4.4)", () => {
  it("errored wins, then running/unknown give incomplete, otherwise complete", () => {
    expect(traceStatusOf([])).toBe("complete");
    expect(traceStatusOf([row("a", { status: "complete" }), row("b", { order: 1, status: "suspended" })])).toBe(
      "complete"
    );
    expect(traceStatusOf([row("a", { status: "running" })])).toBe("incomplete");
    expect(traceStatusOf([row("a", { status: "unknown" })])).toBe("incomplete");
    expect(traceStatusOf([row("a", { status: "running" }), row("b", { order: 1, status: "errored" })])).toBe("errored");
  });
});

describe("requestSummaryOf (spec 6.2)", () => {
  const http = (id: string, session: string, order: number, attrs?: Attrs): SpanRow =>
    row(id, { session, order, kind: "http.server", ...(attrs === undefined ? {} : { attrs }) });

  it("is null without http.server spans", () => {
    expect(requestSummaryOf([row("a", {}), row("b", { order: 1, kind: "http.client" })])).toBeNull();
  });

  it("counts every http.server span and reads the one with the smallest (session, order)", () => {
    const spans = [
      http("late", "s1", 9, { "http.request.method": "POST", "http.route": "/b", "http.response.status_code": 500 }),
      http("first", "n1", 4, {
        "http.request.method": "GET",
        "http.route": "/api/orders/:id",
        "http.response.status_code": 200
      }),
      http("same-session-later", "n1", 7, { "http.request.method": "PUT" }),
      row("fn", { session: "a0", order: 0 })
    ];
    const expected = { first: { method: "GET", route: "/api/orders/:id", status: 200 }, count: 3 };
    expect(requestSummaryOf(spans)).toEqual(expected);
    expect(requestSummaryOf([...spans].reverse())).toEqual(expected);
  });

  it("compares sessions byte-wise, not by UTF-16 order", () => {
    const spans = [
      http("astral", "😀", 0, { "http.route": "/astral" }),
      http("bmp", "\uffff", 5, { "http.route": "/bmp" })
    ];
    expect(requestSummaryOf(spans)?.first?.route).toBe("/bmp");
  });

  it("keeps a string status, drops non-string method/route and a boolean status", () => {
    expect(
      requestSummaryOf([
        http("a", "s", 0, { "http.request.method": 1, "http.route": true, "http.response.status_code": "200" })
      ])
    ).toEqual({ first: { method: null, route: null, status: "200" }, count: 1 });
    expect(requestSummaryOf([http("a", "s", 0, { "http.response.status_code": false, "http.route": "/x" })])).toEqual({
      first: { method: null, route: "/x", status: null },
      count: 1
    });
  });

  it("gives first = null when the first request has none of the three attributes", () => {
    expect(requestSummaryOf([http("a", "s", 0), http("b", "s", 1, { "http.route": "/x" })])).toEqual({
      first: null,
      count: 2
    });
  });
});
