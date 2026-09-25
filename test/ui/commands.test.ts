/**
 * Task 15: `:` commands of spec 6.6 over a TraceModel.
 */
import { describe, expect, it } from "vitest";
import { parseCommandLine } from "../../src/ui/commands.js";
import { initialState, update, type ViewState } from "../../src/ui/state.js";
import { model, ref, span } from "./model-fixtures.js";

const cart = { module: "src/cart", feature: "cart" };
const pricing = { module: "src/pricing", feature: "cart" };

/**
 * req GET /cart (src/server.ts:1)
 * ├─ calc1 calc (src/cart.ts:12) ─ p1 price (src/price.ts:5)
 * ├─ calc2 calc (src/cart.ts:12) ─ p2 price (src/price.ts:5)
 * ├─ co checkout (src/checkout.ts:3) ─ p3 price, log2 log (no location)
 * ├─ log log (no location)
 * ├─ sp_1 (s1)
 * └─ n1:sp_1 (other session)
 * p4 price (src/price.ts:5), parent "ghost" missing → unknown(missing) root
 */
function shop(): ViewState {
  const trace = model([
    span({
      id: "req",
      order: 0,
      name: "GET /cart",
      kind: "http.server",
      location: { file: "src/server.ts", line: 1 },
      area: { module: "src/server" }
    }),
    span({
      id: "calc1",
      parent: "req",
      order: 1,
      name: "calc",
      location: { file: "src/cart.ts", line: 12 },
      area: cart
    }),
    span({
      id: "p1",
      parent: "calc1",
      order: 2,
      name: "price",
      location: { file: "src/price.ts", line: 5 },
      area: cart
    }),
    span({
      id: "calc2",
      parent: "req",
      order: 3,
      name: "calc",
      location: { file: "src/cart.ts", line: 12 },
      area: cart
    }),
    span({
      id: "p2",
      parent: "calc2",
      order: 4,
      name: "price",
      location: { file: "src/price.ts", line: 5 },
      area: pricing
    }),
    span({
      id: "co",
      parent: "req",
      order: 5,
      name: "checkout",
      location: { file: "src/checkout.ts", line: 3 },
      area: { module: "src/checkout", feature: "checkout" }
    }),
    span({
      id: "p3",
      parent: "co",
      order: 6,
      name: "price",
      location: { file: "src/price.ts", line: 5 },
      area: pricing
    }),
    span({ id: "p4", parent: "ghost", order: 7, name: "price", location: { file: "src/price.ts", line: 5 } }),
    span({ id: "log", parent: "req", order: 8, name: "log" }),
    span({ id: "log2", parent: "co", order: 9, name: "log" }),
    span({ id: "sp_1", parent: "req", order: 10 }),
    span({ id: "sp_1", session: "n1", parent: "req", parentSession: "s1", order: 0 })
  ]);
  let state = initialState({ root: "/work", readOnly: false });
  [state] = update(state, {
    type: "datasetOpened",
    dataset: {
      info: { id: "ds" },
      kind: "json",
      origin: { path: "/work/shop.kosmo-trace.json" },
      traces: [{ id: "t1", name: "GET /cart", spans: 12, status: "complete", requests: null }],
      hasMore: false,
      notices: [],
      reloadable: true
    }
  });
  [state] = update(state, { type: "traceLoaded", model: trace });
  return state;
}

