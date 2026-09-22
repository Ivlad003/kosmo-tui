/**
 * Composition root: `parseArgv` (pure) and `run(proc, deps)` (design D2).
 *
 * Every argument is validated before any side effect: no network, review, terminal or
 * source work starts until parsing, flag combinations, target detection and project
 * selection have all succeeded. Detection only stats files and reads a small header.
 *
 * Exit codes (D15): 0 success (including explicit truncated output), 1 usage/TTY,
 * 2 source/auth/codec/capability failure, 3 missing bin (connect launcher only — this
 * binary never returns it), 130 SIGINT, 143 SIGTERM.
 */

import { readFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectTarget,
  discoverProjectCandidates,
  selectProject,
  type DetectFs,
  type ProjectCandidate,
  type ProjectConfigReader,
  type ResolvedTarget
} from "./detect.js";
import { takeProcessToken } from "./context.js";
import { runEvalCommand } from "./eval.js";
import { openViewerSession } from "./open-viewer.js";
import { runPrintCommand } from "./print.js";
import { runSqlCommand } from "./sql.js";
import { controllingTerminalAvailable } from "./terminal-input.js";

/** Target kind → concrete source; the viewer/print handlers open their source through this. */
export { openTargetSource, type OpenTargetDeps, type OpenTargetInput, type OpenTargetResult } from "./source-open.js";

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_SOURCE = 2;
/** Reserved for the `kosmo-callflow connect` launcher when this bin is missing. */
export const EXIT_MISSING_BIN = 3;
export const EXIT_SIGINT = 130;
export const EXIT_SIGTERM = 143;

export const DEPTHS = ["app", "feature", "module", "symbol", "call"] as const;
export type Depth = (typeof DEPTHS)[number];
export const FORMATS = ["lisp", "tab", "json"] as const;
export type OutputFormat = (typeof FORMATS)[number];
export type Detail = 0 | 1 | 2;
export type ProjectionVersion = 1 | 2;

export const REPLAY_SPEED_MIN = 0.1;
export const REPLAY_SPEED_MAX = 10;
export const REPLAY_STEP_MIN_MS = 16;
export const REPLAY_STEP_MAX_MS = 60_000;
export const REFRESH_MIN_MS = 16;
export const REFRESH_MAX_MS = 60_000;

export type ViewOptions = {
  trace?: string;
  depth?: Depth;
  detail?: Detail;
  values: boolean;
  projectionVersion?: ProjectionVersion;
  project?: string;
};

export type ViewerArgs = ViewOptions & {
  command: "viewer";
  target?: string;
  reviewDir?: string;
  noEval: boolean;
  readOnly: boolean;
  noResume: boolean;
  /** Present for one-shot output; `format` undefined means "auto" (decided by capabilities). */
  print?: { format?: OutputFormat };
  replay: boolean;
  speed?: number;
  stepIntervalMs?: number;
  refreshMs?: number;
};

export type SqlArgs = {
  command: "sql";
  query: string;
  source?: string;
  project?: string;
  trace?: string;
  /** Undefined means the table default, JSON. */
  format?: OutputFormat;
};
export type EvalArgs = {
  command: "eval";
  code: string;
  source?: string;
  project?: string;
  format?: OutputFormat;
  trace?: string;
  /** Set by `-r` / `--no-eval`: the action is refused as unavailable before any child starts. */
  readOnly?: true;
  noEval?: true;
};
export type HelpArgs = { command: "help" } | { command: "version" };
export type ParsedArgs = ViewerArgs | SqlArgs | EvalArgs | HelpArgs;

export type ParseResult = { ok: true; args: ParsedArgs } | { ok: false; message: string };

export const USAGE = `Usage:
  kosmo-tui [target] [options]           interactive viewer
  kosmo-tui [target] --print [lisp|tab|json] [options]
  kosmo-tui sql <query> [--source <events.sqlite>] [--project <id>] [--trace <id>] [--print json|tab]
  kosmo-tui eval <code> [--source <target>] [--trace <id>] [--project <id>] [--format json]
        trusted local code only: node:vm is a separate JS context, not a security
        boundary. 64 MiB V8 heap (flags) + 128 MiB RSS watchdog for off-heap memory.
        -r / --no-eval disable eval.

Target: none (cwd live project) | - (NDJSON on stdin) | http(s)://endpoint |
        ./export.json | ./store.sqlite | <traceId>. Use --trace <id> for a literal id
        that collides with a path or with the sql/eval subcommands.

Options:
  --trace <id>                 select a trace
  --depth app|feature|module|symbol|call
  --detail 0|1|2               --values             --projection-version 1|2
  --project <id>               choose among ambiguous local projects
  --review-dir <dir>           -r read-only (no review, no eval)
  -n                           do not resume an existing review
  --no-eval                    disable local eval
  --print [lisp|tab|json]      one-shot output (--format selects the format too)
  --replay [--speed 0.1..10 | --step-interval <ms|s>]
  --refresh <ms|s>             redraw rate
  -h, --help                   --version
`;

