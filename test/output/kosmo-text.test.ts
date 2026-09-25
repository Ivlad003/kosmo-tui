import { describe, expect, it } from "vitest";
import type { Json, SpanValues, Value } from "../../src/format/types.js";
import {
  OUTPUT_BYTE_CAP,
  capValueText,
  jstr,
  joinWithinCap,
  renderKosmoText,
  valueText
} from "../../src/output/kosmo-text.js";
import { chain, fromSpans, model, span, utf8 } from "./helpers.js";

const text = (spans: Parameters<typeof model>[0], detail: 0 | 1 = 0, options: Parameters<typeof model>[1] = {}) =>
  renderKosmoText(model(spans, options), { detail, values: fromSpans });
const lines = (out: string) => out.split("\n").slice(0, -1);
const RAW_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

describe("kosmo-text/v1 header (spec 7.2)", () => {
  it("names the trace, its span count and derived status", () => {
    const out = text([span("a", null, 0), span("b", "a", 1, { status: "errored" })]);
    expect(lines(out)[0]).toBe('kosmo-text/v1 trace="t1" name="GET /cart" spans=2 status=errored');
  });

  it("writes - for a trace without a name and escapes the id", () => {
    const out = text([span("a", null, 0, { trace: "t\u009b1" })], 0, { id: "t\u009b1", name: null });
    expect(lines(out)[0]).toBe('kosmo-text/v1 trace="t\\u009b1" name=- spans=1 status=complete');
  });
});

