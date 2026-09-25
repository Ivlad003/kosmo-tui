/**
 * Task 18: detail pane of spec 6.4 — values of 4.2, location/area of 4.7, the code window with the
 * `▶` line always visible (review focus 3), hostile text in every field (review focus 2).
 */
import { describe, expect, it } from "vitest";
import { stripAnsi, visibleWidth } from "../../src/ansi.js";
import { COLOR_16, COLOR_NONE } from "../../src/color.js";
import type { Snippet } from "../../src/code/snippet.js";
import type { LinkRow, SpanRow, SpanValues } from "../../src/format/types.js";
import { detailLines, valueText, type DetailInput, type DetailOptions } from "../../src/ui/detail.js";
import { model, ref, span } from "./model-fixtures.js";

const CODE = [
  "export async function calculateLineTotal(item, qty) {",
  "  const p = await price(item.id);",
  "  if (item.discount > 100) {",
  '    throw new RangeError("discount > 100%");',
  "  }",
  "  const total = p * qty;",
  "  log(total);",
  "  return total;",
  "}"
];

const EXAMPLE: SpanRow = span({
  id: "sp_3",
  name: "calculateLineTotal",
  status: "errored",
  runtime: "node",
  durationMs: 1.8,
  location: { file: "src/cart.ts", line: 12, column: 3, endLine: 20, snippet: CODE[0]! },
  area: { module: "src/cart", feature: "cart" },
  attrs: { "code.function": "calculateLineTotal" },
  values: {
    args: { state: "recorded", value: [{ id: 7 }, 2] },
    return: { state: "not-recorded", reason: "threw" },
    error: { state: "recorded", value: { name: "RangeError", message: "discount > 100%" } }
  }
});

const OK_SNIPPET: Snippet = {
  state: "ok",
  file: "src/cart.ts",
  lines: CODE.map((text, index) => ({ n: 12 + index, text })),
  target: 12
};

function render(
  target: SpanRow,
  size: { width: number; height: number },
  extra: Partial<DetailInput> = {},
  options: Partial<DetailOptions> = {},
  links: LinkRow[] = []
): string[] {
  const trace = model([target], links);
  return detailLines(
    { model: trace, ref: target.ref, root: "/work", values: undefined, snippet: OK_SNIPPET, ...extra },
    { width: size.width, height: size.height, focused: false, scroll: 0, color: COLOR_NONE, links: false, ...options }
  );
}

function plain(lines: readonly string[]): string[] {
  return lines.map(stripAnsi);
}

describe("the spec 6.4 example", () => {
  it("renders header, location + area, the code window, values and attrs", () => {
    expect(plain(render(EXAMPLE, { width: 60, height: 17 }))).toEqual([
      "calculateLineTotal · function · errored · node · s1",
      "src/cart.ts:12:3  area src/cart · cart",
      "┌ src/cart.ts ──────────────────────────────────────────────",
      "│▶ 12  export async function calculateLineTotal(item, qty) {",
      "│  13    const p = await price(item.id);",
      "│  14    if (item.discount > 100) {",
      '│  15      throw new RangeError("discount > 100%");',
      "│  16    }",
      "│  17    const total = p * qty;",
      "│  18    log(total);",
      "│  19    return total;",
      "│  20  }",
      "└───────────────────────────────────────────────────────────",
      'args    [{"id":7},2]',
      "return  not-recorded (threw)",
      "error   RangeError: discount > 100%",
      "attrs   code.function = calculateLineTotal"
    ]);
  });
});

describe("the name is never shortened", () => {
  it("with focus the header wraps and shows the whole name", () => {
    const name = `handle${"Checkout".repeat(18)}Request`;
    const long = { ...EXAMPLE, name };
    const lines = plain(render(long, { width: 60, height: 20 }, {}, { focused: true }));
    const header = lines.slice(0, 4).join("");
    expect(header).toContain(name);
    expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
  });

  it("with focus, 1 MB of text in the header or a value is clipped before it is wrapped", () => {
    const huge = "界".repeat(1_000_000);
    const hostile: SpanRow = {
      ...EXAMPLE,
      name: huge,
      values: {
        args: { state: "invalid-value", position: huge, what: huge },
        return: { state: "not-recorded", reason: huge },
        error: { state: "not-recorded" }
      }
    };
    render(hostile, { width: 60, height: 20 }, {}, { focused: true });
    const started = performance.now();
    const lines = plain(render(hostile, { width: 60, height: 20 }, {}, { focused: true, scroll: 1_000_000 }));
    expect(performance.now() - started).toBeLessThan(200);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
    expect(lines.join("")).toContain("…");
  });
});

