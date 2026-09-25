import { describe, expect, it } from "vitest";
import {
  UNKNOWN_AREA,
  areaKeyId,
  areaKeyOf,
  buildTraceModel,
  derivedModule,
  type TraceModel
} from "../../src/format/model.js";
import type { Area, LinkRow, Location, SpanRef, SpanRow, SpanStatus } from "../../src/format/types.js";

type Extra = {
  parentSession?: string;
  status?: SpanStatus;
  area?: Area;
  location?: Location;
  name?: string;
  trace?: string;
};

/** A validated span row: `session:id`, parent id (or null), order. */
function row(session: string, id: string, parent: string | null, order: number, extra: Extra = {}): SpanRow {
  const { trace = "t", name = `${session}:${id}`, ...rest } = extra;
  return {
    ref: { trace, session, id },
    parent,
    order,
    name,
    kind: "function",
    status: rest.status ?? "complete",
    droppedAttrs: 0,
    marks: [],
    ...(rest.parentSession === undefined ? {} : { parentSession: rest.parentSession }),
    ...(rest.area === undefined ? {} : { area: rest.area }),
    ...(rest.location === undefined ? {} : { location: rest.location })
  };
}

function build(spans: readonly SpanRow[], links: readonly LinkRow[] = []): TraceModel {
  return buildTraceModel({ id: "t", name: "GET /cart" }, spans, links);
}

const ref = (session: string, id: string): SpanRef => ({ trace: "t", session, id });
const label = (refs: readonly SpanRef[]): string[] => refs.map((r) => `${r.session}:${r.id}`);

