import { describe, expect, it, vi } from "vitest";
import {
  EXIT_MISSING_BIN,
  EXIT_OK,
  EXIT_SIGINT,
  EXIT_SIGTERM,
  EXIT_SOURCE,
  EXIT_USAGE,
  USAGE,
  parseArgv,
  run,
  type EvalArgs,
  type Invocation,
  type SqlArgs,
  type RunDeps,
  type ViewerArgs
} from "../src/cli.js";
import { SQLITE_HEADER, fakeFs, fakeProc } from "./helpers.js";

const FILES = {
  "/work/app/export.json": '{"formatVersion":1}',
  "/work/app/store.sqlite": `${SQLITE_HEADER}x`,
  "/work/app/bad.json": "garbage"
};

function spies(extra: Partial<RunDeps> = {}) {
  const openViewer = vi.fn(async (_: Invocation<ViewerArgs>) => EXIT_OK);
  const runPrint = vi.fn(async (_: Invocation<ViewerArgs>) => EXIT_OK);
  const runSql = vi.fn(async (_: Invocation<SqlArgs>) => EXIT_OK);
  const runEval = vi.fn(async (_: Invocation<EvalArgs>) => EXIT_OK);
  const readProjectConfig = vi.fn(async (dir: string) => (dir === "/work/app" ? { projectId: "shop" } : undefined));
  const deps: RunDeps = {
    fs: fakeFs(FILES),
    homedir: () => "/home/me",
    readProjectConfig,
    terminalInputAvailable: () => true,
    openViewer,
    runPrint,
    runSql,
    runEval,
    readVersion: () => "9.9.9",
    ...extra
  };
  const sideEffects = () =>
    openViewer.mock.calls.length + runPrint.mock.calls.length + runSql.mock.calls.length + runEval.mock.calls.length;
  return { deps, openViewer, runPrint, runSql, runEval, readProjectConfig, sideEffects };
}

function parsed(argv: string[]) {
  const result = parseArgv(argv);
  if (!result.ok) throw new Error(result.message);
  return result.args;
}

function parseError(argv: string[]): string {
  const result = parseArgv(argv);
  if (result.ok) throw new Error(`expected a usage error for ${argv.join(" ")}`);
  return result.message;
}

