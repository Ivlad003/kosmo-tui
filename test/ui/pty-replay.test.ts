import { describe, expect, it } from "vitest";
import { replayScreen } from "../pty.js";

const ESC = "\u001b";
const row = (n: number, text: string) => `${ESC}[${n};1H${ESC}[2K${text}`;

describe("replayScreen (test/pty.ts)", () => {
  it("treats an OSC 8 ending in ESC \\ as zero-width", () => {
    const log = row(1, `a ${ESC}]8;;file:///repo/src/cart.ts${ESC}\\src/cart.ts:12${ESC}]8;;${ESC}\\ b`);
    expect(replayScreen(log, 3)).toEqual(["a src/cart.ts:12 b", "", ""]);
  });

  it("still treats an OSC ending in BEL as zero-width", () => {
    const log = row(2, `x${ESC}]8;;file:///a\u0007y${ESC}]8;;\u0007z`);
    expect(replayScreen(log, 3)).toEqual(["", "xyz", ""]);
  });

  it("ends an OSC at the ESC of the next sequence, as xterm does", () => {
    const log = row(1, `a${ESC}]0;title${ESC}[2Kb`);
    expect(replayScreen(log, 1)).toEqual(["b"]);
  });

  it("shows escaped data literally: a `\\u001b[2J` text does not clear the screen", () => {
    const log = row(1, "keep") + row(2, "\\u001b[2J");
    expect(replayScreen(log, 2)).toEqual(["keep", "\\u001b[2J"]);
  });
});
