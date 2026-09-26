import { describe, expect, it } from "vitest";
import { isCaptureName, parameterNames } from "../../src/code/params.js";
import { bodyAnchor, siteCondition, type Registration } from "../../src/debug/sites.js";
import {
  SiteRegistry,
  anchorInOther,
  originalAnchor,
  trustedAnchor,
  type CdpSetter,
  type LogicalPoint
} from "../../src/debug/points.js";
import { formatScope } from "../../src/debug/scopes.js";
import { SourceMapConsumer, decodeDataUrl, parseSourceMap } from "../../src/debug/sourcemap.js";
import { normalizeSource, sourcesMatch } from "../../src/debug/normalize.js";
import { isLoopbackHost, loopbackWebSocketUrl, toLoopbackIp } from "../../src/debug/loopback.js";
import {
  frameworkLabel,
  isNodeProcess,
  probeOrder,
  supervisorReason,
  type ProcessInfo
} from "../../src/debug/discover.js";
import { nodeHelperSource } from "../../src/debug/helper.js";
import { serializeLive } from "../../src/debug/capture-core.js";

const node = (over: Partial<ProcessInfo> = {}): ProcessInfo => ({
  pid: 1,
  ppid: 0,
  uid: 1,
  command: "node app.js",
  argv: ["node", "app.js"],
  ucomm: "node",
  exeBase: "node",
  ...over
});

describe("stage 2 discovery", () => {
  it("treats ucomm node as node and --watch as a supervisor", () => {
    expect(isNodeProcess(node())).toBe(true);
    expect(isNodeProcess(node({ ucomm: "next-server (v16", exeBase: null }))).toBe(false);
    expect(supervisorReason(node({ argv: ["node", "--watch", "app.js"] }))).toBe("node --watch");
    expect(supervisorReason(node({ argv: ["node", "server.js"] }))).toBeNull();
  });

  it("labels next-server and probes inspector ports first", () => {
    expect(frameworkLabel(node({ command: "next-server (v16.3.6)", argv: ["next-server"] }))).toContain(
      "next-server v16.3.6"
    );
    expect(probeOrder([3000, 9230, 9229], [9231])).toEqual([9230, 9229, 3000]);
  });
});

describe("stage 2 maps and capture", () => {
  it("decodes a one-segment source map", () => {
    const consumer = new SourceMapConsumer({ version: 3, sources: ["a.ts"], names: [], mappings: "AAAA" });
    expect(consumer.originalPositionFor(0, 0)?.source).toBe("a.ts");
    expect(consumer.allGeneratedPositionsFor("a.ts", 0).length).toBe(1);
  });

  it("normalizes webpack and turbopack sources", () => {
    expect(normalizeSource("webpack-internal:///(rsc)/./src/cart.ts", null).relative).toBe("src/cart.ts");
    expect(normalizeSource("turbopack:///[project]/src/cart.ts", null).relative).toBe("src/cart.ts");
    expect(normalizeSource("turbopack:///[turbopack]/runtime.js", null).ignored).toBe(true);
    expect(sourcesMatch("src/cart.ts", normalizeSource("src/cart.ts", null), "/work", false)).toBe(true);
  });

  it("reads parameter names and refuses a capture name that is not an identifier", () => {
    expect(parameterNames("function calculateLineTotal(item, qty) {\n  return item;\n}", 1)).toEqual(["item", "qty"]);
    expect(() =>
      siteCondition("a".repeat(32), "ab", [{ id: 1, kind: "tp", names: ["item;"], sameCase: false, capPlus50: 150 }])
    ).toThrow(/refusing/);
  });

  it("builds a helper whose only interpolated secret is a hex nonce", () => {
    const source = nodeHelperSource("ab".repeat(16));
    expect(source).toContain('const nonce = "abababababababababababababababab"');
    expect(source).toContain("sourceURL=kosmo-tui://helper");
    expect(serializeLive({ password: "x" })).toEqual({ password: { $type: "masked" } });
  });
});