function fail(message: string): ParseResult {
  return { ok: false, message };
}

function parseDurationMs(value: string, minMs: number, maxMs: number): number | undefined {
  const match = /^(\d+)(ms|s)?$/.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const ms = match[2] === "s" ? amount * 1_000 : amount;
  if (ms < minMs || ms > maxMs) return undefined;
  return ms;
}

/** Viewer flags the eval subcommand also accepts (D3: -r / --no-eval switch local eval off). */
const EVAL_ACCEPTED = new Set(["--trace", "-r", "--no-eval"]);
/** Viewer flags the sql subcommand also accepts: a trace scope and the output format. */
const SQL_ACCEPTED = new Set(["--trace", "--print"]);

const VIEWER_ONLY = new Set([
  "--trace",
  "--depth",
  "--detail",
  "--values",
  "--projection-version",
  "--review-dir",
  "--no-eval",
  "-r",
  "-n",
  "--print",
  "--replay",
  "--speed",
  "--step-interval",
  "--refresh"
]);
const VALUE_FLAGS = new Set([
  "--trace",
  "--depth",
  "--detail",
  "--projection-version",
  "--review-dir",
  "--format",
  "--speed",
  "--step-interval",
  "--refresh",
  "--source",
  "--project"
]);

/**
 * Parse argv (without node and script). Pure: no filesystem, no env.
 *
 * `--print` optionally consumes the next argument when it is exactly lisp/tab/json;
 * `--print=<fmt>` and `--flag=value` forms are accepted too. `-` is the stdin target,
 * `--` ends option parsing.
 */
