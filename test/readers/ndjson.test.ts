/**
 * NDJSON reader (spec 4.5) and Review focus 5: a stream that does not end cleanly.
 * "Помилка рядка … зупиняє читання. TUI будує модель з уже прочитаних рядків і показує
 * банер stream stopped at line N: <reason>." Only a broken header is fatal.
 */
import { describe, expect, it } from "vitest";
import { openTarget } from "../../src/readers/open.js";
import { NDJSON_LIMITS, readNdjson, type NdjsonResult } from "../../src/readers/ndjson.js";
import { RECIPES } from "../fixture-recipes.js";
import { dataset } from "../trace-builder.js";
import { toNdjsonLines, toNdjsonText } from "../trace-writers.js";
import { bytes, chunks, failing, memoryFs, neverEnding, signal, splitAt } from "./reader-fakes.js";

const header = '{"type":"header","format":"kosmo-trace","version":1,"dataset":{"id":"ds"}}';
const span = (id: string, order: number, extra = "") =>
  `{"type":"span","trace":"t","session":"s1","id":"${id}","parent":null,"order":${order},"name":"${id}","status":"complete"${extra}}`;

async function read(parts: readonly (string | Uint8Array)[], limits = NDJSON_LIMITS): Promise<NdjsonResult> {
  return readNdjson(chunks(parts), { signal: signal(), limits });
}

function ids(result: NdjsonResult): string[] {
  if (!result.ok) throw new Error(result.error.message);
  return result.acc.spansOf("t").map((row) => row.ref.id);
}

