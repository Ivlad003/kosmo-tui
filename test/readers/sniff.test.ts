/**
 * Spec 6.8 container detection: SQLite magic first; otherwise the first non-empty line
 * (≤ 1 MiB, BOM dropped) parsed as a complete object with "type":"header" → ndjson, else
 * json; the extension decides only ambiguous cases. The same rule for stdin (no path).
 */
import { describe, expect, it } from "vitest";
import { SNIFF_HEAD_BYTES, SQLITE_MAGIC, firstLineComplete, sniffContainer } from "../../src/readers/sniff.js";
import { bytes } from "./reader-fakes.js";

const header = '{"type":"header","format":"kosmo-trace","version":1,"dataset":{"id":"ds"}}';

describe("sniffContainer (spec 6.8)", () => {
  it("SQLite magic wins over any extension", () => {
    const head = new Uint8Array([...SQLITE_MAGIC, 0x10, 0x00]);
    expect(sniffContainer(head, "x.kosmo-trace.json")).toBe("sqlite");
    expect(sniffContainer(head)).toBe("sqlite");
  });

  it("a first line that is a complete header object means ndjson, whatever the extension", () => {
    expect(sniffContainer(bytes(`${header}\n{"type":"span"}\n`), "trace.json")).toBe("ndjson");
    expect(sniffContainer(bytes(`\uFEFF${header}\r\n`))).toBe("ndjson");
    expect(sniffContainer(bytes(`\n  \r\n\t\n${header}\n`))).toBe("ndjson");
    // no line end at all: the header is the whole input
    expect(sniffContainer(bytes(header))).toBe("ndjson");
  });

  it("anything else is a JSON document", () => {
    expect(sniffContainer(bytes('{\n  "format": "kosmo-trace",\n  "version": 1\n}\n'), "x.ndjson")).toBe("json");
    expect(sniffContainer(bytes('{"format":"kosmo-trace","version":1,"dataset":{"id":"d"},"spans":[]}'))).toBe("json");
    expect(sniffContainer(bytes("not json at all\n"))).toBe("json");
    expect(sniffContainer(bytes('["type","header"]\n'))).toBe("json");
    expect(sniffContainer(bytes('{"type":"header"'))).toBe("json");
  });

  it("the extension decides only ambiguous heads", () => {
    const record = '{"type":"span","trace":"t"}\n';
    expect(sniffContainer(bytes(record), "x.kosmo-trace.ndjson")).toBe("ndjson");
    expect(sniffContainer(bytes(record), "x.kosmo-trace.json")).toBe("json");
    expect(sniffContainer(bytes(record))).toBe("json");
    expect(sniffContainer(bytes(""), "x.kosmo-trace.ndjson")).toBe("ndjson");
    expect(sniffContainer(bytes("\n\n"), "x.kosmo-trace.SQLITE")).toBe("sqlite");
    expect(sniffContainer(bytes(" \n"), "x.kosmo-trace.json")).toBe("json");
    expect(sniffContainer(bytes(""))).toBeNull();
    expect(sniffContainer(bytes("\uFEFF\n"), "notes.txt")).toBeNull();
  });

  it("a first line over 1 MiB is never ndjson", () => {
    const padded = `{"type":"header","format":"kosmo-trace","version":1,"dataset":{"id":"ds"},"pad":"${"x".repeat(1_048_576)}"}\n`;
    expect(sniffContainer(bytes(padded).slice(0, SNIFF_HEAD_BYTES))).toBe("json");
  });

  it("firstLineComplete tells a stream reader when the head is enough", () => {
    expect(firstLineComplete(bytes(header))).toBe(false);
    expect(firstLineComplete(bytes(`\uFEFF\n\n${header}\n`))).toBe(true);
    expect(firstLineComplete(bytes("\n\n"))).toBe(false);
  });
});
