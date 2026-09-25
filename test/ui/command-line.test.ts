/**
 * Task 24: the `:` tokenizer that stays in src/command-line.ts (ported from
 * test/command-line.test.ts; the command grammar itself is tested in test/ui/commands.test.ts).
 */
import { describe, expect, it } from "vitest";
import { tokenize, type Token } from "../../src/command-line.js";

function tokens(line: string): Token[] {
  const result = tokenize(line);
  if (!result.ok) throw new Error(result.error);
  return result.tokens;
}

function one(line: string): Token {
  return tokens(line)[0]!;
}

describe("tokenizer", () => {
  it("splits bare words on whitespace", () => {
    expect(tokens("path  a   b").map((token) => token.text)).toEqual(["path", "a", "b"]);
  });

  it("single quotes are literal, double quotes understand escapes", () => {
    expect(one("'a b\\n'").text).toBe("a b\\n");
    expect(one('"a \\"b\\" \\\\ c\\n"').text).toBe('a "b" \\ c\n');
    expect(one("a\\ b").text).toBe("a b");
  });

  it("only unquoted colons split a ref into parts", () => {
    expect(one("s-1:t-1:a").parts).toEqual(["s-1", "t-1", "a"]);
    expect(one('"sess:1":t-1:a').parts).toEqual(["sess:1", "t-1", "a"]);
    expect(one("x\\:y:z").parts).toEqual(["x:y", "z"]);
  });

  it("a regex literal may contain spaces, quotes and escaped slashes", () => {
    const token = one("/a b'\\/c/i");
    expect(token.regex).toEqual({ source: "a b'\\/c", flags: "i" });
  });

  it("reports unterminated quotes and regexes instead of guessing", () => {
    expect(tokenize("'abc").ok).toBe(false);
    expect(tokenize('"abc').ok).toBe(false);
    expect(tokenize("/abc").ok).toBe(false);
    expect(tokenize("abc\\").ok).toBe(false);
    expect(tokenize("/a/x!").ok).toBe(false);
  });
});
