/**
 * Task 7.4: one-shot `--print`. Bounded dataset list without a trace (never a random
 * trace), the selected trace's projection with version/format selection, summary-only
 * sources as tables (Lisp needs the canonical capability), 51,200-byte STRUCTURAL
 * truncation with a valid envelope, no review/ANSI, a finite stdin stream with a 5 s
 * deadline, and an empty stdout whenever anything fails before the single write.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  connectSnapshotId,
  connectTraceRef,
  encodeCanonicalChunks,
  headerFrame,
  headerFrameV2,
  parseTraceText,
  parseTraceTextV2,
  traceFrame,
  type ConnectSnapshotInput,
  type ConnectSnapshotManifestEntry
} from "@kosmo-callflow/protocol";
import type { ReplayRecord } from "@kosmo-callflow/replay";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgv, run, type Invocation, type ViewerArgs } from "../src/cli.js";
import type { ResolvedTarget } from "../src/detect.js";
import { PRINT_STDIN_DEADLINE_MS, runPrintCommand, TRACE_LIST_SCHEMA, type PrintDeps } from "../src/print.js";
import { OUTPUT_MAX_BYTES } from "../src/serializers.js";
import type { StreamInput } from "../src/source-stream.js";
import { fakeProc, type FakeProc } from "./helpers.js";
import { canonicalV2, portableExport } from "./source-fixtures.js";
import { event } from "./replay-records.js";

const ESC = String.fromCharCode(27);
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "kosmo-tui-print-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function exportFile(records?: ReplayRecord[], name = "trace.json"): Promise<string> {
  const file = path.join(tmp, name);
  await writeFile(file, JSON.stringify(portableExport(records)));
  return file;
}

function viewerArgs(argv: string[]): ViewerArgs {
  const parsed = parseArgv(argv);
  if (!parsed.ok || parsed.args.command !== "viewer") throw new Error(`bad argv ${argv.join(" ")}`);
  return parsed.args;
}

async function print(
  argv: string[],
  target: ResolvedTarget,
  deps: PrintDeps = {},
  proc: FakeProc = fakeProc(argv, { stdoutTty: false, cwd: tmp })
): Promise<{ code: number; out: string; err: string; proc: FakeProc }> {
  const invocation: Invocation<ViewerArgs> = {
    args: viewerArgs(argv),
    target,
    project: null,
    proc,
    signal: new AbortController().signal
  };
  const code = await runPrintCommand(invocation, deps);
  return { code, out: proc.out, err: proc.err, proc };
}

/** `count` traces, one span each with a recorded argument. */
function manyTraces(count: number): ReplayRecord[] {
  const records: ReplayRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const traceId = `trace-${String(index).padStart(5, "0")}`;
    records.push(event({ seq: index * 2 + 1, traceId, payload: { args: [index] } }));
    records.push(event({ seq: index * 2 + 2, traceId, type: "exit", payload: { ret: index } }));
  }
  return records;
}

/** One trace with `count` child spans, each carrying a sizable argument. */
function wideTrace(count: number): ReplayRecord[] {
  const records: ReplayRecord[] = [event({ seq: 1, spanId: "root", payload: { args: ["root"] } })];
  for (let index = 0; index < count; index += 1) {
    const spanId = `c-${String(index).padStart(4, "0")}`;
    records.push(
      event({
        seq: 2 + index * 2,
        spanId,
        parentSpanId: "root",
        nodeId: `src/module-${index}.ts#work`,
        payload: { args: ["x".repeat(120)] }
      }),
      event({ seq: 3 + index * 2, spanId, parentSpanId: "root", type: "exit", nodeId: `src/module-${index}.ts#work` })
    );
  }
  records.push(event({ seq: 10_000, spanId: "root", type: "exit" }));
  return records;
}

