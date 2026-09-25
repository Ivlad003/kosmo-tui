import { describe, expect, it } from "vitest";
import { utf8Bytes } from "../../src/format/bytes.js";
import { NOT_RECORDED, type Json, type Value } from "../../src/format/types.js";
import {
  MASKED_TEXT,
  VALUE_MAX_BYTES,
  VALUE_MAX_DEPTH,
  capValue,
  compactJson,
  isMaskedKey,
  keyWords,
  maskString,
  maskValue,
  parseValue,
  tagOf
} from "../../src/format/value.js";

const AT = "$.spans[0].args";

function nest(levels: number): Json {
  let node: Json = 1;
  for (let level = 0; level < levels; level += 1) node = [node];
  return node;
}

/** Every tag allowed in a recorded value (spec 4.2), each in its exact shape. */
const RECORDED_TAGS: Json = [
  { $type: "undefined" },
  { $type: "number", value: "NaN" },
  { $type: "number", value: "-0" },
  { $type: "bigint", value: "-12345678901234567890" },
  { $type: "function", name: "f" },
  { $type: "symbol", description: "x" },
  { $type: "date", value: "2026-09-24T10:00:00.000Z" },
  { $type: "map", entries: [["k", { $type: "undefined" }]] },
  { $type: "set", values: [1, 2] },
  { $type: "class", name: "RangeError", value: { name: "RangeError", message: "discount > 100%" } },
  { $type: "accessor", get: true, set: false },
  { $type: "hole" },
  { $type: "cycle", path: "$.a.b" },
  { $type: "masked" },
  { $type: "object", entries: { $type: "user-field", nested: { $type: "undefined" } } }
];

describe("parseValue: states (spec 4.2, 4.11)", () => {
  it("an absent field is not-recorded; null inside value is a real null", () => {
    expect(parseValue(undefined, AT)).toBe(NOT_RECORDED);
    expect(parseValue({ state: "recorded", value: null }, AT)).toEqual({ state: "recorded", value: null });
  });

  it("keeps reasons of truncated, masked and not-recorded and ignores unknown fields", () => {
    expect(parseValue({ state: "truncated", value: [1], reason: "depth", extra: 1 }, AT)).toEqual({
      state: "truncated",
      value: [1],
      reason: "depth"
    });
    expect(parseValue({ state: "masked" }, AT)).toEqual({ state: "masked" });
    expect(parseValue({ state: "masked", reason: "policy" }, AT)).toEqual({ state: "masked", reason: "policy" });
    expect(parseValue({ state: "not-recorded", reason: "threw" }, AT)).toEqual({
      state: "not-recorded",
      reason: "threw"
    });
    expect(parseValue({ state: "recorded", value: 1, reason: "ignored" }, AT)).toEqual({ state: "recorded", value: 1 });
  });

  it("a wrong shape becomes invalid-value with the position of the problem", () => {
    expect(parseValue("x", AT)).toEqual({
      state: "invalid-value",
      position: AT,
      what: "must be an object with a state"
    });
    expect(parseValue(null, AT)).toEqual({
      state: "invalid-value",
      position: AT,
      what: "must be an object with a state"
    });
    expect(parseValue([], AT)).toEqual({
      state: "invalid-value",
      position: AT,
      what: "must be an object with a state"
    });
    expect(parseValue({ state: 1 }, AT)).toEqual({
      state: "invalid-value",
      position: `${AT}.state`,
      what: "must be a string"
    });
    expect(parseValue({ state: "recorded" }, AT)).toEqual({
      state: "invalid-value",
      position: `${AT}.value`,
      what: "is required"
    });
    expect(parseValue({ state: "masked", reason: 5 }, AT)).toEqual({
      state: "invalid-value",
      position: `${AT}.reason`,
      what: "must be a string"
    });
  });

  it("live never comes from a file (it is the debugger's state)", () => {
    expect(parseValue({ state: "live", value: 1 }, AT)).toEqual({
      state: "invalid-value",
      position: `${AT}.state`,
      what: "live values never come from a file"
    });
  });

  it("an unknown state string is unknown-state with the raw value (4.11)", () => {
    expect(parseValue({ state: "partial", value: 1 }, AT)).toEqual({ state: "unknown-state", raw: "partial" });
    expect(parseValue({ state: "invalid-value" }, AT)).toEqual({ state: "unknown-state", raw: "invalid-value" });
  });
});