describe("span-line", () => {
  it("glyph, jstr name, optional kind, loc, area, dur", () => {
    const out = text([
      span("handler", null, 0, {
        location: { file: "src/cart.ts", line: 12 },
        area: { module: "src/cart", feature: "cart" },
        durationMs: 1.8
      }),
      span("auth", "handler", 1, { kind: "express.middleware" })
    ]);
    expect(lines(out).slice(1)).toEqual([
      '✓ "handler"  src/cart.ts:12  [src/cart · cart]  1.8ms',
      '  ✓ "auth" express.middleware  (no location)  [(unknown)]  -'
    ]);
  });

  it("uses one glyph per status", () => {
    const statuses = ["complete", "errored", "running", "suspended", "unknown"] as const;
    const out = text(statuses.map((status, i) => span(status, null, i, { status, statusReason: "x" })));
    expect(
      lines(out)
        .slice(1)
        .map((line) => line.slice(0, 1))
    ).toEqual(["✓", "✗", "…", "⏸", "?"]);
  });

  it("loc: as is for safe paths, jstr otherwise, and the two placeholders", () => {
    const out = text([
      span("a", null, 0, { location: { file: "node_modules/@scope/pkg+x/a~b#c$d.js", line: 3 } }),
      span("b", null, 1, { location: { file: "src/my file.ts", line: 4 } }),
      span("c", null, 2, { marks: ["invalid-location"] }),
      span("d", null, 3)
    ]);
    const locs = lines(out)
      .slice(1)
      .map((line) => line.split("  ")[1]);
    expect(locs).toEqual([
      "node_modules/@scope/pkg+x/a~b#c$d.js:3",
      '"src/my file.ts":4',
      "(invalid-location)",
      "(no location)"
    ]);
  });

  it("area: module, module · feature, ~derived, (unknown), and · feature without a module", () => {
    const out = text([
      span("a", null, 0, { area: { module: "src/cart" } }),
      span("b", null, 1, { area: { module: "src/cart", feature: "check out" } }),
      span("c", null, 2, { location: { file: "src/cart/total.ts", line: 1 } }),
      span("d", null, 3, {
        location: { file: "node_modules/.pnpm/cors@2.8.5/node_modules/cors/lib/index.js", line: 1 }
      }),
      span("e", null, 4),
      span("f", null, 5, { area: { feature: "checkout" }, location: { file: "src/pay.ts", line: 2 } })
    ]);
    const areas = lines(out)
      .slice(1)
      .map((line) => /\[(.*)\]/.exec(line)![1]);
    expect(areas).toEqual(["src/cart", 'src/cart · "check out"', "~src/cart", "~cors", "(unknown)", "· checkout"]);
  });

  it("kind: omitted for function, as is when lower-case dotted, jstr otherwise", () => {
    const out = text([
      span("a", null, 0, { kind: "function" }),
      span("b", null, 1, { kind: "nest.guard" }),
      span("c", null, 2, { kind: "Nest.Guard" })
    ]);
    expect(
      lines(out)
        .slice(1)
        .map((line) => line.split("  ")[0])
    ).toEqual(['✓ "a"', '✓ "b" nest.guard', '✓ "c" "Nest.Guard"']);
  });

  it("dur: toFixed(1) + ms", () => {
    const out = text([
      span("a", null, 0, { durationMs: 12 }),
      span("b", null, 1, { durationMs: 0 }),
      span("c", null, 2, { durationMs: 1234.56 })
    ]);
    expect(
      lines(out)
        .slice(1)
        .map((line) => line.split("  ")[3])
    ).toEqual(["12.0ms", "0.0ms", "1234.6ms"]);
  });

  it("http: only for http.server with at least one of method, route, status; masked like attrs (8.3)", () => {
    const out = text([
      span("r1", null, 0, {
        kind: "http.server",
        attrs: { "http.request.method": "GET", "http.route": "/cart", "http.response.status_code": 200 }
      }),
      span("r2", null, 1, { kind: "http.server", attrs: { "http.route": "/api/orders/:id" } }),
      span("r3", null, 2, { kind: "http.server", attrs: { "next.request.type": "rsc" } }),
      span("r4", null, 3, { kind: "http.client", attrs: { "http.request.method": "GET" } }),
      span("r5", null, 4, { kind: "http.server", attrs: { "http.route": "/cart?token=abc" } })
    ]);
    expect(lines(out).slice(1)).toEqual([
      '✓ "r1" http.server  (no location)  [(unknown)]  -  GET /cart → 200',
      '✓ "r2" http.server  (no location)  [(unknown)]  -  - "/api/orders/:id" → -',
      '✓ "r3" http.server  (no location)  [(unknown)]  -',
      '✓ "r4" http.client  (no location)  [(unknown)]  -',
      '✓ "r5" http.server  (no location)  [(unknown)]  -  - "/cart?token=masked" → -'
    ]);
  });

  it("marks in the fixed order parent, cycle, status, strict-duplicate, invalid-attrs", () => {
    const out = text([
      span("orphan", "nobody", 0, {
        status: "unknown",
        statusReason: "aborted",
        attrs: { "react.strict_mode.duplicate": true },
        droppedAttrs: 2,
        marks: ["invalid-attrs"]
      }),
      span("x", "y", 1, { status: "unknown" }),
      span("y", "x", 2, { marks: ["invalid-attrs"] })
    ]);
    expect(lines(out).slice(1)).toEqual([
      '? "orphan"  (no location)  [(unknown)]  -  parent=unknown(missing) unknown(aborted) strict-duplicate invalid-attrs(2)',
      '? "x"  (no location)  [(unknown)]  -  cycle unknown(unspecified)',
      '  ✓ "y"  (no location)  [(unknown)]  -  invalid-attrs'
    ]);
  });

  it("parent=unknown(ambiguous) for a parent id found in two other sessions", () => {
    const out = text([
      span("p", null, 0, { session: "a" }),
      span("p", null, 0, { session: "b" }),
      span("c", "p", 0, { session: "z" })
    ]);
    expect(out).toContain('✓ "c"  (no location)  [(unknown)]  -  parent=unknown(ambiguous)');
  });

  it("indents two spaces per level in DFS order", () => {
    const out = text([span("root", null, 0), span("b", "root", 2), span("a", "root", 1), span("a1", "a", 3)]);
    const body = lines(out).slice(1);
    expect(body.map((line) => line.indexOf("✓"))).toEqual([0, 2, 4, 2]);
    expect(body.map((line) => line.trim().split(" ")[1])).toEqual(['"root"', '"a"', '"a1"', '"b"']);
  });

  it("never lets a control or bidi character through", () => {
    const hostile = "evil\u001b[2J\u009b31m\u202e\u007f";
    const out = text([
      span(hostile, null, 0, {
        name: hostile,
        kind: hostile,
        location: { file: hostile, line: 1 },
        area: { module: hostile, feature: hostile },
        status: "unknown",
        statusReason: hostile
      })
    ]);
    expect(out).not.toMatch(RAW_CONTROL);
    expect(out).toContain('"evil\\u001b[2J\\u009b31m\\u202e\\u007f"');
  });

  it("does not depend on the order of spans in the input", () => {
    const spans = [span("r", null, 0), span("a", "r", 1), span("b", "r", 2), span("a1", "a", 3)];
    expect(text([...spans].reverse(), 1)).toBe(text(spans, 1));
  });
});

