import { describe, expect, it } from "vitest";
import { NOT_RECORDED, type SpanRow } from "../../src/format/types.js";
import {
  DatasetAccumulator,
  LIMITS,
  atPath,
  compareBytes,
  utf8Bytes,
  validateDocument,
  validateHeader,
  validateLink,
  validateSpan,
  validateTraceDecl
} from "../../src/format/validate.js";

const AT = "$.spans[0]";
/** 128 × "я" is 256 UTF-8 bytes in 128 characters: limits are bytes, not characters. */
const ID_256 = "я".repeat(128);
const ID_257 = `${ID_256}a`;
const TEXT_1024 = "я".repeat(512);
const TEXT_1025 = `${TEXT_1024}a`;

function rawSpan(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { trace: "t", session: "s1", id: "sp_1", parent: null, order: 0, name: "f", status: "complete", ...fields };
}

function spanOf(raw: unknown, position = AT): SpanRow {
  const result = validateSpan(raw, position);
  if (!result.ok) throw new Error(`unexpected fatal ${result.position}: ${result.what}`);
  return result.span;
}

function documentOf(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { format: "kosmo-trace", version: 1, dataset: { id: "ds_1" }, spans: [], ...fields };
}

describe("LIMITS and helpers", () => {
  it("are the spec 4.9 numbers", () => {
    expect(LIMITS).toEqual({
      fileBytes: 64 * 1024 * 1024,
      ndjsonLineBytes: 1024 * 1024,
      streamBytes: 64 * 1024 * 1024,
      streamSpans: 200_000,
      traceSpans: 200_000,
      idBytes: 256,
      textBytes: 1024,
      fileBytesPath: 4096,
      snippetBytes: 512
    });
  });

  it("re-exports the byte helpers and builds JSON-path positions", () => {
    expect(utf8Bytes(ID_257)).toBe(257);
    expect(compareBytes("Z", "a")).toBe(-1);
    expect(atPath("$", "spans", 3, "location", "line")).toBe("$.spans[3].location.line");
    expect(atPath("line 12", "trace")).toBe("line 12.trace");
    expect(atPath("$.attrs", "http.route")).toBe('$.attrs["http.route"]');
    expect(atPath("$", "\u001b[2J\u009b\u202e")).toBe('$["\\u001b[2J\\u009b\\u202e"]');
  });
});