describe("parseValue: tags (spec 4.2, 4.9)", () => {
  it("accepts every recorded tag in its exact shape and keeps the JSON as is", () => {
    const parsed = parseValue({ state: "recorded", value: RECORDED_TAGS }, AT);
    expect(parsed).toEqual({ state: "recorded", value: RECORDED_TAGS });
  });

  it("rejects deeper, more, string-cut and object.more in recorded but accepts them in truncated", () => {
    const cases: [Json, string, string][] = [
      [[{ $type: "deeper" }], `${AT}.value[0]`, "tag deeper is not allowed in a recorded value"],
      [[1, { $type: "more", count: 3 }], `${AT}.value[1]`, "tag more is not allowed in a recorded value"],
      [
        { $type: "string-cut", value: "ab", length: 10 },
        `${AT}.value`,
        "tag string-cut is not allowed in a recorded value"
      ],
      [{ $type: "object", entries: {}, more: 2 }, `${AT}.value.more`, "more is not allowed in a recorded value"]
    ];
    for (const [value, position, what] of cases) {
      expect(parseValue({ state: "recorded", value }, AT)).toEqual({ state: "invalid-value", position, what });
      expect(parseValue({ state: "truncated", value }, AT)).toEqual({ state: "truncated", value });
    }
  });

  it("unavailable is live-only: in a file it is invalid-value in every state", () => {
    for (const state of ["recorded", "truncated"]) {
      expect(parseValue({ state, value: { $type: "unavailable", reason: "TDZ" } }, AT)).toEqual({
        state: "invalid-value",
        position: `${AT}.value`,
        what: "tag unavailable is only allowed in live values"
      });
    }
  });

  it("more is only the last element of an array, map.entries or set.values", () => {
    const more = { $type: "more", count: 5 };
    expect(parseValue({ state: "truncated", value: [more, 1] }, AT)).toEqual({
      state: "invalid-value",
      position: `${AT}.value[0]`,
      what: "tag more must be the last element of an array, map or set"
    });
    expect(parseValue({ state: "truncated", value: { a: more } }, AT)).toMatchObject({ state: "invalid-value" });
    expect(parseValue({ state: "truncated", value: more }, AT)).toMatchObject({ state: "invalid-value" });
    const map = { $type: "map", entries: [["a", 1], more] };
    const set = { $type: "set", values: [1, more] };
    expect(parseValue({ state: "truncated", value: [map, set] }, AT)).toEqual({
      state: "truncated",
      value: [map, set]
    });
    expect(parseValue({ state: "truncated", value: { $type: "map", entries: [more, ["a", 1]] } }, AT)).toEqual({
      state: "invalid-value",
      position: `${AT}.value.entries[0]`,
      what: "must be a [key, value] pair"
    });
  });

  it("a known tag with a wrong field type is invalid-value", () => {
    const bad: [Json, string, string][] = [
      [{ $type: "number", value: "12" }, `${AT}.value.value`, 'must be "NaN", "Infinity", "-Infinity" or "-0"'],
      [{ $type: "bigint", value: 12 }, `${AT}.value.value`, "must be a decimal integer string"],
      [{ $type: "bigint", value: "007" }, `${AT}.value.value`, "must be a decimal integer string"],
      [{ $type: "function", name: 1 }, `${AT}.value.name`, "must be a string"],
      [{ $type: "accessor", get: "yes", set: false }, `${AT}.value.get`, "must be a boolean"],
      [{ $type: "cycle", path: null }, `${AT}.value.path`, "must be a string"],
      [{ $type: "map", entries: {} }, `${AT}.value.entries`, "must be an array"],
      [{ $type: "map", entries: [["only-key"]] }, `${AT}.value.entries[0]`, "must be a [key, value] pair"],
      [{ $type: "set", values: 1 }, `${AT}.value.values`, "must be an array"],
      [{ $type: "object", entries: [] }, `${AT}.value.entries`, "must be an object"]
    ];
    for (const [value, position, what] of bad) {
      expect(parseValue({ state: "recorded", value }, AT)).toEqual({ state: "invalid-value", position, what });
    }
    expect(parseValue({ state: "truncated", value: { $type: "string-cut", value: "abc", length: 2 } }, AT)).toEqual({
      state: "invalid-value",
      position: `${AT}.value.length`,
      what: "must be an integer >= the prefix length"
    });
    expect(parseValue({ state: "truncated", value: [{ $type: "more", count: -1 }] }, AT)).toEqual({
      state: "invalid-value",
      position: `${AT}.value[0].count`,
      what: "must be a non-negative integer"
    });
  });

  it("an unknown $type, or a known tag with other keys, is an unknown-tag object kept as is", () => {
    const unknown = { $type: "regexp", source: "a+", flags: "g" };
    const extraKey = { $type: "undefined", note: 1 };
    expect(parseValue({ state: "recorded", value: [unknown, extraKey] }, AT)).toEqual({
      state: "recorded",
      value: [unknown, extraKey]
    });
    expect(tagOf(unknown)).toBe("unknown-tag");
    expect(tagOf(extraKey)).toBe("unknown-tag");
    expect(tagOf({ $type: 5 })).toBe("unknown-tag");
    // its property values are still values: a forbidden tag inside is still caught
    expect(parseValue({ state: "recorded", value: { $type: "regexp", inner: { $type: "deeper" } } }, AT)).toEqual({
      state: "invalid-value",
      position: `${AT}.value.inner`,
      what: "tag deeper is not allowed in a recorded value"
    });
  });

  it("a huge object key is clipped to 256 B in the position, with … after the quoted prefix", () => {
    const key = "k".repeat(2_000_000);
    const result = parseValue({ state: "recorded", value: { [key]: { $type: "deeper" } } }, AT);
    expect(result).toEqual({
      state: "invalid-value",
      position: `${AT}.value["${"k".repeat(256)}"…]`,
      what: "tag deeper is not allowed in a recorded value"
    });
    const bidi = "\u202e".repeat(1_000_000);
    const other = parseValue({ state: "recorded", value: { [bidi]: { $type: "deeper" } } }, AT);
    expect(other.state === "invalid-value" && other.position.length).toBeLessThan(2048);
    const short = "я".repeat(128);
    expect(parseValue({ state: "recorded", value: { [short]: { $type: "deeper" } } }, AT)).toMatchObject({
      position: `${AT}.value["${short}"]`
    });
  });

  it("object escapes a real object with a $type key: entries keys are literal, entries values are values", () => {
    const value = { $type: "object", entries: { $type: "deeper", x: { $type: "undefined" } } };
    expect(parseValue({ state: "recorded", value }, AT)).toEqual({ state: "recorded", value });
    expect(tagOf(value)).toBe("object");
  });

  it("tagOf is null for scalars, arrays and plain objects", () => {
    expect(tagOf(null)).toBeNull();
    expect(tagOf("x")).toBeNull();
    expect(tagOf([{ $type: "hole" }])).toBeNull();
    expect(tagOf({ a: 1 })).toBeNull();
    expect(tagOf({ $type: "hole" })).toBe("hole");
  });

  it("depth: 64 nested containers pass, 65 are invalid-value (4.9); leaf tags add no level", () => {
    expect(VALUE_MAX_DEPTH).toBe(64);
    expect(parseValue({ state: "recorded", value: nest(64) }, AT)).toEqual({ state: "recorded", value: nest(64) });
    const deep = parseValue({ state: "recorded", value: nest(65) }, AT);
    expect(deep).toEqual({
      state: "invalid-value",
      position: `${AT}.value${"[0]".repeat(64)}`,
      what: "nesting deeper than 64"
    });
    let withLeaf: Json = { $type: "undefined" };
    for (let level = 0; level < 64; level += 1) withLeaf = [withLeaf];
    expect(parseValue({ state: "recorded", value: withLeaf }, AT).state).toBe("recorded");
    let viaTags: Json = 1;
    for (let level = 0; level < 65; level += 1) viaTags = { $type: "class", name: "C", value: viaTags };
    expect(parseValue({ state: "recorded", value: viaTags }, AT)).toMatchObject({
      state: "invalid-value",
      what: "nesting deeper than 64"
    });
  });

  it("non-JSON input (not from JSON.parse) is invalid-value", () => {
    expect(parseValue({ state: "recorded", value: [Number.NaN] }, AT)).toEqual({
      state: "invalid-value",
      position: `${AT}.value[0]`,
      what: "must be a finite number (use the number tag)"
    });
    expect(parseValue({ state: "recorded", value: { a: undefined } }, AT)).toEqual({
      state: "invalid-value",
      position: `${AT}.value.a`,
      what: "is not a JSON value"
    });
  });

  it("positions quote keys that are not identifiers, escaping control and bidi characters", () => {
    expect(parseValue({ state: "recorded", value: { "a b": { $type: "deeper" } } }, AT)).toEqual({
      state: "invalid-value",
      position: `${AT}.value["a b"]`,
      what: "tag deeper is not allowed in a recorded value"
    });
    expect(parseValue({ state: "recorded", value: { "\u001b\u009b\u202e": { $type: "deeper" } } }, AT)).toMatchObject({
      position: `${AT}.value["\\u001b\\u009b\\u202e"]`
    });
  });
});

