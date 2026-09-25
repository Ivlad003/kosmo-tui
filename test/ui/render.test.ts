/**
 * Task 19: whole frames (spec 6.1–6.5). Golden frames at 80x24 and the 40x10 minimum, frame
 * invariants at every size, hostile data (review focus 2), tiny terminals and huge traces (focus 1, 3),
 * and the committed framework fixtures of task 6 as the TUI shows them (spec 13.1, 13.3).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripAnsi, visibleWidth } from "../../src/ansi.js";
import { COLOR_16, COLOR_NONE } from "../../src/color.js";
import type { Snippet } from "../../src/code/snippet.js";
import { buildTraceModel } from "../../src/format/model.js";
import { validateDocument } from "../../src/format/validate.js";
import { renderKosmoText } from "../../src/output/kosmo-text.js";
import { tooSmallFrame } from "../../src/terminal.js";
import { renderFrame, type RenderEnv } from "../../src/ui/render.js";
import { initialState, update, visibleRows, type Action, type StartRow, type ViewState } from "../../src/ui/state.js";
import { fixtureFile } from "../fixture-recipes.js";
import { chain, model, ref, span } from "./model-fixtures.js";

const PLAIN: RenderEnv = { color: COLOR_NONE, links: false };

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

function apply(state: ViewState, ...actions: Action[]): ViewState {
  let current = state;
  for (const action of actions) [current] = update(current, action);
  return current;
}

/**
 * submitOrder (b1, browser) ── ┄┄ browser → node · s1 ┄┄ ── POST /cart (s1, node, http.server)
 *   ├─ cors (express.middleware, node_modules)
 *   ├─ calculateLineTotal (errored, the spec 6.4 span)
 *   └─ onError (express.error-handler)
 */
function cartTrace() {
  return model(
    [
      span({
        id: "act",
        session: "b1",
        order: 0,
        name: "submitOrder",
        kind: "next.server-action",
        runtime: "browser",
        status: "errored",
        durationMs: 31.2,
        location: { file: "src/app/cart/actions.ts", line: 3 },
        area: { module: "src/app/cart", feature: "cart" }
      }),
      span({
        id: "req",
        parent: "act",
        parentSession: "b1",
        order: 0,
        name: "POST /cart",
        kind: "http.server",
        runtime: "node",
        status: "errored",
        durationMs: 12.5,
        location: { file: "src/server.ts", line: 8 },
        attrs: {
          "http.request.method": "POST",
          "http.route": "/cart",
          "http.response.status_code": 500,
          "next.request.type": "action"
        }
      }),
      span({
        id: "cors",
        parent: "req",
        order: 1,
        name: "cors",
        kind: "express.middleware",
        runtime: "node",
        durationMs: 0.3,
        location: { file: "node_modules/cors/lib/index.js", line: 188 }
      }),
      span({
        id: "sp_3",
        parent: "req",
        order: 2,
        name: "calculateLineTotal",
        runtime: "node",
        status: "errored",
        durationMs: 1.8,
        location: { file: "src/cart.ts", line: 12, column: 3, endLine: 20, snippet: CODE[0]! },
        area: { module: "src/cart", feature: "cart" },
        attrs: { "code.function": "calculateLineTotal" },
        values: {
          args: { state: "recorded", value: [{ id: 7 }, 2] },
          return: { state: "not-recorded", reason: "threw" },
          error: { state: "recorded", value: { name: "RangeError", message: "discount > 100%" } }
        }
      }),
      span({
        id: "err",
        parent: "req",
        order: 3,
        name: "onError",
        kind: "express.error-handler",
        runtime: "node",
        durationMs: 0.2,
        location: { file: "src/errors.ts", line: 4 }
      })
    ],
    [],
    "POST /cart"
  );
}

