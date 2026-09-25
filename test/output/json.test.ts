import { describe, expect, it } from "vitest";
import type { DatasetInfo, LinkRow, SpanValues } from "../../src/format/types.js";
import { validateDocument } from "../../src/format/validate.js";
import { jsonText, renderDatasetJson, renderTraceSliceJson, valueJson } from "../../src/output/json.js";
import { fromSpans, model, span } from "./helpers.js";

const DATASET: DatasetInfo = { id: "ds_1", producer: { name: "test", version: "1.0.0" }, title: "checkout" };
const RAW_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const ref = (id: string, trace = "t1", session = "s1") => ({ trace, session, id });

describe("--format json: normalized document (spec 7.1)", () => {
  const values: SpanValues = {
    args: { state: "recorded", value: [{ password: "hunter2", id: 7 }] },
    return: { state: "invalid-value", position: "$.spans[1].return", what: "bad tag" },
    error: { state: "unknown-state", raw: "future" }
  };
  const t1 = () =>
    model(
      [
        span("child", "root", 1, {
          kind: "express.handler",
          location: { file: "src/a.ts", line: 3, endLine: 9, snippet: "export function a() {" },
          area: { feature: "cart" },
          attrs: { "http.route": "/cart", "session.id": "abc" },
          durationMs: 1.5,
          runtime: "node",
          values
        }),
        span("root", null, 0, {
          marks: ["invalid-location", "invalid-duration"],
          status: "unknown",
          statusReason: "aborted"
        })
      ],
      { links: [{ from: ref("child"), to: ref("root"), kind: "caused-by" }] }
    );

  it("writes format, dataset, traces, spans in DFS order and links", () => {
    const out = renderDatasetJson({ dataset: DATASET, traces: [t1().trace], models: [t1()], values: fromSpans });
    const doc = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(["format", "version", "dataset", "traces", "spans", "links"]);
    expect(doc.format).toBe("kosmo-trace");
    expect(doc.version).toBe(1);
    expect(doc.dataset).toEqual({ id: "ds_1", producer: { name: "test", version: "1.0.0" }, title: "checkout" });
    expect(doc.traces).toEqual([{ id: "t1", name: "GET /cart" }]);
    expect(doc.links).toEqual([{ from: ref("child"), to: ref("root"), kind: "caused-by" }]);
    const spans = doc.spans as Array<Record<string, unknown>>;
    expect(spans.map((s) => s.id)).toEqual(["root", "child"]);
    expect(out.endsWith("}\n")).toBe(true);
  });

  it("omits fields dropped while reading and writes values in file states only, masked", () => {
    const doc = JSON.parse(
      renderDatasetJson({ dataset: DATASET, traces: [t1().trace], models: [t1()], values: fromSpans })
    );
    const [root, child] = doc.spans as Array<Record<string, unknown>>;
    expect(root).toEqual({
      trace: "t1",
      session: "s1",
      id: "root",
      parent: null,
      order: 0,
      name: "root",
      kind: "function",
      status: "unknown",
      statusReason: "aborted",
      args: { state: "not-recorded" },
      return: { state: "not-recorded" },
      error: { state: "not-recorded" }
    });
    expect(child).toMatchObject({
      parent: "root",
      durationMs: 1.5,
      runtime: "node",
      location: { file: "src/a.ts", line: 3, endLine: 9, snippet: "export function a() {" },
      area: { feature: "cart" },
      attrs: { "http.route": "/cart", "session.id": "masked" },
      args: { state: "recorded", value: [{ password: { $type: "masked" }, id: 7 }] },
      return: { state: "not-recorded", reason: "invalid-value" },
      error: { state: "not-recorded", reason: "future" }
    });
  });

  it("passes validation again (the point of dropping fields)", () => {
    const out = renderDatasetJson({ dataset: DATASET, traces: [t1().trace], models: [t1()], values: fromSpans });
    const result = validateDocument(JSON.parse(out));
    expect(result.ok).toBe(true);
  });

  it("writes C0, DEL, C1 and bidi as \\uXXXX, including \\n and \\t", () => {
    const hostile = "a\nb\tc\u001b[2J\u007f\u009b\u202e";
    const m = model([span("root", null, 0, { name: hostile })]);
    const out = renderDatasetJson({ dataset: DATASET, traces: [m.trace], models: [m], values: fromSpans });
    const body = out.slice(0, -1);
    expect(body.replace(/\n/g, "")).not.toMatch(RAW_CONTROL);
    expect(out).toContain('"name": "a\\u000ab\\u0009c\\u001b[2J\\u007f\\u009b\\u202e"');
    expect((JSON.parse(out) as { spans: Array<{ name: string }> }).spans[0]!.name).toBe(hostile);
    expect(jsonText({ s: 'q"\\\\n' })).toBe('{\n  "s": "q\\"\\\\\\\\n"\n}\n');
  });

  it("keeps a link from a missing span once and does not duplicate cross-trace links", () => {
    const links: LinkRow[] = [
      { from: ref("ghost"), to: ref("root"), kind: "follows-from" },
      { from: ref("root"), to: ref("other", "t2"), kind: "caused-by" }
    ];
    const a = model([span("root", null, 0)], { links });
    const b = model([span("other", null, 0, { trace: "t2" })], { id: "t2", name: null, links });
    const doc = JSON.parse(
      renderDatasetJson({ dataset: DATASET, traces: [a.trace, b.trace], models: [a, b], values: fromSpans })
    );
    expect(doc.traces).toEqual([{ id: "t1", name: "GET /cart" }, { id: "t2" }]);
    expect(doc.links).toEqual([
      { from: ref("root"), to: ref("other", "t2"), kind: "caused-by" },
      { from: ref("ghost"), to: ref("root"), kind: "follows-from" }
    ]);
  });
});