describe("detail-line", () => {
  const recorded = (value: Json): Value => ({ state: "recorded", value });

  it("is indented four spaces past its span and lists args, return, error, attrs", () => {
    const values: SpanValues = {
      args: { state: "recorded", value: [{ id: 7 }, 2] },
      return: { state: "not-recorded", reason: "threw" },
      error: { state: "recorded", value: { name: "RangeError", message: "discount > 100%" } }
    };
    const out = text(
      [span("r", null, 0, { attrs: { "code.function": "calculateLineTotal" }, values }), span("c", "r", 1)],
      1
    );
    expect(lines(out).slice(1)).toEqual([
      '✓ "r"  (no location)  [(unknown)]  -',
      '    args=[{"id":7},2]  return=not-recorded(threw)  error={"message":"discount > 100%","name":"RangeError"}  attrs={"code.function":"calculateLineTotal"}',
      '  ✓ "c"  (no location)  [(unknown)]  -',
      "      args=not-recorded  return=not-recorded  error=not-recorded"
    ]);
  });

  it("v forms for every state (unknown state → unknown-state(jstr raw))", () => {
    expect(valueText(recorded({ b: 1, a: [2] }))).toBe('{"a":[2],"b":1}');
    expect(valueText({ state: "truncated", value: [1, { $type: "more", count: 3 }], reason: "viewer-cap" })).toBe(
      'truncated:[1,{"$type":"more","count":3}]'
    );
    expect(valueText({ state: "masked", reason: "policy" })).toBe("masked");
    expect(valueText({ state: "not-recorded" })).toBe("not-recorded");
    expect(valueText({ state: "not-recorded", reason: "level too low" })).toBe('not-recorded("level too low")');
    expect(valueText({ state: "invalid-value", position: "$.spans[3].args.value", what: "depth > 64" })).toBe(
      'invalid-value("$.spans[3].args.value")'
    );
    expect(valueText({ state: "unknown-state", raw: "future\u009b" })).toBe('unknown-state("future\\u009b")');
  });

  it("masks by key in values and attrs (spec 8.3), state unchanged", () => {
    expect(valueText(recorded({ password: "hunter2", user: "u" }))).toBe('{"password":{"$type":"masked"},"user":"u"}');
    const out = text([span("r", null, 0, { attrs: { "session.id": "abc", "http.route": "/cart" } })], 1);
    expect(lines(out)[2]).toContain('attrs={"http.route":"/cart","session.id":"masked"}');
  });

  it("the lookup wins over values stored in the span (lazy SQLite values)", () => {
    const loaded: SpanValues = {
      args: { state: "recorded", value: 1 },
      return: { state: "recorded", value: 2 },
      error: { state: "not-recorded" }
    };
    const out = renderKosmoText(model([span("r", null, 0)]), { detail: 1, values: () => loaded });
    expect(lines(out)[2]).toBe("    args=1  return=2  error=not-recorded");
  });

  it("caps each value at 512 B: ≤ 509 B at a code point boundary, then …", () => {
    const twoByte = capValueText(`"${"é".repeat(400)}"`);
    expect(twoByte).toBe(`"${"é".repeat(254)}…`);
    expect(utf8(twoByte)).toBe(512);
    const threeByte = capValueText(`"${"中".repeat(400)}"`);
    expect(threeByte).toBe(`"${"中".repeat(169)}…`);
    expect(utf8(threeByte)).toBe(511);
    const exact = `"${"a".repeat(510)}"`;
    expect(capValueText(exact)).toBe(exact);
    const emoji = capValueText("😀".repeat(200));
    expect(emoji).toBe(`${"😀".repeat(127)}…`);
    const out = text(
      [
        span("r", null, 0, { values: { args: recorded("x".repeat(2000)), return: recorded(1), error: recorded(null) } })
      ],
      1
    );
    const args = /args=(.*)  return=/.exec(lines(out)[2]!)![1]!;
    expect(utf8(args)).toBe(512);
    expect(args.endsWith("…")).toBe(true);
  });
});

