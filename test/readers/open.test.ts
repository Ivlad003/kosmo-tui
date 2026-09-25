/**
 * openTarget / reopen (spec 5.4, 6.8): path errors, sniff-then-dispatch, stdin (the same
 * sniff rule, a JSON document collected up to 64 MiB, no SQLite over a stream).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { openTarget, reopen } from "../../src/readers/open.js";
import { SQLITE_MAGIC, sniffContainer } from "../../src/readers/sniff.js";

vi.mock("../../src/readers/sniff.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/readers/sniff.js")>();
  return { ...original, sniffContainer: vi.fn(original.sniffContainer) };
});
import { fixtureFile } from "../fixture-recipes.js";
import { chunks, memoryFs, neverEnding, signal } from "./reader-fakes.js";

const basicText = readFileSync(fixtureFile("kosmo-trace/basic"), "utf8");

describe("openTarget: paths", () => {
  it("a missing path is file-not-found", async () => {
    expect(await openTarget({ path: "nope.json" }, { fs: memoryFs() }, signal())).toEqual({
      ok: false,
      error: { code: "file-not-found", message: "file-not-found: nope.json" }
    });
  });

  it("a directory is is-directory", async () => {
    expect(await openTarget({ path: "traces" }, { fs: memoryFs({ traces: null }) }, signal())).toEqual({
      ok: false,
      error: { code: "is-directory", message: "is-directory: traces" }
    });
  });

  it("a stat failure other than a missing file is read-error", async () => {
    const fs = memoryFs();
    fs.stat = async () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    };
    expect(await openTarget({ path: "locked.json" }, { fs }, signal())).toEqual({
      ok: false,
      error: { code: "read-error", message: "read-error: locked.json: EACCES: permission denied" }
    });
  });

  it("an empty file without a telling extension is not-a-kosmo-trace", async () => {
    expect(await openTarget({ path: "empty.txt" }, { fs: memoryFs({ "empty.txt": "" }) }, signal())).toEqual({
      ok: false,
      error: { code: "not-a-kosmo-trace", message: "not-a-kosmo-trace($: empty input)", position: "$" }
    });
  });

  it("sniffs the head and opens a JSON document", async () => {
    const fs = memoryFs({ "x.kosmo-trace.json": basicText });
    const result = await openTarget({ path: "x.kosmo-trace.json" }, { fs }, signal());
    expect(result.ok && result.dataset.kind).toBe("json");
    expect(fs.calls).toEqual([
      "stat x.kosmo-trace.json",
      "readHead x.kosmo-trace.json 1052672",
      "readFile x.kosmo-trace.json"
    ]);
  });

  it("an already aborted signal opens nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const fs = memoryFs({ "x.json": basicText });
    const result = await openTarget({ path: "x.json" }, { fs }, controller.signal);
    expect(result.ok === false && result.error.code).toBe("stream-stopped");
    expect(fs.calls).toEqual([]);
  });
});

describe("openTarget: stdin", () => {
  it("stdin without a stream is read-error", async () => {
    expect(await openTarget("stdin", { fs: memoryFs() }, signal())).toEqual({
      ok: false,
      error: { code: "read-error", message: "read-error: stdin is not available" }
    });
  });

  it("a JSON document on stdin, in small chunks", async () => {
    const parts = basicText.match(/[\s\S]{1,7}/g) ?? [];
    const result = await openTarget("stdin", { fs: memoryFs(), stdin: chunks(parts) }, signal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dataset.origin).toBe("stdin");
    expect(result.dataset.traces.items.map((item) => item.id)).toEqual(["t_cart"]);
  });

  it("empty stdin is not-a-kosmo-trace", async () => {
    const result = await openTarget("stdin", { fs: memoryFs(), stdin: chunks([]) }, signal());
    expect(result.ok === false && result.error.message).toBe("not-a-kosmo-trace($: empty input)");
  });

  it("SQLite bytes on stdin are refused and the stream is released", async () => {
    const stdin = neverEnding([String.fromCharCode(...SQLITE_MAGIC) + "rest\n"]);
    const result = await openTarget("stdin", { fs: memoryFs(), stdin }, signal());
    expect(result).toEqual({
      ok: false,
      error: { code: "read-error", message: "read-error: a SQLite store cannot be read from a stream; pass its path" }
    });
    expect(stdin.returned).toBe(true);
  });

  it("SQLite magic split over chunks and no newline is refused at the magic length", async () => {
    const magic = String.fromCharCode(...SQLITE_MAGIC);
    const stdin = neverEnding([magic.slice(0, 5), magic.slice(5), "page bytes without a line end"]);
    const result = await openTarget("stdin", { fs: memoryFs(), stdin }, signal());
    expect(result.ok === false && result.error.code).toBe("read-error");
    expect(stdin.returned).toBe(true);
  });

  it("sniffs once the accumulated head holds the first line, even if its newline came earlier", async () => {
    const sniff = vi.mocked(sniffContainer);
    sniff.mockClear();
    const result = await openTarget(
      "stdin",
      { fs: memoryFs(), stdin: chunks(["{}", "\n", "  ", "0123456789abcdefghij"]) },
      signal()
    );
    expect(result.ok).toBe(false);
    expect(sniff).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(sniff.mock.calls[0]?.[0])).toBe("{}\n");
  });

  it("aborting while stdin is silent returns at once (Review focus 5)", async () => {
    const controller = new AbortController();
    const stdin = neverEnding(["{"]);
    const pending = openTarget("stdin", { fs: memoryFs(), stdin }, controller.signal);
    setTimeout(() => controller.abort(), 10);
    const result = await pending;
    expect(result).toEqual({
      ok: false,
      error: { code: "stream-stopped", message: "stream-stopped: reading was cancelled" }
    });
    expect(stdin.returned).toBe(true);
  });
});

describe("reopen", () => {
  it("is null for stdin: reload is unavailable(stdin-stream)", async () => {
    const result = await openTarget("stdin", { fs: memoryFs(), stdin: chunks([basicText]) }, signal());
    if (!result.ok) throw new Error(result.error.message);
    expect(reopen(result.dataset, { fs: memoryFs() }, signal())).toBeNull();
  });

  it("reads a path again and sees the new content", async () => {
    const fs = memoryFs({ "x.json": basicText });
    const first = await openTarget({ path: "x.json" }, { fs }, signal());
    if (!first.ok) throw new Error(first.error.message);
    fs.files.set("x.json", new TextEncoder().encode(basicText.replaceAll("t_cart", "t_cart2")));
    const second = await reopen(first.dataset, { fs }, signal());
    expect(second?.ok && second.dataset.traces.items.map((item) => item.id)).toEqual(["t_cart2"]);
  });
});