describe("validateHeader (spec 4.1, 4.9)", () => {
  it("reads every dataset field and ignores unknown ones and the NDJSON type", () => {
    const raw = {
      type: "header",
      format: "kosmo-trace",
      version: 1,
      dataset: {
        id: "ds_01J",
        producer: { name: "my-recorder", version: "1.2.0" },
        createdAt: "2026-09-24T10:00:00Z",
        root: "/Users/me/app",
        title: "checkout bug repro",
        future: true
      }
    };
    expect(validateHeader(raw, "line 1")).toEqual({
      ok: true,
      dataset: {
        id: "ds_01J",
        producer: { name: "my-recorder", version: "1.2.0" },
        createdAt: "2026-09-24T10:00:00Z",
        root: "/Users/me/app",
        title: "checkout bug repro"
      }
    });
    expect(
      validateHeader({ format: "kosmo-trace", version: 1, dataset: { id: "d", producer: { name: "p" } } }, "$")
    ).toEqual({ ok: true, dataset: { id: "d", producer: { name: "p" } } });
  });

  it("format ≠ kosmo-trace is not-a-kosmo-trace, version ≠ 1 is unsupported-version", () => {
    expect(validateHeader({ format: "other", version: 1, dataset: { id: "d" } }, "$")).toEqual({
      ok: false,
      code: "not-a-kosmo-trace",
      position: "$.format",
      what: 'must be "kosmo-trace"'
    });
    expect(validateHeader({ version: 1 }, "$")).toMatchObject({ code: "not-a-kosmo-trace" });
    expect(validateHeader([], "$")).toMatchObject({ code: "not-a-kosmo-trace" });
    expect(validateHeader({ format: "kosmo-trace", version: 2, dataset: { id: "d" } }, "$")).toEqual({
      ok: false,
      code: "unsupported-version",
      position: "$.version",
      what: "version 2 is not supported"
    });
  });

  it("a missing or mistyped required field is invalid", () => {
    expect(validateHeader({ format: "kosmo-trace", dataset: { id: "d" } }, "$")).toEqual({
      ok: false,
      code: "invalid",
      position: "$.version",
      what: "is required"
    });
    expect(validateHeader({ format: "kosmo-trace", version: "1", dataset: { id: "d" } }, "$")).toMatchObject({
      code: "invalid",
      what: "must be a number"
    });
    expect(validateHeader({ format: "kosmo-trace", version: 1 }, "$")).toMatchObject({ position: "$.dataset" });
    expect(validateHeader({ format: "kosmo-trace", version: 1, dataset: "d" }, "$")).toMatchObject({
      position: "$.dataset",
      what: "must be an object"
    });
    expect(validateHeader({ format: "kosmo-trace", version: 1, dataset: { id: ID_257 } }, "line 1")).toEqual({
      ok: false,
      code: "invalid",
      position: "line 1.dataset.id",
      what: "exceeds 256 bytes"
    });
    expect(
      validateHeader({ format: "kosmo-trace", version: 1, dataset: { id: "d", producer: {} } }, "$")
    ).toMatchObject({
      position: "$.dataset.producer.name",
      what: "is required"
    });
    expect(validateHeader({ format: "kosmo-trace", version: 1, dataset: { id: "d", root: null } }, "$")).toMatchObject({
      position: "$.dataset.root",
      what: "must be a string"
    });
  });

  it("caps title, createdAt and producer strings at 1024 B and root at 4096 B, fatal like an oversize name", () => {
    const header = (dataset: Record<string, unknown>) =>
      validateHeader({ format: "kosmo-trace", version: 1, dataset: { id: "d", ...dataset } }, "$");
    for (const key of ["title", "createdAt"]) {
      expect(header({ [key]: TEXT_1024 }).ok).toBe(true);
      expect(header({ [key]: TEXT_1025 })).toEqual({
        ok: false,
        code: "invalid",
        position: `$.dataset.${key}`,
        what: "exceeds 1024 bytes"
      });
    }
    expect(header({ producer: { name: TEXT_1024, version: TEXT_1024 } }).ok).toBe(true);
    expect(header({ producer: { name: TEXT_1025 } })).toMatchObject({
      code: "invalid",
      position: "$.dataset.producer.name",
      what: "exceeds 1024 bytes"
    });
    expect(header({ producer: { name: "p", version: TEXT_1025 } })).toMatchObject({
      code: "invalid",
      position: "$.dataset.producer.version",
      what: "exceeds 1024 bytes"
    });
    const root4096 = `/${"я".repeat(2047)}a`;
    expect(utf8Bytes(root4096)).toBe(4096);
    expect(header({ root: root4096 }).ok).toBe(true);
    expect(header({ root: `${root4096}a` })).toMatchObject({
      code: "invalid",
      position: "$.dataset.root",
      what: "exceeds 4096 bytes"
    });
    expect(header({ title: "x".repeat(1_048_576) })).toMatchObject({ what: "exceeds 1024 bytes" });
  });
});

describe("validateTraceDecl", () => {
  it("reads id and optional name", () => {
    expect(validateTraceDecl({ id: "t_9f", name: "GET /cart" }, "$.traces[0]")).toEqual({
      ok: true,
      trace: { id: "t_9f", name: "GET /cart" }
    });
    expect(validateTraceDecl({ id: "t" }, "$.traces[0]")).toEqual({ ok: true, trace: { id: "t", name: null } });
  });

  it("enforces types and byte limits", () => {
    expect(validateTraceDecl({ id: "t", name: null }, "$.traces[0]")).toMatchObject({ position: "$.traces[0].name" });
    expect(validateTraceDecl({ id: ID_257 }, "$.traces[0]")).toMatchObject({ what: "exceeds 256 bytes" });
    expect(validateTraceDecl({ id: "t", name: TEXT_1025 }, "$.traces[0]")).toMatchObject({
      what: "exceeds 1024 bytes"
    });
    expect(validateTraceDecl({ id: "t", name: TEXT_1024 }, "$.traces[0]").ok).toBe(true);
    expect(validateTraceDecl("t", "$.traces[0]")).toMatchObject({ what: "must be an object" });
  });
});