describe("parseCommandLine: general", () => {
  const state = shop();

  it("unknown commands list the available ones", () => {
    expect(parseCommandLine(state, ":js 1+1")).toEqual({
      error: "unknown command :js; available: :trace :ancestors :path :callers :find :filter :area :bookmark :root :q"
    });
  });

  it("an empty line just closes the prompt; quoting errors are reported", () => {
    expect(parseCommandLine(state, ":")).toEqual({ type: "promptCancel" });
    expect(parseCommandLine(state, ':find "x')).toEqual({ error: "unterminated double quote" });
  });

  it(":q, :trace, :root", () => {
    expect(parseCommandLine(state, ":q")).toEqual({ type: "quit" });
    expect(parseCommandLine(state, "trace t_9f")).toEqual({ type: "openTrace", id: "t_9f" });
    expect(parseCommandLine(state, ":trace")).toEqual({ error: "usage: :trace <trace>" });
    expect(parseCommandLine(state, ":root")).toEqual({ type: "showBanner", level: "info", text: "root: /work" });
    expect(parseCommandLine({ ...state, root: null, rootUnset: "filesystem-root" }, ":root")).toEqual({
      type: "showBanner",
      level: "info",
      text: "code root not set: cwd is the filesystem root; use :root or --root"
    });
    expect(parseCommandLine(state, ":root ../app")).toEqual({ type: "setRoot", dir: "../app" });
    // Spec 6.6: a leading `/` marks a regex only in :find, :filter name and :area, so an absolute
    // path is a plain argument here (the shared tokenizer alone would fail on `/abs/app`).
    expect(parseCommandLine(state, ":root /abs/app")).toEqual({ type: "setRoot", dir: "/abs/app" });
    expect(parseCommandLine(state, ':root "/my app"')).toEqual({ type: "setRoot", dir: "/my app" });
    expect(parseCommandLine(state, ":trace /t")).toEqual({ type: "openTrace", id: "/t" });
    expect(parseCommandLine(state, ':js "x')).toEqual({
      error: "unknown command :js; available: :trace :ancestors :path :callers :find :filter :area :bookmark :root :q"
    });
  });

  it("trace commands need an open trace", () => {
    expect(parseCommandLine(initialState({ root: "/", readOnly: false }), ":find /x/")).toEqual({
      error: ":find needs an open trace"
    });
  });

  it(":bookmark and :bookmark list", () => {
    expect(parseCommandLine(state, ":bookmark")).toEqual({ type: "toggleBookmark" });
    expect(parseCommandLine(state, ":bookmark list")).toEqual({ type: "openPane", pane: "bookmarks" });
  });
});

describe(":ancestors and :path", () => {
  const state = shop();

  it(":ancestors defaults to the selection and ends with the stop marker", () => {
    const selected: ViewState = { ...state, selected: ref("p1") };
    expect(parseCommandLine(selected, ":ancestors")).toEqual({
      type: "showResults",
      results: {
        kind: "ancestors",
        title: "ancestors of price (s1:p1): 2",
        refs: [ref("p1"), ref("calc1"), ref("req")],
        labels: [null, null, null],
        footer: "root reached"
      }
    });
    const orphan = parseCommandLine(state, ":ancestors p4");
    expect(orphan).toMatchObject({ results: { refs: [ref("p4")], footer: "parent unknown(missing)" } });
  });

  it("an ambiguous short id is refused with its candidates", () => {
    expect(parseCommandLine(state, ":ancestors sp_1")).toEqual({ error: "ambiguous ref sp_1: s1:sp_1, n1:sp_1" });
    expect(parseCommandLine(state, ":ancestors n1:sp_1")).toMatchObject({
      results: { refs: [ref("sp_1", "n1"), ref("req")] }
    });
    expect(parseCommandLine(state, ":ancestors nope")).toEqual({ error: "span nope not found in trace t1" });
  });

  it(":path found in either direction, root first", () => {
    const found = {
      type: "showResults",
      results: {
        kind: "path",
        title: "path req → p1: found, 2 edge(s)",
        refs: [ref("req"), ref("calc1"), ref("p1")],
        labels: [null, null, null],
        footer: null
      }
    };
    expect(parseCommandLine(state, ":path req p1")).toEqual(found);
    expect(parseCommandLine(state, ":path p1 req")).toMatchObject({
      results: { title: "path p1 → req: found, 2 edge(s)", refs: [ref("req"), ref("calc1"), ref("p1")] }
    });
  });

  it(":path no-path, unknown-path(reason) and different traces", () => {
    expect(parseCommandLine(state, ":path calc2 p1")).toEqual({
      type: "showBanner",
      level: "info",
      text: "no-path: calc2 → p1"
    });
    expect(parseCommandLine(state, ":path p4 req")).toEqual({
      type: "showBanner",
      level: "info",
      text: "unknown-path(missing): p4 → req"
    });
    expect(parseCommandLine(state, ":path t9:s1:x p1")).toEqual({
      type: "showBanner",
      level: "info",
      text: "no-path: t9:s1:x → p1 (different traces)"
    });
    expect(parseCommandLine(state, ":path req")).toEqual({ error: "usage: :path <from> <to>" });
  });
});