describe("parseArgv", () => {
  it("parses viewer flags", () => {
    expect(
      parsed([
        "./export.json",
        "--trace",
        "t1",
        "--depth",
        "feature",
        "--detail",
        "2",
        "--values",
        "--projection-version",
        "1",
        "--review-dir",
        "rev",
        "--no-eval",
        "-n",
        "--project",
        "shop"
      ])
    ).toEqual({
      command: "viewer",
      target: "./export.json",
      trace: "t1",
      depth: "feature",
      detail: 2,
      values: true,
      projectionVersion: 1,
      reviewDir: "rev",
      noEval: true,
      readOnly: false,
      noResume: true,
      replay: false,
      project: "shop"
    });
  });

  it("parses replay flags and --flag=value", () => {
    expect(parsed(["--replay", "--speed", "0.5"])).toMatchObject({ replay: true, speed: 0.5 });
    expect(parsed(["--replay", "--step-interval=2s", "--refresh", "250ms"])).toMatchObject({
      stepIntervalMs: 2000,
      refreshMs: 250
    });
    expect(parsed(["-rn"])).toMatchObject({ readOnly: true, noResume: true });
  });

  it("--print takes an optional format, --format agrees with it", () => {
    expect(parsed(["x.json", "--print"])).toMatchObject({ target: "x.json", print: {} });
    expect(parsed(["--print", "json", "t1"])).toMatchObject({ target: "t1", print: { format: "json" } });
    expect(parsed(["--print", "t1"])).toMatchObject({ target: "t1", print: {} });
    expect(parsed(["--print=tab"])).toMatchObject({ print: { format: "tab" } });
    expect(parsed(["--print", "--format", "lisp"])).toMatchObject({ print: { format: "lisp" } });
    expect(parseError(["--print", "lisp", "--format", "json"])).toMatch(/conflicts/);
    expect(parseError(["--format", "json"])).toMatch(/requires --print/);
    expect(parseError(["--print", "--format", "xml"])).toMatch(/--format must be/);
  });

  it("enforces replay constraints", () => {
    expect(parseError(["--replay", "--speed", "2", "--step-interval", "100ms"])).toMatch(/mutually exclusive/);
    expect(parseError(["--speed", "2"])).toMatch(/requires --replay/);
    expect(parseError(["--step-interval", "100ms"])).toMatch(/requires --replay/);
    expect(parseError(["--replay", "--speed", "-1"])).toMatch(/0\.1\.\.10/);
    expect(parseError(["--replay", "--speed", "11"])).toMatch(/0\.1\.\.10/);
    expect(parseError(["--replay", "--speed", "fast"])).toMatch(/0\.1\.\.10/);
    expect(parseError(["--replay", "--step-interval", "5ms"])).toMatch(/step-interval/);
    expect(parseError(["--refresh", "0"])).toMatch(/refresh/);
    expect(parseError(["--print", "--replay"])).toMatch(/--replay/);
    expect(parseError(["--print", "--refresh", "100ms"])).toMatch(/--refresh/);
    expect(parseError(["-", "--replay"])).toMatch(/stdin/);
  });

  it("validates enumerated values", () => {
    expect(parseError(["--depth", "package"])).toMatch(/--depth/);
    expect(parseError(["--detail", "3"])).toMatch(/--detail/);
    expect(parseError(["--projection-version", "3"])).toMatch(/--projection-version/);
    expect(parseError(["--trace"])).toMatch(/requires a value/);
    expect(parseError(["--trace", "--values"])).toMatch(/requires a value/);
    expect(parseError(["--bogus"])).toMatch(/unknown option --bogus/);
    expect(parseError(["a", "b"])).toMatch(/one target/);
    expect(parseError(["--values", "--values"])).toMatch(/more than once/);
    expect(parseError(["-r", "--review-dir", "x"])).toMatch(/-r/);
    expect(parseError(["--print", "--review-dir", "x"])).toMatch(/--print/);
    expect(parseError(["--source", "x.json"])).toMatch(/--source/);
  });

  it("reserves sql/eval; --trace carries a literal colliding id", () => {
    expect(parsed(["--trace", "sql"])).toMatchObject({ command: "viewer", trace: "sql" });
    expect(parsed(["--trace", "eval", "./export.json"])).toMatchObject({
      command: "viewer",
      trace: "eval",
      target: "./export.json"
    });
    expect(parsed(["--", "-weird"])).toMatchObject({ command: "viewer", target: "-weird" });
    expect(parsed(["sql", "select 1", "--source", "./export.json", "--format", "tab"])).toEqual({
      command: "sql",
      query: "select 1",
      source: "./export.json",
      format: "tab"
    });
    expect(parsed(["eval", "trace.spans.length", "--project", "shop"])).toEqual({
      command: "eval",
      code: "trace.spans.length",
      project: "shop"
    });
    expect(parseError(["sql"])).toMatch(/requires a query/);
    expect(parseError(["sql", "  "])).toMatch(/empty/);
    expect(parseError(["sql", "select", "1"])).toMatch(/quote/);
    expect(parseError(["sql", "select 1", "--format", "lisp"])).toMatch(/table/);
    expect(parseError(["sql", "select 1", "--depth", "app"])).toMatch(/not accepted by the sql/);
    // -r / --no-eval are accepted so eval can refuse as unavailable (D3), not as a usage error.
    expect(parsed(["eval", "1", "-r", "--no-eval", "--trace", "t1"])).toEqual({
      command: "eval",
      code: "1",
      trace: "t1",
      readOnly: true,
      noEval: true
    });
    expect(parseError(["eval", "1", "--depth", "app"])).toMatch(/not accepted by the eval/);
    expect(parseError(["eval", "1", "--print"])).toMatch(/not accepted/);
  });

  it("help and version", () => {
    expect(parsed(["--help"])).toEqual({ command: "help" });
    expect(parsed(["x", "-h"])).toEqual({ command: "help" });
    expect(parsed(["--version"])).toEqual({ command: "version" });
  });
});