describe("compactJson", () => {
  it("sorts keys byte-wise, drops whitespace and is independent of insertion order", () => {
    expect(compactJson({ b: 1, a: [true, null, "x"], é: 3, Z: { y: 1, x: 2 } })).toBe(
      '{"Z":{"x":2,"y":1},"a":[true,null,"x"],"b":1,"é":3}'
    );
    expect(compactJson({ x: 1, y: 2 })).toBe(compactJson({ y: 2, x: 1 }));
  });

  it("escapes C0 (JSON), DEL, C1 and bidi as \\uXXXX and stays valid JSON", () => {
    const text = "\u001b[2J\u007f\u009b\u202e\u2066\n";
    expect(compactJson(text)).toBe('"\\u001b[2J\\u007f\\u009b\\u202e\\u2066\\n"');
    expect(JSON.parse(compactJson({ [text]: text }))).toEqual({ [text]: text });
    expect(compactJson("\ud800")).toBe('"\\ud800"');
  });
});

describe("capValue (spec 4.9, last row)", () => {
  function reparse(value: Value): Value {
    if (value.state !== "truncated") throw new Error(`expected truncated, got ${value.state}`);
    return parseValue({ state: "truncated", value: value.value, reason: value.reason }, AT);
  }

  it("returns a value that fits unchanged (same object)", () => {
    const value: Value = { state: "recorded", value: { a: [1, 2, 3] } };
    expect(capValue(value)).toBe(value);
    expect(VALUE_MAX_BYTES).toBe(65_536);
  });

  it("leaves states without a value alone", () => {
    const states: Value[] = [
      { state: "masked" },
      { state: "not-recorded", reason: "threw" },
      { state: "invalid-value", position: AT, what: "x" },
      { state: "unknown-state", raw: "partial" }
    ];
    for (const value of states) expect(capValue(value, 1)).toBe(value);
  });

  it("cuts a long string to a string-cut prefix with the full UTF-16 length", () => {
    const text = "я".repeat(100_000);
    const capped = capValue({ state: "recorded", value: text });
    expect(capped).toMatchObject({ state: "truncated", reason: "viewer-cap" });
    if (capped.state !== "truncated") throw new Error("unreachable");
    const cut = capped.value as { $type: string; value: string; length: number };
    expect(cut.$type).toBe("string-cut");
    expect(cut.length).toBe(100_000);
    expect(text.startsWith(cut.value)).toBe(true);
    expect(cut.value.length).toBeGreaterThan(20_000);
    expect(utf8Bytes(compactJson(capped.value))).toBeLessThanOrEqual(VALUE_MAX_BYTES);
    expect(reparse(capped)).toEqual(capped);
  });

  it("cuts a long array with a trailing more marker that counts the rest", () => {
    const items = Array.from({ length: 10_000 }, (_, index) => ({ id: index, name: `item-${index}` }));
    const capped = capValue({ state: "recorded", value: items });
    if (capped.state !== "truncated") throw new Error("expected truncated");
    const out = capped.value as Json[];
    const more = out[out.length - 1] as { $type: string; count: number };
    expect(more.$type).toBe("more");
    expect(out.length - 1 + more.count).toBe(10_000);
    // every kept item but the last is whole; the last one may itself be cut structurally
    expect(out.slice(0, -2)).toEqual(items.slice(0, out.length - 2));
    expect(utf8Bytes(compactJson(capped.value))).toBeLessThanOrEqual(VALUE_MAX_BYTES);
    expect(reparse(capped)).toEqual(capped);
  });

  it("turns a plain object with too many keys into an object tag with more", () => {
    const entries = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`k${String(i).padStart(5, "0")}`, i]));
    const capped = capValue({ state: "recorded", value: entries });
    if (capped.state !== "truncated") throw new Error("expected truncated");
    const tag = capped.value as { $type: string; entries: Record<string, number>; more: number };
    expect(tag.$type).toBe("object");
    expect(Object.keys(tag.entries).length + tag.more).toBe(20_000);
    expect(Object.keys(tag.entries)[0]).toBe("k00000");
    expect(reparse(capped)).toEqual(capped);
  });

  it("adds to an existing trailing more of a truncated value", () => {
    const items: Json[] = [...Array.from({ length: 3000 }, (_, i) => `value-${i}`), { $type: "more", count: 500 }];
    const capped = capValue({ state: "truncated", value: items, reason: "producer" }, 2000);
    if (capped.state !== "truncated") throw new Error("expected truncated");
    const out = capped.value as Json[];
    const more = out[out.length - 1] as { count: number };
    expect(out.length - 1 + more.count).toBe(3500);
    expect(capped.reason).toBe("viewer-cap");
  });

  it("keeps live values live with the same markers", () => {
    const capped = capValue({ state: "live", value: ["x".repeat(500), 1, 2] }, 200);
    expect(capped.state).toBe("live");
    if (capped.state !== "live") throw new Error("unreachable");
    expect((capped.value as Json[])[0]).toMatchObject({ $type: "string-cut", length: 500 });
    expect(utf8Bytes(compactJson(capped.value))).toBeLessThanOrEqual(200);
  });

  it("always fits, also for nested maps, sets, classes and escape-heavy strings", () => {
    const hostile: Json = {
      map: { $type: "map", entries: Array.from({ length: 200 }, (_, i) => [`k${i}`, "v".repeat(50)]) },
      set: { $type: "set", values: Array.from({ length: 200 }, (_, i) => i) },
      error: { $type: "class", name: "Error", value: { message: "\u009b".repeat(5000), stack: "s".repeat(4000) } },
      nested: nest(60)
    };
    for (const max of [120, 300, 1000, 4000]) {
      const capped = capValue({ state: "recorded", value: hostile }, max);
      expect(utf8Bytes(compactJson((capped as { value: Json }).value)), `max ${max}`).toBeLessThanOrEqual(max);
      expect(reparse(capped).state).toBe("truncated");
    }
  });

  it("replaces a leaf that cannot be cut (a huge bigint) with deeper", () => {
    const capped = capValue({ state: "recorded", value: { $type: "bigint", value: "9".repeat(1000) } }, 200);
    expect(capped).toEqual({ state: "truncated", value: { $type: "deeper" }, reason: "viewer-cap" });
  });

  it("keeps a __proto__ key as an own property", () => {
    const raw = JSON.parse(`{"__proto__":{"a":1},"big":"${"x".repeat(400)}"}`) as Json;
    const capped = capValue({ state: "recorded", value: raw }, 200);
    if (capped.state !== "truncated") throw new Error("expected truncated");
    const out = capped.value as Record<string, Json>;
    const holder = out.$type === "object" ? (out.entries as Record<string, Json>) : out;
    expect(Object.hasOwn(holder, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(holder)).toBe(Object.prototype);
  });
});

