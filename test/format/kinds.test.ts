import { describe, expect, it } from "vitest";
import { utf8Bytes } from "../../src/format/bytes.js";
import {
  ATTR_KEY_RE,
  KNOWN_KINDS,
  isKnownKind,
  kindMatchesGlob,
  maskAttrs,
  validateAttrs
} from "../../src/format/kinds.js";
import { MASKED_TEXT } from "../../src/format/value.js";

describe("KNOWN_KINDS (spec 4.13)", () => {
  it("is exactly the v1 table, function first", () => {
    expect(KNOWN_KINDS).toEqual([
      "function",
      "http.server",
      "http.client",
      "express.router",
      "express.middleware",
      "express.handler",
      "express.error-handler",
      "nest.middleware",
      "nest.guard",
      "nest.interceptor",
      "nest.pipe",
      "nest.handler",
      "nest.filter",
      "react.render",
      "react.effect",
      "next.middleware",
      "next.route-handler",
      "next.server-action",
      "next.render"
    ]);
    expect(Object.isFrozen(KNOWN_KINDS)).toBe(true);
  });

  it("recognises only exact names; an unknown kind is simply not special", () => {
    expect(isKnownKind("nest.guard")).toBe(true);
    expect(isKnownKind("Nest.guard")).toBe(false);
    expect(isKnownKind("nest.*")).toBe(false);
    expect(isKnownKind("koa.middleware")).toBe(false);
    expect(isKnownKind("")).toBe(false);
  });
});

describe("ATTR_KEY_RE (spec 4.13)", () => {
  it("accepts OTel names and templated keys", () => {
    for (const key of [
      "a",
      "http.route",
      "http.request.method",
      "http.response.status_code",
      "http.request.header.content-type",
      "react.strict_mode.duplicate",
      "express.mount_path",
      "a.0b"
    ]) {
      expect(ATTR_KEY_RE.test(key), key).toBe(true);
    }
  });

  it("rejects upper case, leading digits or separators, empty segments and non-ASCII", () => {
    for (const key of ["Http.route", "1abc", ".a", "a.", "a..b", "a.-b", "a b", "_a", "__proto__", "é", ""]) {
      expect(ATTR_KEY_RE.test(key), key).toBe(false);
    }
  });
});

describe("validateAttrs (spec 4.13, 4.9)", () => {
  it("absent attrs are no attrs; a non-object is dropped whole", () => {
    expect(validateAttrs(undefined)).toEqual({ dropped: 0, invalidWhole: false });
    for (const raw of [null, [], "x", 5, true]) {
      expect(validateAttrs(raw), JSON.stringify(raw)).toEqual({ dropped: 0, invalidWhole: true });
    }
    expect(validateAttrs({})).toEqual({ dropped: 0, invalidWhole: false });
  });

  it("drops each invalid entry (key, type, size) and keeps the rest in document order", () => {
    const raw = {
      "http.route": "/api/orders/:id",
      BadKey: "x",
      ["k".repeat(129)]: "too long key",
      "a.null": null,
      "a.array": [1],
      "a.object": { x: 1 },
      "a.infinite": Number.POSITIVE_INFINITY,
      "a.long": "я".repeat(256) + "a",
      "a.max": "я".repeat(256),
      "http.response.status_code": 404,
      "react.strict_mode.duplicate": true,
      "text.hostile": "\u009b31m\u202e"
    };
    const result = validateAttrs(raw);
    expect(result.dropped).toBe(7);
    expect(result.invalidWhole).toBe(false);
    expect(Object.keys(result.attrs ?? {})).toEqual([
      "http.route",
      "a.max",
      "http.response.status_code",
      "react.strict_mode.duplicate",
      "text.hostile"
    ]);
    expect(Object.isFrozen(result.attrs)).toBe(true);
  });

  it("accepts at most 32 keys; invalid entries are dropped first and do not use up the 32", () => {
    const raw: Record<string, unknown> = {};
    for (let index = 0; index < 5; index += 1) raw[`bad.${index}`] = null;
    for (let index = 0; index < 33; index += 1) raw[`k.${String(index).padStart(2, "0")}`] = index;
    const result = validateAttrs(raw);
    expect(Object.keys(result.attrs ?? {})).toHaveLength(32);
    expect(result.attrs?.["k.31"]).toBe(31);
    expect(result.attrs?.["k.32"]).toBeUndefined();
    expect(result.dropped).toBe(6);
  });

  it("stops at 8 KiB of serialised object and drops every later entry, even small ones", () => {
    const raw: Record<string, unknown> = {};
    for (let index = 0; index < 20; index += 1) raw[`k.${index}`] = "x".repeat(500);
    raw["k.small"] = 1;
    const result = validateAttrs(raw);
    const kept = Object.keys(result.attrs ?? {});
    expect(utf8Bytes(JSON.stringify(result.attrs))).toBeLessThanOrEqual(8192);
    // 2 + 10 × 508 + 6 × 509 + 15 commas = 8151 B; the 17th entry would make it 8661 B
    expect(kept).toHaveLength(16);
    expect(kept).not.toContain("k.small");
    expect(result.dropped).toBe(21 - 16);
    const withNext = { ...result.attrs, "k.16": "x".repeat(500) };
    expect(utf8Bytes(JSON.stringify(withNext))).toBeGreaterThan(8192);
  });

  it("gives no attrs when every entry is dropped", () => {
    expect(validateAttrs({ Bad: 1, "a.b": null })).toEqual({ dropped: 2, invalidWhole: false });
  });
});

