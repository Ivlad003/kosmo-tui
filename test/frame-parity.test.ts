/**
 * Frame parity with the kosmo-callflow viewer (task 3.3).
 *
 * Baseline: test/fixtures/parity/golden/*.txt, produced ONLY by scripts/parity-kc.mjs
 * from kosmo-callflow's own renderer. Every baseline case is ASCII-only recorded data,
 * and kosmo-tui must render it byte-identically at 80x24, 120x40 and 60x16.
 *
 * Intentional differences are never folded into the baseline. They live in
 * test/fixtures/parity/intentional-cases.json with the kosmo-callflow output kept for
 * reference (intentional/kc) next to kosmo-tui's own golden (intentional/kt), and each
 * one is explained in test/fixtures/parity/README.md and asserted below by the property
 * that changed. `UPDATE_PARITY=1 npx vitest run test/frame-parity.test.ts` rewrites only
 * the intentional/kt goldens; the baseline is never written from kosmo-tui output.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { visibleWidth } from "../src/ansi.js";
import {
  DEFAULT_KC_ROOT,
  PARITY_DIR,
  frameText,
  goldenName,
  kcFrame,
  loadKc,
  type ParityFixture
} from "../scripts/parity-kc.mjs";
import { ktFrame } from "./parity-state.js";

const baseline = JSON.parse(readFileSync(path.join(PARITY_DIR, "cases.json"), "utf8")) as ParityFixture;
const intentional = JSON.parse(readFileSync(path.join(PARITY_DIR, "intentional-cases.json"), "utf8")) as ParityFixture;
const REQUIRED_SIZES = [
  [80, 24],
  [120, 40],
  [60, 16]
];
const kcAvailable = existsSync(path.join(DEFAULT_KC_ROOT, "packages/cli/dist/connect/render.js"));
const update = process.env.UPDATE_PARITY === "1";

function read(dir: string, name: string, cols: number, rows: number): string {
  return readFileSync(path.join(PARITY_DIR, dir, goldenName(name, cols, rows)), "utf8");
}

describe("frame parity baseline", () => {
  it("covers the required sizes and ASCII-only fixtures", () => {
    expect(baseline.sizes).toEqual(REQUIRED_SIZES);
    expect(intentional.sizes).toEqual(REQUIRED_SIZES);
    // A non-ASCII byte in a baseline case would make "byte-identical" depend on the
    // width rules that intentionally changed; such cases belong in intentional-cases.
    expect(/[^\x20-\x7e\n\r\t]/.test(readFileSync(path.join(PARITY_DIR, "cases.json"), "utf8"))).toBe(false);
  });

  for (const testCase of baseline.cases) {
    for (const [cols, rows] of baseline.sizes) {
      it(`${testCase.name} at ${cols}x${rows} is byte-identical to kosmo-callflow`, () => {
        const golden = read("golden", testCase.name, cols, rows);
        const frame = ktFrame(baseline.cases, testCase, cols, rows);
        expect(frame).toHaveLength(rows);
        expect(frameText(frame)).toBe(golden);
      });
    }
  }

  it.skipIf(!kcAvailable)("goldens are exactly what the built kosmo-callflow renderer produces", async () => {
    const kc = await loadKc();
    for (const testCase of baseline.cases) {
      for (const [cols, rows] of baseline.sizes) {
        expect(frameText(kcFrame(kc, baseline.cases, testCase, cols, rows)), `${testCase.name} ${cols}x${rows}`).toBe(
          read("golden", testCase.name, cols, rows)
        );
      }
    }
  });
});

const ESC_OR_BEL = /[\u001b\u0007]/;

const properties: Record<string, (kt: string[], kc: string[], cols: number) => void> = {
  "unicode-width": (kt, kc, cols) => {
    for (const line of kt) expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
    // kosmo-callflow cut by UTF-16 length: wide rows overflow the terminal or split a
    // surrogate pair / grapheme.
    const overflow = kc.some((line) => visibleWidth(line) > cols);
    const split = kc.some((line) =>
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(line)
    );
    expect(overflow || split).toBe(true);
  },
  "full-identity": (kt, kc) => {
    expect(kt.filter((line) => line.includes("src/a.ts#handle"))).toHaveLength(2);
    expect(kt.join("\n")).toContain("src/a.ts#handle @s-1");
    expect(kt.join("\n")).toContain("src/a.ts#handle @s-2");
    // kosmo-callflow merged both sessions' "root" into one row.
    expect(kc.filter((line) => line.includes("src/a.ts#handle"))).toHaveLength(1);
  },
  "tab-expansion": (kt, kc, cols) => {
    // kosmo-callflow emitted raw tabs and counted each as one column; kosmo-tui expands
    // them to the next stop of 8, so the line is what a terminal would show and fits.
    expect(kt.join("\n")).not.toContain("\t");
    for (const line of kt) expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
    expect(kt.some((line) => line.startsWith("  tab: kosmo.trace-text/v1 "))).toBe(true);
    expect(kc.join("\n")).toContain("\t");
  },
  "source-accurate-header": (kt, kc) => {
    // kosmo-callflow said "connected; live" for any source that was not disconnected; an
    // export, a SQLite snapshot or a stdin stream now names itself. Only the header differs.
    expect(kc[0]).toContain("connected; live");
    expect(kt[0]).not.toContain("connected; live");
    expect(kt[0]).toMatch(/^(export snapshot|sqlite snapshot \(static\)|stream v2 \(incomplete\)) \| /);
    expect(kt.slice(1)).toEqual(kc.slice(1));
  },
  "terminal-escaping": (kt, kc) => {
    expect(ESC_OR_BEL.test(kt.join("\n"))).toBe(false);
    expect(kt.join("\n")).toContain("\\u001b");
    expect(ESC_OR_BEL.test(kc.join("\n"))).toBe(true);
  }
};

describe("intentional differences from kosmo-callflow", () => {
  for (const testCase of intentional.cases) {
    for (const [cols, rows] of testCase.sizes ?? intentional.sizes) {
      it(`${testCase.name} (${testCase.change}) at ${cols}x${rows}`, () => {
        const frame = ktFrame(intentional.cases, testCase, cols, rows);
        const file = path.join(PARITY_DIR, "intentional/kt", goldenName(testCase.name, cols, rows));
        if (update) {
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, frameText(frame));
        }
        const kc = read("intentional/kc", testCase.name, cols, rows);
        expect(frame).toHaveLength(rows);
        expect(frameText(frame)).toBe(readFileSync(file, "utf8"));
        expect(frameText(frame)).not.toBe(kc);
        const check = properties[testCase.change ?? ""];
        expect(check, `no property check for change ${testCase.change}`).toBeDefined();
        check!(frame, kc.replace(/\n$/, "").split("\n"), cols);
      });
    }
  }
});