describe("isMaskedKey (spec 8.3)", () => {
  it("follows the spec examples", () => {
    expect(isMaskedKey("tokenizer")).toBe(false);
    expect(isMaskedKey("sessionStorage")).toBe(false);
    expect(isMaskedKey("csrfToken")).toBe(true);
    expect(isMaskedKey("x-api-key")).toBe(true);
    expect(isMaskedKey("auth")).toBe(true);
  });

  it("masks every listed word, including auth and otp, in any position", () => {
    const words = [
      "password",
      "passwd",
      "pwd",
      "secret",
      "token",
      "auth",
      "authorization",
      "cookie",
      "credential",
      "credentials",
      "jwt",
      "bearer",
      "otp"
    ];
    for (const word of words) {
      expect(isMaskedKey(word), word).toBe(true);
      expect(isMaskedKey(`user_${word}`), word).toBe(true);
      expect(isMaskedKey(`my.${word}.value`), word).toBe(true);
    }
    expect(isMaskedKey("otpCode")).toBe(true);
    expect(isMaskedKey("http.request.header.authorization")).toBe(true);
    expect(isMaskedKey("oauthToken")).toBe(true);
  });

  it("masks the listed pairs of consecutive words only in that order", () => {
    for (const key of ["apiKey", "api_key", "APIKey", "sessionId", "session.id", "sessionID", "privateKey"]) {
      expect(isMaskedKey(key), key).toBe(true);
    }
    for (const key of ["accessKeyId", "client-secret", "x-access-key"]) expect(isMaskedKey(key), key).toBe(true);
    for (const key of ["api", "key", "keyApi", "session", "id", "idSession", "access", "client"]) {
      expect(isMaskedKey(key), key).toBe(false);
    }
  });

  it("masks the listed whole keys, case-insensitively, and nothing that merely contains them", () => {
    for (const key of ["apikey", "APIKEY", "sessionid", "sid", "SID", "set-cookie"])
      expect(isMaskedKey(key), key).toBe(true);
    for (const key of ["sidebar", "insider", "author", "authorName", "cookiecutter"]) {
      expect(isMaskedKey(key), key).toBe(false);
    }
  });

  it("splits camelCase, separators and letter/digit boundaries (hardening: password2)", () => {
    expect(keyWords("XMLHttpRequest")).toEqual(["xml", "http", "request"]);
    expect(keyWords("csrfToken")).toEqual(["csrf", "token"]);
    expect(keyWords("x-api-key")).toEqual(["x", "api", "key"]);
    expect(keyWords("password2")).toEqual(["password", "2"]);
    expect(keyWords("a b:c/d")).toEqual(["a", "b", "c", "d"]);
    expect(isMaskedKey("password2")).toBe(true);
  });
});

