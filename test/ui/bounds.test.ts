/** Task 24: what stays of src/bounds.ts — jsonBytes, CACHE_MAX_BYTES and ByteLru (from test/session-bounds.test.ts). */
import { describe, expect, it } from "vitest";
import { ByteLru, CACHE_MAX_BYTES, jsonBytes } from "../../src/bounds.js";

describe("ByteLru", () => {
  it("ships a 64 MiB default budget", () => {
    expect(CACHE_MAX_BYTES).toBe(64 * 1024 * 1024);
    expect(new ByteLru().maxBytes).toBe(CACHE_MAX_BYTES);
  });

  it("evicts oldest first, names what it evicted and never exceeds its budget", () => {
    const cache = new ByteLru<string, string>(100);
    cache.set("a", "x", 40);
    cache.set("b", "x", 40);
    cache.get("a");
    expect(cache.set("c", "x", 40)).toEqual(["b"]);
    expect(cache.keys()).toEqual(["a", "c"]);
    expect(cache.set("huge", "x", 101)).toEqual(["huge"]);
    expect(cache.bytes).toBe(80);
    expect(jsonBytes({ text: "日本" })).toBe(Buffer.byteLength('{"text":"日本"}'));
  });
});