describe("run: exit codes and validation before side effects", () => {
  it("exit code constants follow D15", () => {
    expect([EXIT_OK, EXIT_USAGE, EXIT_SOURCE, EXIT_MISSING_BIN, EXIT_SIGINT, EXIT_SIGTERM]).toEqual([
      0, 1, 2, 3, 130, 143
    ]);
  });

  it("usage error: stderr message, exit 1, nothing else happens", async () => {
    const s = spies();
    const proc = fakeProc(["--replay", "--speed", "2", "--step-interval", "1s"]);
    expect(await run(proc, s.deps)).toBe(EXIT_USAGE);
    expect(proc.out).toBe("");
    expect(proc.err).toMatch(/mutually exclusive/);
    expect(s.sideEffects()).toBe(0);
    expect(s.readProjectConfig).not.toHaveBeenCalled();
  });

  it("scenario: t_9f opens the live viewer, ./missing.json is a usage error without a daemon request", async () => {
    const s = spies();
    const ok = fakeProc(["t_9f"]);
    expect(await run(ok, s.deps)).toBe(EXIT_OK);
    expect(s.openViewer).toHaveBeenCalledTimes(1);
    expect(s.openViewer.mock.calls[0]![0]).toMatchObject({
      target: { kind: "live-trace", traceId: "t_9f" },
      project: { projectId: "shop" }
    });

    const s2 = spies();
    const missing = fakeProc(["./missing.json"]);
    expect(await run(missing, s2.deps)).toBe(EXIT_USAGE);
    expect(missing.err).toMatch(/does not exist/);
    expect(missing.out).toBe("");
    expect(s2.sideEffects()).toBe(0);
    expect(s2.readProjectConfig).not.toHaveBeenCalled();
  });

  it("scenario: ./export.json > out.txt without --print → exit 1, empty stdout, terminal untouched", async () => {
    const s = spies();
    const proc = fakeProc(["./export.json"], { stdoutTty: false });
    expect(await run(proc, s.deps)).toBe(EXIT_USAGE);
    expect(proc.out).toBe("");
    expect(proc.err).toMatch(/interactive terminal required/);
    expect(proc.err).toMatch(/--print/);
    expect(s.sideEffects()).toBe(0);
  });

  it("non-TTY stdin without --print is also refused", async () => {
    const s = spies();
    const proc = fakeProc(["./export.json"], { stdinTty: false });
    expect(await run(proc, s.deps)).toBe(EXIT_USAGE);
    expect(s.sideEffects()).toBe(0);
  });

  it("stdin target needs a controlling-terminal port, not a TTY stdin", async () => {
    const without = spies({ terminalInputAvailable: () => false });
    const p1 = fakeProc(["-"], { stdinTty: false });
    expect(await run(p1, without.deps)).toBe(EXIT_USAGE);
    expect(p1.err).toMatch(/interactive terminal required/);
    expect(p1.out).toBe("");
    expect(without.sideEffects()).toBe(0);

    const withPort = spies();
    const p2 = fakeProc(["-"], { stdinTty: false });
    expect(await run(p2, withPort.deps)).toBe(EXIT_OK);
    expect(withPort.openViewer.mock.calls[0]![0].target).toEqual({ kind: "stdin" });
  });

  it("--print works without a TTY and goes to runPrint", async () => {
    const s = spies();
    const proc = fakeProc(["./export.json", "--print", "lisp", "--trace", "t1"], { stdoutTty: false, stdinTty: false });
    expect(await run(proc, s.deps)).toBe(EXIT_OK);
    expect(s.openViewer).not.toHaveBeenCalled();
    expect(s.runPrint.mock.calls[0]![0]).toMatchObject({
      target: { kind: "export", path: "/work/app/export.json" },
      args: { print: { format: "lisp" }, trace: "t1" },
      project: null
    });
    expect(s.readProjectConfig).not.toHaveBeenCalled();
  });

  it("sqlite and sql --source resolve through the same detection", async () => {
    const s = spies();
    expect(await run(fakeProc(["store.sqlite"]), s.deps)).toBe(EXIT_OK);
    expect(s.openViewer.mock.calls[0]![0].target).toEqual({ kind: "sqlite", path: "/work/app/store.sqlite" });
    expect(await run(fakeProc(["sql", "select 1", "--source", "./export.json"], { stdoutTty: false }), s.deps)).toBe(
      EXIT_OK
    );
    expect(s.runSql).toHaveBeenCalledTimes(1);
    expect(await run(fakeProc(["eval", "1"], { stdoutTty: false }), s.deps)).toBe(EXIT_OK);
    expect(s.runEval.mock.calls[0]![0]).toMatchObject({
      target: { kind: "live-project" },
      project: { projectId: "shop" }
    });
  });

  it("--trace sql selects a literal trace id instead of the subcommand", async () => {
    const s = spies();
    expect(await run(fakeProc(["--trace", "sql"]), s.deps)).toBe(EXIT_OK);
    expect(s.runSql).not.toHaveBeenCalled();
    expect(s.openViewer.mock.calls[0]![0]).toMatchObject({ target: { kind: "live-project" }, args: { trace: "sql" } });
  });

  it("conflicting positional trace id and --trace is a usage error", async () => {
    const s = spies();
    expect(await run(fakeProc(["t1", "--trace", "t2"]), s.deps)).toBe(EXIT_USAGE);
    expect(s.sideEffects()).toBe(0);
  });

  it("an unrecognized file is a source error (exit 2) before side effects", async () => {
    const s = spies();
    const proc = fakeProc(["./bad.json", "--print"]);
    expect(await run(proc, s.deps)).toBe(EXIT_SOURCE);
    expect(proc.out).toBe("");
    expect(s.sideEffects()).toBe(0);
  });

  it("endpoint credentials are rejected without printing them", async () => {
    const s = spies();
    const proc = fakeProc(["http://me:hunter2@127.0.0.1:4318/"]);
    expect(await run(proc, s.deps)).toBe(EXIT_USAGE);
    expect(proc.err).not.toContain("hunter2");
    expect(s.sideEffects()).toBe(0);
  });

  it("an explicit endpoint skips local project discovery", async () => {
    const s = spies();
    expect(await run(fakeProc(["http://127.0.0.1:4318/"]), s.deps)).toBe(EXIT_OK);
    expect(s.readProjectConfig).not.toHaveBeenCalled();
    expect(s.openViewer.mock.calls[0]![0].target).toEqual({ kind: "live-endpoint", url: "http://127.0.0.1:4318/" });
  });

  it("ambiguous project fails before the viewer; --project resolves it", async () => {
    const readProjectConfig = async (dir: string) =>
      dir === "/work/app" ? { projectId: "shop" } : dir === "/work" ? { projectId: "mono" } : undefined;
    const s = spies({ readProjectConfig });
    const proc = fakeProc([]);
    expect(await run(proc, s.deps)).toBe(EXIT_USAGE);
    expect(proc.err).toMatch(/--project/);
    expect(s.sideEffects()).toBe(0);
    expect(await run(fakeProc(["--project", "mono"]), s.deps)).toBe(EXIT_OK);
    expect(s.openViewer.mock.calls[0]![0].project).toMatchObject({ projectId: "mono", root: "/work" });
  });

  it("help/version go to stdout with exit 0", async () => {
    const help = fakeProc(["--help"], { stdoutTty: false });
    expect(await run(help, spies().deps)).toBe(EXIT_OK);
    expect(help.out).toBe(USAGE);
    const version = fakeProc(["--version"]);
    expect(await run(version, spies().deps)).toBe(EXIT_OK);
    expect(version.out).toBe("9.9.9\n");
  });

  it("missing handlers report unavailable with exit 2, never 3", async () => {
    const proc = fakeProc(["./export.json", "--print"]);
    const code = await run(proc, { fs: fakeFs(FILES), readProjectConfig: async () => undefined });
    expect(code).toBe(EXIT_SOURCE);
    expect(code).not.toBe(EXIT_MISSING_BIN);
    expect(proc.out).toBe("");
  });

  it("a throwing handler gives exit 2 with a bounded error", async () => {
    const proc = fakeProc(["t1"]);
    const code = await run(
      proc,
      spies({
        openViewer: async () => {
          throw new Error("x".repeat(10_000));
        }
      }).deps
    );
    expect(code).toBe(EXIT_SOURCE);
    expect(proc.err.length).toBeLessThan(2_100);
  });

  it("SIGINT → 130 and SIGTERM → 143, abort the invocation, and handlers are removed", async () => {
    for (const [signal, expected] of [
      ["SIGINT", EXIT_SIGINT],
      ["SIGTERM", EXIT_SIGTERM]
    ] as const) {
      const proc = fakeProc(["t1"]);
      let aborted = false;
      const openViewer = (invocation: Invocation<ViewerArgs>) =>
        new Promise<number>((resolve) => {
          invocation.signal.addEventListener("abort", () => {
            aborted = true;
            resolve(EXIT_OK);
          });
          setTimeout(() => proc.emit(signal), 0);
        });
      expect(await run(proc, spies({ openViewer }).deps)).toBe(expected);
      expect(aborted).toBe(true);
      expect(proc.listeners.get("SIGINT")?.size ?? 0).toBe(0);
      expect(proc.listeners.get("SIGTERM")?.size ?? 0).toBe(0);
    }
  });

  it("no signal handlers are installed when validation fails", async () => {
    const proc = fakeProc(["--bogus"]);
    const on = vi.spyOn(proc, "on");
    await run(proc, spies().deps);
    expect(on).not.toHaveBeenCalled();
  });
});
