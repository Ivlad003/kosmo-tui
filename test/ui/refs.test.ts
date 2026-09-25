/**
 * Spec 6.6: span-ref grammar `.` | `<id>` | `<session>:<id>` | `<trace>:<session>:<id>`, resolved in
 * the current trace; an ambiguous short id is never guessed.
 */
import { describe, expect, it } from "vitest";
import { formatSpanRef, parseSpanRef, regexFromLiteral, resolveSpanRef, spanRefFromToken } from "../../src/ui/refs.js";
import { tokenize } from "../../src/command-line.js";
import { model, ref, span } from "./model-fixtures.js";

describe("parseSpanRef", () => {
  it("reads the four forms", () => {
    expect(parseSpanRef(".")).toEqual({ kind: "selected" });
    expect(parseSpanRef("sp_3")).toEqual({ kind: "id", id: "sp_3" });
    expect(parseSpanRef("s1:sp_3")).toEqual({ kind: "session-id", session: "s1", id: "sp_3" });
    expect(parseSpanRef("t_9f:s1:sp_3")).toEqual({ kind: "full", trace: "t_9f", session: "s1", id: "sp_3" });
  });

  it("only unquoted colons separate parts", () => {
    expect(parseSpanRef('"a:b"')).toEqual({ kind: "id", id: "a:b" });
    expect(parseSpanRef('s1:"a:b"')).toEqual({ kind: "session-id", session: "s1", id: "a:b" });
    // A quoted dot is an id, not the selection.
    expect(parseSpanRef('"."')).toEqual({ kind: "id", id: "." });
  });

  it("rejects empty parts, too many parts, several tokens and regex literals", () => {
    expect(parseSpanRef("s1:")).toEqual({ error: "empty part in ref s1:" });
    expect(parseSpanRef("a:b:c:d")).toEqual({
      error: "bad span ref a:b:c:d; expected . | <id> | <session>:<id> | <trace>:<session>:<id>"
    });
    expect(parseSpanRef("a b")).toEqual({ error: "expected one span ref, got 2 tokens" });
    expect(parseSpanRef("/x/")).toEqual({ error: "a regex is not a span ref: /x/" });
    expect(parseSpanRef('"open')).toEqual({ error: "unterminated double quote" });
  });

  it("spanRefFromToken reads a token the command line already split", () => {
    const tokenized = tokenize('"n:1":sp_9');
    if (!tokenized.ok) throw new Error(tokenized.error);
    expect(spanRefFromToken(tokenized.tokens[0]!)).toEqual({ kind: "session-id", session: "n:1", id: "sp_9" });
  });
});

describe("resolveSpanRef", () => {
  // The same id in two sessions: spec 4.3 says these are two different spans.
  const trace = model([
    span({ id: "root", order: 0 }),
    span({ id: "sp_1", parent: "root", order: 1 }),
    span({ id: "sp_1", session: "n1", parent: "root", parentSession: "s1", order: 0 }),
    span({ id: "only", parent: "root", order: 2 })
  ]);

  it("`.` is the selection, and needs one", () => {
    expect(resolveSpanRef(trace, ref("only"), { kind: "selected" })).toEqual({ ok: true, ref: ref("only") });
    expect(resolveSpanRef(trace, null, { kind: "selected" })).toEqual({ ok: false, reason: "no-selection" });
    expect(resolveSpanRef(trace, ref("x", "s1", "other"), { kind: "selected" })).toEqual({
      ok: false,
      reason: "not-found"
    });
  });

  it("a unique id resolves in any session", () => {
    expect(resolveSpanRef(trace, null, { kind: "id", id: "only" })).toEqual({ ok: true, ref: ref("only") });
  });

  it("an id shared by two sessions is ambiguous and lists both candidates, never picks one", () => {
    const result = resolveSpanRef(trace, null, { kind: "id", id: "sp_1" });
    expect(result).toEqual({ ok: false, reason: "ambiguous", candidates: [ref("sp_1"), ref("sp_1", "n1")] });
  });

  it("session:id and trace:session:id are exact", () => {
    expect(resolveSpanRef(trace, null, { kind: "session-id", session: "n1", id: "sp_1" })).toEqual({
      ok: true,
      ref: ref("sp_1", "n1")
    });
    expect(resolveSpanRef(trace, null, { kind: "full", trace: "t1", session: "s1", id: "sp_1" })).toEqual({
      ok: true,
      ref: ref("sp_1")
    });
    expect(resolveSpanRef(trace, null, { kind: "full", trace: "t2", session: "s1", id: "sp_1" })).toEqual({
      ok: false,
      reason: "not-found"
    });
    expect(resolveSpanRef(trace, null, { kind: "id", id: "nope" })).toEqual({ ok: false, reason: "not-found" });
  });
});

describe("formatSpanRef and regexFromLiteral", () => {
  it("formats session:id and quotes parts that need it", () => {
    expect(formatSpanRef(ref("sp_1", "n1"))).toBe("n1:sp_1");
    expect(formatSpanRef(ref("a:b", "s 1"))).toBe('"s 1":"a:b"');
  });

  it("accepts only i, m, s, u flags and never throws", () => {
    expect(regexFromLiteral("/cart/i")).toEqual(/cart/i);
    expect(regexFromLiteral("/cart/g")).toEqual({ error: "regex flag g is not allowed (use imsu)" });
    expect(regexFromLiteral("/cart/ii")).toEqual({ error: "repeated regex flag in /cart/ii" });
    expect(regexFromLiteral("cart")).toEqual({ error: "expected /regex/flags, got cart" });
    const broken = regexFromLiteral("/(/");
    expect("error" in broken && broken.error.startsWith("invalid regex /(/:")).toBe(true);
  });
});