function cartState(): ViewState {
  const snippet: Snippet = {
    state: "ok",
    file: "src/cart.ts",
    lines: CODE.map((text, index) => ({ n: 12 + index, text })),
    target: 12
  };
  return apply(
    initialState({ root: "/work/shop", readOnly: false }),
    {
      type: "datasetOpened",
      dataset: {
        info: { id: "ds_01", title: "checkout bug repro" },
        kind: "json",
        origin: { path: "/work/shop/cart.kosmo-trace.json" },
        traces: [
          {
            id: "t1",
            name: "POST /cart",
            spans: 5,
            status: "errored",
            requests: { first: { method: "POST", route: "/cart", status: 500 }, count: 1 }
          }
        ],
        hasMore: false,
        notices: [],
        reloadable: true
      }
    },
    { type: "traceLoaded", model: cartTrace() },
    { type: "selectRef", ref: ref("sp_3") },
    { type: "snippetLoaded", ref: ref("sp_3"), snippet }
  );
}

const START_ROWS: StartRow[] = [
  {
    path: "traces/checkout-bug.kosmo-trace.json",
    size: 2_202_009,
    mtimeMs: Date.UTC(2026, 8, 24, 10, 2),
    source: "found",
    missing: false
  },
  {
    path: "traces/cart.kosmo-trace.sqlite",
    size: 41_943_040,
    mtimeMs: Date.UTC(2026, 8, 23),
    source: "found",
    missing: false
  },
  {
    path: "~/work/storefront/.traces/pdp.kosmo-trace.json",
    size: 812,
    mtimeMs: Date.UTC(2026, 8, 23),
    source: "recent",
    missing: false
  },
  { path: "~/tmp/crash.kosmo-trace.ndjson", size: null, mtimeMs: null, source: "recent", missing: true }
];

function tracesState(): ViewState {
  return apply(
    initialState({ root: "/work", readOnly: false, start: START_ROWS }),
    { type: "activate" },
    {
      type: "datasetOpened",
      dataset: {
        info: { id: "ds_02" },
        kind: "sqlite",
        origin: { path: "traces/checkout-bug.kosmo-trace.json" },
        traces: [
          {
            id: "t_9f",
            name: "GET /cart",
            spans: 42,
            status: "errored",
            requests: { first: { method: "GET", route: "/cart", status: 500 }, count: 1 }
          },
          {
            id: "t_a0",
            name: "POST /checkout",
            spans: 128,
            status: "complete",
            requests: { first: { method: "POST", route: "/checkout", status: 200 }, count: 3 }
          },
          { id: "t_b7", name: null, spans: null, status: null, requests: null }
        ],
        hasMore: true,
        notices: [{ kind: "unknown-lines-skipped", count: 2 }],
        reloadable: true
      }
    }
  );
}

function plain(frame: readonly string[]): string[] {
  return frame.map(stripAnsi);
}