describe("validateSpan: fields (spec 4.1)", () => {
  it("a minimal span gets kind function, no marks and not-recorded values", () => {
    expect(spanOf(rawSpan())).toEqual({
      ref: { trace: "t", session: "s1", id: "sp_1" },
      parent: null,
      order: 0,
      name: "f",
      kind: "function",
      status: "complete",
      droppedAttrs: 0,
      marks: [],
      values: { args: NOT_RECORDED, return: NOT_RECORDED, error: NOT_RECORDED }
    });
  });

  it("reads the spec 4.1 example span", () => {
    const span = spanOf({
      trace: "t_9f",
      session: "s1",
      id: "sp_3",
      parent: "sp_1",
      order: 17,
      name: "calculateLineTotal",
      kind: "function",
      status: "errored",
      durationMs: 1.8,
      runtime: "node",
      location: {
        file: "src/cart.ts",
        line: 12,
        column: 3,
        endLine: 20,
        snippet: "export async function f(item, qty) {"
      },
      area: { module: "src/cart", feature: "cart" },
      attrs: { "code.function": "calculateLineTotal" },
      args: { state: "recorded", value: [{ id: 7 }, 2] },
      return: { state: "not-recorded", reason: "threw" },
      error: { state: "recorded", value: { name: "RangeError", message: "discount > 100%" } },
      futureField: 1
    });
    expect(span).toEqual({
      ref: { trace: "t_9f", session: "s1", id: "sp_3" },
      parent: "sp_1",
      order: 17,
      name: "calculateLineTotal",
      kind: "function",
      status: "errored",
      durationMs: 1.8,
      runtime: "node",
      location: {
        file: "src/cart.ts",
        line: 12,
        column: 3,
        endLine: 20,
        snippet: "export async function f(item, qty) {"
      },
      area: { module: "src/cart", feature: "cart" },
      attrs: { "code.function": "calculateLineTotal" },
      droppedAttrs: 0,
      marks: [],
      values: {
        args: { state: "recorded", value: [{ id: 7 }, 2] },
        return: { state: "not-recorded", reason: "threw" },
        error: { state: "recorded", value: { name: "RangeError", message: "discount > 100%" } }
      }
    });
  });

  it("every missing required field is fatal at its position", () => {
    for (const key of ["trace", "session", "id", "parent", "order", "name", "status"]) {
      const raw = rawSpan();
      delete raw[key];
      expect(validateSpan(raw, AT), key).toEqual({
        ok: false,
        code: "invalid",
        position: `${AT}.${key}`,
        what: "is required"
      });
    }
    expect(validateSpan("span", AT)).toEqual({ ok: false, code: "invalid", position: AT, what: "must be an object" });
  });

  it("a wrong JSON type of a required field is fatal", () => {
    expect(validateSpan(rawSpan({ id: 1 }), AT)).toMatchObject({ position: `${AT}.id`, what: "must be a string" });
    expect(validateSpan(rawSpan({ parent: 3 }), AT)).toMatchObject({ what: "must be a string or null" });
    expect(validateSpan(rawSpan({ status: 5 }), AT)).toMatchObject({ position: `${AT}.status` });
    expect(validateSpan(rawSpan({ kind: null }), AT)).toMatchObject({ position: `${AT}.kind` });
    expect(validateSpan(rawSpan({ durationMs: "1.8" }), AT)).toMatchObject({ what: "must be a number" });
    expect(validateSpan(rawSpan({ runtime: 1 }), AT)).toMatchObject({ position: `${AT}.runtime` });
    expect(validateSpan(rawSpan({ area: "cart" }), AT)).toMatchObject({ position: `${AT}.area` });
    expect(validateSpan(rawSpan({ area: { module: 5 } }), AT)).toMatchObject({ position: `${AT}.area.module` });
  });

  it("uses the reader's base position, e.g. an NDJSON line", () => {
    expect(validateSpan({ ...rawSpan(), trace: undefined }, "line 12")).toMatchObject({ position: "line 12.trace" });
  });

  it("order is an integer 0…2^53−1 (spec 4.3)", () => {
    expect(spanOf(rawSpan({ order: 2 ** 53 - 1 })).order).toBe(2 ** 53 - 1);
    for (const order of [-1, 1.5, 2 ** 53, "17", Number.NaN]) {
      expect(validateSpan(rawSpan({ order }), AT), String(order)).toEqual({
        ok: false,
        code: "invalid",
        position: `${AT}.order`,
        what: "must be an integer from 0 to 2^53-1"
      });
    }
  });

  it("parentSession is kept with a parent and fatal with parent: null (spec 4.3 rule 1)", () => {
    expect(spanOf(rawSpan({ parent: "p", parentSession: "browser" })).parentSession).toBe("browser");
    expect(validateSpan(rawSpan({ parent: null, parentSession: "s1" }), AT)).toEqual({
      ok: false,
      code: "invalid",
      position: `${AT}.parentSession`,
      what: "is not allowed with parent: null"
    });
  });

  it("status: unknown values become unknown with the raw value as reason (spec 4.4, 4.11)", () => {
    const paused = spanOf(rawSpan({ status: "paused", statusReason: "ignored" }));
    expect(paused.status).toBe("unknown");
    expect(paused.statusReason).toBe("paused");
    expect(paused.marks).toEqual(["unknown-status"]);
    const aborted = spanOf(rawSpan({ status: "unknown", statusReason: "aborted" }));
    expect(aborted).toMatchObject({ status: "unknown", statusReason: "aborted", marks: [] });
    const unspecified = spanOf(rawSpan({ status: "unknown" }));
    expect(unspecified.statusReason).toBeUndefined();
    for (const status of ["complete", "errored", "running", "suspended"])
      expect(spanOf(rawSpan({ status })).status).toBe(status);
  });

  it("runtime: unknown values become other (spec 4.11)", () => {
    expect(spanOf(rawSpan({ runtime: "deno" })).runtime).toBe("other");
    expect(spanOf(rawSpan({ runtime: "edge" })).runtime).toBe("edge");
    expect(spanOf(rawSpan()).runtime).toBeUndefined();
  });

  it("durationMs < 0 or not finite is dropped with invalid-duration", () => {
    for (const durationMs of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
      const span = spanOf(rawSpan({ durationMs }));
      expect(span.durationMs).toBeUndefined();
      expect(span.marks).toEqual(["invalid-duration"]);
    }
    expect(spanOf(rawSpan({ durationMs: 0 })).durationMs).toBe(0);
  });

  it("area: an object without module and feature counts as absent", () => {
    expect(spanOf(rawSpan({ area: {} })).area).toBeUndefined();
    expect(spanOf(rawSpan({ area: { feature: "cart" } })).area).toEqual({ feature: "cart" });
    expect(validateSpan(rawSpan({ area: { module: TEXT_1025 } }), AT)).toMatchObject({ what: "exceeds 1024 bytes" });
  });

  it("attrs: a non-object drops attrs whole, bad entries are counted (spec 4.13)", () => {
    const whole = spanOf(rawSpan({ attrs: ["a"] }));
    expect(whole).toMatchObject({ droppedAttrs: 0, marks: ["invalid-attrs"] });
    expect(whole.attrs).toBeUndefined();
    const partial = spanOf(rawSpan({ attrs: { "http.route": "/a", Bad: 1, "x.y": null } }));
    expect(partial).toMatchObject({ attrs: { "http.route": "/a" }, droppedAttrs: 2, marks: ["invalid-attrs"] });
  });

  it("marks come in a fixed order", () => {
    const span = spanOf(rawSpan({ status: "weird", durationMs: -5, attrs: 1, location: { file: "/abs", line: 1 } }));
    expect(span.marks).toEqual(["invalid-location", "invalid-attrs", "invalid-duration", "unknown-status"]);
  });

  it("values: opts.values false leaves them for the lazy SQLite path", () => {
    const span = validateSpan(rawSpan({ args: { state: "recorded", value: 1 } }), AT, { values: false });
    expect(span.ok && span.span.values).toBeUndefined();
  });

  it("values: a field over 64 KiB is cut by the viewer (spec 4.9)", () => {
    const span = spanOf(rawSpan({ args: { state: "recorded", value: "x".repeat(70_000) } }));
    expect(span.values?.args).toMatchObject({ state: "truncated", reason: "viewer-cap" });
  });
});