/** Deterministic PRNG (mulberry32) and Fisher–Yates shuffle, so property runs are reproducible. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], next: () => number): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const other = Math.floor(next() * (index + 1));
    [out[index], out[other]] = [out[other] as T, out[index] as T];
  }
  return out;
}

describe("parent resolution (spec 4.3 rules 1–4)", () => {
  it("rule 1: parent null is a true root", () => {
    const model = build([row("s1", "a", null, 0)]);
    expect(model.parentOf(ref("s1", "a"))).toEqual({ kind: "root" });
    expect(label(model.roots())).toEqual(["s1:a"]);
  });

  it("rule 2: parentSession is an exact lookup, with no fallback even to the own session", () => {
    const spans = [
      row("node", "a", null, 0),
      row("browser", "a", null, 0),
      row("browser", "call", "a", 1, { parentSession: "node" }),
      row("browser", "lost", "zz", 2, { parentSession: "node" }),
      row("browser", "self", "b1", 3, { parentSession: "browser" }),
      row("node", "b1", null, 4),
      row("browser", "own", "call", 5, { parentSession: "browser" })
    ];
    const model = build(spans);
    expect(model.parentOf(ref("browser", "call"))).toEqual({ kind: "resolved", ref: ref("node", "a") });
    expect(model.parentOf(ref("browser", "lost"))).toEqual({ kind: "unknown", reason: "missing" });
    // node:b1 exists, but parentSession says browser: no other attempt
    expect(model.parentOf(ref("browser", "self"))).toEqual({ kind: "unknown", reason: "missing" });
    // parentSession equal to the own session is the same exact lookup
    expect(model.parentOf(ref("browser", "own"))).toEqual({ kind: "resolved", ref: ref("browser", "call") });
  });

  it("rule 3.1: the own session wins over other sessions", () => {
    const model = build([row("s1", "p", null, 0), row("s2", "p", null, 0), row("s1", "c", "p", 1)]);
    expect(model.parentOf(ref("s1", "c"))).toEqual({ kind: "resolved", ref: ref("s1", "p") });
  });

  it("rule 3.2: exactly one other session resolves, two are ambiguous, none is missing", () => {
    const one = build([row("node", "p", null, 0), row("browser", "c", "p", 0)]);
    expect(one.parentOf(ref("browser", "c"))).toEqual({ kind: "resolved", ref: ref("node", "p") });
    const two = build([row("n1", "p", null, 0), row("n2", "p", null, 0), row("browser", "c", "p", 0)]);
    expect(two.parentOf(ref("browser", "c"))).toEqual({ kind: "unknown", reason: "ambiguous" });
    const none = build([row("browser", "c", "p", 0)]);
    expect(none.parentOf(ref("browser", "c"))).toEqual({ kind: "unknown", reason: "missing" });
  });

  it("rule 4: a span with an unknown parent is a root of its trace", () => {
    const model = build([row("s1", "orphan", "gone", 3), row("s1", "root", null, 7)]);
    expect(label(model.roots())).toEqual(["s1:root", "s1:orphan"]);
    expect(model.children(ref("s1", "root"))).toEqual([]);
  });
});

describe("cycles (spec 4.3 rule 5)", () => {
  it("breaks each cycle at its smallest (session, order) member and keeps the rest attached", () => {
    const model = build([
      row("s1", "a", "c", 5),
      row("s1", "b", "a", 3),
      row("s1", "c", "b", 9),
      row("s1", "tail", "a", 10)
    ]);
    expect(model.parentOf(ref("s1", "b"))).toEqual({ kind: "cycle" });
    expect(model.parentOf(ref("s1", "c"))).toEqual({ kind: "resolved", ref: ref("s1", "b") });
    expect(model.parentOf(ref("s1", "a"))).toEqual({ kind: "resolved", ref: ref("s1", "c") });
    expect(label(model.dfs())).toEqual(["s1:b", "s1:c", "s1:a", "s1:tail"]);
  });

  it("compares sessions byte-wise before order across sessions", () => {
    const model = build([row("b", "x", "y", 0, { parentSession: "a" }), row("a", "y", "x", 9, { parentSession: "b" })]);
    expect(model.parentOf(ref("a", "y"))).toEqual({ kind: "cycle" });
    expect(model.parentOf(ref("b", "x"))).toEqual({ kind: "resolved", ref: ref("a", "y") });
  });

  it("a self-parent is a cycle of one; separate cycles are separate roots", () => {
    const model = build([
      row("s1", "self", "self", 4),
      row("s1", "p", "q", 1),
      row("s1", "q", "p", 2),
      row("s1", "true-root", null, 50)
    ]);
    expect(model.parentOf(ref("s1", "self"))).toEqual({ kind: "cycle" });
    expect(model.parentOf(ref("s1", "p"))).toEqual({ kind: "cycle" });
    expect(label(model.roots())).toEqual(["s1:true-root", "s1:p", "s1:self"]);
  });
});

describe("order (spec 4.3)", () => {
  it("children: same session as the parent by order, then other sessions byte-wise, each by order", () => {
    const model = build([
      row("n1", "p", null, 0),
      row("n1", "late", "p", 5),
      row("n1", "early", "p", 2),
      row("b", "x", "p", 1, { parentSession: "n1" }),
      row("a", "y", "p", 9, { parentSession: "n1" }),
      row("a", "z", "p", 3, { parentSession: "n1" })
    ]);
    expect(label(model.children(ref("n1", "p")))).toEqual(["n1:early", "n1:late", "a:z", "a:y", "b:x"]);
  });

  it("roots: true roots, then unknown parents, then cycle roots, each by (session, order)", () => {
    const model = build([
      row("s2", "cy1", "cy2", 0),
      row("s2", "cy2", "cy1", 1),
      row("s1", "miss", "nope", 0),
      row("s0", "amb", "dup", 5),
      row("x1", "dup", null, 9),
      row("x2", "dup", null, 9),
      row("s1", "r1", null, 3),
      row("s0", "r0", null, 8)
    ]);
    expect(label(model.roots())).toEqual(["s0:r0", "s1:r1", "x1:dup", "x2:dup", "s0:amb", "s1:miss", "s2:cy1"]);
  });

  it("dfs is pre-order over roots and children; depthOf follows it", () => {
    const model = build([
      row("s", "root", null, 0),
      row("s", "b", "root", 2),
      row("s", "a", "root", 1),
      row("s", "a1", "a", 3),
      row("s", "other", null, 10)
    ]);
    expect(label(model.dfs())).toEqual(["s:root", "s:a", "s:a1", "s:b", "s:other"]);
    expect(model.depthOf(ref("s", "a1"))).toBe(2);
    expect(model.depthOf(ref("s", "other"))).toBe(0);
    expect(model.dfs()).toHaveLength(model.size);
  });
});

describe("model basics", () => {
  it("summarises the trace and looks spans up by full identity", () => {
    const model = build([row("s", "a", null, 0, { status: "errored" }), row("s", "b", "a", 1, { status: "running" })]);
    expect(model.trace).toEqual({ id: "t", name: "GET /cart", spans: 2, status: "errored", requests: null });
    expect(model.size).toBe(2);
    expect(model.get(ref("s", "a"))?.status).toBe("errored");
    expect(model.get(ref("other", "a"))).toBeUndefined();
    expect(model.get({ trace: "t2", session: "s", id: "a" })).toBeUndefined();
  });

  it("ignores spans of other traces and repeated identities (first wins)", () => {
    const model = build([
      row("s", "a", null, 0, { name: "first" }),
      row("s", "a", null, 1, { name: "second" }),
      row("s", "x", null, 2, { trace: "t2" })
    ]);
    expect(model.size).toBe(1);
    expect(model.get(ref("s", "a"))?.name).toBe("first");
  });

  it("answers safely for a ref outside the model", () => {
    const model = build([row("s", "a", null, 0)]);
    const outside = ref("s", "nope");
    expect(model.parentOf(outside)).toEqual({ kind: "unknown", reason: "missing" });
    expect(model.children(outside)).toEqual([]);
    expect(model.depthOf(outside)).toBe(0);
    expect(model.areaOf(outside)).toEqual(UNKNOWN_AREA);
    expect(model.links(outside)).toEqual({ out: [], in: [] });
  });
});

describe("areas (spec 4.7)", () => {
  it("derivedModule: dirname, . for the root, the package after the last node_modules", () => {
    expect(derivedModule("src/cart.ts")).toBe("src");
    expect(derivedModule("src/cart/line.ts")).toBe("src/cart");
    expect(derivedModule("cart.ts")).toBe(".");
    expect(derivedModule("./src/cart.ts")).toBe("src");
    expect(derivedModule("node_modules/.pnpm/cors@2.8.5/node_modules/cors/lib/index.js")).toBe("cors");
    expect(derivedModule("node_modules/@nestjs/common/pipes/validation.pipe.js")).toBe("@nestjs/common");
    expect(derivedModule("apps/api/node_modules/body-parser/index.js")).toBe("body-parser");
    expect(derivedModule("my_node_modules/x/y.js")).toBe("my_node_modules/x");
  });

  it("derivedModule: a scope needs a package directory, else the dirname fallback", () => {
    expect(derivedModule("node_modules/@scope/pkg/x.js")).toBe("@scope/pkg");
    expect(derivedModule("node_modules/@scope/pkg/lib/deep/x.js")).toBe("@scope/pkg");
    expect(derivedModule("node_modules/@scope/index.js")).toBe("node_modules/@scope");
    expect(derivedModule("node_modules/index.js")).toBe("node_modules");
    expect(derivedModule("node_modules/cors")).toBe("node_modules");
    expect(derivedModule("node_modules/a/node_modules/@s/p/index.js")).toBe("@s/p");
    expect(derivedModule("node_modules/@a/b/node_modules/c/index.js")).toBe("c");
    expect(derivedModule("node_modules/a/node_modules/@s/index.js")).toBe("node_modules/a/node_modules/@s");
    expect(derivedModule("node_modules/.pnpm/@s+p@1.0.0/node_modules/@s/p/dist/i.js")).toBe("@s/p");
  });

  it("areaKeyOf: explicit area, derived module from location, or (unknown)", () => {
    const explicit = row("s", "a", null, 0, { area: { module: "src/cart", feature: "cart" } });
    expect(areaKeyOf(explicit)).toEqual({ module: "src/cart", feature: "cart", derived: false });
    const featureOnly = row("s", "b", null, 1, { area: { feature: "cart" }, location: { file: "src/x.ts", line: 1 } });
    expect(areaKeyOf(featureOnly)).toEqual({ module: null, feature: "cart", derived: false });
    const derived = row("s", "c", null, 2, { area: {}, location: { file: "src/cart/x.ts", line: 1 } });
    expect(areaKeyOf(derived)).toEqual({ module: "src/cart", feature: null, derived: true });
    expect(areaKeyOf(row("s", "d", null, 3))).toBe(UNKNOWN_AREA);
    expect(areaKeyId({ module: "src/cart", feature: null, derived: false })).not.toBe(
      areaKeyId({ module: "src/cart", feature: null, derived: true })
    );
  });

  it("counts spans and errors per (module, feature, derived) and lists members in DFS order", () => {
    const model = build([
      row("s", "root", null, 0, { location: { file: "server.ts", line: 1 } }),
      row("s", "c2", "root", 4, { area: { module: "src/cart" }, status: "errored" }),
      row("s", "c1", "root", 2, { location: { file: "src/cart/total.ts", line: 3 } }),
      row("s", "cors", "root", 1, {
        location: { file: "node_modules/.pnpm/cors@2.8.5/node_modules/cors/lib/index.js", line: 1 }
      }),
      row("s", "feat", "root", 5, { area: { feature: "checkout" } }),
      row("s", "nothing", "root", 6),
      row("s", "c3", "root", 7, { area: { module: "src/cart" } })
    ]);
    expect(model.areas()).toEqual([
      { module: null, feature: "checkout", derived: false, spans: 1, errors: 0 },
      { module: ".", feature: null, derived: true, spans: 1, errors: 0 },
      { module: "cors", feature: null, derived: true, spans: 1, errors: 0 },
      { module: "src/cart", feature: null, derived: false, spans: 2, errors: 1 },
      { module: "src/cart", feature: null, derived: true, spans: 1, errors: 0 },
      { module: null, feature: null, derived: false, spans: 1, errors: 0 }
    ]);
    expect(label(model.spansInArea({ module: "src/cart", feature: null, derived: false }))).toEqual(["s:c2", "s:c3"]);
    expect(label(model.spansInArea(UNKNOWN_AREA))).toEqual(["s:nothing"]);
    expect(model.spansInArea({ module: "nope", feature: null, derived: false })).toEqual([]);
    expect(model.areaOf(ref("s", "cors"))).toEqual({ module: "cors", feature: null, derived: true });
  });
});

describe("links (spec 4.12)", () => {
  it("gives outgoing and incoming views with the other end's name, missing ends as null", () => {
    const spans = [row("s", "effect", null, 0, { name: "useEffect" }), row("s", "fetch", null, 1, { name: "fetch" })];
    const links: LinkRow[] = [
      { from: ref("s", "fetch"), to: ref("s", "effect"), kind: "caused-by" },
      { from: ref("s", "fetch"), to: ref("s", "ghost"), kind: "follows-from" },
      { from: ref("s", "fetch"), to: { trace: "t2", session: "s", id: "effect" }, kind: "caused-by" },
      { from: { trace: "t9", session: "s", id: "a" }, to: { trace: "t9", session: "s", id: "b" }, kind: "caused-by" }
    ];
    const model = build(spans, links);
    expect(model.links(ref("s", "fetch"))).toEqual({
      out: [
        { kind: "caused-by", other: ref("s", "effect"), otherName: "useEffect" },
        { kind: "follows-from", other: ref("s", "ghost"), otherName: null },
        { kind: "caused-by", other: { trace: "t2", session: "s", id: "effect" }, otherName: null }
      ],
      in: []
    });
    expect(model.links(ref("s", "effect"))).toEqual({
      out: [],
      in: [{ kind: "caused-by", other: ref("s", "fetch"), otherName: "fetch" }]
    });
  });

  it("orders views independently of the input order", () => {
    const spans = [row("s", "a", null, 0), row("s", "b", null, 1), row("s", "c", null, 2)];
    const links: LinkRow[] = [
      { from: ref("s", "a"), to: ref("s", "c"), kind: "follows-from" },
      { from: ref("s", "a"), to: ref("s", "b"), kind: "follows-from" },
      { from: ref("s", "a"), to: ref("s", "b"), kind: "caused-by" }
    ];
    const forward = build(spans, links).links(ref("s", "a"));
    const backward = build(spans, [...links].reverse()).links(ref("s", "a"));
    expect(backward).toEqual(forward);
    expect(forward.out.map((view) => `${view.other.id}/${view.kind}`)).toEqual([
      "b/caused-by",
      "b/follows-from",
      "c/follows-from"
    ]);
  });
});

describe("independence from input order (spec 4.3, property)", () => {
  const fixture: SpanRow[] = [
    row("node", "req", null, 0, { location: { file: "src/server.ts", line: 1 } }),
    row("node", "mw1", "req", 1, { location: { file: "node_modules/cors/index.js", line: 1 } }),
    row("node", "mw2", "req", 2, { status: "running" }),
    row("node", "handler", "req", 3, { area: { module: "src/cart", feature: "cart" }, status: "errored" }),
    row("browser", "click", null, 0),
    row("browser", "action", "handler", 1, { parentSession: "node" }),
    row("browser", "req", "click", 2),
    row("browser", "orphan", "gone", 3),
    row("s1", "dup", null, 0),
    row("s2", "dup", null, 0),
    row("browser", "amb", "dup", 4),
    row("node", "cy1", "cy3", 10),
    row("node", "cy2", "cy1", 7),
    row("node", "cy3", "cy2", 12),
    row("node", "cy-tail", "cy2", 13),
    row("node", "self", "self", 20)
  ];

  function snapshot(model: TraceModel): unknown {
    return {
      dfs: label(model.dfs()),
      roots: label(model.roots()),
      parents: fixture.map((span) => model.parentOf(span.ref)),
      children: fixture.map((span) => label(model.children(span.ref))),
      depths: fixture.map((span) => model.depthOf(span.ref)),
      areas: model.areas(),
      trace: model.trace
    };
  }

  it("gives the same tree, parents, depths and areas for 200 shuffles of the spans", () => {
    const expected = snapshot(build(fixture));
    const next = prng(20260924);
    for (let run = 0; run < 200; run += 1)
      expect(snapshot(build(shuffle(fixture, next))), `run ${run}`).toEqual(expected);
  });
});

describe("pathological depth (Фокус рецензії 1)", () => {
  const DEPTH = 50_000;

  it("builds a 50 000-deep chain given in reverse order without recursion", () => {
    const spans: SpanRow[] = [];
    for (let index = DEPTH - 1; index >= 0; index -= 1) {
      spans.push(row("s", `n${index}`, index === 0 ? null : `n${index - 1}`, index));
    }
    const model = build(spans);
    expect(model.size).toBe(DEPTH);
    expect(model.dfs()).toHaveLength(DEPTH);
    expect(model.dfs()[0]).toEqual(ref("s", "n0"));
    expect(model.dfs()[DEPTH - 1]).toEqual(ref("s", `n${DEPTH - 1}`));
    expect(model.depthOf(ref("s", `n${DEPTH - 1}`))).toBe(DEPTH - 1);
    expect(model.parentOf(ref("s", `n${DEPTH - 1}`))).toEqual({ kind: "resolved", ref: ref("s", `n${DEPTH - 2}`) });
    expect(label(model.roots())).toEqual(["s:n0"]);
  }, 30_000);

  it("breaks a 50 000-member cycle at its smallest (session, order) member", () => {
    const spans: SpanRow[] = [];
    for (let index = 0; index < DEPTH; index += 1) {
      spans.push(row("s", `n${index}`, `n${(index + 1) % DEPTH}`, (index + 7) % DEPTH));
    }
    const model = build(spans);
    // order 0 belongs to n49993 ((49993 + 7) % 50000 === 0)
    expect(label(model.roots())).toEqual(["s:n49993"]);
    expect(model.parentOf(ref("s", "n49993"))).toEqual({ kind: "cycle" });
    expect(model.dfs()).toHaveLength(DEPTH);
    expect(model.depthOf(ref("s", "n49994"))).toBe(DEPTH - 1);
  }, 30_000);
});