describe("the ▶ line is always visible (review focus 3)", () => {
  it("at the 40x10 minimum the pane keeps header, location and the ▶ line in a box", () => {
    const lines = plain(render(EXAMPLE, { width: 40, height: 5 }));
    expect(lines).toEqual([
      "calculateLineTotal · function · errored…",
      "src/cart.ts:12:3  area src/cart · cart",
      "┌ src/cart.ts ──────────────────────────",
      "│▶ 12  export async function calculateL…",
      "└ … ────────────────────────────────────"
    ]);
  });

  it("with fewer rows it drops the borders, then location, then the header, never the ▶ line", () => {
    for (let height = 1; height <= 12; height += 1) {
      const lines = plain(render(EXAMPLE, { width: 40, height }));
      expect(lines, `height ${height}`).toHaveLength(height);
      expect(
        lines.some((line) => line.startsWith("│▶ 12")),
        `height ${height}`
      ).toBe(true);
    }
    expect(plain(render(EXAMPLE, { width: 40, height: 3 }))).toEqual([
      "calculateLineTotal · function · errored…",
      "src/cart.ts:12:3  area src/cart · cart",
      "│▶ 12  export async function calculateL…"
    ]);
    expect(plain(render(EXAMPLE, { width: 40, height: 1 }))).toEqual(["│▶ 12  export async function calculateL…"]);
  });

  it("a 200 KB minified line is cut, not measured, and every line fits the width", () => {
    const huge = `(()=>{${"var a=1;".repeat(25_000)}})();`;
    const minified: Snippet = { state: "ok", file: "dist/app.min.js", lines: [{ n: 1, text: huge }], target: 1 };
    const target = span({ id: "m", location: { file: "dist/app.min.js", line: 1 } });
    const started = performance.now();
    const lines = render(target, { width: 80, height: 10 }, { snippet: minified });
    expect(performance.now() - started).toBeLessThan(500);
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
    expect(plain(lines).find((line) => line.startsWith("│▶ 1"))).toMatch(/^│▶ 1 {2}\(\(\)=>\{var a=1;.*…$/);
  });

  it("CJK and emoji never break the frame", () => {
    const wide = span({
      id: "w",
      name: "計算合計😀😀😀😀😀😀😀😀😀😀",
      location: { file: "src/カート.ts", line: 1 }
    });
    const snippet: Snippet = {
      state: "ok",
      file: "src/カート.ts",
      lines: [{ n: 1, text: "const 合計 = '👨\u200d👩\u200d👧\u200d👦'.repeat(40) + '漢字'.repeat(40);" }],
      target: 1
    };
    for (const width of [40, 41, 80]) {
      const lines = render(wide, { width, height: 10 }, { snippet });
      expect(
        lines.every((line) => visibleWidth(line) <= width),
        `width ${width}`
      ).toBe(true);
      expect(
        plain(lines).some((line) => line.startsWith("│▶ 1")),
        `width ${width}`
      ).toBe(true);
    }
  });
});

describe("the line-number gutter", () => {
  const numbered = (from: number, to: number): Snippet["lines"] =>
    Array.from({ length: to - from + 1 }, (_, index) => ({ n: from + index, text: `line ${from + index}` }));

  it("is as wide as the largest number shown: 98..102 with ▶ at 99 keeps one column", () => {
    const target = span({ id: "g", location: { file: "src/g.ts", line: 99 } });
    const snippet: Snippet = { state: "ok", file: "src/g.ts", lines: numbered(98, 102), target: 99 };
    expect(plain(render(target, { width: 40, height: 9 }, { snippet })).slice(2, 9)).toEqual([
      "┌ src/g.ts ─────────────────────────────",
      "│   98  line 98",
      "│▶  99  line 99",
      "│  100  line 100",
      "│  101  line 101",
      "│  102  line 102",
      "└───────────────────────────────────────"
    ]);
  });

  it("the code text gets exactly the columns the gutter leaves", () => {
    // `│▶ 100  ` is digits + 5 columns: a line of width - 8 columns fits whole, one more is cut with `…`.
    const target = span({ id: "g", location: { file: "src/g.ts", line: 100 } });
    const fits = "x".repeat(32);
    for (const [text, shown] of [
      [fits, fits],
      [`${fits}yz`, `${"x".repeat(31)}…`]
    ] as const) {
      const snippet: Snippet = { state: "ok", file: "src/g.ts", lines: [{ n: 100, text }], target: 100 };
      const lines = render(target, { width: 40, height: 5 }, { snippet }, { color: COLOR_16 });
      const code = plain(lines).find((line) => line.startsWith("│▶"));
      expect(code).toBe(`│▶ 100  ${shown}`);
      expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    }
  });

  it("disk lines without the ▶ line: the recorded snippet is the ▶ line", () => {
    const target = span({ id: "g", location: { file: "src/g.ts", line: 99, snippet: "recorded()" } });
    const stale: Snippet = { state: "ok", file: "src/g.ts", lines: numbered(1, 5), target: 99 };
    const lines = plain(render(target, { width: 40, height: 6 }, { snippet: stale }));
    expect(lines.slice(2, 5)).toEqual([
      "┌ src/g.ts · recorded snippet ──────────",
      "│▶ 99  recorded()",
      "└───────────────────────────────────────"
    ]);
  });

  it("disk lines without the ▶ line and nothing recorded: no line is marked or kept in its place", () => {
    const target = span({ id: "g", location: { file: "src/g.ts", line: 99 } });
    const stale: Snippet = { state: "ok", file: "src/g.ts", lines: numbered(1, 5), target: 99 };
    const lines = plain(render(target, { width: 40, height: 9 }, { snippet: stale }));
    expect(lines.slice(2, 9)).toEqual([
      "┌ src/g.ts ─────────────────────────────",
      "│  1  line 1",
      "│  2  line 2",
      "│  3  line 3",
      "│  4  line 4",
      "│  5  line 5",
      "└───────────────────────────────────────"
    ]);
    expect(lines.some((line) => line.includes("▶"))).toBe(false);
    // Short of rows, line 1 is context like any other: it is not kept as if it were the ▶ line.
    expect(plain(render(target, { width: 40, height: 3 }, { snippet: stale }))).toEqual([
      "g · function · complete · s1",
      "src/g.ts:99  area ~src",
      "┌ src/g.ts ─────────────────────────────"
    ]);
  });
});

describe("snippet states", () => {
  it("a missing file shows the recorded snippet as the ▶ line and names the state", () => {
    const missing: Snippet = { state: "file-missing", file: "src/cart.ts", lines: [], target: 12 };
    const lines = plain(render(EXAMPLE, { width: 70, height: 8 }, { snippet: missing }));
    expect(lines[2]).toBe("┌ src/cart.ts · file-missing · recorded snippet ──────────────────────");
    expect(lines[3]).toBe("│▶ 12  export async function calculateLineTotal(item, qty) {");
  });

  it("moved to line N, loading and a state without any code", () => {
    const moved: Snippet = { state: "moved", file: "src/cart.ts", lines: OK_SNIPPET.lines, target: 14, movedFrom: 12 };
    const movedLines = plain(render(EXAMPLE, { width: 60, height: 17 }, { snippet: moved }));
    expect(movedLines[2]).toBe("┌ src/cart.ts · moved to line 14 ───────────────────────────");
    expect(movedLines.filter((line) => line.startsWith("│▶"))).toEqual(["│▶ 14    if (item.discount > 100) {"]);
    const bare = span({ id: "b", location: { file: "src/b.ts", line: 3 } });
    expect(plain(render(bare, { width: 50, height: 6 }, { snippet: "loading" })).slice(2, 4)).toEqual([
      "┌ src/b.ts · loading… ────────────────────────────",
      "│  loading…"
    ]);
    const outside: Snippet = { state: "outside-root", file: "src/b.ts", lines: [], target: 3 };
    expect(plain(render(bare, { width: 50, height: 6 }, { snippet: outside })).slice(2, 4)).toEqual([
      "┌ src/b.ts · outside-root ────────────────────────",
      "│  no code: outside-root"
    ]);
  });

  it("tabs in the recorded snippet become spaces to the next stop of 4", () => {
    const tabbed = span({ id: "t", location: { file: "src/t.ts", line: 7, snippet: "\tif (x)\t{" } });
    const missing: Snippet = { state: "file-missing", file: "src/t.ts", lines: [], target: 7 };
    expect(plain(render(tabbed, { width: 50, height: 6 }, { snippet: missing }))[3]).toBe("│▶ 7      if (x)  {");
  });

  it("no location: no code window, `(no location)` and area `(unknown)`", () => {
    const bare = span({ id: "n", name: "anon" });
    expect(plain(render(bare, { width: 50, height: 6 }, { snippet: undefined })).slice(0, 2)).toEqual([
      "anon · function · complete · s1",
      "(no location)  area (unknown)"
    ]);
    const invalid = span({ id: "n", name: "anon", marks: ["invalid-location"] });
    expect(plain(render(invalid, { width: 50, height: 6 }, { snippet: undefined }))[1]).toBe(
      "(invalid-location)  area (unknown)"
    );
    const derived = span({
      id: "d",
      location: { file: "node_modules/.pnpm/cors@2.8.5/node_modules/cors/lib/index.js", line: 1 }
    });
    expect(plain(render(derived, { width: 90, height: 6 }, { snippet: "loading" }))[1]).toBe(
      "node_modules/.pnpm/cors@2.8.5/node_modules/cors/lib/index.js:1  area ~cors"
    );
  });
});

describe("values, attrs, links", () => {
  it("each Value state reads as itself", () => {
    expect(valueText({ state: "recorded", value: null })).toBe("null");
    expect(valueText({ state: "recorded", value: { password: "hunter2", user: "ann" } })).toBe(
      '{"password":{"$type":"masked"},"user":"ann"}'
    );
    expect(valueText({ state: "truncated", value: [1, { $type: "more", count: 3 }], reason: "viewer-cap" })).toBe(
      'truncated(viewer-cap) [1,{"$type":"more","count":3}]'
    );
    expect(valueText({ state: "masked" })).toBe("masked");
    expect(valueText({ state: "not-recorded", reason: "threw" })).toBe("not-recorded (threw)");
    expect(valueText({ state: "not-recorded" })).toBe("not-recorded");
    expect(valueText({ state: "invalid-value", position: "kosmo_spans(t,s,id)", what: "depth > 64" })).toBe(
      "invalid-value(kosmo_spans(t,s,id): depth > 64)"
    );
    expect(valueText({ state: "unknown-state", raw: "weird" })).toBe("not-recorded (weird) · unknown-state");
    expect(valueText("loading")).toBe("loading…");
    expect(valueText({ state: "recorded", value: { name: "TypeError", message: "x is undefined" } }, "error")).toBe(
      "TypeError: x is undefined"
    );
    expect(valueText({ state: "recorded", value: "x".repeat(10_000) }).endsWith("…")).toBe(true);
  });

  it("an object with an unknown $type is plain JSON marked unknown-tag (tagOf, spec 4.2)", () => {
    expect(valueText({ state: "recorded", value: [{ $type: "regexp", source: "a+" }] })).toBe(
      '[{"$type":"regexp","source":"a+"}] · unknown-tag'
    );
    // Anywhere in the value, also under a known tag and in truncated values.
    const nested = { $type: "map", entries: [["k", { a: [{ $type: "hole", extra: 1 }] }]] };
    expect(valueText({ state: "truncated", value: nested, reason: "viewer-cap" })).toMatch(/ · unknown-tag$/);
    // Known tags and plain objects are not marked.
    expect(valueText({ state: "recorded", value: [{ $type: "undefined" }, { a: 1 }] })).toBe(
      '[{"$type":"undefined"},{"a":1}]'
    );
    const target = span({
      id: "u",
      values: {
        args: { state: "recorded", value: [{ $type: "regexp", source: "a+" }] },
        return: { state: "not-recorded" },
        error: { state: "not-recorded" }
      }
    });
    expect(plain(render(target, { width: 60, height: 6 }, { snippet: undefined }))[2]).toBe(
      'args    [{"$type":"regexp","source":"a+"}] · unknown-tag'
    );
  });

  it("lazy SQLite values: loading until they arrive", () => {
    const lazy = span({ id: "l", location: { file: "src/l.ts", line: 1 } });
    const loading = plain(render(lazy, { width: 50, height: 10 }, { values: "loading", snippet: "loading" }));
    expect(loading).toContain("args    loading…");
    const values: SpanValues = {
      args: { state: "recorded", value: [1] },
      return: { state: "recorded", value: 2 },
      error: { state: "not-recorded" }
    };
    expect(plain(render(lazy, { width: 50, height: 10 }, { values, snippet: "loading" }))).toContain("return  2");
  });

  it("attrs are sorted, masked by key and by value (maskAttrs) and end with invalid-attrs(N)", () => {
    const target = span({
      id: "a",
      attrs: {
        "http.route": "/cart?token=abc",
        "http.request.header.authorization": "Basic abc",
        "code.function": "f"
      },
      droppedAttrs: 2
    });
    const lines = plain(render(target, { width: 60, height: 12 }, { snippet: undefined }));
    expect(lines.slice(5, 9)).toEqual([
      "attrs   code.function = f",
      "        http.request.header.authorization = masked",
      "        http.route = /cart?token=masked",
      "        invalid-attrs(2)"
    ]);
    expect(lines.join("\n")).not.toContain("abc");
  });

  it("links: outgoing →, incoming ←, a missing end is `missing`", () => {
    const a = span({ id: "a", name: "fetchCart", order: 0 });
    const b = span({ id: "b", name: "useEffect", order: 1 });
    const trace = model(
      [a, b],
      [
        { from: a.ref, to: b.ref, kind: "caused-by" },
        { from: ref("ghost"), to: a.ref, kind: "follows-from" }
      ]
    );
    const lines = plain(
      detailLines(
        { model: trace, ref: a.ref, root: "/work", values: undefined, snippet: undefined },
        { width: 60, height: 8, focused: false, scroll: 0, color: COLOR_NONE, links: false }
      )
    );
    expect(lines.slice(5, 7)).toEqual(["links   → useEffect (caused-by)", "        ← missing (follows-from)"]);
  });

  it("the focused pane shows everything and scrolls; scrolling past the end is clamped", () => {
    const long = { ...EXAMPLE, attrs: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i])) };
    const top = plain(render(long, { width: 60, height: 8 }, {}, { focused: true, scroll: 0 }));
    expect(top.slice(0, 4)).toEqual([
      "calculateLineTotal · function · errored · node · s1",
      "src/cart.ts:12:3  area src/cart · cart",
      "┌ src/cart.ts ──────────────────────────────────────────────",
      "│▶ 12  export async function calculateLineTotal(item, qty) {"
    ]);
    const bottom = plain(render(long, { width: 60, height: 8 }, {}, { focused: true, scroll: 1_000_000 }));
    expect(bottom[7]).toBe("        k9 = 9");
  });

  it("without focus a long attrs block goes before the code context: ▶ keeps two lines around it", () => {
    // Spec 6.4: the window shrinks the context around ▶, never the line; the tail (values, attrs,
    // links) may not squeeze the window below ▶ ± 2 when the file has those lines.
    const busy = { ...EXAMPLE, attrs: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i])) };
    expect(plain(render(busy, { width: 60, height: 14 }))).toEqual([
      "calculateLineTotal · function · errored · node · s1",
      "src/cart.ts:12:3  area src/cart · cart",
      "┌ src/cart.ts ──────────────────────────────────────────────",
      "│▶ 12  export async function calculateLineTotal(item, qty) {",
      "│  13    const p = await price(item.id);",
      "│  14    if (item.discount > 100) {",
      '│  15      throw new RangeError("discount > 100%");',
      "│  16    }",
      "└ … ────────────────────────────────────────────────────────",
      'args    [{"id":7},2]',
      "return  not-recorded (threw)",
      "error   RangeError: discount > 100%",
      "attrs   k0 = 0",
      "        k1 = 1"
    ]);
  });
});