describe("validateSpan: location (spec 4.8, 4.9)", () => {
  it("keeps a valid location", () => {
    expect(spanOf(rawSpan({ location: { file: "src/cart.ts", line: 12 } })).location).toEqual({
      file: "src/cart.ts",
      line: 12
    });
    expect(
      spanOf(rawSpan({ location: { file: "node_modules/@scope/p/x.js", line: 1, snippetCut: true } })).location
    ).toEqual({
      file: "node_modules/@scope/p/x.js",
      line: 1
    });
  });

  it("drops every broken location with invalid-location and keeps the span", () => {
    const broken: unknown[] = [
      "src/cart.ts",
      null,
      {},
      { file: "src/cart.ts" },
      { file: "/etc/passwd", line: 1 },
      { file: "../outside.ts", line: 1 },
      { file: "src/../../x.ts", line: 1 },
      { file: "file:///work/app/x.ts", line: 1 },
      { file: "webpack://app/./src/x.ts", line: 1 },
      { file: "C:/work/x.ts", line: 1 },
      { file: "src\\cart.ts", line: 1 },
      { file: "src/\u001b[2Jcart.ts", line: 1 },
      { file: "src/\u009bcart.ts", line: 1 },
      { file: "src/cart\u202e.ts", line: 1 },
      { file: "", line: 1 },
      { file: `${"a".repeat(4095)}.t`, line: 1 },
      { file: "src/cart.ts", line: 0 },
      { file: "src/cart.ts", line: "12" },
      { file: "src/cart.ts", line: 1.5 },
      { file: "src/cart.ts", line: 3, column: 0 },
      { file: "src/cart.ts", line: 3, endLine: 2 },
      { file: 5, line: 1 }
    ];
    for (const location of broken) {
      const label = JSON.stringify(location).slice(0, 60);
      const span = spanOf(rawSpan({ location }));
      expect(span.location, label).toBeUndefined();
      expect(span.marks, label).toEqual(["invalid-location"]);
    }
    // 4096 bytes is the limit itself
    expect(spanOf(rawSpan({ location: { file: `${"a".repeat(4094)}.t`, line: 1 } })).marks).toEqual([]);
  });

  it("a bad snippet is dropped with invalid-snippet and the location stays", () => {
    const at = { file: "src/cart.ts", line: 12 };
    expect(spanOf(rawSpan({ location: { ...at, snippet: "я".repeat(256) } })).marks).toEqual([]);
    for (const extra of [
      { snippet: `${"я".repeat(256)}a` },
      { snippet: "line one\nline two" },
      { snippet: 5 },
      { snippet: "ok", snippetCut: "yes" },
      // no snippet at all: a non-boolean snippetCut is still marked (the schema rejects it, spec 4.10)
      { snippetCut: 1 }
    ]) {
      const span = spanOf(rawSpan({ location: { ...at, ...extra } }));
      expect(span.location, JSON.stringify(extra)).toEqual(at);
      expect(span.marks, JSON.stringify(extra)).toEqual(["invalid-snippet"]);
    }
    expect(spanOf(rawSpan({ location: { ...at, snippet: "export async", snippetCut: true } })).location).toEqual({
      ...at,
      snippet: "export async",
      snippetCut: true
    });
  });
});