describe(":callers", () => {
  const state = shop();

  it("groups the parents of every span at the same file:line, with counts and (unknown parent)", () => {
    expect(parseCommandLine(state, ":callers p1")).toEqual({
      type: "showResults",
      results: {
        kind: "callers",
        title: "callers of price at src/price.ts:5: 4 call(s), 3 caller(s)",
        refs: [ref("calc1"), ref("co"), ref("p4")],
        labels: ["2×  calc  src/cart.ts:12", "1×  checkout  src/checkout.ts:3", "1×  (unknown parent)"],
        footer: null
      }
    });
  });

  it("without a location the same name is matched; equal counts keep DFS order", () => {
    // DFS visits co → log2 before req's later child log.
    expect(parseCommandLine(state, ":callers log")).toMatchObject({
      results: {
        title: "callers of log at (no location): 2 call(s), 2 caller(s)",
        refs: [ref("co"), ref("req")],
        labels: ["1×  checkout  src/checkout.ts:3", "1×  GET /cart  src/server.ts:1"]
      }
    });
  });
});

describe(":find", () => {
  const state = shop();

  it("matches name or location.file in DFS order and fills the results pane", () => {
    expect(parseCommandLine(state, ":find /price/")).toMatchObject({
      results: { kind: "find", title: "find /price/: 4 match(es)", refs: [ref("p1"), ref("p2"), ref("p3"), ref("p4")] }
    });
    expect(parseCommandLine(state, ":find /src\\/check/")).toMatchObject({ results: { refs: [ref("co")] } });
    expect(parseCommandLine(state, ":find /zzz/")).toMatchObject({ results: { refs: [], footer: "no matches" } });
    const [next] = update(state, { type: "runCommand", result: parseCommandLine(state, ":find /calc/") });
    expect(next.pane).toBe("results");
    expect(next.results).toEqual([ref("calc1"), ref("calc2")]);
  });

  it("refuses non-regex arguments and bad flags", () => {
    expect(parseCommandLine(state, ":find price")).toEqual({ error: "usage: :find /regex/[imsu]" });
    expect(parseCommandLine(state, ":find /price/g")).toEqual({ error: "regex flag g is not allowed (use imsu)" });
  });
});

describe(":filter and :area", () => {
  const state = shop();

  it(":filter errors | name | kind | area | clear", () => {
    expect(parseCommandLine(state, ":filter errors")).toEqual({ type: "toggleErrors" });
    expect(parseCommandLine(state, ":filter errors on")).toEqual({ type: "setFilter", patch: { errorsOnly: true } });
    expect(parseCommandLine(state, ":filter errors off")).toEqual({ type: "setFilter", patch: { errorsOnly: false } });
    expect(parseCommandLine(state, ":filter name /^calc$/i")).toEqual({
      type: "setFilter",
      patch: { name: "/^calc$/i" }
    });
    expect(parseCommandLine(state, ":filter name calc")).toEqual({ error: "usage: :filter name /re/" });
    expect(parseCommandLine(state, ":filter kind nest.*")).toEqual({
      type: "setFilter",
      patch: { kindGlob: "nest.*" }
    });
    expect(parseCommandLine(state, ":filter area checkout")).toEqual({
      type: "setFilter",
      patch: { area: { module: "src/checkout", feature: "checkout", derived: false } }
    });
    expect(parseCommandLine(state, ":filter clear")).toEqual({ type: "clearFilters" });
    expect(parseCommandLine(state, ":filter wat")).toEqual({
      error: "usage: :filter errors [on|off] | name /re/ | kind <glob> | area <x> | clear"
    });
  });

  it(":area looks at feature first, then module; module:/feature: pick the field; several are not guessed", () => {
    expect(parseCommandLine(state, ":area cart")).toEqual({
      error: "area cart matches 2 areas: src/cart · cart, src/pricing · cart"
    });
    expect(parseCommandLine(state, ":area module:src/cart")).toEqual({
      type: "setFilter",
      patch: { area: { module: "src/cart", feature: "cart", derived: false } }
    });
    expect(parseCommandLine(state, ":area feature:checkout")).toEqual({
      type: "setFilter",
      patch: { area: { module: "src/checkout", feature: "checkout", derived: false } }
    });
    // p4 has a location but no area: derived module `src`, shown as `~src`.
    expect(parseCommandLine(state, ":area src")).toEqual({
      type: "setFilter",
      patch: { area: { module: "src", feature: null, derived: true } }
    });
    expect(parseCommandLine(state, ":area /^check/")).toEqual({
      type: "setFilter",
      patch: { area: { module: "src/checkout", feature: "checkout", derived: false } }
    });
    expect(parseCommandLine(state, ":area nope")).toEqual({ error: "no area matches nope" });
  });
});
