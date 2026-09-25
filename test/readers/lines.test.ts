/**
 * Byte-level NDJSON line splitting (spec 4.5, Review focus 5): split on "\n" before
 * UTF-8 decoding, CRLF, BOM, the 1 MiB cap before parsing, 1-based line numbers, a last
 * line without "\n", and multi-byte characters split across chunks.
 */
import { describe, expect, it } from "vitest";
import { LineSplitter, type LineEvent } from "../../src/readers/lines.js";
import { bytes, splitAt } from "./reader-fakes.js";

function run(parts: readonly Uint8Array[], max = 1024): LineEvent[] {
  const splitter = new LineSplitter(max);
  return [...parts.flatMap((part) => splitter.push(part)), ...splitter.end()];
}

const line = (n: number, text: string): LineEvent => ({ kind: "line", n, text });

describe("LineSplitter", () => {
  it("numbers every line from 1, blank ones included", () => {
    expect(run([bytes("a\n\nb\n")])).toEqual([line(1, "a"), line(2, ""), line(3, "b")]);
  });

  it("emits the last line when the input does not end with a line end", () => {
    expect(run([bytes("a\nb")])).toEqual([line(1, "a"), line(2, "b")]);
    expect(run([bytes("a\n")])).toEqual([line(1, "a")]);
    expect(run([])).toEqual([]);
  });

  it("accepts CRLF and keeps a lone CR inside a line", () => {
    expect(run([bytes("a\r\nb\r"), bytes("\nc\rd\n")])).toEqual([line(1, "a"), line(2, "b"), line(3, "c\rd")]);
  });

  it("drops a BOM at the start of the stream, even split across chunks, and only there", () => {
    const data = bytes("\uFEFFa\n\uFEFFb\n");
    expect(run(splitAt(data, [1, 2]))).toEqual([line(1, "a"), line(2, "\uFEFFb")]);
    expect(run([new Uint8Array([0xef, 0xbb])])).toEqual([{ kind: "invalid-utf8", n: 1 }]);
    expect(run([new Uint8Array([0xef]), bytes("x\n")])).toEqual([{ kind: "invalid-utf8", n: 1 }]);
  });

  it("joins a multi-byte character split across chunks before decoding", () => {
    const data = bytes('{"name":"кошик 🛒"}\n');
    const cyrillic = data.indexOf(0xd0) + 1; // inside the 2-byte "к"
    const emoji = data.indexOf(0xf0) + 2; // inside the 4-byte emoji
    expect(run(splitAt(data, [cyrillic, emoji]))).toEqual([line(1, '{"name":"кошик 🛒"}')]);
    expect(
      run(
        splitAt(
          data,
          Array.from({ length: data.length - 1 }, (_, i) => i + 1)
        )
      )
    ).toEqual([line(1, '{"name":"кошик 🛒"}')]);
  });

  it("reports invalid UTF-8 per line, including a stream cut inside a sequence", () => {
    const cut = bytes("ok\nкошик").slice(0, -1);
    expect(run([cut])).toEqual([line(1, "ok"), { kind: "invalid-utf8", n: 2 }]);
  });

  it("caps a line before parsing: exactly the cap passes, cap + 1 is too-long (CR not counted)", () => {
    expect(run([bytes(`${"x".repeat(8)}\r\n`)], 8)).toEqual([line(1, "x".repeat(8))]);
    expect(run([bytes(`${"x".repeat(9)}\nok\n`)], 8)).toEqual([{ kind: "too-long", n: 1 }, line(2, "ok")]);
  });

  it("does not buffer a too-long line: the event comes before its line end, the rest is skipped", () => {
    const splitter = new LineSplitter(8);
    expect(splitter.push(bytes("x".repeat(20)))).toEqual([{ kind: "too-long", n: 1 }]);
    expect(splitter.push(bytes("y".repeat(20)))).toEqual([]);
    expect(splitter.push(bytes("z\nnext\n"))).toEqual([line(2, "next")]);
    expect(splitter.end()).toEqual([]);
  });
});