describe("validateLink (spec 4.12)", () => {
  const ref = { trace: "t", session: "s1", id: "a" };

  it("checks only the SpanRef shapes and the kind; unknown kinds stay as they are", () => {
    expect(validateLink({ from: ref, to: { ...ref, id: "missing" }, kind: "caused-by" }, "$.links[0]")).toEqual({
      ok: true,
      link: { from: ref, to: { ...ref, id: "missing" }, kind: "caused-by" }
    });
    expect(validateLink({ from: ref, to: ref, kind: "caught-by" }, "$.links[0]")).toMatchObject({ ok: true });
  });

  it("is fatal on a broken ref or kind", () => {
    expect(validateLink({ to: ref, kind: "k" }, "$.links[0]")).toMatchObject({ position: "$.links[0].from" });
    expect(validateLink({ from: { ...ref, id: ID_257 }, to: ref, kind: "k" }, "$.links[0]")).toMatchObject({
      position: "$.links[0].from.id",
      what: "exceeds 256 bytes"
    });
    expect(validateLink({ from: ref, to: "t:s1:a", kind: "k" }, "$.links[0]")).toMatchObject({
      position: "$.links[0].to"
    });
    expect(validateLink({ from: ref, to: ref }, "$.links[0]")).toMatchObject({ position: "$.links[0].kind" });
    expect(validateLink({ from: ref, to: ref, kind: TEXT_1025 }, "$.links[0]")).toMatchObject({
      what: "exceeds 1024 bytes"
    });
  });
});

