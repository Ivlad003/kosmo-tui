import { describe, expect, it } from "vitest";
import { clipBytes, compareBytes, utf8Bytes, utf8Prefix } from "../../src/format/bytes.js";

/** Deterministic PRNG (mulberry32) so the property checks are reproducible. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ["a", "Z", "0", "é", "я", "購", "\uFFFF", "\uE000", "😀", "\ud800", "\udc00", "\u0000", "~"];

function randomText(next: () => number): string {
  let text = "";
  const length = Math.floor(next() * 6);
  for (let index = 0; index < length; index += 1) text += ALPHABET[Math.floor(next() * ALPHABET.length)];
  return text;
}

describe("utf8Bytes", () => {
  it("counts UTF-8 bytes, not UTF-16 units", () => {
    expect(utf8Bytes("")).toBe(0);
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("я")).toBe(2);
    expect(utf8Bytes("購")).toBe(3);
    expect(utf8Bytes("😀")).toBe(4);
    expect(utf8Bytes("\ud800")).toBe(3); // lone surrogate encodes as U+FFFD
  });

  it("agrees with Buffer.byteLength on random text", () => {
    const next = prng(1);
    for (let run = 0; run < 2000; run += 1) {
      const text = randomText(next);
      expect(utf8Bytes(text), JSON.stringify(text)).toBe(Buffer.byteLength(text, "utf8"));
    }
  });
});

describe("compareBytes", () => {
  it("orders by UTF-8 bytes, which differs from UTF-16 order for astral vs U+E000–U+FFFF", () => {
    expect(compareBytes("\uFFFF", "😀")).toBe(-1);
    expect("\uFFFF" < "😀").toBe(false); // plain JS string order disagrees
    expect(compareBytes("Z", "a")).toBe(-1);
    expect(compareBytes("z", "é")).toBe(-1);
    expect(compareBytes("ab", "a")).toBe(1);
    expect(compareBytes("a", "a")).toBe(0);
  });

  it("agrees with Buffer.compare on random text, lone surrogates included", () => {
    const next = prng(2);
    for (let run = 0; run < 4000; run += 1) {
      const a = randomText(next);
      const b = randomText(next);
      expect(compareBytes(a, b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(
        Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
      );
    }
  });
});

describe("utf8Prefix", () => {
  it("keeps the longest prefix that fits and never splits a code point", () => {
    expect(utf8Prefix("abc", 2)).toBe("ab");
    expect(utf8Prefix("яя", 3)).toBe("я");
    expect(utf8Prefix("a😀b", 4)).toBe("a");
    expect(utf8Prefix("a😀b", 5)).toBe("a😀");
    expect(utf8Prefix("abc", 0)).toBe("");
    expect(utf8Prefix("abc", 100)).toBe("abc");
  });
});

describe("clipBytes", () => {
  it("keeps text that fits and cuts longer text at a code point boundary with …", () => {
    expect(clipBytes("abc", 3)).toBe("abc");
    expect(clipBytes("abcd", 3)).toBe("abc…");
    expect(clipBytes("яяя", 6)).toBe("яяя");
    expect(clipBytes("яяя", 5)).toBe("яя…");
    expect(clipBytes("a😀b", 4)).toBe("a…");
    expect(clipBytes("x".repeat(5_000_000), 256)).toBe(`${"x".repeat(256)}…`);
  });
});