describe("golden frames", () => {
  it("trace screen at 80x24: tree with the session separator, detail with the ▶ line", () => {
    expect(plain(renderFrame(cartState(), { cols: 80, rows: 24 }, PLAIN))).toMatchInlineSnapshot(`
      [
        " kosmo-tui · POST /cart · 5 spans · errored Enter detail · / search · e errors …",
        "   - ✗ submitOrder next.server-action  src/app/cart/actions.ts:3  31.2ms",
        "       ┄┄ browser → node · s1 ┄┄",
        "     - ✗ POST /cart http.server POST /cart → 500 · action  src/server.ts:8  12.…",
        "         ✓ cors express.middleware  node_modules/cors/lib/index.js:188  0.3ms",
        " ▸       ✗ calculateLineTotal  src/cart.ts:12  1.8ms",
        "         ✓ ⤳ onError express.error-handler  src/errors.ts:4  0.2ms",
        "",
        "",
        " calculateLineTotal · function · errored · node · s1",
        " src/cart.ts:12:3  area src/cart · cart",
        " ┌ src/cart.ts ─────────────────────────────────────────────────────────────────",
        " │▶ 12  export async function calculateLineTotal(item, qty) {",
        " │  13    const p = await price(item.id);",
        " │  14    if (item.discount > 100) {",
        " │  15      throw new RangeError("discount > 100%");",
        " │  16    }",
        " │  17    const total = p * qty;",
        " └ … ───────────────────────────────────────────────────────────────────────────",
        " args    [{"id":7},2]",
        " return  not-recorded (threw)",
        " error   RangeError: discount > 100%",
        " attrs   code.function = calculateLineTotal",
        " tree",
      ]
    `);
  });

  it("trace screen at the 40x10 minimum still shows the ▶ line", () => {
    expect(plain(renderFrame(cartState(), { cols: 40, rows: 10 }, PLAIN))).toMatchInlineSnapshot(`
      [
        " kosmo-tui · POST /cart… Enter detail ·…",
        "         ✓ cors express.middleware  nod…",
        " ▸       ✗ calculateLineTotal  src/cart…",
        "         ✓ ⤳ onError express.error-hand…",
        " calculateLineTotal · function · errore…",
        " src/cart.ts:12:3  area src/cart · cart",
        " ┌ src/cart.ts ─────────────────────────",
        " │▶ 12  export async function calculate…",
        " └ … ───────────────────────────────────",
        " tree",
      ]
    `);
  });

  it("start screen at 80x24", () => {
    const state = initialState({ root: "/work", readOnly: false, start: START_ROWS });
    expect(plain(renderFrame(state, { cols: 80, rows: 24 }, PLAIN))).toMatchInlineSnapshot(`
      [
        " kosmo-tui                                       Enter open · / filter · q quit ",
        " Found in ./ (depth 2)",
        " ▸ traces/checkout-bug.kosmo-trace.json                      2.1 MB  2026-09-24",
        "   traces/cart.kosmo-trace.sqlite                             40 MB  2026-09-23",
        " Recent",
        "   ~/work/storefront/.traces/pdp.kosmo-trace.json             812 B  2026-09-23",
        "   ~/tmp/crash.kosmo-trace.ndjson                                file-not-found",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ]
    `);
  });

  it("trace list at 80x24 and 40x10", () => {
    expect(plain(renderFrame(tracesState(), { cols: 80, rows: 24 }, PLAIN))).toMatchInlineSnapshot(`
      [
        " kosmo-tui · ds_02 · 3+ traces Enter open · / filter · > more · Esc back · r re…",
        " ▸ t_9f                 GET /cart                     42  errored     GET /cart…",
        "   t_a0                 POST /checkout               128  complete    POST /che…",
        "   t_b7                 -                              -  -",
        "   … more traces: press >",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        " 2 unknown lines skipped",
      ]
    `);
    expect(plain(renderFrame(tracesState(), { cols: 40, rows: 10 }, PLAIN))).toMatchInlineSnapshot(`
      [
        " kosmo-tui · ds_02 · 3+… Enter open · /…",
        " ▸ t_9f       GET /cart         42  err…",
        "   t_a0       POST /check…     128  com…",
        "   t_b7       -                  -  -",
        "   … more traces: press >",
        "",
        "",
        "",
        "",
        " 2 unknown lines skipped",
      ]
    `);
  });

  it("focused detail fills the body", () => {
    const focused = apply(cartState(), { type: "activate" });
    expect(plain(renderFrame(focused, { cols: 80, rows: 24 }, PLAIN))).toMatchInlineSnapshot(`
      [
        " kosmo-tui · POST /cart · 5 spans · errored      j/k scroll · Tab back · q quit ",
        " calculateLineTotal · function · errored · node · s1",
        " src/cart.ts:12:3  area src/cart · cart",
        " ┌ src/cart.ts ─────────────────────────────────────────────────────────────────",
        " │▶ 12  export async function calculateLineTotal(item, qty) {",
        " │  13    const p = await price(item.id);",
        " │  14    if (item.discount > 100) {",
        " │  15      throw new RangeError("discount > 100%");",
        " │  16    }",
        " │  17    const total = p * qty;",
        " │  18    log(total);",
        " │  19    return total;",
        " │  20  }",
        " └──────────────────────────────────────────────────────────────────────────────",
        " args    [{"id":7},2]",
        " return  not-recorded (threw)",
        " error   RangeError: discount > 100%",
        " attrs   code.function = calculateLineTotal",
        "",
        "",
        "",
        "",
        "",
        " tree",
      ]
    `);
  });
});

