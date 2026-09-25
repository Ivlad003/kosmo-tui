/**
 * Task 17: row text of spec 6.2 / 6.3 and the framework kinds of 4.13 (13.3 "UI фреймворків").
 */
import { describe, expect, it } from "vitest";
import { stripAnsi, visibleWidth } from "../../src/ansi.js";
import { COLOR_16, COLOR_NONE } from "../../src/color.js";
import type { SpanRow, SpanValues } from "../../src/format/types.js";
import { areaText, httpText, statusText } from "../../src/ui/labels.js";
import {
  indentText,
  separatorRowText,
  tableHeaderText,
  tableRowText,
  traceListRowText,
  treeRowText,
  type RowContext
} from "../../src/ui/rows.js";
import type { TreeRow } from "../../src/ui/state.js";
import { model, ref, span } from "./model-fixtures.js";

const DIM = "\u001b[2m";

function row(target: SpanRow, depth = 0, extra: Partial<TreeRow> = {}): TreeRow {
  return { ref: target.ref, depth, context: false, ...extra };
}

function text(target: SpanRow, options: { values?: SpanValues; selected?: boolean; width?: number } = {}): string {
  const trace = model([target]);
  return treeRowText(trace, row(target), false, {
    selected: options.selected ?? false,
    width: options.width ?? 120,
    color: COLOR_NONE,
    values: options.values ?? target.values
  });
}

describe("labels", () => {
  it("status texts: running is `running (at capture)`, unknown always has a reason", () => {
    expect(statusText(span({ id: "a", status: "running" }))).toBe("running (at capture)");
    expect(statusText(span({ id: "a", status: "unknown" }))).toBe("unknown(unspecified)");
    expect(statusText(span({ id: "a", status: "unknown", statusReason: "aborted" }))).toBe("unknown(aborted)");
    expect(statusText(span({ id: "a", status: "suspended" }))).toBe("suspended");
  });

  it("areas: explicit, derived with ~, unknown", () => {
    expect(areaText({ module: "src/cart", feature: "cart", derived: false })).toBe("src/cart · cart");
    expect(areaText({ module: "cors", feature: null, derived: true })).toBe("~cors");
    expect(areaText({ module: null, feature: "cart", derived: false })).toBe("· cart");
    expect(areaText({ module: null, feature: null, derived: false })).toBe("(unknown)");
  });

  it("http.server: METHOD route → status and next.request.type; nothing for other kinds", () => {
    const attrs = {
      "http.request.method": "GET",
      "http.route": "/api/orders/:id",
      "http.response.status_code": 200,
      "next.request.type": "rsc"
    };
    expect(httpText(span({ id: "r", kind: "http.server", attrs }))).toBe("GET /api/orders/:id → 200 · rsc");
    expect(httpText(span({ id: "r", kind: "http.server", attrs: { "http.route": "/x" } }))).toBe("- /x → -");
    expect(httpText(span({ id: "r", kind: "http.server" }))).toBeNull();
    expect(httpText(span({ id: "r", kind: "express.handler", attrs }))).toBeNull();
  });
});