describe("DatasetAccumulator", () => {
  const span = (fields: Record<string, unknown>): SpanRow => spanOf(rawSpan(fields));

  it("rejects a second declaration of a trace and duplicate spans or orders (spec 4.9)", () => {
    const acc = new DatasetAccumulator();
    expect(acc.addTrace({ id: "t", name: null }, "$.traces[0]")).toBeNull();
    expect(acc.addTrace({ id: "t", name: "again" }, "$.traces[1]")).toEqual({
      ok: false,
      code: "invalid",
      position: "$.traces[1]",
      what: "duplicate trace id"
    });
    expect(acc.addSpan(span({ id: "a", order: 1 }), "$.spans[0]")).toBeNull();
    expect(acc.addSpan(span({ id: "a", order: 2 }), "$.spans[1]")).toEqual({
      ok: false,
      code: "invalid",
      position: "$.spans[1]",
      what: "duplicate span (trace, session, id)"
    });
    expect(acc.addSpan(span({ id: "b", order: 1 }), "$.spans[2]")).toEqual({
      ok: false,
      code: "invalid",
      position: "$.spans[2]",
      what: "duplicate order in (trace, session)"
    });
    // the same id or order in another session or another trace is a different span
    expect(acc.addSpan(span({ id: "a", order: 1, session: "browser" }), "$.spans[3]")).toBeNull();
    expect(acc.addSpan(span({ id: "a", order: 1, trace: "t2" }), "$.spans[4]")).toBeNull();
    expect(acc.spanCount).toBe(3);
  });

  it("summarises traces by id byte-wise, with spans, status and requests", () => {
    const acc = new DatasetAccumulator();
    for (const id of ["b", "a", "é", "z", "Z", "😀", "\uffff"]) acc.addTrace({ id, name: `trace ${id}` }, "$");
    acc.addSpan(span({ trace: "a", id: "1", status: "errored" }), "$");
    acc.addSpan(
      span({
        trace: "a",
        id: "2",
        order: 1,
        kind: "http.server",
        attrs: { "http.request.method": "GET", "http.route": "/cart", "http.response.status_code": 200 }
      }),
      "$"
    );
    acc.addSpan(span({ trace: "only-spans", id: "1", status: "running" }), "$");
    const summaries = acc.traceSummaries();
    expect(summaries.map((s) => s.id)).toEqual(["Z", "a", "b", "only-spans", "z", "é", "\uffff", "😀"]);
    expect(summaries[1]).toEqual({
      id: "a",
      name: "trace a",
      spans: 2,
      status: "errored",
      requests: { first: { method: "GET", route: "/cart", status: 200 }, count: 1 }
    });
    expect(summaries[2]).toEqual({ id: "b", name: "trace b", spans: 0, status: "complete", requests: null });
    expect(summaries[3]).toEqual({ id: "only-spans", name: null, spans: 1, status: "incomplete", requests: null });
  });

  it("keeps spans in insertion order and links under every trace they touch", () => {
    const acc = new DatasetAccumulator();
    acc.addSpan(span({ id: "second", order: 5 }), "$");
    acc.addSpan(span({ id: "first", order: 1 }), "$");
    expect(acc.spansOf("t").map((s) => s.ref.id)).toEqual(["second", "first"]);
    expect(acc.spansOf("nope")).toEqual([]);
    const cross = {
      from: { trace: "t", session: "s1", id: "first" },
      to: { trace: "t2", session: "s", id: "x" },
      kind: "caused-by"
    };
    const local = {
      from: { trace: "t", session: "s1", id: "first" },
      to: { trace: "t", session: "s1", id: "second" },
      kind: "follows-from"
    };
    acc.addLink(cross);
    acc.addLink(local);
    expect(acc.linksOf("t")).toEqual([cross, local]);
    expect(acc.linksOf("t2")).toEqual([cross]);
    expect(acc.traceSummaries().map((s) => s.id)).toEqual(["t"]); // a link alone never creates a trace
  });
});