describe("frame invariants", () => {
  const states: Array<[string, () => ViewState]> = [
    ["start", () => initialState({ root: "/work", readOnly: false, start: START_ROWS })],
    ["start empty", () => initialState({ root: "/work", readOnly: false })],
    ["traces", tracesState],
    ["tree", cartState],
    ["table", () => apply(cartState(), { type: "toggleTable" })],
    ["text", () => apply(cartState(), { type: "toggleText" })],
    ["detail", () => apply(cartState(), { type: "activate" })],
    ["areas", () => apply(cartState(), { type: "openPane", pane: "areas" })],
    ["stack", () => apply(cartState(), { type: "openPane", pane: "stack" })],
    [
      "prompt",
      () => apply(cartState(), { type: "openPrompt", kind: "command" }, { type: "promptInput", text: "find /cart/" })
    ]
  ];

  it("exactly `rows` lines, none wider than `cols`, at every size from the minimum up", () => {
    for (const [name, make] of states) {
      for (const [cols, rows] of [
        [40, 10],
        [41, 11],
        [80, 24],
        [120, 40],
        [200, 12]
      ] as const) {
        const frame = renderFrame(make(), { cols, rows }, { color: COLOR_16, links: false });
        expect(frame, `${name} ${cols}x${rows}`).toHaveLength(rows);
        for (const line of frame) expect(visibleWidth(line), `${name} ${cols}x${rows}`).toBeLessThanOrEqual(cols);
      }
    }
  });

  it("below 40x10 the frame is tooSmallFrame from terminal.ts", () => {
    for (const size of [
      { cols: 39, rows: 24 },
      { cols: 80, rows: 9 },
      { cols: 10, rows: 3 }
    ]) {
      const frame = renderFrame(cartState(), size, PLAIN);
      expect(frame).toHaveLength(size.rows);
      expect(frame.slice(0, 2)).toEqual([...tooSmallFrame(size)]);
    }
  });

  it("the ▶ line is on screen at 80x24 and 40x10 however the selection moves", () => {
    for (const size of [
      { cols: 80, rows: 24 },
      { cols: 40, rows: 10 }
    ]) {
      const frame = plain(renderFrame(cartState(), size, PLAIN));
      expect(
        frame.some((line) => line.startsWith(" │▶ 12")),
        `${size.cols}x${size.rows}`
      ).toBe(true);
    }
  });

  it("a minified 200 KB line and CJK/emoji names keep the frame and the ▶ line (review focus 3)", () => {
    const wide = model([
      span({
        id: "w",
        order: 0,
        name: "計算合計😀".repeat(30),
        kind: "react.render",
        location: { file: "dist/アプリ.min.js", line: 1 }
      })
    ]);
    const huge: Snippet = {
      state: "ok",
      file: "dist/アプリ.min.js",
      lines: [{ n: 1, text: `(()=>{${"漢字😀a=1;".repeat(20_000)}})();` }],
      target: 1
    };
    const state = apply(
      initialState({ root: "/work", readOnly: false }),
      {
        type: "datasetOpened",
        dataset: {
          info: { id: "wide" },
          kind: "json",
          origin: { path: "/wide.kosmo-trace.json" },
          traces: [{ id: "t1", name: "画面", spans: 1, status: "complete", requests: null }],
          hasMore: false,
          notices: [],
          reloadable: true
        }
      },
      { type: "traceLoaded", model: wide },
      { type: "snippetLoaded", ref: ref("w"), snippet: huge }
    );
    for (const size of [
      { cols: 40, rows: 10 },
      { cols: 80, rows: 24 },
      { cols: 81, rows: 24 }
    ]) {
      const frame = renderFrame(state, size, { color: COLOR_16, links: false });
      expect(frame).toHaveLength(size.rows);
      for (const line of frame) expect(visibleWidth(line), `${size.cols}x${size.rows}`).toBeLessThanOrEqual(size.cols);
      expect(
        plain(frame).some((line) => line.startsWith(" │▶ 1")),
        `${size.cols}x${size.rows}`
      ).toBe(true);
    }
  });

  it("a 50 000-deep chain renders only what is visible (review focus 1)", () => {
    const deep = model(chain(50_000));
    const state = apply(
      initialState({ root: "/work", readOnly: false }),
      {
        type: "datasetOpened",
        dataset: {
          info: { id: "deep" },
          kind: "json",
          origin: { path: "/deep.kosmo-trace.json" },
          traces: [{ id: "t1", name: null, spans: 50_000, status: "complete", requests: null }],
          hasMore: false,
          notices: [],
          reloadable: true
        }
      },
      { type: "traceLoaded", model: deep },
      { type: "moveTo", edge: "last" }
    );
    const started = performance.now();
    const frame = plain(renderFrame(state, { cols: 80, rows: 24 }, PLAIN));
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(frame.some((line) => line.startsWith(" ▸") && line.includes("·49999 ") && line.includes("c49999"))).toBe(
      true
    );
  });
});