describe("stage 2 review regressions", () => {
  it("reads destructured, typed and decorated parameters without hanging", () => {
    expect(parameterNames("function f({ a, b }) {\n}", 1)).toEqual(["a", "b"]);
    expect(parameterNames("const h = ({ params: { id } }) => {\n}", 1)).toEqual(["id"]);
    expect(parameterNames("const h = ([a, b]) => a", 1)).toEqual(["a", "b"]);
    expect(parameterNames("export const Cart = ({ items, onRemove }: Props) => {\n  return null;\n}", 1)).toEqual([
      "items",
      "onRemove"
    ]);
    expect(parameterNames("const f = <T,>(x: T, cb: (v: T) => void): Promise<void> => {\n}", 1)).toEqual(["x", "cb"]);
    expect(
      parameterNames("class A {\n  constructor(private readonly repo: Repo, @Param('id') id: string) {}\n}", 2)
    ).toEqual(["repo", "id"]);
    expect(parameterNames("function f(\n  a,\n  b\n) {\n}", 1)).toEqual(["a", "b"]);
  });

  it("picks the header at the line, not an earlier function or a control statement", () => {
    expect(parameterNames("function a(x) {}\n\nconst b = (y) => {\n}", 3)).toEqual(["y"]);
    expect(parameterNames("if (cond) {\n}", 1)).toEqual([]);
    expect(parameterNames("items.map((item) => {\n  return item;\n});", 2)).toEqual(["item"]);
    expect(isCaptureName("__proto__")).toBe(false);
  });

  it("stays linear on pathological input", () => {
    const started = Date.now();
    parameterNames("a(b) : c ".repeat(8000), 1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("accepts only loopback IP literals", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.evil.com")).toBe(false);
    expect(isLoopbackHost("localhost")).toBe(false);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
    expect(toLoopbackIp("localhost")).toBe("127.0.0.1");
    expect(toLoopbackIp("127.evil.com")).toBeNull();
    expect(loopbackWebSocketUrl("127.evil.com", 9229, "ws://127.0.0.1:9229/abc")).toBeNull();
  });

  it("anchors the body after the parameter list", () => {
    expect(bodyAnchor("function f({a, b}) { return a; }", 1)).toEqual({ line: 1, column: 21 });
    expect(bodyAnchor("function f(\n  a,\n  b\n) {\n  return a;\n}", 1)).toEqual({ line: 5, column: 2 });
    expect(bodyAnchor("const g = (cb: (x: number) => void) => {\n  cb(1);\n}", 1, 3)).toEqual({ line: 2, column: 2 });
    expect(bodyAnchor("const h = (x) => x + 1", 1)).toEqual({ line: 1, column: 17 });
  });

  it("serializes shared references, invalid dates, tags and accessors per spec 4.2 without running getters", () => {
    const shared = { z: 1 };
    expect(serializeLive({ a: shared, b: shared })).toEqual({ a: { z: 1 }, b: { z: 1 } });
    const cyclic: { self?: unknown; a: { back?: unknown } } = { a: {} };
    cyclic.self = cyclic;
    cyclic.a.back = cyclic;
    expect(serializeLive(cyclic)).toEqual({
      a: { back: { $type: "cycle", path: "$" } },
      self: { $type: "cycle", path: "$" }
    });
    expect(serializeLive(new Date(NaN))).toEqual({ $type: "date", value: "Invalid Date" });
    expect(serializeLive({ $type: "masked", x: 1 })).toEqual({ $type: "object", entries: { $type: "masked", x: 1 } });
    expect(serializeLive(new Map([[1, 2]]))).toEqual({ $type: "map", entries: [[1, 2]] });
    expect(serializeLive(new Set([1]))).toEqual({ $type: "set", values: [1] });
    expect(serializeLive([1, , 3])).toEqual([1, { $type: "hole" }, 3]);
    expect(serializeLive(new Uint8Array(3))).toEqual({ $type: "class", name: "Uint8Array", value: { length: 3 } });
    const ran: string[] = [];
    const spy = {
      get $$typeof() {
        ran.push("$$typeof");
        return Symbol.for("react.element");
      },
      get nativeEvent() {
        ran.push("nativeEvent");
        return {};
      }
    };
    expect(serializeLive(spy)).toEqual({
      $$typeof: { $type: "accessor", get: true, set: false },
      nativeEvent: { $type: "accessor", get: true, set: false }
    });
    expect(ran).toEqual([]);
    expect(serializeLive("a=1; sid=abc; token=xyz")).toBe("a=1; sid=masked; token=masked");
  });

  it("never throws on malformed sources or maps", () => {
    expect(normalizeSource("file:///a%zz/b.ts", null).ignored).toBe(true);
    expect(normalizeSource("webpack-internal:///./src/pages/index.tsx", null).relative).toBe("src/pages/index.tsx");
    expect(normalizeSource("webpack:///./src/x.ts", null).relative).toBe("src/x.ts");
    expect(normalizeSource("turbopack://[project]/src/a.ts", null).relative).toBe("src/a.ts");
    expect(normalizeSource("../b.ts", "webpack-internal:///(rsc)/./src/a.ts").relative).toBe("b.ts");
    const broken = new SourceMapConsumer({ version: 3, mappings: 123 as unknown as string, sources: ["a"] });
    expect(broken.all()).toEqual([]);
    const sections = new SourceMapConsumer({
      version: 3,
      sections: [
        { offset: { line: 1, column: 0 }, url: "x.map" },
        { offset: { line: 2, column: 3 }, map: { version: 3, sources: ["b.ts"], mappings: "AAAA" } }
      ]
    });
    expect(sections.originalPositionFor(2, 3)?.source).toBe("b.ts");
    expect(parseSourceMap("{")).toBeNull();
    expect(decodeDataUrl("data:application/json,%zz")).toBeNull();
  });

  it("finds positions by binary search on multi-line maps", () => {
    // line 0: col 0 → a.ts 0:0; col 1 → a.ts 1:1;  line 2: col 2 → a.ts 3:3
    const consumer = new SourceMapConsumer({ version: 3, sources: ["a.ts"], names: [], mappings: "AAAA,CACC;;EACC" });
    expect(consumer.originalPositionFor(0, 5)).toMatchObject({ column: 1, sourceLine: 1, sourceColumn: 1 });
    expect(consumer.originalPositionFor(2, 2)).toMatchObject({ sourceLine: 2, sourceColumn: 2 });
    expect(consumer.originalPositionFor(1, 0)).toBeNull();
    expect(consumer.allGeneratedPositionsFor("a.ts", 1).map((pos) => pos.column)).toEqual([1]);
  });
});

describe("site registry", () => {
  /** A setter with V8's rule: one breakpoint per location, and every call takes a tick. */
  function fakeV8(): { setter: CdpSetter; live: Map<string, string>; calls: string[] } {
    const live = new Map<string, string>(); // location → breakpointId
    const conditions = new Map<string, string>();
    const calls: string[] = [];
    let next = 1;
    const setter: CdpSetter = {
      async set(selector, line, column, condition) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const location = `${selector.scriptHash}:${line}:${column}`;
        if (live.has(location)) throw new Error("Breakpoint at specified location already exists.");
        const id = `bp${next++}`;
        live.set(location, id);
        conditions.set(id, condition);
        calls.push(`set ${id}`);
        return id;
      },
      async remove(breakpointId) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        for (const [location, id] of live) if (id === breakpointId) live.delete(location);
        calls.push(`remove ${breakpointId}`);
      }
    };
    return { setter, live, calls };
  }

  it("serializes concurrent registrations at one location into one shared breakpoint", async () => {
    const v8 = fakeV8();
    const sites = new SiteRegistry("a".repeat(32), v8.setter);
    const reg = (id: number, kind: "tp" | "bp"): Registration => ({
      id,
      kind,
      names: ["x"],
      sameCase: false,
      capPlus50: 150
    });
    await Promise.all([
      sites.add(undefined, { scriptHash: "h" }, 3, 2, reg(1, "tp")),
      sites.add(undefined, { scriptHash: "h" }, 3, 2, reg(2, "bp"))
    ]);
    expect(v8.live.size).toBe(1);
    const id = [...v8.live.values()][0]!;
    expect(sites.breakpointIds().has(id)).toBe(true);
    expect(sites.countFor(1)).toBe(1);
    expect(sites.countFor(2)).toBe(1);
    expect(sites.hasBreakpoints()).toBe(true);
    await sites.remove(2);
    expect(sites.hasBreakpoints()).toBe(false);
    expect(v8.live.size).toBe(1);
    await sites.remove(1);
    expect(v8.live.size).toBe(0);
    // Replaced ids stay attributable until a resume says the old pause cannot come any more.
    sites.forgetRetired();
    expect(sites.breakpointIds().size).toBe(0);
  });

  it("keeps a replaced breakpoint id attributable until the next resume", async () => {
    const v8 = fakeV8();
    const sites = new SiteRegistry("a".repeat(32), v8.setter);
    const reg = (id: number): Registration => ({ id, kind: "tp", names: [], sameCase: false, capPlus50: 150 });
    await sites.add(undefined, { scriptHash: "h" }, 1, 0, reg(1));
    const first = [...v8.live.values()][0]!;
    const adding = sites.add(undefined, { scriptHash: "h" }, 1, 0, reg(2));
    await new Promise((resolve) => setTimeout(resolve, 1));
    // The remove of `first` is in flight: a pause reporting it is still ours.
    expect(sites.breakpointIds().has(first)).toBe(true);
    await adding;
    expect(sites.breakpointIds().has(first)).toBe(true);
    sites.forgetRetired();
    expect(sites.breakpointIds().has(first)).toBe(false);
  });

  it("anchors a statement line at its own first token, a header after its opener", () => {
    const text =
      "function sum(items) {\n  let total = 0;\n  for (const item of items) {\n    total += item;\n  }\n  return total;\n}\n";
    const point = (line: number): LogicalPoint => ({
      id: 1,
      kind: "tp",
      absolute: "/w/a.js",
      relative: "a.js",
      root: "/w",
      line,
      names: [],
      sameCase: false,
      cap: 100,
      runtime: "node"
    });
    // Header: the first statement of the body, never the header itself (spec 9.5 step 2).
    expect(originalAnchor(point(1), text)).toEqual({ line: 2, column: 2 });
    expect(originalAnchor(point(2), text)).toEqual({ line: 2, column: 2 });
    expect(originalAnchor(point(4), text)).toEqual({ line: 4, column: 4 });
    expect(originalAnchor(point(2), null)).toEqual({ line: 2, column: 0 });
  });
});

