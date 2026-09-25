import { describe, expect, it } from "vitest";
import type { TraceSummary } from "../../src/format/types.js";
import { OUTPUT_BYTE_CAP } from "../../src/output/kosmo-text.js";
import { escapeTabCell, renderSpansTab, renderTraceListTab } from "../../src/output/tab.js";
import { model, span, utf8 } from "./helpers.js";

const summary = (id: string, extra: Partial<TraceSummary> = {}): TraceSummary => ({
  id,
  name: `trace ${id}`,
  spans: 3,
  status: "complete",
  requests: null,
  ...extra
});

describe("--format tab (spec 7.1)", () => {
  it("trace list: id, name, spans, status; null is -", () => {
    expect(renderTraceListTab([summary("t1"), summary("t2", { name: null, spans: null, status: null })])).toBe(
      "t1\ttrace t1\t3\tcomplete\nt2\t-\t-\t-\n"
    );
  });

  it("escapes tab, newline, backslash and control/bidi characters in cells", () => {
    expect(escapeTabCell("a\tb\nc\\d\u001b[2J\u009b\u202e\u007f")).toBe(
      "a\\u0009b\\u000ac\\u005cd\\u001b[2J\\u009b\\u202e\\u007f"
    );
    const out = renderTraceListTab([summary("t\t1", { name: "line\nbreak" })]);
    expect(out).toBe("t\\u00091\tline\\u000abreak\t3\tcomplete\n");
    expect(out.split("\n")[0]!.split("\t")).toHaveLength(4);
  });

  it("spans: session, id, parent, status, kind, file:line, name in DFS order", () => {
    const out = renderSpansTab(
      model([
        span("b", "root", 2, { kind: "express.handler", location: { file: "src/b.ts", line: 9 } }),
        span("root", null, 0, { kind: "http.server", name: "GET /cart" }),
        span("a", "root", 1, { status: "errored", marks: ["invalid-location"] }),
        span("x", "root", 0, { session: "s2", parentSession: "s1" })
      ])
    );
    expect(out).toBe(
      [
        "s1\troot\t-\tcomplete\thttp.server\t-\tGET /cart",
        "s1\ta\troot\terrored\tfunction\t(invalid-location)\ta",
        "s1\tb\troot\tcomplete\texpress.handler\tsrc/b.ts:9\tb",
        "s2\tx\troot\tcomplete\tfunction\t-\tx",
        ""
      ].join("\n")
    );
  });

  it("caps the list at 51 200 B, trailer included, dropping whole rows", () => {
    const items = Array.from({ length: 5_000 }, (_, i) => summary(`t${String(i).padStart(5, "0")}`));
    const out = renderTraceListTab(items);
    expect(utf8(out)).toBeLessThanOrEqual(OUTPUT_BYTE_CAP);
    const rows = out.split("\n").slice(0, -1);
    const match = /^… truncated: output-byte-cap \(shown (\d+) of 5000 traces\)$/.exec(rows.at(-1)!);
    expect(match).not.toBeNull();
    expect(rows).toHaveLength(Number(match![1]) + 1);
    for (const row of rows.slice(0, -1)) expect(row.split("\t")).toHaveLength(4);
  });

  it("caps the span rows the same way", () => {
    const spans = Array.from({ length: 3_000 }, (_, i) => span(`span-${i}-${"y".repeat(20)}`, null, i));
    const out = renderSpansTab(model(spans));
    expect(utf8(out)).toBeLessThanOrEqual(OUTPUT_BYTE_CAP);
    expect(out).toMatch(/… truncated: output-byte-cap \(shown \d+ of 3000 spans\)\n$/);
  });
});