describe("views and panes", () => {
  it("text view shows kosmo-text/v1 of the trace with the selected span marked", () => {
    const state = apply(cartState(), { type: "toggleText" });
    const frame = plain(renderFrame(state, { cols: 120, rows: 30 }, PLAIN));
    const text = renderKosmoText(state.trace!, { detail: 0, values: () => undefined }).split("\n");
    expect(frame[1]).toBe(`   ${text[0]}`.slice(0, 120));
    expect(frame).toContain(` ▸ ${text[4]}`);
  });

  it("table view has a header row and no separator rows", () => {
    const frame = plain(renderFrame(apply(cartState(), { type: "toggleTable" }), { cols: 100, rows: 24 }, PLAIN));
    expect(frame[1]).toMatch(/^ {3}S NAME +KIND +LOCATION +DURATION {2}AREA$/);
    expect(frame.some((line) => line.includes("┄┄"))).toBe(false);
  });

  it("areas pane lists every area with counts; derived ones have ~", () => {
    const frame = plain(
      renderFrame(apply(cartState(), { type: "openPane", pane: "areas" }), { cols: 80, rows: 24 }, PLAIN)
    );
    expect(frame).toContain(" areas (4) · Enter filter · Esc close");
    expect(frame.some((line) => /~node_modules\/cors|~cors/.test(line))).toBe(true);
    expect(frame.some((line) => /src\/cart · cart +1 spans {2}1 errors/.test(line))).toBe(true);
  });

  it("stack pane: recorded ancestors and where the walk stopped", () => {
    const frame = plain(
      renderFrame(apply(cartState(), { type: "openPane", pane: "stack" }), { cols: 80, rows: 24 }, PLAIN)
    );
    expect(frame).toContain(" stack · recorded ancestors, not a live JS stack");
    expect(frame).toContain(" ▸ #0 ✗ calculateLineTotal  src/cart.ts:12");
    expect(frame).toContain("   #1 ✗ POST /cart  src/server.ts:8");
    expect(frame).toContain("   #2 ✗ submitOrder  src/app/cart/actions.ts:3");
    expect(frame).toContain("   root reached");
  });

  it("bookmarks and results panes", () => {
    const marked = apply(cartState(), { type: "toggleBookmark" }, { type: "openPane", pane: "bookmarks" });
    expect(plain(renderFrame(marked, { cols: 80, rows: 24 }, PLAIN))).toContain(" ▸ 1. calculateLineTotal  s1:sp_3");
    const results = apply(cartState(), {
      type: "showResults",
      results: {
        kind: "callers",
        title: "callers of calculateLineTotal at src/cart.ts:12: 1 call(s), 1 caller(s)",
        refs: [ref("req")],
        labels: ["1×  POST /cart  src/server.ts:8"],
        footer: null
      }
    });
    const frame = plain(renderFrame(results, { cols: 100, rows: 24 }, PLAIN));
    expect(frame).toContain(
      " callers of calculateLineTotal at src/cart.ts:12: 1 call(s), 1 caller(s) · Enter go · Esc close"
    );
    expect(frame).toContain(" ▸ 1×  POST /cart  src/server.ts:8");
  });
});