describe("validateDocument (spec 4.1, 4.5)", () => {
  it("accepts the spec example and counts unknown top-level fields", () => {
    const result = validateDocument(
      documentOf({
        traces: [{ id: "t_9f", name: "GET /cart" }],
        spans: [
          rawSpan({ trace: "t_9f", id: "sp_1" }),
          rawSpan({ trace: "t_9f", id: "sp_3", parent: "sp_1", order: 17 })
        ],
        links: [
          {
            from: { trace: "t_9f", session: "s1", id: "sp_3" },
            to: { trace: "t_9f", session: "s1", id: "sp_1" },
            kind: "caused-by"
          }
        ],
        comment: "unknown",
        extensions: {}
      })
    );
    if (!result.ok) throw new Error(result.what);
    expect(result.dataset).toEqual({ id: "ds_1" });
    expect(result.unknownFields).toBe(2);
    expect(result.acc.spanCount).toBe(2);
    expect(result.acc.traceSummaries()).toEqual([
      { id: "t_9f", name: "GET /cart", spans: 2, status: "complete", requests: null }
    ]);
    expect(result.acc.linksOf("t_9f")).toHaveLength(1);
  });

  it("an empty spans array is a valid document", () => {
    const result = validateDocument(documentOf());
    expect(result.ok && result.acc.traceSummaries()).toEqual([]);
  });

  it("reports the first fatal problem with its JSON path", () => {
    expect(validateDocument([])).toMatchObject({ code: "not-a-kosmo-trace", position: "$" });
    expect(validateDocument("x")).toMatchObject({ code: "not-a-kosmo-trace" });
    const noSpans = documentOf();
    delete noSpans.spans;
    expect(validateDocument(noSpans)).toEqual({ ok: false, code: "invalid", position: "$.spans", what: "is required" });
    expect(validateDocument(documentOf({ spans: {} }))).toMatchObject({
      position: "$.spans",
      what: "must be an array"
    });
    expect(validateDocument(documentOf({ traces: "t" }))).toMatchObject({ position: "$.traces" });
    expect(validateDocument(documentOf({ links: [{}] }))).toMatchObject({ position: "$.links[0].from" });
    expect(validateDocument(documentOf({ spans: [rawSpan(), rawSpan({ order: 1 })] }))).toEqual({
      ok: false,
      code: "invalid",
      position: "$.spans[1]",
      what: "duplicate span (trace, session, id)"
    });
    expect(validateDocument(documentOf({ traces: [{ id: "t" }, { id: "t" }] }))).toMatchObject({
      position: "$.traces[1]",
      what: "duplicate trace id"
    });
  });
});