describe("tree rows", () => {
  it("a function row: glyph, name, file:line, duration; no kind", () => {
    const fn = span({
      id: "f",
      name: "calculateLineTotal",
      status: "errored",
      durationMs: 1.8,
      location: { file: "src/cart.ts", line: 12 }
    });
    expect(stripAnsi(text(fn))).toBe("     ✗ calculateLineTotal  src/cart.ts:12  1.8ms");
  });

  it("a non-function kind is shown in full and dimmed, so express and nest middleware never look alike", () => {
    const express = text(span({ id: "m", name: "cors", kind: "express.middleware" }));
    const nest = text(span({ id: "m", name: "cors", kind: "nest.middleware" }));
    expect(stripAnsi(express)).toBe("     ✓ cors express.middleware  (no location)");
    expect(stripAnsi(nest)).toBe("     ✓ cors nest.middleware  (no location)");
    expect(express).toContain(`${DIM}express.middleware\u001b[0m`);
  });

  it("http.server row carries the request line", () => {
    const req = span({
      id: "req",
      name: "GET /cart",
      kind: "http.server",
      attrs: {
        "http.request.method": "GET",
        "http.route": "/cart",
        "http.response.status_code": 500,
        "next.request.type": "document"
      }
    });
    expect(stripAnsi(text(req))).toBe("     ✓ GET /cart http.server GET /cart → 500 · document  (no location)");
  });

  it("error handlers and filters get ⤳; a guard that returned false is denied", () => {
    expect(stripAnsi(text(span({ id: "e", name: "onError", kind: "express.error-handler" })))).toBe(
      "     ✓ ⤳ onError express.error-handler  (no location)"
    );
    expect(stripAnsi(text(span({ id: "e", name: "HttpFilter", kind: "nest.filter" })))).toContain("⤳ HttpFilter");
    const denied: SpanValues = {
      args: { state: "not-recorded" },
      return: { state: "recorded", value: false },
      error: { state: "not-recorded" }
    };
    const guard = span({ id: "g", name: "AuthGuard", kind: "nest.guard", values: denied });
    expect(stripAnsi(text(guard))).toBe("     ✓ AuthGuard nest.guard → false (denied)  (no location)");
    const allowed = { ...denied, return: { state: "recorded" as const, value: true } };
    expect(stripAnsi(text(span({ id: "g", name: "AuthGuard", kind: "nest.guard", values: allowed })))).not.toContain(
      "denied"
    );
    // SQLite before the values are loaded: nothing is claimed.
    expect(stripAnsi(text(span({ id: "g", name: "AuthGuard", kind: "nest.guard" })))).not.toContain("denied");
  });

  it("a StrictMode duplicate is dimmed as a whole and marked ⧉strict", () => {
    const dup = text(
      span({ id: "r", name: "Cart", kind: "react.render", attrs: { "react.strict_mode.duplicate": true } })
    );
    expect(dup.startsWith(DIM)).toBe(true);
    expect(stripAnsi(dup)).toBe("     ✓ Cart react.render  (no location)  ⧉strict");
  });

  it("a running middleware is only `running (at capture)`: no invented diagnosis", () => {
    const stuck = span({
      id: "m",
      name: "auth",
      kind: "express.middleware",
      status: "running",
      location: { file: "src/auth.ts", line: 4 }
    });
    expect(stripAnsi(text(stuck))).toBe("     … auth express.middleware  src/auth.ts:4  running (at capture)");
  });

  it("parent marks: unknown(missing) and cycle", () => {
    const orphan = span({ id: "o", parent: "ghost", order: 1 });
    const trace = model([orphan]);
    expect(
      stripAnsi(
        treeRowText(trace, row(orphan), false, { selected: true, width: 80, color: COLOR_NONE, values: undefined })
      )
    ).toBe(" ▸   ✓ o  (no location)  parent=unknown(missing)");

    // a ⇄ b: the member with the smallest (session, order) becomes a root whose parent edge is dropped.
    const a = span({ id: "a", parent: "b", order: 1 });
    const b = span({ id: "b", parent: "a", order: 2 });
    const cyclic = model([a, b]);
    expect(cyclic.parentOf(a.ref)).toEqual({ kind: "cycle" });
    const ctx: RowContext = { selected: false, width: 80, color: COLOR_NONE, values: undefined };
    expect(stripAnsi(treeRowText(cyclic, row(a), false, ctx))).toBe("   - ✓ a  (no location)  cycle");
    // Its child keeps its resolved parent: no mark.
    expect(stripAnsi(treeRowText(cyclic, row(b, 1), false, ctx))).toBe("       ✓ b  (no location)");
  });

  it("expander shows children and collapse state; context rows are dimmed", () => {
    const parent = span({ id: "p", order: 0 });
    const child = span({ id: "c", parent: "p", order: 1 });
    const trace = model([parent, child]);
    const ctx: RowContext = { selected: false, width: 80, color: COLOR_NONE, values: undefined };
    expect(stripAnsi(treeRowText(trace, row(parent), false, ctx))).toBe("   - ✓ p  (no location)");
    expect(stripAnsi(treeRowText(trace, row(parent), true, ctx))).toBe("   + ✓ p  (no location)");
    expect(stripAnsi(treeRowText(trace, row(child, 1), false, ctx))).toBe("       ✓ c  (no location)");
    expect(treeRowText(trace, row(parent, 0, { context: true }), false, ctx).startsWith(DIM)).toBe(true);
  });

  it("deep rows keep the name visible and never exceed the width", () => {
    expect(indentText(3, 80)).toBe("      ");
    expect(indentText(50_000, 80)).toBe("                   ·50000 ");
    const deep = span({ id: "deep", name: "leaf", order: 0 });
    const trace = model([deep]);
    const line = treeRowText(trace, row(deep, 50_000), false, {
      selected: false,
      width: 40,
      color: COLOR_NONE,
      values: undefined
    });
    expect(stripAnsi(line)).toContain("leaf");
    expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });

  it("hostile text in name, kind, file and attrs is escaped (review focus 2)", () => {
    const hostile = span({
      id: "h",
      name: "a\u001b[31mred\u001b]8;;http://evil\u0007x",
      kind: "k\u009b2J",
      location: { file: "src/\u202eevil.ts", line: 1 },
      attrs: { "http.route": "/\u001b[2J" }
    });
    const line = text({ ...hostile, kind: "http.server" });
    const withoutSgr = line.replace(/\u001b\[[0-9;]*m/g, "");
    expect(withoutSgr).not.toMatch(/[\u001b\u009b\u202e]/);
    expect(stripAnsi(line)).toContain("a\\u001b[31mred\\u001b]8;;http://evil\\u0007x");
    expect(stripAnsi(line)).toContain("src/\\u202eevil.ts:1");
    expect(stripAnsi(line)).toContain("/\\u001b[2J");
    const kindLine = text(hostile);
    expect(stripAnsi(kindLine)).toContain("k\\u009b2J");
  });
});

describe("separator, table and trace list rows", () => {
  it("separator: «┄┄ browser → node · n1 ┄┄», dimmed and escaped", () => {
    const line = separatorRowText(
      { ref: ref("a", "n1"), depth: 1, context: false, separator: "┄┄ browser → node · n1 ┄┄" },
      80,
      COLOR_16
    );
    expect(stripAnsi(line)).toBe("       ┄┄ browser → node · n1 ┄┄");
    expect(line.startsWith(DIM)).toBe(true);
    expect(
      stripAnsi(
        separatorRowText(
          { ref: ref("a"), depth: 0, context: false, separator: "┄┄ - → - · \u001b[2J ┄┄" },
          80,
          COLOR_NONE
        )
      )
    ).toBe("     ┄┄ - → - · \\u001b[2J ┄┄");
  });

  it("table row: flat columns with kind, location, duration and area", () => {
    const fn = span({
      id: "f",
      name: "calc",
      kind: "nest.pipe",
      durationMs: 2,
      location: { file: "src/a.ts", line: 3 },
      area: { module: "src/a", feature: "cart" }
    });
    const trace = model([fn]);
    const line = stripAnsi(
      tableRowText(trace, row(fn), { selected: true, width: 100, color: COLOR_NONE, values: undefined })
    );
    expect(line).toBe(
      " ▸ ✓ calc                       nest.pipe         src/a.ts:3                  2.0ms  src/a · cart"
    );
    expect(stripAnsi(tableHeaderText(100, COLOR_NONE))).toBe(
      "   S NAME                       KIND              LOCATION                 DURATION  AREA"
    );
  });

  it("trace list row: id, name, spans, status, first request and N requests; nulls are -", () => {
    const line = traceListRowText(
      {
        id: "t_9f",
        name: "GET /cart",
        spans: 42,
        status: "errored",
        requests: { first: { method: "GET", route: "/cart", status: 500 }, count: 3 }
      },
      true,
      120,
      COLOR_NONE
    );
    expect(stripAnsi(line)).toBe(
      " ▸ t_9f                     GET /cart                             42  errored     GET /cart → 500 · 3 requests"
    );
    const bare = traceListRowText(
      { id: "t_1", name: null, spans: null, status: null, requests: null },
      false,
      80,
      COLOR_NONE
    );
    expect(stripAnsi(bare)).toBe("   t_1                  -                              -  -");
  });

  it("a secret in the route is masked in the tree row and in the trace list row (spec 8.3)", () => {
    const req = span({
      id: "req",
      name: "GET /cart",
      kind: "http.server",
      attrs: { "http.request.method": "GET", "http.route": "/cart?token=abc", "http.response.status_code": 200 }
    });
    const tree = stripAnsi(text(req));
    expect(tree).toContain("GET /cart?token=masked → 200");
    expect(tree).not.toContain("abc");
    const list = stripAnsi(
      traceListRowText(
        {
          id: "t_1",
          name: "GET /cart",
          spans: 1,
          status: "complete",
          requests: { first: { method: "GET", route: "/cart?token=abc", status: 200 }, count: 1 }
        },
        false,
        120,
        COLOR_NONE
      )
    );
    expect(list).toContain("GET /cart?token=masked → 200");
    expect(list).not.toContain("abc");
  });
});