describe("header and footer", () => {
  it("prompt, banner, reading progress and notices", () => {
    const prompt = apply(
      cartState(),
      { type: "openPrompt", kind: "command" },
      { type: "promptInput", text: "find /x/" }
    );
    expect(plain(renderFrame(prompt, { cols: 80, rows: 24 }, PLAIN))[23]).toBe(" :find /x/_");
    const banner = apply(
      cartState(),
      { type: "reload" },
      { type: "showBanner", level: "error", text: "reload: unavailable(stdin-stream)" }
    );
    expect(plain(renderFrame(banner, { cols: 80, rows: 24 }, PLAIN))[23]).toBe(" ! reload: unavailable(stdin-stream)");
    const reading = apply(initialState({ root: "/", readOnly: false }), { type: "readingProgress", spans: 1200 });
    const frame = plain(renderFrame(reading, { cols: 80, rows: 24 }, PLAIN));
    expect(frame[1]).toBe(" reading… 1200 spans");
    expect(frame[23]).toBe(" reading… 1200 spans");
    expect(plain(renderFrame(tracesState(), { cols: 80, rows: 24 }, PLAIN))[23]).toBe(" 2 unknown lines skipped");
  });

  it("`r reload` is advertised only when the source can be re-read", () => {
    const stdin = apply(initialState({ root: "/", readOnly: false }), {
      type: "datasetOpened",
      dataset: {
        info: { id: "s" },
        kind: "ndjson",
        origin: "stdin",
        traces: [
          { id: "a", name: null, spans: 1, status: "complete", requests: null },
          { id: "b", name: null, spans: 1, status: "complete", requests: null }
        ],
        hasMore: false,
        notices: [{ kind: "stream-stopped", line: 12, reason: "invalid JSON" }],
        reloadable: false
      }
    });
    const frame = plain(renderFrame(stdin, { cols: 120, rows: 24 }, PLAIN));
    expect(frame[0]).not.toContain("r reload");
    expect(frame[23]).toBe(" stream stopped at line 12: invalid JSON");
    expect(plain(renderFrame(tracesState(), { cols: 120, rows: 24 }, PLAIN))[0]).toContain("r reload");
  });
});

describe("terminal safety of whole frames (review focus 2)", () => {
  it("CSI, OSC, C1 and bidi from the data never reach the terminal raw", () => {
    const evil = "\u001b[2J\u001b]8;;http://evil\u0007\u009b31m\u202e";
    const hostile = model(
      [
        span({
          id: `r${evil}`,
          order: 0,
          name: `root${evil}`,
          kind: `k${evil}`,
          runtime: "browser",
          location: { file: `src/${evil}.ts`, line: 1, snippet: `snip${evil}` }
        }),
        span({
          id: "c",
          session: `s${evil}`,
          parent: `r${evil}`,
          parentSession: "s1",
          order: 0,
          name: `child${evil}`,
          runtime: "node"
        })
      ],
      [],
      `trace${evil}`
    );
    const base = apply(
      initialState({
        root: "/work",
        readOnly: false,
        start: [{ path: `x${evil}.kosmo-trace.json`, size: 1, mtimeMs: 0, source: "found", missing: false }]
      })
    );
    const start = renderFrame(base, { cols: 120, rows: 24 }, { color: COLOR_16, links: true });
    const opened = apply(
      base,
      { type: "activate" },
      {
        type: "datasetOpened",
        dataset: {
          info: { id: `ds${evil}`, title: `title${evil}` },
          kind: "ndjson",
          origin: "stdin",
          traces: [
            {
              id: `t1`,
              name: `name${evil}`,
              spans: 2,
              status: "complete",
              requests: { first: { method: `M${evil}`, route: `/r${evil}`, status: `s${evil}` }, count: 2 }
            },
            { id: `t2${evil}`, name: null, spans: 0, status: null, requests: null }
          ],
          hasMore: false,
          notices: [{ kind: "stream-stopped", line: 3, reason: `bad${evil}` }],
          reloadable: false
        }
      }
    );
    const list = renderFrame(opened, { cols: 120, rows: 24 }, { color: COLOR_16, links: true });
    const trace = apply(opened, { type: "traceLoaded", model: hostile });
    const snippet: Snippet = { state: "ok", file: `src/${evil}.ts`, lines: [{ n: 1, text: `code${evil}` }], target: 1 };
    const withCode = apply(
      trace,
      { type: "snippetLoaded", ref: trace.selected!, snippet },
      { type: "showBanner", level: "error", text: `boom${evil}` }
    );
    const frames = [
      start,
      list,
      renderFrame(withCode, { cols: 120, rows: 24 }, { color: COLOR_16, links: true }),
      renderFrame(apply(withCode, { type: "toggleText" }), { cols: 120, rows: 24 }, { color: COLOR_16, links: true }),
      renderFrame(
        apply(withCode, { type: "openPrompt", kind: "search" }, { type: "promptInput", text: `p\u202eq` }),
        { cols: 120, rows: 24 },
        PLAIN
      )
    ];
    for (const frame of frames) {
      const text = frame.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
      expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    }
    expect(stripAnsi(frames[2]!.join("\n"))).toContain("root\\u001b[2J\\u001b]8;;http://evil\\u0007\\u009b31m\\u202e");
  });
});