describe("hostile matrix (spec 13.3, validator part)", () => {
  type Case = { name: string; raw: unknown; expect: { fatal: string; position: string } | { marks: string[] } };
  const cases: Case[] = [
    {
      name: "id of 257 bytes in 129 characters (Cyrillic)",
      raw: rawSpan({ id: ID_257 }),
      expect: { fatal: "invalid", position: `${AT}.id` }
    },
    {
      name: "trace of 257 bytes",
      raw: rawSpan({ trace: ID_257 }),
      expect: { fatal: "invalid", position: `${AT}.trace` }
    },
    {
      name: "session of 257 bytes",
      raw: rawSpan({ session: ID_257 }),
      expect: { fatal: "invalid", position: `${AT}.session` }
    },
    {
      name: "parent of 257 bytes",
      raw: rawSpan({ parent: ID_257 }),
      expect: { fatal: "invalid", position: `${AT}.parent` }
    },
    {
      name: "parentSession of 257 bytes",
      raw: rawSpan({ parent: "p", parentSession: ID_257 }),
      expect: { fatal: "invalid", position: `${AT}.parentSession` }
    },
    { name: "id of exactly 256 bytes", raw: rawSpan({ id: ID_256 }), expect: { marks: [] } },
    {
      name: "name of 1025 bytes",
      raw: rawSpan({ name: TEXT_1025 }),
      expect: { fatal: "invalid", position: `${AT}.name` }
    },
    {
      name: "kind of 1025 bytes",
      raw: rawSpan({ kind: TEXT_1025 }),
      expect: { fatal: "invalid", position: `${AT}.kind` }
    },
    {
      name: "statusReason of 1025 bytes",
      raw: rawSpan({ status: "unknown", statusReason: TEXT_1025 }),
      expect: { fatal: "invalid", position: `${AT}.statusReason` }
    },
    {
      // an unknown status becomes statusReason (4.11), so it has the statusReason limit
      name: "unknown status of 1025 bytes",
      raw: rawSpan({ status: TEXT_1025 }),
      expect: { fatal: "invalid", position: `${AT}.status` }
    },
    {
      name: "parentSession with parent null",
      raw: rawSpan({ parentSession: "s1" }),
      expect: { fatal: "invalid", position: `${AT}.parentSession` }
    },
    { name: "negative order", raw: rawSpan({ order: -1 }), expect: { fatal: "invalid", position: `${AT}.order` } },
    {
      name: "ESC/CSI/OSC in name stays data",
      raw: rawSpan({ name: "\u001b[2J\u001b]8;;x\u0007" }),
      expect: { marks: [] }
    },
    { name: "C1 and bidi in kind stay data", raw: rawSpan({ kind: "\u009b\u202eevil" }), expect: { marks: [] } },
    {
      name: "control character in location.file",
      raw: rawSpan({ location: { file: "src/\u001b]8;;x.ts", line: 1 } }),
      expect: { marks: ["invalid-location"] }
    },
    {
      name: "bidi in location.file",
      raw: rawSpan({ location: { file: "src/\u2066x.ts", line: 1 } }),
      expect: { marks: ["invalid-location"] }
    },
    {
      name: "'..' in location.file",
      raw: rawSpan({ location: { file: "src/../../etc/passwd", line: 1 } }),
      expect: { marks: ["invalid-location"] }
    },
    {
      name: "absolute location.file",
      raw: rawSpan({ location: { file: "/etc/passwd", line: 1 } }),
      expect: { marks: ["invalid-location"] }
    },
    { name: "unknown status", raw: rawSpan({ status: "paused" }), expect: { marks: ["unknown-status"] } },
    { name: "unknown runtime", raw: rawSpan({ runtime: "deno" }), expect: { marks: [] } },
    { name: "unknown kind", raw: rawSpan({ kind: "koa.middleware" }), expect: { marks: [] } }
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const result = validateSpan(testCase.raw, AT);
      if ("fatal" in testCase.expect) {
        expect(result).toMatchObject({ ok: false, code: testCase.expect.fatal, position: testCase.expect.position });
      } else {
        expect(result.ok && result.span.marks).toEqual(testCase.expect.marks);
      }
    });
  }

  it("control and bidi text in data is kept as is (the terminal layer escapes it)", () => {
    const span = spanOf(rawSpan({ name: "\u001b[2J", attrs: { "x.y": "\u009b\u202e" } }));
    expect(span.name).toBe("\u001b[2J");
    expect(span.attrs).toEqual({ "x.y": "\u009b\u202e" });
  });

  it("Value nested 65 deep becomes invalid-value; the span and the trace stay", () => {
    let deep: unknown = 1;
    for (let level = 0; level < 65; level += 1) deep = [deep];
    const result = validateDocument(documentOf({ spans: [rawSpan({ args: { state: "recorded", value: deep } })] }));
    if (!result.ok) throw new Error(result.what);
    const args = result.acc.spansOf("t")[0]?.values?.args;
    expect(args).toMatchObject({ state: "invalid-value", what: "nesting deeper than 64" });
    expect(args?.state === "invalid-value" && args.position.startsWith("$.spans[0].args.value")).toBe(true);
  });

  it("unavailable in a file, unknown tags and unknown states degrade per field", () => {
    const span = spanOf(
      rawSpan({
        args: { state: "recorded", value: { $type: "unavailable", reason: "TDZ" } },
        return: { state: "recorded", value: { $type: "regexp", source: "x" } },
        error: { state: "exploded" }
      })
    );
    expect(span.values?.args).toMatchObject({ state: "invalid-value", position: `${AT}.args.value` });
    expect(span.values?.return).toEqual({ state: "recorded", value: { $type: "regexp", source: "x" } });
    expect(span.values?.error).toEqual({ state: "unknown-state", raw: "exploded" });
  });

  it("a position built from a hostile key carries no control or bidi character", () => {
    const span = spanOf(
      rawSpan({ args: { state: "recorded", value: { "\u001b]8;;x\u0007\u009b\u202e": { $type: "deeper" } } } })
    );
    const args = span.values?.args;
    if (args?.state !== "invalid-value") throw new Error("expected invalid-value");
    expect(args.position).toBe(`${AT}.args.value["\\u001b]8;;x\\u0007\\u009b\\u202e"]`);
    expect(args.position).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
  });

  it("version 2 and a foreign format are refused before anything else", () => {
    expect(validateDocument(documentOf({ version: 2, spans: "garbage" }))).toMatchObject({
      code: "unsupported-version"
    });
    expect(validateDocument(documentOf({ format: "otel", spans: "garbage" }))).toMatchObject({
      code: "not-a-kosmo-trace"
    });
  });

  it("duplicate spans and duplicate orders are fatal in a document", () => {
    expect(validateDocument(documentOf({ spans: [rawSpan({ id: "a" }), rawSpan({ id: "b" })] }))).toMatchObject({
      what: "duplicate order in (trace, session)",
      position: "$.spans[1]"
    });
  });
});