describe("terminal safety", () => {
  it("hostile text in every field reaches the pane escaped (review focus 2)", () => {
    const evil = "\u001b[2J\u001b]8;;http://evil\u0007\u009b31m\u202eX";
    const target = span({
      id: `id${evil}`,
      session: `s${evil}`,
      name: `n${evil}`,
      kind: `k${evil}`,
      status: "unknown",
      statusReason: `r${evil}`,
      location: { file: `src/f${evil}.ts`, line: 1, snippet: `snip${evil}` },
      area: { module: `m${evil}`, feature: `f${evil}` },
      attrs: { "x.key": `v${evil}` },
      values: {
        args: { state: "recorded", value: [`a${evil}`] },
        return: { state: "invalid-value", position: `p${evil}`, what: `w${evil}` },
        error: { state: "recorded", value: { name: `E${evil}`, message: `m${evil}` } }
      }
    });
    const other = span({ id: "o", session: `s${evil}`, name: `linked${evil}`, order: 1 });
    const trace = model([target, other], [{ from: target.ref, to: other.ref, kind: `kind${evil}` }]);
    const disk: Snippet = {
      state: "ok",
      file: target.location!.file,
      lines: [{ n: 1, text: `code${evil}` }],
      target: 1
    };
    for (const snippet of [disk, { ...disk, state: "file-missing" as const, lines: [] }]) {
      const lines = detailLines(
        { model: trace, ref: target.ref, root: "/work", values: undefined, snippet },
        { width: 200, height: 30, focused: true, scroll: 0, color: COLOR_NONE, links: true }
      );
      const text = lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
      expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
      for (const field of ["n", "k", "r", "src/f", "m", "f", "v", "p", "w", "E", "linked", "kind"]) {
        expect(text, field).toContain(`${field}\\u001b[2J\\u001b]8;;http://evil\\u0007\\u009b31m\\u202eX`);
      }
      expect(text).toContain(snippet.lines.length > 0 ? "code\\u001b[2J" : "snip\\u001b[2J");
    }
  });

  it("escapes runtime and an unknown parent reason before they are fitted", () => {
    const evil = `${String.fromCharCode(0x1b)}[2J`;
    const escaped = `${String.fromCharCode(92)}u001b[2J`;
    const target = span({ id: "r", runtime: `node${evil}` as "node" });
    const trace = model([target]);
    const lines = detailLines(
      {
        model: { ...trace, parentOf: () => ({ kind: "unknown", reason: `missing${evil}` as "missing" }) },
        ref: target.ref,
        root: "/work",
        values: undefined,
        snippet: undefined
      },
      { width: 80, height: 6, focused: false, scroll: 0, color: COLOR_NONE, links: false }
    );
    const text = lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
    expect(text).not.toContain(evil);
    expect(text).toContain(`node${escaped}`);
    expect(text).toContain(`parent  unknown(missing${escaped})`);
  });

  it("OSC 8 on file:line only with links on and a URI inside the root", () => {
    const target = span({ id: "x", location: { file: "src/cart.ts", line: 12 } });
    const off = render(target, { width: 80, height: 6 }, { snippet: "loading" });
    expect(off.join("")).not.toContain("\u001b]8;");
    const on = render(target, { width: 80, height: 6 }, { snippet: "loading" }, { links: true });
    expect(on[1]).toContain("\u001b]8;;file:///work/src/cart.ts\u001b\\src/cart.ts:12\u001b]8;;\u001b\\");
  });
});