/** Any C0 (newline included), DEL, C1 or bidi control; frame lines never carry one raw. */
const RAW_CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const SGR = /\u001b\[[0-9;]*m/g;
const DIM = "\u001b[2m";
const SIZE = { cols: 120, rows: 40 };
const COLORED: RenderEnv = { color: COLOR_16, links: false };
const HOSTILE_TEXT = fileURLToPath(new URL("../fixtures/hostile/hostile-text.json", import.meta.url));

/**
 * A committed fixture (task 6) opened the way the session opens a file: validateDocument →
 * buildTraceModel, then datasetOpened and traceLoaded of trace `id`.
 */
function openFixture(file: string, id: string): ViewState {
  const result = validateDocument(JSON.parse(readFileSync(file, "utf8")));
  if (!result.ok) throw new Error(`${file}: ${result.code} at ${result.position}: ${result.what}`);
  const traces = result.acc.traceSummaries();
  const summary = traces.find((trace) => trace.id === id)!;
  const trace = buildTraceModel({ id, name: summary.name }, result.acc.spansOf(id), result.acc.linksOf(id));
  return apply(
    initialState({ root: "/work", readOnly: false }),
    {
      type: "datasetOpened",
      dataset: {
        info: result.dataset,
        kind: "json",
        origin: { path: file },
        traces,
        hasMore: false,
        notices: [],
        reloadable: true
      }
    },
    { type: "traceLoaded", model: trace }
  );
}

/**
 * The frame line of span `id`'s tree row. Every fixture trace fits the 120x40 list, so the window
 * starts at row 0: the list begins on line 1 and a separator takes a line of its own.
 */
function treeLine(state: ViewState, frame: readonly string[], id: string): string {
  let line = 1;
  for (const row of visibleRows(state)) {
    if (row.separator !== undefined) line += 1;
    if (row.ref.id === id) return frame[line]!;
    line += 1;
  }
  throw new Error(`no tree row for ${id}`);
}

/** Column of the status glyph: equal for siblings with the same expander state. */
function glyphColumn(line: string): number {
  return line.search(/[✓✗…⏸?]/);
}

describe("framework fixtures (spec 13.1, 13.3)", () => {
  it("express-chain: layers are siblings under the router, ⤳ on the error handler, a hung layer is only running", () => {
    const state = openFixture(fixtureFile("frameworks/express-chain"), "t_express");
    const frame = plain(renderFrame(state, SIZE, PLAIN));
    const router = glyphColumn(treeLine(state, frame, "router1"));
    const layers = ["mw_cors", "mw_json", "h_get", "eh"].map((id) => glyphColumn(treeLine(state, frame, id)));
    expect(layers).toEqual([router + 2, router + 2, router + 2, router + 2]);
    expect(treeLine(state, frame, "eh")).toContain("✓ ⤳ errorHandler express.error-handler");
    expect(treeLine(state, frame, "mw_auth")).toBe(
      "         … authenticate express.middleware  src/middleware/auth.ts:3  running (at capture)"
    );
  });

  it("nest-pipeline: a guard that returned false is denied; kind nest.* keeps the nest layers under dimmed requests", () => {
    const state = openFixture(fixtureFile("frameworks/nest-pipeline"), "t_nest");
    const frame = plain(renderFrame(state, SIZE, PLAIN));
    expect(treeLine(state, frame, "r2_guard")).toContain("RolesGuard.canActivate nest.guard → false (denied)");
    expect(treeLine(state, frame, "r1_guard")).not.toContain("denied");
    const filtered = apply(state, { type: "setFilter", patch: { kindGlob: "nest.*" } });
    expect(visibleRows(filtered).map((row) => row.ref.id)).toEqual([
      "r1",
      "r1_logger",
      "r1_guard",
      "r1_icpt",
      "r1_pipe",
      "r1_handler",
      "r2",
      "r2_guard",
      "r2_filter",
      "r3",
      "r3_pipe",
      "r3_filter"
    ]);
    const colored = renderFrame(filtered, SIZE, COLORED);
    expect(treeLine(filtered, colored, "r1").startsWith(DIM)).toBe(true);
    expect(treeLine(filtered, colored, "r1_logger").startsWith(DIM)).toBe(false);
    expect(plain(colored).some((line) => line.includes("helmet"))).toBe(false);
    expect(stripAnsi(colored[39]!)).toBe(" tree · kind nest.*");
  });

  it("react-strict: StrictMode duplicates are dimmed and marked ⧉strict, the first render is not", () => {
    const state = openFixture(fixtureFile("frameworks/react-strict"), "t_react");
    const frame = plain(renderFrame(state, SIZE, PLAIN));
    expect(treeLine(state, frame, "rd_cart_dup")).toBe(
      "       ✓ CartView react.render  src/cart/CartView.tsx:12  ⧉strict"
    );
    expect(treeLine(state, frame, "rd_cart")).not.toContain("⧉strict");
    expect(treeLine(state, frame, "ef_cleanup")).toContain("⧉strict");
    expect(treeLine(state, frame, "ef_setup1")).not.toContain("⧉strict");
    expect(treeLine(state, renderFrame(state, SIZE, COLORED), "rd_cart_dup").startsWith(DIM)).toBe(true);
  });

  it("next-action: a separator before each change of session or runtime", () => {
    const state = openFixture(fixtureFile("frameworks/next-action"), "t_next_action");
    expect(plain(renderFrame(state, SIZE, PLAIN)).slice(1, 9)).toEqual([
      " ▸ - ✓ onSubmit  app/cart/AddToCart.tsx:14",
      "     - ✓ addToCart next.server-action  app/cart/actions.ts:3",
      "         ┄┄ browser → node · node ┄┄",
      "       - ✓ POST /cart http.server POST /cart → 200 · action  (no location)",
      "           ┄┄ node → edge · node ┄┄",
      "           ✓ middleware next.middleware  middleware.ts:4",
      "           ✓ addToCart next.server-action  app/cart/actions.ts:3",
      "           ✓ render /cart next.render  app/cart/page.tsx:1"
    ]);
  });

  it("attrs-hostile: the attrs block of at_mixed is masked, counts dropped entries and is escaped", () => {
    const state = openFixture(fixtureFile("frameworks/attrs-hostile"), "t_attrs");
    expect(state.selected).toEqual(ref("at_mixed", "s1", "t_attrs"));
    const frame = renderFrame(state, SIZE, COLORED);
    expect(plain(frame).slice(21, 27)).toEqual([
      " attrs   bidi.value = \\u202eevil.txt",
      "         c1.value = \\u009b31mred",
      "         esc.value = \\u001b]8;;file:///etc/passwd\\u0007x",
      "         http.request.header.authorization = masked",
      "         ok.first = kept",
      "         invalid-attrs(5)"
    ]);
    for (const line of frame) expect(line.replace(SGR, "")).not.toMatch(RAW_CONTROL);
    expect(plain(frame).join("\n")).not.toContain("Bearer");
  });

  it("hostile/hostile-text.json: every text field reaches the tree and the detail escaped (spec 8.1)", () => {
    const state = openFixture(HOSTILE_TEXT, "t");
    const frames = [renderFrame(state, SIZE, COLORED), renderFrame(apply(state, { type: "activate" }), SIZE, COLORED)];
    for (const frame of frames) {
      expect(frame).toHaveLength(SIZE.rows);
      for (const line of frame) expect(line.replace(SGR, "")).not.toMatch(RAW_CONTROL);
    }
    const detail = plain(frames[1]!).join("\n");
    for (const escaped of [
      "evil\\u001b[2J\\u001b]52;c;aGVsbG8=\\u0007\\u009b31m\\u202eeman",
      "x.\\u001b[31mkind",
      "unknown(\\u001b]8;;file:///etc/passwd\\u0007click)",
      "src/\\u009b31m",
      "x.text = \\u001b[2Jwipe",
      "Error: \\u001b[31mred\\u001b[0m\\u000d\\u000aforged line"
    ]) {
      expect(detail, escaped).toContain(escaped);
    }
  });
});