export function parseArgv(argv: readonly string[]): ParseResult {
  // Expand `--flag=value` and short clusters (`-rn`).
  const tokens: string[] = [];
  let endOfOptions = false;
  for (const raw of argv) {
    if (endOfOptions) {
      tokens.push(raw);
      continue;
    }
    if (raw === "--") {
      endOfOptions = true;
      tokens.push(raw);
      continue;
    }
    const eq = raw.indexOf("=");
    if (raw.startsWith("--") && eq > 2) {
      tokens.push(raw.slice(0, eq), raw.slice(eq + 1));
      continue;
    }
    if (/^-[rnh]{2,}$/.test(raw)) {
      for (const letter of raw.slice(1)) tokens.push(`-${letter}`);
      continue;
    }
    tokens.push(raw);
  }

  const positionals: string[] = [];
  const seen = new Map<string, string | true>();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "--") {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (token === "-" || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (token === "-h" || token === "--help") return { ok: true, args: { command: "help" } };
    if (token === "--version") return { ok: true, args: { command: "version" } };
    if (seen.has(token)) return fail(`${token} was given more than once`);
    if (token === "--print") {
      const next = tokens[i + 1];
      if (next !== undefined && (FORMATS as readonly string[]).includes(next)) {
        seen.set(token, next);
        i += 1;
      } else {
        seen.set(token, true);
      }
      continue;
    }
    if (VALUE_FLAGS.has(token)) {
      const value = tokens[i + 1];
      // A negative number starts with "-", so only a long flag counts as "no value".
      if (value === undefined || value.startsWith("--") || value === "") return fail(`${token} requires a value`);
      seen.set(token, value);
      i += 1;
      continue;
    }
    if (["--values", "--no-eval", "--replay", "-r", "-n"].includes(token)) {
      seen.set(token, true);
      continue;
    }
    return fail(`unknown option ${token}`);
  }

  const str = (flag: string): string | undefined => {
    const value = seen.get(flag);
    return typeof value === "string" ? value : undefined;
  };

  let format: OutputFormat | undefined;
  const formatRaw = str("--format");
  if (formatRaw !== undefined) {
    if (!(FORMATS as readonly string[]).includes(formatRaw))
      return fail(`--format must be lisp, tab or json, received ${formatRaw}`);
    format = formatRaw as OutputFormat;
  }
  const project = str("--project");

  const sub = positionals[0];
  if (sub === "sql" || sub === "eval") {
    const evalFlags = sub === "eval" ? EVAL_ACCEPTED : SQL_ACCEPTED;
    for (const flag of seen.keys()) {
      if (VIEWER_ONLY.has(flag) && !evalFlags.has(flag))
        return fail(`${flag} is not accepted by the ${sub} subcommand`);
    }
    if (positionals.length < 2) return fail(`${sub} requires ${sub === "sql" ? "a query" : "code"} argument`);
    if (positionals.length > 2)
      return fail(`${sub} accepts one ${sub === "sql" ? "query" : "code"} argument; quote it`);
    const body = positionals[1]!;
    if (body.trim() === "") return fail(`${sub} ${sub === "sql" ? "query" : "code"} is empty`);
    if (sub === "sql") {
      const printValue = seen.get("--print");
      const printFormat = typeof printValue === "string" ? (printValue as OutputFormat) : undefined;
      if (printFormat !== undefined && format !== undefined && printFormat !== format) {
        return fail(`--print ${printFormat} conflicts with --format ${format}`);
      }
      format = printFormat ?? format;
      if (format === "lisp") return fail("sql returns a table; lisp is only for projections (use json or tab)");
    }
    const common = {
      ...(str("--source") !== undefined ? { source: str("--source")! } : {}),
      ...(project !== undefined ? { project } : {}),
      ...(format !== undefined ? { format } : {})
    };
    return {
      ok: true,
      args:
        sub === "sql"
          ? {
              command: "sql",
              query: body,
              ...common,
              ...(str("--trace") !== undefined ? { trace: str("--trace")! } : {})
            }
          : {
              command: "eval",
              code: body,
              ...common,
              ...(str("--trace") !== undefined ? { trace: str("--trace")! } : {}),
              ...(seen.has("-r") ? { readOnly: true as const } : {}),
              ...(seen.has("--no-eval") ? { noEval: true as const } : {})
            }
    };
  }

  // Viewer.
  if (seen.has("--source"))
    return fail("--source is only for sql/eval; pass the viewer target as a positional argument");
  if (positionals.length > 1)
    return fail(`kosmo-tui accepts one target, received ${positionals.length}: ${positionals.join(" ")}`);

  const args: ViewerArgs = {
    command: "viewer",
    values: seen.has("--values"),
    noEval: seen.has("--no-eval"),
    readOnly: seen.has("-r"),
    noResume: seen.has("-n"),
    replay: seen.has("--replay")
  };
  if (positionals[0] !== undefined) args.target = positionals[0];
  if (project !== undefined) args.project = project;

  const trace = str("--trace");
  if (trace !== undefined) args.trace = trace;

  const depth = str("--depth");
  if (depth !== undefined) {
    if (!(DEPTHS as readonly string[]).includes(depth))
      return fail(`--depth must be app, feature, module, symbol or call, received ${depth}`);
    args.depth = depth as Depth;
  }
  const detail = str("--detail");
  if (detail !== undefined) {
    if (!/^[012]$/.test(detail)) return fail(`--detail must be 0, 1 or 2, received ${detail}`);
    args.detail = Number(detail) as Detail;
  }
  const version = str("--projection-version");
  if (version !== undefined) {
    if (version !== "1" && version !== "2") return fail(`--projection-version must be 1 or 2, received ${version}`);
    args.projectionVersion = Number(version) as ProjectionVersion;
  }
  const reviewDir = str("--review-dir");
  if (reviewDir !== undefined) args.reviewDir = reviewDir;

  const speed = str("--speed");
  if (speed !== undefined) {
    const text = speed.trim();
    const value = Number(text);
    if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(text) || value < REPLAY_SPEED_MIN || value > REPLAY_SPEED_MAX) {
      return fail(
        `--speed must be a source-clock multiplier in ${REPLAY_SPEED_MIN}..${REPLAY_SPEED_MAX}, received ${speed}`
      );
    }
    args.speed = value;
  }
  const step = str("--step-interval");
  if (step !== undefined) {
    const ms = parseDurationMs(step, REPLAY_STEP_MIN_MS, REPLAY_STEP_MAX_MS);
    if (ms === undefined)
      return fail(
        `--step-interval must be between ${REPLAY_STEP_MIN_MS}ms and ${REPLAY_STEP_MAX_MS / 1000}s, received ${step}`
      );
    args.stepIntervalMs = ms;
  }
  const refresh = str("--refresh");
  if (refresh !== undefined) {
    const ms = parseDurationMs(refresh, REFRESH_MIN_MS, REFRESH_MAX_MS);
    if (ms === undefined)
      return fail(
        `--refresh must be a redraw rate between ${REFRESH_MIN_MS}ms and ${REFRESH_MAX_MS / 1000}s, received ${refresh}`
      );
    args.refreshMs = ms;
  }

  const printValue = seen.get("--print");
  if (printValue !== undefined) {
    const printFormat = typeof printValue === "string" ? (printValue as OutputFormat) : undefined;
    if (printFormat !== undefined && format !== undefined && printFormat !== format) {
      return fail(`--print ${printFormat} conflicts with --format ${format}`);
    }
    const chosen = printFormat ?? format;
    args.print = chosen !== undefined ? { format: chosen } : {};
  } else if (format !== undefined) {
    return fail("--format selects one-shot output and requires --print");
  }

  // Mutual constraints.
  if (args.speed !== undefined && args.stepIntervalMs !== undefined) {
    return fail(
      "--speed and --step-interval are mutually exclusive: --speed follows the source clock, --step-interval ignores it"
    );
  }
  if (args.speed !== undefined && !args.replay) return fail("--speed is a replay multiplier and requires --replay");
  if (args.stepIntervalMs !== undefined && !args.replay)
    return fail("--step-interval steps recorded states and requires --replay");
  if (args.readOnly && args.reviewDir !== undefined)
    return fail("-r disables review writes, so --review-dir cannot be used with it");
  if (args.print) {
    if (args.replay) return fail("--replay needs the interactive viewer; it cannot be combined with --print");
    if (args.refreshMs !== undefined) return fail("--refresh is a redraw rate and cannot be combined with --print");
    if (args.reviewDir !== undefined)
      return fail("--print never writes reviews, so --review-dir cannot be used with it");
  }
  if (args.target === "-" && args.replay)
    return fail("--replay is unavailable for a stdin stream: streams carry no replay records");
  return { ok: true, args };
}

