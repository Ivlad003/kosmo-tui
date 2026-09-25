/**
 * JSON container (spec 4.1, 4.9): size checked before reading, strict UTF-8 with an
 * optional BOM, validateDocument, values in memory, unknown top-level fields counted.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../../src/format/validate.js";
import { openJsonFile, parseJsonDocument } from "../../src/readers/json.js";
import { RECIPES, fixtureFile } from "../fixture-recipes.js";
import { dataset, recorded } from "../trace-builder.js";
import { toJsonText } from "../trace-writers.js";
import { bytes, memoryFs, signal } from "./reader-fakes.js";

const basicText = readFileSync(fixtureFile("kosmo-trace/basic"), "utf8");

describe("parseJsonDocument", () => {
  it("opens the basic fixture: dataset info, one trace summary, values in memory", async () => {
    const result = parseJsonDocument(bytes(basicText), { path: "basic.kosmo-trace.json" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const opened = result.dataset;
    expect(opened.kind).toBe("json");
    expect(opened.origin).toEqual({ path: "basic.kosmo-trace.json" });
    expect(opened.info).toEqual({
      id: "ds_basic",
      producer: { name: "kosmo-tui-fixtures", version: "1.0.0" },
      createdAt: "2026-09-24T10:00:00Z",
      title: "checkout bug repro"
    });
    expect(opened.traces.hasMore).toBe(false);
    expect(opened.traces.items.map((item) => [item.id, item.name, item.spans, item.status])).toEqual([
      ["t_cart", "GET /cart", 4, "errored"]
    ]);
    expect(opened.notices).toEqual([]);
    expect(opened.loadMoreTraces).toBeUndefined();
    expect(opened.loadValues).toBeUndefined();
    const loaded = await opened.loadTrace("t_cart", signal());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.model.size).toBe(4);
    const sp3 = loaded.model.get({ trace: "t_cart", session: "s1", id: "sp_3" });
    expect(sp3?.values?.error).toEqual({
      state: "recorded",
      value: { name: "RangeError", message: "discount > 100%" }
    });
    expect(sp3?.values?.return).toEqual({ state: "not-recorded", reason: "threw" });
  });

  it("builds a model once per trace id", async () => {
    const result = parseJsonDocument(bytes(basicText), "stdin");
    if (!result.ok) throw new Error(result.error.message);
    const first = await result.dataset.loadTrace("t_cart", signal());
    const second = await result.dataset.loadTrace("t_cart", signal());
    expect(first.ok && second.ok && first.model === second.model).toBe(true);
  });

  it("an unknown trace id is an error, not a throw", async () => {
    const result = parseJsonDocument(bytes(basicText), "stdin");
    if (!result.ok) throw new Error(result.error.message);
    expect(await result.dataset.loadTrace("t_nope", signal())).toEqual({
      ok: false,
      error: { code: "invalid", message: 'invalid(trace: no trace "t_nope" in this dataset)' }
    });
  });

  it("drops a UTF-8 BOM", () => {
    expect(parseJsonDocument(bytes(`\uFEFF${basicText}`), "stdin").ok).toBe(true);
  });

  it("invalid UTF-8 → invalid($: not valid UTF-8)", () => {
    const broken = new Uint8Array([...bytes('{"format":"kosmo-trace","x":"'), 0xc3, 0x28, ...bytes('"}')]);
    expect(parseJsonDocument(broken, "stdin")).toEqual({
      ok: false,
      error: { code: "invalid", message: "invalid($: not valid UTF-8)", position: "$" }
    });
  });

  it("not JSON → not-a-kosmo-trace, without quoting the input", () => {
    const result = parseJsonDocument(bytes('{"format":"kosmo-trace", \u001b[31m'), "stdin");
    expect(result).toEqual({
      ok: false,
      error: { code: "not-a-kosmo-trace", message: "not-a-kosmo-trace($: not valid JSON)", position: "$" }
    });
  });

  it("validator fatals keep their code and position", () => {
    const doc = { ...RECIPES["kosmo-trace/basic"]!(), version: 2 };
    const result = parseJsonDocument(bytes(JSON.stringify(doc)), "stdin");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unsupported-version");
    expect(result.error.position).toBeDefined();
    expect(result.error.message.startsWith(`unsupported-version(${String(result.error.position)}: `)).toBe(true);
  });

  it("unknown top-level fields become one notice (spec 4.11)", () => {
    const doc = dataset("ds")
      .trace("t")
      .span("a", "x", { args: recorded(1) })
      .field("x-one", 1)
      .field("x-two", 2)
      .build();
    const result = parseJsonDocument(bytes(toJsonText(doc)), "stdin");
    expect(result.ok && result.dataset.notices).toEqual([{ kind: "unknown-fields-ignored", count: 2 }]);
  });
});

describe("openJsonFile", () => {
  it("checks the size before reading anything (spec 4.9: > 64 MiB → too-large)", async () => {
    const fs = memoryFs({ "big.kosmo-trace.json": basicText });
    const result = await openJsonFile("big.kosmo-trace.json", LIMITS.fileBytes + 1, fs);
    expect(result).toEqual({
      ok: false,
      error: { code: "too-large", message: "too-large: big.kosmo-trace.json is larger than 67108864 bytes" }
    });
    expect(fs.calls).toEqual([]);
  });

  it("a file that grew past the limit after stat is too-large as well", async () => {
    const fs = memoryFs({ "grew.json": basicText });
    fs.sizes.set("grew.json", LIMITS.fileBytes + 10);
    const result = await openJsonFile("grew.json", 100, fs);
    expect(result.ok === false && result.error.code).toBe("too-large");
  });

  it("a read failure is read-error with the path", async () => {
    const result = await openJsonFile("gone.json", 10, memoryFs({}));
    expect(result).toEqual({
      ok: false,
      error: { code: "read-error", message: "read-error: gone.json: ENOENT: no such file gone.json" }
    });
  });

  it("reads through the port and keeps the path as origin", async () => {
    const fs = memoryFs({ "a.json": basicText });
    const result = await openJsonFile("a.json", basicText.length, fs);
    expect(result.ok && result.dataset.origin).toEqual({ path: "a.json" });
    expect(fs.calls).toEqual(["readFile a.json"]);
  });
});
