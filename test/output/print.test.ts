/** Task 23: `--print` and the table of spec 7.1, with the exit codes of spec 6.8. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { PrintArgs } from "../../src/args.js";
import { validateDocument } from "../../src/format/validate.js";
import { TEXT_VALUE_SPANS, runPrint } from "../../src/output/print.js";
import { EXIT_OK, EXIT_SOURCE, EXIT_USAGE } from "../../src/proc.js";
import { nodeReaderFs } from "../../src/readers/node-fs.js";
import { loadSqliteModule } from "../../src/readers/sqlite-loader.js";
import type { ReaderDeps } from "../../src/readers/types.js";
import { RECIPES, fixtureFile } from "../fixture-recipes.js";
import { chunks, memoryFs } from "../readers/reader-fakes.js";
import { dataset, recorded } from "../trace-builder.js";
import { NODE_SQLITE_AVAILABLE, cleanupTempDirs, toNdjsonLines, writeAllContainers } from "../trace-writers.js";
import { fakeProc } from "../ui/proc-fakes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASIC = readFileSync(fixtureFile("kosmo-trace/basic"), "utf8");
const LINKS = readFileSync(fixtureFile("kosmo-trace/links"), "utf8");
const GOLDEN = readFileSync(path.join(here, "../golden/basic.t_cart.kosmo-text"), "utf8");
const NDJSON = toNdjsonLines(RECIPES["kosmo-trace/basic"]!()).map((line) => `${line}\n`);

afterAll(() => cleanupTempDirs());

async function print(args: Omit<PrintArgs, "command">, reader: ReaderDeps) {
  const proc = fakeProc([]);
  const code = await runPrint(
    { args: { command: "print", ...args }, proc, signal: new AbortController().signal },
    { reader }
  );
  return { code, out: proc.out, err: proc.err };
}

const file = (text: string) => ({ fs: memoryFs({ "x.kosmo-trace.json": text }) });

describe("--print --format text (kosmo-text/v1)", () => {
  it("prints the golden projection with --detail 1 (the default)", async () => {
    expect(
      await print({ target: "x.kosmo-trace.json", format: "text", trace: "t_cart", detail: 1 }, file(BASIC))
    ).toEqual({ code: EXIT_OK, out: GOLDEN, err: "" });
  });

  it("--detail 0 keeps only the header and the span lines", async () => {
    const run = await print({ target: "x.kosmo-trace.json", format: "text", trace: "t_cart", detail: 0 }, file(BASIC));
    expect(run.out.split("\n").filter((line) => line !== "")).toHaveLength(5);
    expect(run.out).not.toContain("args=");
  });

  it("stdin is read to EOF without a deadline and gives the same text", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = (async function* () {
      yield new TextEncoder().encode(NDJSON[0]!);
      await gate;
      for (const line of NDJSON.slice(1)) yield new TextEncoder().encode(line);
    })();
    const proc = fakeProc([]);
    const pending = runPrint(
      {
        args: { command: "print", target: "-", format: "text", trace: "t_cart", detail: 1 },
        proc,
        signal: new AbortController().signal
      },
      { reader: { fs: memoryFs(), stdin: slow } }
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(proc.out).toBe("");
    release();
    expect(await pending).toBe(EXIT_OK);
    expect(proc.out).toBe(GOLDEN);
  });
});

describe("--print --format tab and json", () => {
  it("tab without --trace lists the traces, with --trace one row per span", async () => {
    expect((await print({ target: "x.kosmo-trace.json", format: "tab", detail: 1 }, file(BASIC))).out).toBe(
      "t_cart\tGET /cart\t4\terrored\n"
    );
    const spans = await print({ target: "x.kosmo-trace.json", format: "tab", trace: "t_cart", detail: 1 }, file(BASIC));
    expect(spans.out.split("\n")[2]).toBe("s1\tsp_3\tsp_1\terrored\tfunction\tsrc/cart.ts:12\tcalculateLineTotal");
  });

  it("json without --trace is a document that validates again", async () => {
    const run = await print({ target: "x.kosmo-trace.json", format: "json", detail: 1 }, file(BASIC));
    const parsed = validateDocument(JSON.parse(run.out));
    expect(parsed.ok && parsed.acc.spanCount).toBe(4);
  });

  it("json --trace keeps the trace and every link with an end in it (spec 4.12)", async () => {
    const run = await print(
      { target: "x.kosmo-trace.json", format: "json", trace: "t_links_server", detail: 1 },
      file(LINKS)
    );
    const doc = JSON.parse(run.out) as { traces: Array<{ id: string }>; links: Array<{ to: { id: string } }> };
    expect(doc.traces.map((trace) => trace.id)).toEqual(["t_links_server"]);
    expect(doc.links.map((link) => link.to.id)).toEqual(["f1"]);
  });
});

describe("failures (spec 6.8)", () => {
  it("a missing path or a directory is 1, a format error 2; stdout stays empty", async () => {
    const missing = await print({ target: "nope.json", format: "json", detail: 1 }, { fs: memoryFs() });
    expect(missing).toEqual({ code: EXIT_USAGE, out: "", err: "kosmo-tui: file-not-found: nope.json\n" });
    const directory = await print({ target: "dir", format: "json", detail: 1 }, { fs: memoryFs({ dir: null }) });
    expect(directory.code).toBe(EXIT_USAGE);
    const wrong = await print({ target: "x.kosmo-trace.json", format: "json", detail: 1 }, file('{"format":"x"}'));
    expect(wrong.code).toBe(EXIT_SOURCE);
    expect(wrong.out).toBe("");
    expect(wrong.err).toMatch(/^kosmo-tui: not-a-kosmo-trace\(/);
  });

  it("an unknown --trace is 2 with the reader's reason", async () => {
    const run = await print({ target: "x.kosmo-trace.json", format: "tab", trace: "nope", detail: 1 }, file(BASIC));
    expect(run).toEqual({
      code: EXIT_SOURCE,
      out: "",
      err: 'kosmo-tui: invalid(trace: no trace "nope" in this dataset)\n'
    });
  });

  it("a stream stopped by a bad line prints nothing: stderr has the line, exit 2 (spec 4.5)", async () => {
    const stdin = chunks([...NDJSON.slice(0, 3), "{oops\n", ...NDJSON.slice(3)]);
    const run = await print({ target: "-", format: "tab", detail: 1 }, { fs: memoryFs(), stdin });
    expect(run.code).toBe(EXIT_SOURCE);
    expect(run.out).toBe("");
    expect(run.err).toMatch(/^kosmo-tui: stream stopped at line 4: /);
  });

  it("a failed write (EPIPE) is exit 2 with a note, never a success", async () => {
    const proc = fakeProc([]);
    proc.stdout = {
      writable: true,
      write: (_chunk: string, callback?: (error?: Error | null) => void) => {
        callback?.(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        return false;
      }
    };
    const code = await runPrint(
      {
        args: { command: "print", target: "x.kosmo-trace.json", format: "tab", detail: 1 },
        proc,
        signal: new AbortController().signal
      },
      { reader: file(BASIC) }
    );
    expect(code).toBe(EXIT_SOURCE);
    expect(proc.err).toBe("kosmo-tui: output ended early (EPIPE)\n");
  });

  it("control characters of the input never reach stderr raw", async () => {
    const run = await print({ target: "a\u001b]0;x\u0007.json", format: "json", detail: 1 }, { fs: memoryFs() });
    expect(run.err).toBe("kosmo-tui: file-not-found: a\\u001b]0;x\\u0007.json\n");
  });
});

describe.skipIf(!NODE_SQLITE_AVAILABLE)("--print over SQLite: lazy values", () => {
  it("text --detail 1 reads the values and matches the JSON golden text", async () => {
    expect(TEXT_VALUE_SPANS).toBe(1024);
    const written = writeAllContainers(RECIPES["kosmo-trace/basic"]!(), "basic");
    const reader: ReaderDeps = { fs: nodeReaderFs, loadSqlite: () => loadSqliteModule() };
    for (const target of [written.sqlite, written.ndjson, written.json]) {
      const run = await print({ target, format: "text", trace: "t_cart", detail: 1 }, reader);
      expect(run, target).toEqual({ code: EXIT_OK, out: GOLDEN, err: "" });
    }
    const json = await print({ target: written.sqlite, format: "json", detail: 1 }, reader);
    const parsed = JSON.parse(json.out) as { spans: Array<{ id: string; args?: unknown }> };
    expect(parsed.spans.find((span) => span.id === "sp_2")?.args).toEqual({ state: "recorded", value: ["u_42"] });
  });

  it("text --detail 1 reads the values of every span that fits under the cap, not only the first 800", async () => {
    // 1 000 of the smallest groups (a 21 B span line and a 30 B detail line) fit in 51 200 B.
    const builder = dataset("ds_cap").trace("t_cap", "cap");
    for (let index = 0; index < 1000; index += 1) {
      builder.span(`s${index}`, "a", {
        location: { file: "a", line: 1 },
        area: { module: "a" },
        args: recorded(0),
        return: recorded(0),
        error: recorded(0)
      });
    }
    const written = writeAllContainers(builder.build(), "cap");
    const reader: ReaderDeps = { fs: nodeReaderFs, loadSqlite: () => loadSqliteModule() };
    const fromJson = await print({ target: written.json, format: "text", trace: "t_cap", detail: 1 }, reader);
    expect(fromJson.out).not.toContain("truncated");
    expect(fromJson.out).not.toContain("not-recorded");
    const fromSqlite = await print({ target: written.sqlite, format: "text", trace: "t_cap", detail: 1 }, reader);
    expect(fromSqlite).toEqual(fromJson);
  });
});