// ---------------------------------------------------------------------------
// run(proc, deps)

export type Writable = { write(chunk: string): unknown; isTTY?: boolean };
export type Readable = { isTTY?: boolean };
export type SignalName = "SIGINT" | "SIGTERM";

export type Proc = {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  cwd(): string;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  platform?: string;
  on?(signal: SignalName, handler: () => void): unknown;
  off?(signal: SignalName, handler: () => void): unknown;
};

export type Invocation<A> = {
  args: A;
  target: ResolvedTarget;
  project: ProjectCandidate | null;
  proc: Proc;
  signal: AbortSignal;
};

/** Handlers return an exit code; the defaults are the real adapters (open-viewer.ts, print.ts, sql.ts, eval.ts). */
export type RunDeps = {
  fs?: DetectFs;
  homedir?: () => string;
  readProjectConfig?: ProjectConfigReader;
  /** Whether a controlling-terminal keyboard port exists (needed when stdin carries data). */
  terminalInputAvailable?: () => boolean;
  openViewer?: (invocation: Invocation<ViewerArgs>) => Promise<number>;
  runPrint?: (invocation: Invocation<ViewerArgs>) => Promise<number>;
  runSql?: (invocation: Invocation<SqlArgs>) => Promise<number>;
  runEval?: (invocation: Invocation<EvalArgs>) => Promise<number>;
  readVersion?: () => string;
};