describe("maskAttrs (spec 4.13, 8.3)", () => {
  it("masks by key and by value and keeps the order", () => {
    const masked = maskAttrs({
      "http.request.header.authorization": "Bearer x",
      "http.route": "/a",
      "url.full": "https://x.test/?token=1&q=2",
      "session.id": "abc",
      "http.response.status_code": 200,
      "custom.header": "Basic dXNlcg=="
    });
    expect(masked).toEqual({
      "http.request.header.authorization": MASKED_TEXT,
      "http.route": "/a",
      "url.full": `https://x.test/?token=${MASKED_TEXT}&q=2`,
      "session.id": MASKED_TEXT,
      "http.response.status_code": 200,
      "custom.header": MASKED_TEXT
    });
    expect(Object.keys(masked)[0]).toBe("http.request.header.authorization");
  });
});

describe("kindMatchesGlob (spec 6.6)", () => {
  it("* matches any run of characters, dots included", () => {
    expect(kindMatchesGlob("nest.guard", "nest.*")).toBe(true);
    expect(kindMatchesGlob("nest.pipe", "nest.*")).toBe(true);
    expect(kindMatchesGlob("nest.pipe.custom", "nest.*")).toBe(true);
    expect(kindMatchesGlob("express.middleware", "*.middleware")).toBe(true);
    expect(kindMatchesGlob("next.render", "n*t.*")).toBe(true);
    expect(kindMatchesGlob("anything", "*")).toBe(true);
    expect(kindMatchesGlob("", "*")).toBe(true);
  });

  it("everything else is literal and case-sensitive", () => {
    expect(kindMatchesGlob("express.middleware", "express.middleware")).toBe(true);
    expect(kindMatchesGlob("nestjs.guard", "nest.*")).toBe(false);
    expect(kindMatchesGlob("express.middleware", "nest.*")).toBe(false);
    expect(kindMatchesGlob("nest.guard", "Nest.*")).toBe(false);
    expect(kindMatchesGlob("nest.guard", "nest.")).toBe(false);
    expect(kindMatchesGlob("nest.guard", "")).toBe(false);
    expect(kindMatchesGlob("", "")).toBe(true);
    expect(kindMatchesGlob("a+b", "a+b")).toBe(true);
    expect(kindMatchesGlob("aab", "a.b")).toBe(false);
  });

  it("stays fast on pathological globs", () => {
    const started = Date.now();
    expect(kindMatchesGlob("a".repeat(5000), "a*a*a*a*a*b")).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
