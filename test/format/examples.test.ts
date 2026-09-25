/**
 * Spec 13.1 `examples/`: every committed example trace is valid for both validators, the hand-written
 * one (no fatal, no mark, no degraded value, no unknown field) and the JSON Schema through ajv, the way
 * schema-parity.test.ts checks the fixtures. The storefront trace is also held to its 13.1 / 14.3 role:
 * the two criterion-5 loaders of `storefront-next-template@1a5b952b`.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { spanKey, type SpanRow, type Value } from "../../src/format/types.js";
import { validateDocument } from "../../src/format/validate.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXAMPLES = path.join(root, "examples");
const schema = JSON.parse(readFileSync(path.join(root, "schema", "kosmo-trace-v1.schema.json"), "utf8")) as object;
const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

function exampleFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return exampleFiles(file);
      return entry.name.endsWith(".kosmo-trace.json") ? [file] : [];
    })
    .sort();
}

function spansOf(raw: unknown): SpanRow[] {
  const result = validateDocument(raw);
  if (!result.ok) throw new Error(`${result.code} at ${result.position}: ${result.what}`);
  return result.acc.traceSummaries().flatMap((trace) => [...result.acc.spansOf(trace.id)]);
}

const files = exampleFiles(EXAMPLES);
const relative = (file: string) => path.relative(root, file);

describe("examples/", () => {
  it("finds the demo and the storefront example", () => {
    expect(files.map(relative)).toEqual([
      "examples/demo.kosmo-trace.json",
      "examples/storefront/cart-and-pdp.kosmo-trace.json"
    ]);
  });

  it.each(files.map((file) => [relative(file), file]))("%s passes the hand validator and the schema", (_, file) => {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    const result = validateDocument(raw);
    if (!result.ok) throw new Error(`${result.code} at ${result.position}: ${result.what}`);
    expect(result.unknownFields).toBe(0);
    for (const span of spansOf(raw)) {
      expect(span.marks, span.ref.id).toEqual([]);
      expect(span.droppedAttrs, span.ref.id).toBe(0);
      const values: Value[] =
        span.values === undefined ? [] : [span.values.args, span.values.return, span.values.error];
      for (const value of values) expect(["recorded", "not-recorded"], span.ref.id).toContain(value.state);
    }
    expect(validateSchema(raw), JSON.stringify(validateSchema.errors)).toBe(true);
  });
});

describe("examples/storefront/cart-and-pdp.kosmo-trace.json (spec 13.1, 14.3)", () => {
  const file = path.join(EXAMPLES, "storefront", "cart-and-pdp.kosmo-trace.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as { links: { from: SpanRow["ref"]; to: SpanRow["ref"] }[] };
  const spans = spansOf(raw);

  it("points at the two criterion-5 loaders", () => {
    const loaders = spans.filter((span) => span.name === "loader").map((span) => span.location);
    expect(loaders).toEqual([
      { file: "src/routes/_app.cart.tsx", line: 116 },
      { file: "src/routes/_app.product.$productId.tsx", line: 137 }
    ]);
  });

  it("has several sessions, a cross-session parent and links whose ends all exist", () => {
    expect(new Set(spans.map((span) => `${span.ref.trace}/${span.ref.session}`)).size).toBeGreaterThan(2);
    expect(spans.some((span) => span.parentSession !== undefined)).toBe(true);
    const keys = new Set(spans.map((span) => spanKey(span.ref)));
    expect(raw.links.length).toBeGreaterThan(0);
    for (const link of raw.links) {
      expect(keys.has(spanKey(link.from)), JSON.stringify(link.from)).toBe(true);
      expect(keys.has(spanKey(link.to)), JSON.stringify(link.to)).toBe(true);
    }
  });

  it("holds nothing the masking would hide: no credential-like value to leak", () => {
    const text = readFileSync(file, "utf8");
    expect(text).not.toMatch(/Bearer|Basic |eyJ|password|secret|token|cookie|authorization/i);
  });
});
