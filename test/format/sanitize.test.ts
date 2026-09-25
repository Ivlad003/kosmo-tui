import { describe, expect, it } from "vitest";
import { escapeTerminalControls, isSafeOsc8Uri, toFileUri } from "../../src/sanitize.js";

describe("escapeTerminalControls (spec 8.1)", () => {
  it("escapes ESC, so CSI and OSC sequences from data become visible text", () => {
    expect(escapeTerminalControls("a\u001b[31mred\u001b[0m")).toBe("a\\u001b[31mred\\u001b[0m");
    expect(escapeTerminalControls("\u001b]8;;file:///etc/passwd\u0007x\u001b]8;;\u001b\\")).toBe(
      "\\u001b]8;;file:///etc/passwd\\u0007x\\u001b]8;;\\u001b\\"
    );
  });

  it("escapes every C0 character, DEL and every C1 character, U+009B included", () => {
    for (let code = 0; code <= 0x1f; code += 1) {
      const char = String.fromCharCode(code);
      expect(escapeTerminalControls(char)).toBe(`\\u${code.toString(16).padStart(4, "0")}`);
    }
    expect(escapeTerminalControls("\u007f")).toBe("\\u007f");
    for (let code = 0x80; code <= 0x9f; code += 1) {
      expect(escapeTerminalControls(String.fromCharCode(code))).toBe(`\\u00${code.toString(16)}`);
    }
    expect(escapeTerminalControls("\u009b2J")).toBe("\\u009b2J");
  });

  it("escapes the bidi controls U+202A–U+202E and U+2066–U+2069", () => {
    for (const code of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
      expect(escapeTerminalControls(`x${String.fromCharCode(code)}y`)).toBe(`x\\u${code.toString(16)}y`);
    }
    expect(escapeTerminalControls("invoice\u202egpj.exe")).toBe("invoice\\u202egpj.exe");
  });

  it("leaves printable text alone: NBSP, other format characters, Cyrillic, CJK, emoji", () => {
    const text = "a\u00a0b \u200f \u2028 кошик 購物車 🛒 e\u0301";
    expect(escapeTerminalControls(text)).toBe(text);
  });

  it("keeps only \\n in multiline blocks; \\t and \\r stay escaped (tabs are expanded before escaping)", () => {
    expect(escapeTerminalControls("a\nb", { multiline: true })).toBe("a\nb");
    expect(escapeTerminalControls("a\nb")).toBe("a\\u000ab");
    expect(escapeTerminalControls("a\tb", { multiline: true })).toBe("a\\u0009b");
    expect(escapeTerminalControls("a\tb")).toBe("a\\u0009b");
    expect(escapeTerminalControls("a\r\nb", { multiline: true })).toBe("a\\u000d\nb");
    expect(escapeTerminalControls("x\u001b\ny\u202e", { multiline: true })).toBe("x\\u001b\ny\\u202e");
  });

  it("is idempotent: escaped output has no control character left", () => {
    const hostile = "\u0000\u001b[2J\u009b\u202e\u2066\t\r\n\u007f";
    const once = escapeTerminalControls(hostile);
    expect(escapeTerminalControls(once)).toBe(once);
    expect(once).toMatch(/^[\x20-\x7e]*$/);
  });
});

describe("toFileUri", () => {
  it("percent-encodes everything except unreserved characters and /", () => {
    expect(toFileUri("/work/app/src/cart.ts")).toBe("file:///work/app/src/cart.ts");
    expect(toFileUri("/work/my app/a#b?.ts")).toBe("file:///work/my%20app/a%23b%3F.ts");
    expect(toFileUri("/work/кошик.ts")).toBe("file:///work/%D0%BA%D0%BE%D1%88%D0%B8%D0%BA.ts");
    expect(toFileUri("/w/\u001b.ts")).toBe("file:///w/%1B.ts");
  });
});

describe("isSafeOsc8Uri (spec 6.4, 8.2)", () => {
  const root = "/work/app";

  it("accepts a file:/// URI inside the root, with or without a trailing slash on the root", () => {
    expect(isSafeOsc8Uri("file:///work/app/src/cart.ts", root)).toBe(true);
    expect(isSafeOsc8Uri("file:///work/app/src/cart.ts", "/work/app/")).toBe(true);
    expect(isSafeOsc8Uri(toFileUri("/work/app/src/my file#1.ts"), root)).toBe(true);
    expect(isSafeOsc8Uri(toFileUri("/work/app/src/кошик.ts"), root)).toBe(true);
    expect(isSafeOsc8Uri("file:///anything/at/all.ts", "/")).toBe(true);
  });

  it("rejects other schemes, hosts and relative forms", () => {
    expect(isSafeOsc8Uri("https://example.com/work/app/x.ts", root)).toBe(false);
    expect(isSafeOsc8Uri("file://host/work/app/x.ts", root)).toBe(false);
    expect(isSafeOsc8Uri("file:work/app/x.ts", root)).toBe(false);
    expect(isSafeOsc8Uri("/work/app/x.ts", root)).toBe(false);
  });

  it("rejects paths outside the root, sibling prefixes and dot segments", () => {
    expect(isSafeOsc8Uri("file:///etc/passwd", root)).toBe(false);
    expect(isSafeOsc8Uri("file:///work/application/x.ts", root)).toBe(false);
    expect(isSafeOsc8Uri("file:///work/app/../secret.ts", root)).toBe(false);
    expect(isSafeOsc8Uri("file:///work/app/%2E%2E/secret.ts", root)).toBe(false);
    expect(isSafeOsc8Uri("file:///work/app/./x.ts", root)).toBe(false);
    expect(isSafeOsc8Uri("file:///work/app//x.ts", root)).toBe(false);
    expect(isSafeOsc8Uri("file:///work/app", "relative/root")).toBe(false);
  });

  it("rejects raw or percent-encoded control and bidi characters, raw ? # space and backslash", () => {
    expect(isSafeOsc8Uri("file:///work/app/a\u001b]8;;x.ts", root)).toBe(false);
    expect(isSafeOsc8Uri("file:///work/app/a%1B.ts", root)).toBe(false);
    expect(isSafeOsc8Uri("file:///work/app/a%C2%9B.ts", root)).toBe(false);
    expect(isSafeOsc8Uri("file:///work/app/a%E2%80%AE.ts", root)).toBe(false);
    expect(isSafeOsc8Uri("file:///work/app/a\u202e.ts", root)).toBe(false);
    expect(isSafeOsc8Uri("file:///work/app/a.ts?x=1", root)).toBe(false);
    expect(isSafeOsc8Uri("file:///work/app/a.ts#L1", root)).toBe(false);
    expect(isSafeOsc8Uri("file:///work/app/a b.ts", root)).toBe(false);
    expect(isSafeOsc8Uri("file:///work/app/a%5Cb.ts", root)).toBe(false);
    expect(isSafeOsc8Uri("file:///work/app/%E0%A4%A.ts", root)).toBe(false);
    expect(isSafeOsc8Uri("file:///work/app/x.ts", "/work/\u001bapp")).toBe(false);
  });
});