describe("--print: dataset list without a trace", () => {
  it("returns the bounded dataset list as a table, never a trace projection", async () => {
    const file = await exportFile(manyTraces(3));
    const json = await print([file, "--print", "json"], { kind: "export", path: file });
    expect(json.code).toBe(0);
    expect(json.err).toBe("");
    const table = JSON.parse(json.out) as {
      kind: string;
      schema: string;
      rows: unknown[][];
      coverage: { scope: string; cursor: string | null };
    };
    expect(table).toMatchObject({ kind: "table", schema: TRACE_LIST_SCHEMA, truncated: false });
    // The source's own order (newest first); every trace of the dataset, none picked.
    expect(table.rows.map((row) => row[3])).toEqual(["trace-00002", "trace-00001", "trace-00000"]);
    expect(table.coverage).toMatchObject({ scope: "complete", cursor: null });
    expect(json.out).not.toContain("kosmo.trace-text");

    // No explicit format: the table default is JSON, still the list.
    const auto = await print([file, "--print"], { kind: "export", path: file });
    expect(JSON.parse(auto.out)).toMatchObject({ schema: TRACE_LIST_SCHEMA });

    const tab = await print([file, "--print", "tab"], { kind: "export", path: file });
    expect(tab.code).toBe(0);
    expect(tab.out.split("\n")[0]).toBe("kosmo.query-table/v1");
    expect(tab.out).toContain("trace-00002");
  });

  it("lisp without a trace is a usage error before the source is even opened", async () => {
    const reads: string[] = [];
    const file = path.join(tmp, "never-read.json");
    const result = await print(
      [file, "--print", "lisp"],
      { kind: "export", path: file },
      {
        source: {
          exportFs: {
            size: async (target: string) => {
              reads.push(target);
              return 1;
            },
            readBounded: async (target: string) => {
              reads.push(target);
              return new TextEncoder().encode("{}");
            }
          }
        }
      }
    );
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toContain("pass --trace <id>");
    expect(reads).toEqual([]);
  });

  it("truncates a large list at item boundaries inside 51,200 bytes, keeping a valid envelope", async () => {
    const file = await exportFile(manyTraces(900));
    for (const format of ["json", "tab"] as const) {
      const result = await print([file, "--print", format], { kind: "export", path: file });
      expect(result.code, format).toBe(0);
      expect(bytes(result.out), format).toBeLessThanOrEqual(OUTPUT_MAX_BYTES);
      expect(bytes(result.out), format).toBeGreaterThan(OUTPUT_MAX_BYTES - 1_000);
      expect(result.out.endsWith("\n"), format).toBe(true);
      if (format === "json") {
        const table = JSON.parse(result.out) as { truncated: boolean; truncation: unknown; rows: unknown[][] };
        expect(table.truncated).toBe(true);
        expect(table.truncation).toMatchObject({ reason: "byte-limit", maxBytes: OUTPUT_MAX_BYTES });
        expect(table.rows.length).toBeLessThan(900);
        // Every kept row is whole.
        for (const row of table.rows) expect(row).toHaveLength(7);
      } else {
        expect(result.out).toContain("truncated=true reason=byte-limit");
        const rows = result.out.trimEnd().split("\n").slice(3);
        for (const row of rows) expect(row.split("\t")).toHaveLength(7);
      }
    }
  });
});