describe("byte cap 51 200 B (spec 7.2)", () => {
  it("drops whole groups from the end and ends with the trailer", () => {
    const spans = Array.from({ length: 2_000 }, (_, i) =>
      span(`span-${String(i).padStart(4, "0")}-${"x".repeat(40)}`, null, i)
    );
    const out = text(spans, 1);
    expect(utf8(out)).toBeLessThanOrEqual(OUTPUT_BYTE_CAP);
    const all = lines(out);
    const trailer = all.at(-1)!;
    const match = /^… truncated: output-byte-cap \(shown (\d+) of 2000 spans\)$/.exec(trailer);
    expect(match).not.toBeNull();
    const shown = Number(match![1]);
    expect(all).toHaveLength(1 + shown * 2 + 1);
    expect(all.at(-2)!.startsWith("    args=")).toBe(true);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("adds nothing when everything fits", () => {
    const out = text([span("a", null, 0)]);
    expect(out).not.toContain("truncated");
  });

  it("joinWithinCap keeps the trailer inside the cap even when it has to drop more groups", () => {
    // 30 B groups; the trailer "… truncated: output-byte-cap (shown 1 of 3 spans)\n" is 52 B.
    const groups = ["a", "b", "c"].map((letter) => `${letter.repeat(29)}\n`);
    const out = joinWithinCap("H\n", groups, 3, "spans", 2 + 30 + 52);
    expect(out).toBe(`H\n${"a".repeat(29)}\n… truncated: output-byte-cap (shown 1 of 3 spans)\n`);
    expect(utf8(out)).toBe(84);
    expect(joinWithinCap("H\n", groups, 3, "spans", 92)).toBe(`H\n${groups.join("")}`);
  });

  it("Фокус рецензії 1: a 50 000-deep chain stays under the cap without recursion", () => {
    const deep = model(chain(50_000));
    for (const detail of [0, 1] as const) {
      const out = renderKosmoText(deep, { detail, values: fromSpans });
      expect(utf8(out)).toBeLessThanOrEqual(OUTPUT_BYTE_CAP);
      const all = lines(out);
      const match = /^… truncated: output-byte-cap \(shown (\d+) of 50000 spans\)$/.exec(all.at(-1)!);
      expect(match).not.toBeNull();
      const shown = Number(match![1]);
      expect(shown).toBeGreaterThan(100);
      const spanLines = all.filter((line) => line.trimStart().startsWith("✓"));
      expect(spanLines).toHaveLength(shown);
      expect(spanLines.at(-1)!.indexOf("✓")).toBe(2 * (shown - 1));
    }
  });
});

describe("subtree (y)", () => {
  const tree = () => model([span("root", null, 0), span("a", "root", 1), span("a1", "a", 2), span("b", "root", 3)]);

  it("prints only the subtree, indented from its root, with the trace header", () => {
    const out = renderKosmoText(tree(), {
      detail: 0,
      values: fromSpans,
      subtree: { trace: "t1", session: "s1", id: "a" }
    });
    expect(lines(out)).toEqual([
      'kosmo-text/v1 trace="t1" name="GET /cart" spans=4 status=complete',
      '✓ "a"  (no location)  [(unknown)]  -',
      '  ✓ "a1"  (no location)  [(unknown)]  -'
    ]);
  });

  it("counts the subtree in the trailer", () => {
    const deep = model(chain(30_000));
    const out = renderKosmoText(deep, {
      detail: 0,
      values: fromSpans,
      subtree: { trace: "t1", session: "s1", id: "c10000" }
    });
    expect(lines(out).at(-1)).toMatch(/^… truncated: output-byte-cap \(shown \d+ of 20000 spans\)$/);
    expect(lines(out)[1]).toBe('✓ "c10000"  (no location)  [(unknown)]  -');
  });

  it("an unknown ref gives just the header", () => {
    const out = renderKosmoText(tree(), {
      detail: 0,
      values: fromSpans,
      subtree: { trace: "t1", session: "s1", id: "zz" }
    });
    expect(lines(out)).toHaveLength(1);
  });
});

describe("jstr", () => {
  it("is JSON.stringify plus \\uXXXX for DEL, C1 and bidi", () => {
    expect(jstr('a"b\n')).toBe('"a\\"b\\n"');
    expect(jstr("\u007f\u0085\u009b\u202a\u202e\u2066\u2069")).toBe(
      '"\\u007f\\u0085\\u009b\\u202a\\u202e\\u2066\\u2069"'
    );
    expect(JSON.parse(jstr("x\u009by"))).toBe("x\u009by");
  });
});
