/**
 * Spec 4.10: the JSON Schema is documentation for producers; the viewer validates with its
 * own code. This test keeps the two in step:
 *  - every valid fixture and every NDJSON line made from it passes both validators;
 *  - "schema-expressible" hostile cases are rejected by the schema AND rejected or marked
 *    by the validator;
 *  - "validator-only" cases pass the schema and are rejected or marked by the validator;
 *  - "both-accept" cases pass both (the schema is never stricter on soft fields).
 * "Усе, що відкидає схема, ручний валідатор теж відкидає або позначає."
 */
import { readFileSync, readdirSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { ATTR_KEY_RE, KNOWN_KINDS } from "../../src/format/kinds.js";
import type { SpanRow, Value } from "../../src/format/types.js";
import {
  validateDocument,
  validateHeader,
  validateLink,
  validateSpan,
  validateTraceDecl
} from "../../src/format/validate.js";
import { FIXTURE_NAMES, fixtureFile } from "../fixture-recipes.js";
import { toNdjsonLines } from "../trace-writers.js";
import type { RawDocument } from "../trace-builder.js";

type SchemaJson = {
  $id: string;
  $defs: {
    span: { properties: { kind: { examples: string[] } } };
    attrs: { propertyNames: { pattern: string } };
  };
};

const schema = JSON.parse(
  readFileSync(new URL("../../schema/kosmo-trace-v1.schema.json", import.meta.url), "utf8")
) as SchemaJson;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);

function lineSchema(type: string) {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${type}`);
  if (validate === undefined) throw new Error(`schema has no $defs/${type}`);
  return validate;
}

type Verdict =
  { kind: "fatal"; code: string } | { kind: "degraded"; marks: string[]; values: string[] } | { kind: "ok" };

function valueStates(span: SpanRow): string[] {
  const values: Value[] = span.values === undefined ? [] : [span.values.args, span.values.return, span.values.error];
  return values.map((value) => value.state).filter((state) => state === "invalid-value" || state === "unknown-state");
}

function verdict(raw: unknown): Verdict {
  const result = validateDocument(raw);
  if (!result.ok) return { kind: "fatal", code: result.code };
  const marks: string[] = [];
  const values: string[] = [];
  for (const trace of result.acc.traceSummaries()) {
    for (const span of result.acc.spansOf(trace.id)) {
      marks.push(...span.marks);
      if (span.droppedAttrs > 0) marks.push("invalid-attrs");
      values.push(...valueStates(span));
    }
  }
  return marks.length > 0 || values.length > 0 ? { kind: "degraded", marks, values } : { kind: "ok" };
}

function readJson(url: URL | string): unknown {
  return JSON.parse(readFileSync(url, "utf8"));
}

type HostileCase = {
  file: string;
  parity: "schema-expressible" | "validator-only" | "both-accept";
  validator: "fatal" | "degraded" | "ok";
  code?: string;
  mark?: string;
  value?: string;
  why: string;
};

const hostileDir = new URL("../fixtures/hostile/", import.meta.url);
const manifest = readJson(new URL("manifest.json", hostileDir)) as { cases: HostileCase[] };

describe("schema parity (spec 4.10)", () => {
  it("the schema compiles in ajv strict mode and documents the known kinds and the attrs key pattern", () => {
    expect([...schema.$defs.span.properties.kind.examples].sort()).toEqual([...KNOWN_KINDS].sort());
    expect(schema.$defs.attrs.propertyNames.pattern).toBe(ATTR_KEY_RE.source);
  });

  const valid = FIXTURE_NAMES.filter((name) => name !== "frameworks/attrs-hostile");

  it.each(valid)("valid fixture %s passes both validators without marks", (name) => {
    const doc = readJson(fixtureFile(name));
    expect(validateSchema(doc), JSON.stringify(validateSchema.errors)).toBe(true);
    expect(verdict(doc)).toEqual({ kind: "ok" });
  });

  it.each(valid)("every NDJSON line of %s passes its $defs schema and its line validator", (name) => {
    const doc = readJson(fixtureFile(name)) as RawDocument;
    toNdjsonLines(doc).forEach((text, index) => {
      const line = JSON.parse(text) as { type: string } & Record<string, unknown>;
      const check = lineSchema(line.type);
      expect(check(line), `${name} line ${index + 1}: ${JSON.stringify(check.errors)}`).toBe(true);
      const { type, ...rest } = line;
      const position = `line ${index + 1}`;
      const result =
        type === "header"
          ? validateHeader(rest, position)
          : type === "trace"
            ? validateTraceDecl(rest, position)
            : type === "span"
              ? validateSpan(rest, position)
              : validateLink(rest, position);
      expect(result.ok, `${name} line ${index + 1}`).toBe(true);
    });
  });

  it("attrs-hostile is schema-expressible: the schema rejects it, the validator keeps the spans and marks invalid-attrs", () => {
    const doc = readJson(fixtureFile("frameworks/attrs-hostile"));
    expect(validateSchema(doc)).toBe(false);
    const result = verdict(doc);
    expect(result.kind).toBe("degraded");
    expect(result.kind === "degraded" && result.marks).toContain("invalid-attrs");
  });

  it("the manifest lists every hostile file exactly once", () => {
    const files = readdirSync(hostileDir)
      .filter((file) => file !== "manifest.json")
      .sort();
    expect(manifest.cases.map((entry) => entry.file).sort()).toEqual(files);
  });

  it.each(manifest.cases)("hostile $file ($parity): $why", (entry) => {
    const doc = readJson(new URL(entry.file, hostileDir));
    const schemaAccepts = validateSchema(doc);
    expect(schemaAccepts, JSON.stringify(validateSchema.errors)).toBe(entry.parity !== "schema-expressible");
    const result = verdict(doc);
    expect(result.kind).toBe(entry.validator);
    if (entry.parity !== "both-accept") expect(result.kind).not.toBe("ok");
    if (result.kind === "fatal") expect(result.code).toBe(entry.code);
    if (result.kind === "degraded" && entry.mark !== undefined) expect(result.marks).toContain(entry.mark);
    if (result.kind === "degraded" && entry.value !== undefined) expect(result.values).toContain(entry.value);
  });
});