describe("readNdjson: shape", () => {
  it("reads header, trace, span and link lines in any order", async () => {
    const doc = RECIPES["kosmo-trace/links"]!();
    const result = await read([toNdjsonText(doc, { order: "reverse" })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.info).toEqual(doc.dataset);
    expect(result.acc.traceSummaries().map((item) => item.id)).toEqual(["t_links", "t_links_server"]);
    expect(result.acc.spanCount).toBe(4);
    expect(result.notices).toEqual([]);
  });

  it("skips blank lines and counts unknown record types (spec 4.11)", async () => {
    const result = await read([`${header}\n\n   \n{"type":"metric","x":1}\n${span("a", 0)}\n{"type":"future"}\n`]);
    expect(ids(result)).toEqual(["a"]);
    expect(result.ok && result.notices).toEqual([{ kind: "unknown-lines-skipped", count: 2 }]);
  });

  it("the first line must be a header: otherwise not-a-kosmo-trace", async () => {
    expect(await read([`${span("a", 0)}\n`])).toEqual({
      ok: false,
      error: {
        code: "not-a-kosmo-trace",
        message: "not-a-kosmo-trace(line 1: the first line is not a header)",
        position: "line 1"
      }
    });
    expect(await read([""])).toEqual({
      ok: false,
      error: { code: "not-a-kosmo-trace", message: "not-a-kosmo-trace(line 1: no header line)", position: "line 1" }
    });
    const broken = await read(["{not json\n"]);
    expect(broken.ok === false && broken.error.message).toBe("not-a-kosmo-trace(line 1: not valid JSON)");
  });

  it("header validation errors are fatal with their own code", async () => {
    const result = await read(['{"type":"header","format":"kosmo-trace","version":2,"dataset":{"id":"d"}}\n']);
    expect(result.ok === false && result.error.code).toBe("unsupported-version");
  });
});

describe("readNdjson: stop semantics", () => {
  it("a second header stops the stream and keeps what was read", async () => {
    const result = await read([`${header}\n${span("a", 0)}\n${header}\n${span("b", 1)}\n`]);
    expect(ids(result)).toEqual(["a"]);
    expect(result.ok && result.notices).toEqual([
      { kind: "stream-stopped", line: 3, reason: "invalid(line 3: second header)" }
    ]);
  });

  it("a duplicate trace line stops the stream", async () => {
    const trace = '{"type":"trace","id":"t","name":"T"}';
    const result = await read([`${header}\n${trace}\n${span("a", 0)}\n${trace}\n`]);
    expect(ids(result)).toEqual(["a"]);
    const notice = result.ok ? result.notices[0] : undefined;
    expect(notice?.kind === "stream-stopped" && notice.line).toBe(4);
  });

  it("a fatal 4.9 violation stops the stream with the validator's position", async () => {
    const result = await read([`${header}\n${span("a", 0)}\n${span("b", 0)}\n${span("c", 2)}\n`]);
    expect(ids(result)).toEqual(["a"]);
    const notice = result.ok ? result.notices[0] : undefined;
    expect(notice).toMatchObject({ kind: "stream-stopped", line: 3 });
    expect(notice?.kind === "stream-stopped" && notice.reason.startsWith("invalid(line 3")).toBe(true);
  });

  it("the last line without a line end is read (Review focus 5)", async () => {
    expect(ids(await read([`${header}\n${span("a", 0)}\n${span("b", 1)}`]))).toEqual(["a", "b"]);
  });

  it("a BOM and CRLF line ends are accepted (Review focus 5)", async () => {
    const doc = RECIPES["kosmo-trace/basic"]!();
    const result = await read([toNdjsonText(doc, { bom: true, crlf: true })]);
    expect(result.ok && result.acc.spanCount).toBe(4);
    expect(result.ok && result.notices).toEqual([]);
  });

  it("a UTF-8 character split across chunks is decoded intact (Review focus 5)", async () => {
    const data = bytes(`${header}\n${span("a", 0, ',"statusReason":"кошик 🛒"')}\n`);
    const offsets = [data.indexOf(0xd0) + 1, data.indexOf(0xf0) + 1, data.indexOf(0xf0) + 3];
    const result = await read(splitAt(data, offsets));
    expect(result.ok && result.acc.spansOf("t")[0]?.statusReason).toBe("кошик 🛒");
  });

  it("the producer dies in the middle of a line: keep the rest, stop at that line (Review focus 5)", async () => {
    const result = await read([`${header}\n${span("a", 0)}\n${span("b", 1)}\n{"type":"span","trace":"t","ses`]);
    expect(ids(result)).toEqual(["a", "b"]);
    expect(result.ok && result.notices).toEqual([
      { kind: "stream-stopped", line: 4, reason: "invalid(line 4: not valid JSON)" }
    ]);
  });

  it("the stream ends inside a UTF-8 sequence: stop at that line", async () => {
    const data = bytes(`${header}\n${span("a", 0)}\n{"type":"span","name":"к`).slice(0, -1);
    const result = await read([data]);
    expect(ids(result)).toEqual(["a"]);
    expect(result.ok && result.notices[0]).toEqual({
      kind: "stream-stopped",
      line: 3,
      reason: "invalid(line 3: not valid UTF-8)"
    });
  });

  it("a line of exactly 1 MiB is parsed, 1 MiB + 1 stops the stream (Review focus 5)", async () => {
    // span(...) plus an ignored field padded so that the line is exactly `total` bytes
    const fit = (id: string, order: number, total: number) =>
      span(id, order, `,"x-pad":"${"p".repeat(total - bytes(span(id, order)).length - ',"x-pad":""'.length)}"`);
    const exact = fit("a", 0, 1_048_576);
    const over = fit("b", 1, 1_048_577);
    expect(bytes(exact).length).toBe(1_048_576);
    expect(bytes(over).length).toBe(1_048_577);
    const result = await read([`${header}\n${exact}\n${over}\n${span("c", 2)}\n`]);
    expect(ids(result)).toEqual(["a"]);
    expect(result.ok && result.notices).toEqual([
      { kind: "stream-stopped", line: 3, reason: "too-large(line 3: line exceeds 1048576 bytes)" }
    ]);
  });

  it("more than streamSpans spans: stream stopped: too-large", async () => {
    const limits = { ...NDJSON_LIMITS, streamSpans: 2 };
    const result = await read([`${header}\n${span("a", 0)}\n${span("b", 1)}\n${span("c", 2)}\n`], limits);
    expect(ids(result)).toEqual(["a", "b"]);
    expect(result.ok && result.notices).toEqual([{ kind: "stream-stopped", line: null, reason: "too-large" }]);
  });

  it("more than streamBytes: lines inside the cap are kept, the cut line is dropped", async () => {
    const text = `${header}\n${span("a", 0)}\n${span("b", 1)}\n`;
    const limits = { ...NDJSON_LIMITS, streamBytes: text.length - 5 };
    const result = await read([text], limits);
    expect(ids(result)).toEqual(["a"]);
    expect(result.ok && result.notices).toEqual([{ kind: "stream-stopped", line: null, reason: "too-large" }]);
  });

  it("a read error after the header stops the stream; before it, it is fatal", async () => {
    const after = await readNdjson(failing([`${header}\n${span("a", 0)}\n`], "input/output error"), {
      signal: signal()
    });
    expect(ids(after)).toEqual(["a"]);
    expect(after.ok && after.notices).toEqual([
      { kind: "stream-stopped", line: null, reason: "read-error(EIO: input/output error)" }
    ]);
    const before = await readNdjson(failing([], "input/output error"), { signal: signal() });
    expect(before).toEqual({
      ok: false,
      error: { code: "read-error", message: "read-error: EIO: input/output error" }
    });
  });
});

describe("readNdjson: progress and abort", () => {
  it("reports progress after chunks and once at the end", async () => {
    const seen: number[] = [];
    const doc = dataset("ds").trace("t").span("a", "a").span("b", "b").span("c", "c").build();
    const lines = toNdjsonLines(doc).map((line) => `${line}\n`);
    await readNdjson(chunks(lines), { signal: signal(), onProgress: (spans) => seen.push(spans) });
    expect(seen).toEqual([0, 0, 1, 2, 3, 3]);
  });

  it("a stdin that never ends: progress arrives, abort returns at once (Review focus 5)", async () => {
    const controller = new AbortController();
    const stdin = neverEnding([`${header}\n${span("a", 0)}\n`]);
    let progressed!: () => void;
    const firstSpan = new Promise<void>((resolve) => (progressed = resolve));
    const pending = openTarget(
      "stdin",
      {
        fs: memoryFs(),
        stdin,
        onProgress: (spans) => {
          if (spans === 1) progressed();
        }
      },
      controller.signal
    );
    await firstSpan;
    controller.abort();
    expect(await pending).toEqual({
      ok: false,
      error: { code: "stream-stopped", message: "stream-stopped: reading was cancelled" }
    });
    expect(stdin.returned).toBe(true);
  });
});

describe("openTarget with NDJSON", () => {
  it("opens an .ndjson file through createReadStream", async () => {
    const doc = RECIPES["kosmo-trace/basic"]!();
    const fs = memoryFs({ "x.kosmo-trace.ndjson": toNdjsonText(doc) });
    const result = await openTarget({ path: "x.kosmo-trace.ndjson" }, { fs }, signal());
    expect(result.ok && result.dataset.kind).toBe("ndjson");
    expect(fs.calls).toContain("createReadStream x.kosmo-trace.ndjson");
    if (!result.ok) return;
    const loaded = await result.dataset.loadTrace("t_cart", signal());
    expect(loaded.ok && loaded.model.size).toBe(4);
  });

  it("opens NDJSON from stdin with the same sniff rule", async () => {
    const doc = RECIPES["kosmo-trace/multi-session"]!();
    const text = toNdjsonText(doc);
    const parts = text.match(/[\s\S]{1,5}/g) ?? [];
    const result = await openTarget("stdin", { fs: memoryFs(), stdin: chunks(parts) }, signal());
    expect(result.ok && result.dataset.kind).toBe("ndjson");
    expect(result.ok && result.dataset.origin).toBe("stdin");
    expect(result.ok && result.dataset.traces.items.map((item) => item.id)).toEqual([
      "t_checkout",
      "t_health",
      "t_orphan"
    ]);
  });

  it("a stopped stream still opens, with the notice (the TUI shows the banner)", async () => {
    const result = await openTarget(
      "stdin",
      { fs: memoryFs(), stdin: chunks([`${header}\n${span("a", 0)}\n{oops\n`]) },
      signal()
    );
    expect(result.ok && result.dataset.notices).toEqual([
      { kind: "stream-stopped", line: 3, reason: "invalid(line 3: not valid JSON)" }
    ]);
  });
});
