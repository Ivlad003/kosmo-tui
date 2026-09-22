/**
 * Trusted local eval (spec trace-programmable-access «Локальний довірений JS eval»,
 * task 5b.4). Uses the built dist/eval-child.js (`npm test` builds first).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT_OK, EXIT_SOURCE, EXIT_USAGE, parseArgv, run } from "../src/cli.js";
import {
  EVAL_HEAP_FLAGS,
  EVAL_HEAP_MB,
  EVAL_OUTPUT_MAX_BYTES,
  buildEvalSnapshot,
  defaultEvalChildScript,
  evalChildEnv,
  eventsFromExportRecords,
  runLocalEval,
  type EvalOutcome,
  type EvalSnapshot
} from "../src/eval.js";
import { importPortableExport } from "@kosmo-callflow/replay";
import { fakeProc } from "./helpers.js";
import { portableExport, processExists, removeDir, tempDir, writeExport } from "./eval-fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures");

function snapshot(): EvalSnapshot {
  const { dataset } = importPortableExport(portableExport(), { namespace: "export", maxBytes: 1 << 20 });
  const built = buildEvalSnapshot(eventsFromExportRecords(dataset.records), {
    source: "export",
    datasetId: dataset.datasetId,
    projectId: dataset.projectId,
    traceId: null
  });
  if (!built.ok) throw new Error(built.message);
  return built.snapshot;
}

async function evaluate(code: string, extra: Partial<Parameters<typeof runLocalEval>[0]> = {}): Promise<EvalOutcome> {
  return runLocalEval({ code, snapshot: snapshot(), env: {}, ...extra });
}

async function value(code: string): Promise<unknown> {
  const outcome = await evaluate(code);
  if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
  return outcome.envelope.value;
}

function expectFailure(outcome: EvalOutcome, code: string, message?: RegExp): void {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  expect(outcome.code).toBe(code);
  if (message !== undefined) expect(outcome.message).toMatch(message);
  // The child was killed and reaped: no zombie, no stray process.
  expect(outcome.pid).toBeTypeOf("number");
  expect(processExists(outcome.pid!)).toBe(false);
}

beforeAll(() => {
  expect(existsSync(defaultEvalChildScript()), "run `npm run build` first").toBe(true);
});

describe("eval result envelope and own-realm trace API", () => {
  it("spec scenario: errors → ancestors → nodeIds, as a computed-local value envelope", async () => {
    const outcome = await evaluate("trace.errors().flatMap(e => trace.ancestors(e.id)).map(s => s.nodeId)");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.envelope).toEqual({
      version: "kosmo.eval-result/v1",
      kind: "value",
      provenance: "computed-local",
      scope: { source: "export", datasetId: "export:ds", projectId: "shop", traceId: null },
      coverage: { scope: "complete", loaded: 4, total: 4 },
      truncated: false,
      value: ["src/app.ts#handle"]
    });
    expect(JSON.parse(outcome.json)).toEqual(outcome.envelope);
    expect(processExists(outcome.pid!)).toBe(false);
  });

  it("walks descendants, path, callers/callees over recorded edges only", async () => {
    const result = (await value(`
      const by = (n) => trace.spans().find((s) => s.nodeId === n);
      const a = by("src/app.ts#handle"), c = by("src/db.ts#query"), d = by("src/late.ts#x");
      [
        trace.descendants(a.id).map((s) => s.nodeId),
        trace.path(a.id, c.id).spans.map((s) => s.nodeId),
        trace.path(c.id, a.id),
        trace.path(a.id, d.id),
        trace.callers("src/cart.ts#load"),
        trace.callees("src/cart.ts#load"),
        typeof a.id,
        Object.isFrozen(a)
      ]
    `)) as unknown[];
    expect(result).toEqual([
      ["src/cart.ts#load", "src/db.ts#query"],
      ["src/app.ts#handle", "src/cart.ts#load", "src/db.ts#query"],
      { state: "no-path" },
      { state: "unknown-path", reason: "not-loaded" },
      [{ nodeId: "src/app.ts#handle", count: 1, provenance: "recorded" }],
      [{ nodeId: "src/db.ts#query", count: 1, provenance: "recorded" }],
      "string",
      true
    ]);
  });

  it("trace.at reports the missing replay capability instead of guessing", async () => {
    expectFailure(await evaluate("trace.at(3)"), "user-error", /unavailable\(replay\)/);
  });

  it("unknown refs are an error, not an empty result", async () => {
    expectFailure(await evaluate('trace.ancestors("t1:b")'), "user-error", /unknown span ref/);
  });
});

describe("masked values stay masked", () => {
  it("trace.value is typed availability without a backing value", async () => {
    const result = (await value(`
      const by = (n) => trace.spans().find((s) => s.nodeId === n);
      [
        trace.value(by("src/db.ts#query").id, "args"),
        trace.value(by("src/cart.ts#load").id, "args"),
        trace.value(by("src/db.ts#query").id, "ret"),
        trace.value(by("src/app.ts#handle").id, "error"),
        trace.value(by("src/late.ts#x").id, "ret")
      ]
    `)) as unknown[];
    expect(result).toEqual([
      { state: "masked" },
      { state: "masked" },
      { state: "recorded", text: "42" },
      { state: "not-recorded" },
      { state: "unavailable", reason: "no exit record" }
    ]);
  });

  it("no route through the API reaches the secret: it is not even in the child's snapshot", async () => {
    expect(JSON.stringify(portableExport())).toContain("tok-live-7f3a9c");
    expect(JSON.stringify(snapshot())).not.toContain("tok-live-7f3a9c");
    const outcome = await evaluate(
      "JSON.stringify([trace.spans(), trace.spans().map((s) => [trace.value(s.id, 'args'), trace.value(s.id, 'ret')])])"
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.json).not.toContain("tok-live-7f3a9c");
  });
});

describe("host isolation is a convenience limit, not a sandbox", () => {
  it("host globals, imports and string code generation are absent", async () => {
    expect(
      await value("[typeof process, typeof require, typeof module, typeof setTimeout, typeof console, typeof fetch]")
    ).toEqual(["undefined", "undefined", "undefined", "undefined", "undefined", "undefined"]);
    expectFailure(await evaluate('this.constructor.constructor("return process")()'), "user-error", /EvalError/);
    expectFailure(await evaluate('eval("1 + 1")'), "user-error", /EvalError/);
    expectFailure(await evaluate('import("node:fs")'), "unsupported-result", /promise/);
  });

  it("the child gets only the allowlisted environment: no tokens, no NODE_OPTIONS", async () => {
    const previous = process.env.KOSMO_TOKEN;
    process.env.KOSMO_TOKEN = "kosmo-secret-token";
    try {
      const probe = path.join(fixtures, "eval-env-probe.mjs");
      const inherited = await runLocalEval({ code: "1", snapshot: snapshot(), childScript: probe });
      expect(inherited.ok).toBe(true);
      if (!inherited.ok) return;
      const seen = inherited.envelope.value as {
        env: Record<string, string>;
        execArgv: string[];
        heapLimitBytes: number;
      };
      expect(seen.env.KOSMO_TOKEN).toBeUndefined();
      expect(JSON.stringify(seen)).not.toContain("kosmo-secret-token");

      const explicit = await runLocalEval({
        code: "1",
        snapshot: snapshot(),
        childScript: probe,
        env: {
          KOSMO_TOKEN: "kosmo-secret-token",
          KOSMO_CALLFLOW_PROJECT_TOKEN: "pt",
          GITHUB_TOKEN: "gh",
          AWS_SECRET_ACCESS_KEY: "aws",
          NODE_OPTIONS: "--require /nonexistent-preload.js",
          HOME: "/home/someone",
          PATH: "/usr/bin",
          TZ: "UTC"
        }
      });
      expect(explicit.ok).toBe(true);
      if (!explicit.ok) return;
      const child = explicit.envelope.value as {
        env: Record<string, string>;
        execArgv: string[];
        heapLimitBytes: number;
      };
      expect(Object.keys(child.env).filter((name) => name !== "__CF_USER_TEXT_ENCODING")).toEqual(["TZ"]);
      expect(child.execArgv).toEqual(expect.arrayContaining([...EVAL_HEAP_FLAGS]));
      // The WHOLE heap (old + young generation) is within the 64 MiB budget on every
      // supported Node — Node 25's larger default young generation included.
      expect(child.heapLimitBytes).toBeLessThanOrEqual(EVAL_HEAP_MB * 1024 * 1024);
      expect(child.heapLimitBytes).toBeGreaterThan(48 * 1024 * 1024);
    } finally {
      if (previous === undefined) delete process.env.KOSMO_TOKEN;
      else process.env.KOSMO_TOKEN = previous;
    }
  });

  it("evalChildEnv is a pure allowlist", () => {
    expect(evalChildEnv({ KOSMO_TOKEN: "x", NODE_OPTIONS: "--inspect", LANG: "C", TZ: undefined })).toEqual({
      LANG: "C"
    });
  });
});

describe("parent-enforced deadline and child failure cleanup", () => {
  it("a busy loop is killed at the deadline; the pid is gone", async () => {
    const started = Date.now();
    expectFailure(await evaluate("while (true) {}"), "timeout", /2000 ms deadline/);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("an endless microtask chain is killed too", async () => {
    expectFailure(await evaluate("(function spin() { Promise.resolve().then(spin); })(); 1"), "timeout");
    expectFailure(await evaluate("(async () => { for (;;) await 0; })(); 1"), "timeout");
  });

  it("a getter that never returns runs inside the timed child", async () => {
    expectFailure(await evaluate("({ get stuck() { for (;;) {} } })"), "timeout");
  });

  it("the heap budget kills a runaway allocation", async () => {
    expectFailure(
      await evaluate("const hoard = []; for (;;) hoard.push(new Array(1e6).fill(1.5));", { deadlineMs: 10_000 }),
      "heap-exceeded",
      /64 MiB/
    );
  }, 15_000);

  it("a crashing child is an explicit error, never partial success", async () => {
    expectFailure(
      await evaluate("1", { childScript: path.join(fixtures, "eval-crash.mjs") }),
      "child-failed",
      /exit code 7/
    );
  });

  it("an aborted invocation kills the child", async () => {
    const controller = new AbortController();
    const pending = evaluate("while (true) {}", { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    expectFailure(await pending, "aborted");
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("syntax and runtime errors are reported with their message", async () => {
    expectFailure(await evaluate("1 +"), "syntax-error");
    expectFailure(await evaluate('throw new Error("nope")'), "user-error", /nope/);
    expectFailure(
      await evaluate("throw { get message() { throw new Error('inner'); } }"),
      "user-error",
      /could not be described/
    );
  });
});

describe("serialization inside the child: toJSON, cycles, unsupported results, output cap", () => {
  it("toJSON and getters are honoured; toJSON that throws is a user error", async () => {
    expect(await value("({ toJSON() { return { via: 'toJSON' }; } })")).toEqual({ via: "toJSON" });
    expect(await value("({ get lazy() { return 7; } })")).toEqual({ lazy: 7 });
    expectFailure(
      await evaluate("({ toJSON() { throw new Error('toJSON exploded'); } })"),
      "user-error",
      /toJSON exploded/
    );
  });

  it("a huge toJSON result fails as output-too-large with no partial JSON", async () => {
    expectFailure(await evaluate("({ toJSON() { return 'x'.repeat(200000); } })"), "output-too-large");
  });

  it("cycles, promises, functions and undefined are typed unsupported results", async () => {
    expectFailure(await evaluate("const a = {}; a.self = a; a"), "unsupported-result", /cycle/);
    expectFailure(await evaluate("const l = []; l.push({ l }); l"), "unsupported-result", /cycle/);
    expectFailure(await evaluate("Promise.resolve(1)"), "unsupported-result", /promise/);
    expectFailure(await evaluate("(() => 1)"), "unsupported-result", /function/);
    expectFailure(await evaluate("({ f() {} })"), "unsupported-result", /function/);
    expectFailure(await evaluate("undefined"), "unsupported-result", /undefined/);
    expectFailure(await evaluate("10n"), "unsupported-result", /bigint/);
    // Shared, acyclic references are fine.
    expect(await value("const x = { v: 1 }; [x, x]")).toEqual([{ v: 1 }, { v: 1 }]);
  });

  it("an oversized array is cut at whole items with an explicit truncation marker", async () => {
    const outcome = await evaluate("Array.from({ length: 10000 }, (_, i) => 'item-' + i)");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { envelope } = outcome;
    expect(envelope.truncated).toBe(true);
    expect(envelope.truncation).toMatchObject({ reason: "output-bytes", totalItems: 10000 });
    const shown = envelope.truncation!.shownItems;
    expect(shown).toBeGreaterThan(1000);
    expect(shown).toBeLessThan(10000);
    const items = envelope.value as string[];
    expect(items).toHaveLength(shown);
    expect(items[shown - 1]).toBe(`item-${shown - 1}`);
    expect(Buffer.byteLength(`${outcome.json}\n`, "utf8")).toBeLessThanOrEqual(EVAL_OUTPUT_MAX_BYTES);
    expect(() => JSON.parse(outcome.json)).not.toThrow();
  });

  it("a small array is complete and says so", async () => {
    const outcome = await evaluate("[1, 2, 3]");
    expect(outcome.ok && outcome.envelope).toMatchObject({ truncated: false, value: [1, 2, 3] });
    expect(outcome.ok && outcome.envelope.truncation).toBeUndefined();
  });

  it("recorded strings in the result go through the shared sanitizer (control chars escaped)", async () => {
    const outcome = await evaluate("'a' + String.fromCharCode(27) + '[31mred'");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.json).not.toContain(String.fromCharCode(27));
  });
});

describe("kosmo-tui eval subcommand", () => {
  let dir: string;
  let exportPath: string;
  beforeAll(async () => {
    dir = await tempDir();
    exportPath = await writeExport(dir);
  });
  afterAll(async () => {
    await removeDir(dir);
  });

  const proc = (argv: string[]) => fakeProc(argv, { stdoutTty: false, stdinTty: false, cwd: dir });

  it("runs over an export and writes one JSON envelope line", async () => {
    const p = proc(["eval", "trace.spans().length", "--source", exportPath]);
    expect(await run(p)).toBe(EXIT_OK);
    expect(p.err).toBe("");
    expect(p.out.endsWith("\n")).toBe(true);
    expect(JSON.parse(p.out)).toMatchObject({ kind: "value", provenance: "computed-local", value: 4 });
  });

  it("--trace narrows the snapshot; an unknown trace is a source error", async () => {
    const p = proc(["eval", "trace.scope.traceId", "--source", exportPath, "--trace", "t1"]);
    expect(await run(p)).toBe(EXIT_OK);
    expect(JSON.parse(p.out).value).toBe("t1");
    const missing = proc(["eval", "1", "--source", exportPath, "--trace", "nope"]);
    expect(await run(missing)).toBe(EXIT_SOURCE);
    expect(missing.out).toBe("");
  });

  it.each([["-r"], ["--no-eval"]])("%s disables eval as unavailable before any child starts", async (flag) => {
    expect(parseArgv(["eval", "1", flag])).toMatchObject({ ok: true });
    const p = proc(["eval", "while (true) {}", "--source", exportPath, flag]);
    const started = Date.now();
    expect(await run(p)).toBe(EXIT_SOURCE);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(p.out).toBe("");
    expect(p.err).toMatch(/eval is unavailable: local eval is disabled by/);
    expect(p.err).toContain(flag);
    expect(p.err).toMatch(/no code was run/);
  });

  it("a non-json format is a usage error; eval defaults to JSON", async () => {
    const p = proc(["eval", "1", "--source", exportPath, "--format", "lisp"]);
    expect(await run(p)).toBe(EXIT_USAGE);
    expect(p.err).toMatch(/unsupported/);
    const json = proc(["eval", "1", "--source", exportPath, "--format", "json"]);
    expect(await run(json)).toBe(EXIT_OK);
    expect(JSON.parse(json.out).value).toBe(1);
  });

  it("timeouts and child errors exit 2 with an empty stdout", async () => {
    const p = proc(["eval", "while (true) {}", "--source", exportPath]);
    expect(await run(p)).toBe(EXIT_SOURCE);
    expect(p.out).toBe("");
    expect(p.err).toMatch(/eval failed: timeout/);
  });

  it("sources this build cannot snapshot are explicitly unavailable", async () => {
    const p = proc(["eval", "1"]);
    const readProjectConfig = async (directory: string) => (directory === dir ? { projectId: "shop" } : undefined);
    expect(await run(p, { readProjectConfig })).toBe(EXIT_SOURCE);
    expect(p.err).toMatch(/eval is unavailable for a live-project source/);
  });

  it("an invalid export is a source error", async () => {
    const bad = await writeExport(dir, { hello: "world" }, "bad.json");
    const p = proc(["eval", "1", "--source", bad]);
    expect(await run(p)).toBe(EXIT_SOURCE);
    expect(p.err).toMatch(/not a valid portable export/);
  });
});