describe("--print: the selected trace", () => {
  it("defaults to the v2 Lisp projection; --projection-version 1 selects legacy; json is the trace-text IR", async () => {
    const file = await exportFile();
    const lisp = await print([file, "--print", "--trace", "t-1"], { kind: "export", path: file });
    expect(lisp.code).toBe(0);
    expect(lisp.out.startsWith("(kosmo.trace-text/v2")).toBe(true);
    const parsed = parseTraceTextV2(lisp.out, { dialect: "lisp" });
    expect(parsed.ok && parsed.data.items.map((item) => item.kind === "span" && item.ref.spanId)).toEqual([
      "sp-1",
      "sp-2"
    ]);

    const legacy = await print([file, "--print", "lisp", "--trace", "t-1", "--projection-version", "1"], {
      kind: "export",
      path: file
    });
    expect(legacy.code).toBe(0);
    expect(parseTraceText(legacy.out, { dialect: "lisp" }).ok).toBe(true);
    expect(legacy.out.startsWith("(kosmo.trace-text/v1")).toBe(true);

    const tab = await print([file, "--print", "tab", "--trace", "t-1"], { kind: "export", path: file });
    expect(parseTraceTextV2(tab.out, { dialect: "tab" }).ok).toBe(true);

    const json = await print([file, "--print", "json", "--trace", "t-1", "--values"], { kind: "export", path: file });
    expect(JSON.parse(json.out)).toMatchObject({ dialect: "kosmo.trace-text/v2", values: "requested" });
    expect(json.out).toContain("cart-1");
  });

  it("an unknown trace is a source error with empty stdout", async () => {
    const file = await exportFile();
    const result = await print([file, "--print", "--trace", "nope"], { kind: "export", path: file });
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toContain("trace nope was not found");
  });

  it("truncates a large projection on item boundaries; the codec output still parses", async () => {
    const file = await exportFile(wideTrace(400));
    for (const format of ["lisp", "tab"] as const) {
      const result = await print([file, "--print", format, "--trace", "t-1", "--values"], {
        kind: "export",
        path: file
      });
      expect(result.code, format).toBe(0);
      expect(bytes(result.out), format).toBeLessThanOrEqual(OUTPUT_MAX_BYTES);
      const parsed = parseTraceTextV2(result.out, { dialect: format });
      expect(parsed.ok, format).toBe(true);
      expect(parsed.ok && parsed.data.truncated, format).toBe(true);
    }
    const json = await print([file, "--print", "json", "--trace", "t-1", "--values"], { kind: "export", path: file });
    expect(bytes(json.out)).toBeLessThanOrEqual(OUTPUT_MAX_BYTES);
    const document = JSON.parse(json.out) as { truncated: boolean; items: unknown[]; coverage: unknown };
    expect(document.truncated).toBe(true);
    expect(document.items.length).toBeGreaterThan(0);
    expect(document.items.length).toBeLessThan(401);
    expect(document.coverage).toBeDefined();
  });

  it("never writes ANSI and never creates a review, even inside a project", async () => {
    const project = path.join(tmp, "app");
    await mkdir(path.join(project, ".kosmo-callflow"), { recursive: true });
    await writeFile(path.join(project, ".kosmo-callflow", "project.json"), JSON.stringify({ projectId: "p" }));
    const file = await exportFile(undefined, "app/trace.json");
    const proc = fakeProc([file, "--print", "--trace", "t-1"], { stdoutTty: true, cwd: project });
    const result = await print([file, "--print", "--trace", "t-1"], { kind: "export", path: file }, {}, proc);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain(ESC);
    expect(existsSync(path.join(project, ".kosmo-callflow", "reviews"))).toBe(false);
    expect(await readdir(path.join(project, ".kosmo-callflow"))).toEqual(["project.json"]);
  });
});

/* ------------------------------------------------------------------ stdin streams */

const snap: ConnectSnapshotInput = {
  dataset: { projectId: "p", datasetId: "local", graphRevision: "g-1", watermarkSeq: 25, retentionEpoch: 1 },
  cursor: "http://127.0.0.1:41729/api/v1/live/deltas?cursor=c-0"
};
const summary = (traceId: string) =>
  traceFrame({
    traceId,
    sessionId: "s-1",
    status: "complete",
    spansCount: 2,
    firstSeq: 10,
    lastSeq: 15,
    hasMissingExit: false,
    hasLossRecords: false
  });
const end = (snapshots?: ConnectSnapshotManifestEntry[]) => ({
  type: "end",
  reason: "complete",
  resume: { cursor: "c-9", watermarkSeq: 25 },
  ...(snapshots ? { manifest: { snapshots, omittedTraces: 0, unavailableTraces: 0 } } : {})
});
const lines = (...frames: unknown[]) => frames.map((frame) => `${JSON.stringify(frame)}\n`).join("");

function input(...parts: string[]): StreamInput {
  return (async function* () {
    for (const part of parts) yield part;
  })();
}

/** A stream that sends `parts` and then never ends (a producer that hangs). */
function hanging(...parts: string[]): StreamInput {
  return (async function* () {
    for (const part of parts) yield part;
    await new Promise(() => undefined);
  })();
}

function v2Stream(): string {
  const ref = connectTraceRef(snap, { sessionId: "s-1", traceId: "t-1" });
  const snapshotId = connectSnapshotId(snap, ref);
  const frames = encodeCanonicalChunks({ snapshotId, ref, page: canonicalV2("t-1"), maxFrameBytes: 4_096 });
  return lines(headerFrameV2(snap, { eventsCount: 5 }), summary("t-1"), ...frames, end([{ snapshotId, ref }]));
}

const STDIN: ResolvedTarget = { kind: "stdin" };