describe("--format json --trace: slice", () => {
  it("has only this trace and the links with at least one end in it (4.12)", () => {
    const links: LinkRow[] = [
      { from: ref("root"), to: ref("x", "t9"), kind: "caused-by" },
      { from: ref("x", "t9"), to: ref("root"), kind: "caused-by" },
      { from: ref("y", "t8"), to: ref("z", "t9"), kind: "caused-by" }
    ];
    const m = model([span("root", null, 0)], { links });
    const doc = JSON.parse(renderTraceSliceJson({ dataset: DATASET, model: m, values: fromSpans, links }));
    expect(doc.traces).toEqual([{ id: "t1", name: "GET /cart" }]);
    expect(doc.spans).toHaveLength(1);
    expect(doc.links).toEqual([links[0], links[1]]);
  });

  it("uses the lookup for lazily loaded values", () => {
    const m = model([span("root", null, 0, { values: undefined })]);
    const loaded: SpanValues = {
      args: { state: "recorded", value: 1 },
      return: { state: "masked" },
      error: { state: "not-recorded" }
    };
    const doc = JSON.parse(renderTraceSliceJson({ dataset: DATASET, model: m, values: () => loaded, links: [] }));
    expect(doc.spans[0].args).toEqual({ state: "recorded", value: 1 });
    expect(doc.spans[0].return).toEqual({ state: "masked" });
    const bare = JSON.parse(renderTraceSliceJson({ dataset: DATASET, model: m, values: fromSpans, links: [] }));
    expect(bare.spans[0]).not.toHaveProperty("args");
  });
});

describe("valueJson", () => {
  it("keeps truncated reasons and live never pretends to be recorded", () => {
    expect(valueJson({ state: "truncated", value: "x", reason: "viewer-cap" })).toEqual({
      state: "truncated",
      value: "x",
      reason: "viewer-cap"
    });
    expect(valueJson({ state: "live", value: 1 })).toEqual({ state: "not-recorded", reason: "live" });
  });
});