describe("maskString (spec 8.3)", () => {
  it("masks credential-looking strings whole, case-insensitively", () => {
    for (const text of ["Bearer abc.def", "basic dXNlcjpwYXNz", "DIGEST username=x", "Negotiate YIIG", "Bearer a b"]) {
      expect(maskString(text), text).toBe(MASKED_TEXT);
    }
    expect(maskString("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln")).toBe(MASKED_TEXT);
    expect(maskString("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.")).toBe(MASKED_TEXT);
    expect(maskString("Bearer")).toBe("Bearer");
    expect(maskString("see Bearer abc")).toBe("see Bearer abc");
    expect(maskString("eyJ.not a jwt")).toBe("eyJ.not a jwt");
  });

  it("masks query values whose key is masked, in URLs, paths and bare query strings", () => {
    expect(maskString("/cart?token=abc&page=2")).toBe(`/cart?token=${MASKED_TEXT}&page=2`);
    expect(maskString("https://x.test/cb?code=1&client_secret=s3#frag")).toBe(
      `https://x.test/cb?code=1&client_secret=${MASKED_TEXT}#frag`
    );
    expect(maskString("token=abc&x=1")).toBe(`token=${MASKED_TEXT}&x=1`);
    expect(maskString("/a?api%5Fkey=zzz")).toBe(`/a?api%5Fkey=${MASKED_TEXT}`);
    expect(maskString("/a?session+id=zzz")).toBe(`/a?session+id=${MASKED_TEXT}`);
    expect(maskString("/search?q=token&tokenizer=1")).toBe("/search?q=token&tokenizer=1");
    expect(maskString("/a?token=")).toBe("/a?token=");
    expect(maskString("/a?%E0%A4%A=1")).toBe("/a?%E0%A4%A=1");
  });

  it("stays linear on long hostile input", () => {
    const text = `?${"a".repeat(200_000)}&${"b=".repeat(100_000)}`;
    const started = Date.now();
    maskString(text);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("maskValue (spec 8.3)", () => {
  it("masks keys, credential strings and URL queries recursively and keeps the state", () => {
    const value: Value = {
      state: "recorded",
      value: [{ password: "hunter2", nested: { apiKey: "k", ok: 1 } }, ["Bearer t0k3n", "/a?token=1&x=2", "plain"]]
    };
    expect(maskValue(value)).toEqual({
      state: "recorded",
      value: [
        { password: { $type: "masked" }, nested: { apiKey: { $type: "masked" }, ok: 1 } },
        [{ $type: "masked" }, `/a?token=${MASKED_TEXT}&x=2`, "plain"]
      ]
    });
  });

  it("walks tags: map keys, set values, class values, object entries and string-cut prefixes", () => {
    const value: Value = {
      state: "truncated",
      value: [
        {
          $type: "map",
          entries: [["token", "abc"], [{ $type: "undefined" }, "Basic eA=="], { $type: "more", count: 2 }]
        },
        { $type: "set", values: ["eyJa.eyJb.c"] },
        { $type: "class", name: "Error", value: { message: "Bearer secret" } },
        { $type: "object", entries: { $type: "x", secret: "s" } },
        { $type: "string-cut", value: "Bearer abcdef", length: 90 }
      ]
    };
    expect(maskValue(value)).toEqual({
      state: "truncated",
      value: [
        {
          $type: "map",
          entries: [
            ["token", { $type: "masked" }],
            [{ $type: "undefined" }, { $type: "masked" }],
            { $type: "more", count: 2 }
          ]
        },
        { $type: "set", values: [{ $type: "masked" }] },
        { $type: "class", name: "Error", value: { message: { $type: "masked" } } },
        { $type: "object", entries: { $type: "x", secret: { $type: "masked" } } },
        { $type: "masked" }
      ]
    });
  });

  it("returns the same object when nothing is masked and leaves other states alone", () => {
    const clean: Value = { state: "recorded", value: { id: 7, items: ["a"] } };
    expect(maskValue(clean)).toBe(clean);
    const masked: Value = { state: "masked" };
    expect(maskValue(masked)).toBe(masked);
    const live: Value = { state: "live", value: { token: "x" } };
    expect(maskValue(live)).toEqual({ state: "live", value: { token: { $type: "masked" } } });
  });

  it("is idempotent and keeps a __proto__ key as an own property", () => {
    const raw = JSON.parse('{"__proto__":{"password":"x"},"a":1}') as Json;
    const once = maskValue({ state: "recorded", value: raw });
    expect(maskValue(once)).toEqual(once);
    const out = (once as { value: Record<string, Json> }).value;
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out["__proto__"]).toEqual({ password: { $type: "masked" } });
  });
});