describe("--print: stdin streams", () => {
  it("a finite, complete v2 stream prints the trace projection", async () => {
    const result = await print(["-", "--print", "--trace", "t-1"], STDIN, { source: { stdinData: input(v2Stream()) } });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(parseTraceTextV2(result.out, { dialect: "lisp" }).ok).toBe(true);
  });

  it("a summary-only v1 stream gives table JSON/Tab; Lisp needs the canonical capability (exit 2)", async () => {
    const text = lines(headerFrame(snap, { interactive: false, eventsCount: 1 }), summary("t-1"), end());
    const json = await print(["-", "--print", "json", "--trace", "t-1"], STDIN, { source: { stdinData: input(text) } });
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toMatchObject({
      kind: "table",
      schema: TRACE_LIST_SCHEMA,
      coverage: { reason: "summary-only(summary-only-stream)" },
      rows: [[expect.any(String), "p", "s-1", "t-1", "complete", 2, expect.anything()]]
    });
    const tab = await print(["-", "--print", "tab", "--trace", "t-1"], STDIN, { source: { stdinData: input(text) } });
    expect(tab.code).toBe(0);
    expect(tab.out).toContain("kosmo.query-table/v1");

    const lisp = await print(["-", "--print", "lisp", "--trace", "t-1"], STDIN, { source: { stdinData: input(text) } });
    expect(lisp.code).toBe(2);
    expect(lisp.out).toBe("");
    expect(lisp.err).toContain("unavailable(summary-only-stream)");
  });

  it("EOF before `end` is incomplete input: exit 2 with EMPTY stdout", async () => {
    const text = lines(headerFrame(snap, { interactive: false, eventsCount: 1 }), summary("t-1"));
    const result = await print(["-", "--print", "json"], STDIN, { source: { stdinData: input(text) } });
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toMatch(/incomplete\(.*\); nothing printed/);
  });

  it("a follow stream is rejected as soon as its header arrives, without waiting for an end", async () => {
    const started = Date.now();
    const text = lines({ ...headerFrameV2(snap, { eventsCount: 5 }), follow: true }, summary("t-1"));
    const result = await print(["-", "--print", "json"], STDIN, { source: { stdinData: hanging(text) } });
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toContain("unavailable(follow-stream)");
    expect(Date.now() - started).toBeLessThan(PRINT_STDIN_DEADLINE_MS);
  });

  it("a finite stream that never ends hits the deadline: exit 2 with EMPTY stdout", async () => {
    const text = lines(headerFrame(snap, { interactive: false, eventsCount: 1 }), summary("t-1"));
    const result = await print(["-", "--print", "json"], STDIN, {
      source: { stdinData: hanging(text) },
      stdinDeadlineMs: 50
    });
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toContain("did not reach end within 0.05 s");
  });

  it("the default deadline is 5 s", () => {
    expect(PRINT_STDIN_DEADLINE_MS).toBe(5_000);
  });

  it("a projection version the stream does not serve fails before any write", async () => {
    const result = await print(["-", "--print", "--trace", "t-1", "--projection-version", "1"], STDIN, {
      source: { stdinData: input(v2Stream()) }
    });
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toContain("unavailable(projection-v1)");
  });
});

describe("--print: the single stdout write", () => {
  it("EPIPE after the write started ends the command without a success claim", async () => {
    const file = await exportFile();
    const proc = fakeProc([file, "--print", "json"], { stdoutTty: false, cwd: tmp });
    const writes: string[] = [];
    proc.stdout = {
      isTTY: false,
      writable: true,
      write(chunk: string, callback?: (error?: Error | null) => void) {
        writes.push(chunk);
        const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
        queueMicrotask(() => callback?.(error));
        return false;
      }
    } as never;
    const result = await print([file, "--print", "json"], { kind: "export", path: file }, {}, proc);
    expect(result.code).toBe(2);
    expect(writes).toHaveLength(1);
    expect(result.err).toContain("output ended early (EPIPE)");
  });

  it("run() maps the outcomes to D15 exit codes and keeps stdout empty on failure", async () => {
    const file = await exportFile();
    const fs = {
      stat: async (target: string) => (target === file ? { isFile: true, isDirectory: false, size: 10 } : undefined),
      readHead: async () => new TextEncoder().encode("{")
    };
    const ok = fakeProc([file, "--print", "json"], { stdoutTty: false, cwd: tmp });
    expect(await run(ok, { fs })).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({ schema: TRACE_LIST_SCHEMA });

    const usage = fakeProc([file, "--print", "lisp"], { stdoutTty: false, cwd: tmp });
    expect(await run(usage, { fs })).toBe(1);
    expect(usage.out).toBe("");

    const missing = fakeProc([file, "--print", "--trace", "missing"], { stdoutTty: false, cwd: tmp });
    expect(await run(missing, { fs })).toBe(2);
    expect(missing.out).toBe("");
  });
});
