/**
 * TEMPORARY parity check (spec 16, stage 1 step 1). Task 25 deletes this file together with the
 * `@kosmo-callflow/*` dependencies; nothing else may import `@kosmo-callflow/trace-artifacts` from new code.
 *
 * Where both specs agree, `src/sanitize.ts` must give byte-identical output to the callflow sanitizer that
 * the old modules still use. kosmo-tui deliberately differs in two places, pinned below:
 *   1. bidi controls U+202A–U+202E and U+2066–U+2069 are escaped (callflow leaves them raw);
 *   2. `multiline: true` keeps only `\n`, while callflow's `preserveNewlines` also keeps `\t`.
 */
import { escapeTerminalControls as callflowEscape } from "@kosmo-callflow/trace-artifacts";
import { describe, expect, it } from "vitest";
import { escapeTerminalControls } from "../../src/sanitize.js";

const isBidi = (code: number): boolean => (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);

describe("escapeTerminalControls parity with @kosmo-callflow/trace-artifacts (temporary, Task 25 deletes)", () => {
  it("single-line mode matches callflow for every BMP code unit except bidi controls", () => {
    const mismatches: string[] = [];
    for (let code = 0; code <= 0xffff; code += 1) {
      if (isBidi(code)) continue;
      const text = `a${String.fromCharCode(code)}b`;
      if (escapeTerminalControls(text) !== callflowEscape(text)) mismatches.push(`U+${code.toString(16)}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("multiline mode matches preserveNewlines for every BMP code unit except \\t and bidi controls", () => {
    const mismatches: string[] = [];
    for (let code = 0; code <= 0xffff; code += 1) {
      if (isBidi(code) || code === 0x09) continue;
      const text = `a\n${String.fromCharCode(code)}\nb`;
      const ours = escapeTerminalControls(text, { multiline: true });
      if (ours !== callflowEscape(text, { preserveNewlines: true })) mismatches.push(`U+${code.toString(16)}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("matches on realistic hostile strings", () => {
    const samples = [
      "GET /cart\u001b[2J\u001b[H",
      "\u001b]8;;file:///etc/passwd\u0007click\u001b]8;;\u0007",
      "\u009b31mred",
      "calculateLineTotal · кошик · 購物車 · 🛒",
      "line1\r\nline2\u0000"
    ];
    for (const sample of samples) expect(escapeTerminalControls(sample)).toBe(callflowEscape(sample));
  });

  it("deliberately differs: bidi controls are escaped here and raw in callflow", () => {
    expect(escapeTerminalControls("a‮b")).toBe("a\\u202eb");
    expect(callflowEscape("a‮b")).toBe("a‮b");
  });

  it("deliberately differs: multiline keeps \\t escaped, callflow's preserveNewlines keeps it raw", () => {
    expect(escapeTerminalControls("a\tb", { multiline: true })).toBe("a\\u0009b");
    expect(callflowEscape("a\tb", { preserveNewlines: true })).toBe("a\tb");
  });
});