describe("map trust and scopes", () => {
  const base = "import x from 'y';\n\nexport function f(a) {\n  return a + 1;\n}\nexport const g = () => 2;\n";

  it("finds the disk line again in sourcesContent when lines were inserted or reformatted", () => {
    expect(anchorInOther(base, base, 3)).toEqual({ line: 3, moved: false });
    const shifted = `// header\n// more\n${base}`;
    expect(anchorInOther(base, shifted, 3)).toEqual({ line: 5, moved: true });
    const reformatted = base.replace("f(a) {", "f( a )   {").replace("'y'", '"y"');
    expect(anchorInOther(base, reformatted, 3)).toEqual({ line: 3, moved: false });
    // A blank line cannot be found again; a line that is gone fails honestly.
    expect(anchorInOther(base, shifted, 2)).toEqual({ failed: "map-mismatch" });
    expect(anchorInOther(base, shifted.replace("return a + 1;", "return a;"), 4)).toEqual({ failed: "map-mismatch" });
  });

  it("uses neighbours to pick one of several identical lines", () => {
    const disk = "a();\nreturn 1;\nb();\nreturn 1;\nc();\n";
    const other = "// x\na();\nreturn 1;\nb();\nreturn 1;\nc();\n";
    expect(anchorInOther(disk, other, 4)).toEqual({ line: 5, moved: true });
    expect(anchorInOther(disk, other, 2)).toEqual({ line: 3, moved: true });
    // Two candidates and neighbours that agree with neither: no guess.
    expect(anchorInOther("x;\nreturn 1;\n", "y;\nreturn 1;\nz;\nreturn 1;\n", 2)).toEqual({ failed: "map-mismatch" });
  });

  it("re-anchors through the trace snippet when the map has no sourcesContent", () => {
    const point: LogicalPoint = {
      id: 1,
      kind: "tp",
      absolute: "/w/a.ts",
      relative: "a.ts",
      root: "/w",
      line: 3,
      endLine: 5,
      snippet: "export function f(a) {",
      names: [],
      sameCase: false,
      cap: 100,
      runtime: "node"
    };
    const disk = `// added\n// added\n${base}`;
    const trusted = trustedAnchor(point, disk, null);
    expect(trusted).toMatchObject({ line: 5, endLine: 7, notes: ["re-anchored"] });
    expect(trustedAnchor(point, base, null)).toMatchObject({ line: 3, endLine: 5, notes: [] });
    // Disk line 3 is the `import` that sits on map line 1: the point follows the text, not the number.
    expect(trustedAnchor(point, disk, base)).toMatchObject({
      line: 1,
      endLine: 3,
      notes: ["map-untrusted", "re-anchored"]
    });
    expect(trustedAnchor(point, base, base)).toMatchObject({ line: 3, notes: [] });
  });

  it("formats scope properties with masking and without touching getters", () => {
    expect(
      formatScope("local", [
        { name: "n", value: { type: "number", value: 1, description: "1" } },
        { name: "password", value: { type: "string", value: "x" } },
        { name: "url", value: { type: "string", value: "/a?token=abc&b=2" } },
        { name: "lazy", get: { type: "function" } },
        {
          name: "item",
          value: {
            type: "object",
            className: "Object",
            preview: {
              properties: [
                { name: "qty", type: "number", value: "2" },
                { name: "apiKey", type: "string", value: "k" }
              ]
            }
          }
        },
        {
          name: "list",
          value: {
            type: "object",
            subtype: "array",
            className: "Array",
            preview: { overflow: true, properties: [{ name: "0", type: "number", value: "1" }] }
          }
        },
        { name: "cb", value: { type: "function", description: "function handler(a) { }" } }
      ])
    ).toEqual([
      "local:",
      "  n = 1",
      "  password = masked",
      '  url = "/a?token=masked&b=2"',
      "  lazy = accessor(get: true, set: false)",
      "  item = {qty: 2, apiKey: masked}",
      "  list = [1, …]",
      "  cb = ƒ handler"
    ]);
  });
});