export const defaultFs: DetectFs = {
  async stat(filePath) {
    try {
      const info = await stat(filePath);
      return { isFile: info.isFile(), isDirectory: info.isDirectory(), size: info.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
        return undefined;
      }
      throw error;
    }
  },
  async readHead(filePath, bytes) {
    const handle = await open(filePath, "r");
    try {
      const buffer = new Uint8Array(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
};

export const defaultReadProjectConfig: ProjectConfigReader = async (directory) => {
  let raw: string;
  try {
    raw = readFileSync(path.join(directory, ".kosmo-callflow", "project.json"), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { projectId?: unknown };
    return typeof parsed.projectId === "string" && parsed.projectId.length > 0
      ? { projectId: parsed.projectId }
      : undefined;
  } catch {
    return undefined;
  }
};

function defaultReadVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function isLive(target: ResolvedTarget): boolean {
  return target.kind === "live-project" || target.kind === "live-trace";
}

export async function run(proc: Proc, deps: RunDeps = {}): Promise<number> {
  // The launcher token lives in memory from here on; no child spawned later inherits it.
  takeProcessToken(proc.env);
  const parsed = parseArgv(proc.argv.slice(2));
  if (!parsed.ok) {
    proc.stderr.write(`kosmo-tui: ${parsed.message}\nRun kosmo-tui --help for usage.\n`);
    return EXIT_USAGE;
  }
  const args = parsed.args;
  if (args.command === "help") {
    proc.stdout.write(USAGE);
    return EXIT_OK;
  }
  if (args.command === "version") {
    proc.stdout.write(`${(deps.readVersion ?? defaultReadVersion)()}\n`);
    return EXIT_OK;
  }

  const cwd = proc.cwd();
  const platform = proc.platform ?? process.platform;
  const fs = deps.fs ?? defaultFs;
  const homedir = (deps.homedir ?? os.homedir)();

  const targetText = args.command === "viewer" ? args.target : args.source;
  const detected = await detectTarget(targetText, { cwd, homedir, fs });
  if (!detected.ok) {
    proc.stderr.write(`${detected.message}\n`);
    return detected.exitCode;
  }
  const target = detected.target;

  if (args.command === "viewer") {
    if (target.kind === "live-trace" && args.trace !== undefined && args.trace !== target.traceId) {
      proc.stderr.write(
        `kosmo-tui: trace ${target.traceId} was given as the target and --trace ${args.trace} as well; pass one\n`
      );
      return EXIT_USAGE;
    }
    if (args.print === undefined) {
      const outputTty = proc.stdout.isTTY === true;
      const inputTty =
        target.kind === "stdin"
          ? (deps.terminalInputAvailable ?? (() => controllingTerminalAvailable(platform)))()
          : proc.stdin.isTTY === true;
      if (!outputTty || !inputTty) {
        proc.stderr.write(
          "kosmo-tui: interactive terminal required (stdout and keyboard input must be a TTY). Use --print [lisp|tab|json] for non-interactive output.\n"
        );
        return EXIT_USAGE;
      }
    }
  }

  let project: ProjectCandidate | null = null;
  if (isLive(target)) {
    const candidates = await discoverProjectCandidates({
      cwd,
      readConfig: deps.readProjectConfig ?? defaultReadProjectConfig
    });
    const selection = selectProject(candidates, args.project);
    if (!selection.ok) {
      proc.stderr.write(`${selection.message}\n`);
      return EXIT_USAGE;
    }
    project = selection.project;
  }

  // Validation is complete: from here on side effects are allowed.
  const controller = new AbortController();
  let signalled: number | undefined;
  const onInt = (): void => {
    signalled ??= EXIT_SIGINT;
    controller.abort("SIGINT");
  };
  const onTerm = (): void => {
    signalled ??= EXIT_SIGTERM;
    controller.abort("SIGTERM");
  };
  proc.on?.("SIGINT", onInt);
  proc.on?.("SIGTERM", onTerm);
  try {
    let code: number;
    if (args.command === "viewer") {
      const invocation: Invocation<ViewerArgs> = { args, target, project, proc, signal: controller.signal };
      code = args.print
        ? await (deps.runPrint ?? runPrintCommand)(invocation)
        : await (deps.openViewer ?? openViewerSession)(invocation);
    } else if (args.command === "sql") {
      code = await (deps.runSql ?? runSqlCommand)({ args, target, project, proc, signal: controller.signal });
    } else {
      code = await (deps.runEval ?? runEvalCommand)({ args, target, project, proc, signal: controller.signal });
    }
    return signalled ?? code;
  } catch (error) {
    if (signalled !== undefined) return signalled;
    const message = error instanceof Error ? error.message : String(error);
    proc.stderr.write(`kosmo-tui: ${message.slice(0, 2_000)}\n`);
    return EXIT_SOURCE;
  } finally {
    proc.off?.("SIGINT", onInt);
    proc.off?.("SIGTERM", onTerm);
  }
}
