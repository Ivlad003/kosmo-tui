/**
 * One-shot output: the default `runPrint` of `kosmo-tui [target] --print [lisp|tab|json]`
 * (task 7.4, design D15, spec tui-debugger "One-shot і terminal lifecycle").
 *
 * Rules:
 *  - never interactive: no terminal, no raw mode, no alt screen, no clipboard, no review
 *    (the session policy is `print`, and nothing here imports the review module);
 *  - without a trace (`--trace`, or a `live-trace` target) the answer is the bounded
 *    dataset list (`kosmo.trace-list/v1`, a table), never an arbitrary first trace;
 *  - with a trace: its projection (`--projection-version`, default v2 when served) as
 *    Lisp/Tab/JSON trace-text through the protocol codecs; a summary-only source gives
 *    the trace's summary row as a table, and Lisp there is `unavailable(<reason>)`;
 *  - stdin: only a finite stream (`follow:false`) that reaches `end` within 5 s; a
 *    follow stream is refused as soon as its header is read, and incomplete or late input
 *    is a source error with EMPTY stdout;
 *  - every check and the whole serialization finish before the first stdout byte, and
 *    the text is written once. Output is bounded to 51,200 UTF-8 bytes by the typed
 *    serializers (whole items/rows dropped, envelope stays valid, truncation marked);
 *  - a sink failure (EPIPE) after writing started cannot take bytes back: it ends the
 *    command with exit 2 and a stderr note, never a success claim.
 *
 * Exit codes (D15): 0 success (including explicit truncation), 1 usage (invalid format
 * combination), 2 source/auth/codec/capability failure; signals are mapped by run().
 */

import {
  projectTraceTextDocument,
  projectTraceTextDocumentV2,
  type CanonicalPageEnvelope,
  type CanonicalPageEnvelopeV2
} from "@kosmo-callflow/protocol";
import { EXIT_OK, EXIT_SOURCE, EXIT_USAGE, type Invocation, type ViewerArgs } from "./cli.js";
import { effectiveCapabilities, type Capabilities } from "./capabilities.js";
import { serializeResult, type ProjectionResult, type TableResult, type TypedResult } from "./serializers.js";
import { openTargetSource, type OpenTargetDeps } from "./source-open.js";
import type { StreamSource } from "./source-stream.js";
import type { ProjectionOptions, SourceOpenResult, TraceSource } from "./source.js";
import type { TraceRow } from "./view-state.js";

export const PRINT_STDIN_DEADLINE_MS = 5_000;
export const TRACE_LIST_SCHEMA = "kosmo.trace-list/v1";
/** Rows the dataset list reads before the byte cap; more stays behind the cursor. */
export const PRINT_LIST_LIMIT = 1_000;
/** Pages scanned for `--trace` before giving up with an explicit error. */
const TRACE_SCAN_PAGES = 20;
const TRACE_SCAN_LIMIT = 1_000;
const DEADLINE = "stdin-deadline";

export type PrintDeps = {
  source?: OpenTargetDeps;
  /** Deadline for a stdin stream to reach `end`; 5 s by default. */
  stdinDeadlineMs?: number;
};

type Built = { ok: true; result: TypedResult } | { ok: false; exitCode: 1 | 2; message: string };

const LIST_COLUMNS = ["dataset_id", "project_id", "session_id", "trace_id", "status", "span_count", "started_at"];

function listRow(row: TraceRow): unknown[] {
  return [row.datasetId, row.projectId, row.sessionId, row.traceId, row.status, row.spanCount, row.startedAt];
}

function listTable(
  opened: SourceOpenResult,
  source: TraceSource,
  rows: TraceRow[],
  coverage: { scope: string; loaded: number; total: number | null; cursor: string | null } & Record<string, unknown>,
  truncated: boolean,
  traceId: string | null
): TableResult {
  const snapshot = opened.snapshot;
  return {
    kind: "table",
    schema: TRACE_LIST_SCHEMA,
    scope: {
      source: source.kind,
      datasetId: snapshot.datasetId,
      projectId: snapshot.projectId,
      snapshotId: snapshot.snapshotId,
      revision: snapshot.revision,
      watermark: snapshot.watermark,
      retentionEpoch: snapshot.retentionEpoch,
      traceId
    },
    coverage,
    columns: LIST_COLUMNS,
    rows: rows.map(listRow),
    truncated
  };
}

/** The bounded dataset view: trace rows of the pinned snapshot, never one picked trace. */
async function datasetList(source: TraceSource, opened: SourceOpenResult, signal: AbortSignal): Promise<Built> {
  const rows = [...opened.firstPage.items];
  let page = opened.firstPage;
  while (page.cursor !== null && rows.length < PRINT_LIST_LIMIT) {
    page = await source.traces(
      opened.snapshot,
      { limit: Math.min(TRACE_SCAN_LIMIT, PRINT_LIST_LIMIT - rows.length), cursor: page.cursor },
      signal
    );
    rows.push(...page.items);
  }
  const { coverage } = page;
  return {
    ok: true,
    result: listTable(
      opened,
      source,
      rows,
      {
        scope: coverage.scope,
        loaded: rows.length,
        total: coverage.total,
        ...(coverage.reason === undefined ? {} : { reason: coverage.reason }),
        cursor: page.cursor
      },
      page.cursor !== null || page.truncated,
      null
    )
  };
}

/** Exactly one trace row with this id, or an explicit error (not found / ambiguous). */
async function findTrace(
  source: TraceSource,
  opened: SourceOpenResult,
  traceId: string,
  signal: AbortSignal
): Promise<{ ok: true; row: TraceRow } | { ok: false; message: string }> {
  const matches: TraceRow[] = [];
  let page = opened.firstPage;
  let scanned = 0;
  for (;;) {
    matches.push(...page.items.filter((row) => row.traceId === traceId));
    scanned += 1;
    if (page.cursor === null || scanned >= TRACE_SCAN_PAGES) break;
    page = await source.traces(opened.snapshot, { limit: TRACE_SCAN_LIMIT, cursor: page.cursor }, signal);
  }
  if (matches.length === 1) return { ok: true, row: matches[0]! };
  if (matches.length > 1) {
    const sessions = matches.map((row) => row.sessionId).join(", ");
    return { ok: false, message: `trace ${traceId} is ambiguous: it exists in sessions ${sessions}` };
  }
  const where = page.cursor === null ? "" : ` in the first ${scanned} page(s)`;
  return { ok: false, message: `trace ${traceId} was not found${where}` };
}

function canonicalDepth(depth: ViewerArgs["depth"]): ProjectionOptions["depth"] | undefined {
  if (depth === "module" || depth === "call") return depth;
  if (depth === "symbol") return "function";
  return undefined;
}

async function traceResult(
  args: ViewerArgs,
  traceId: string,
  source: TraceSource,
  opened: SourceOpenResult,
  caps: Capabilities,
  signal: AbortSignal
): Promise<Built> {
  const format = args.print?.format;
  const found = await findTrace(source, opened, traceId, signal);
  if (!found.ok) return { ok: false, exitCode: EXIT_SOURCE, message: found.message };
  const row = found.row;
  if (!caps.projection.available || source.canonical === undefined) {
    const reason = caps.projection.available ? "no-projection-api" : caps.projection.reason;
    if (format === "lisp") {
      return {
        ok: false,
        exitCode: EXIT_SOURCE,
        message: `--print lisp: unavailable(${reason}): this source has no span projection; --print json or tab gives the trace summary`
      };
    }
    const scope = opened.firstPage.coverage;
    return {
      ok: true,
      result: listTable(
        opened,
        source,
        [row],
        {
          scope: "partial",
          loaded: 1,
          total: 1,
          reason: `summary-only(${reason})`,
          cursor: null,
          ...(scope.reason === undefined ? {} : { sourceCoverage: scope.reason })
        },
        false,
        traceId
      )
    };
  }
  const versions = caps.projectionVersions;
  const version = args.projectionVersion ?? (versions.includes(2) ? 2 : 1);
  if (!versions.includes(version)) {
    return {
      ok: false,
      exitCode: EXIT_SOURCE,
      message: `--projection-version ${version}: unavailable(projection-v${version}); this source serves ${versions.map((v) => `v${v}`).join(", ")}`
    };
  }
  const detail = args.detail ?? 2;
  const values = args.values && caps.values.available;
  const depth = canonicalDepth(args.depth);
  const page = await source.canonical(
    opened.snapshot,
    { kind: "trace", ref: row },
    { version, detail, values, ...(depth === undefined ? {} : { depth }) },
    signal
  );
  const textOptions = { detail, values, ...(args.depth === undefined ? {} : { depth: args.depth }) };
  const projection: ProjectionResult =
    page.version === 2
      ? {
          kind: "projection",
          version: 2,
          document: projectTraceTextDocumentV2(page.envelope as CanonicalPageEnvelopeV2, textOptions)
        }
      : {
          kind: "projection",
          version: 1,
          document: projectTraceTextDocument(page.envelope as CanonicalPageEnvelope, textOptions)
        };
  return { ok: true, result: projection };
}

type SinkLike = {
  write(chunk: string, callback?: (error?: Error | null) => void): unknown;
  writable?: unknown;
  on?(event: "error", listener: (error: Error) => void): unknown;
};

/**
 * Write the serialized text once. A real stream is awaited through its write callback;
 * an error listener stays attached so a late EPIPE never crashes the process.
 */
async function writeOnce(stdout: SinkLike, text: string): Promise<Error | null> {
  let failed: Error | null = null;
  stdout.on?.("error", (error) => {
    failed ??= error;
  });
  await new Promise<void>((resolve) => {
    try {
      if (typeof stdout.writable === "boolean") {
        stdout.write(text, (error) => {
          if (error) failed ??= error;
          resolve();
        });
      } else {
        stdout.write(text);
        resolve();
      }
    } catch (error) {
      failed ??= error as Error;
      resolve();
    }
  });
  return failed;
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^kosmo-tui: /, "")
    .slice(0, 2_000);
}

/** `deps.runPrint` default. */
export async function runPrintCommand(invocation: Invocation<ViewerArgs>, deps: PrintDeps = {}): Promise<number> {
  const { args, target, project, proc, signal } = invocation;
  const fail = (code: number, text: string): number => {
    proc.stderr.write(`kosmo-tui: ${text}\n`);
    return code;
  };
  const traceId = args.trace ?? (target.kind === "live-trace" ? target.traceId : undefined);
  const format = args.print?.format;
  if (traceId === undefined && format === "lisp") {
    return fail(
      EXIT_USAGE,
      "--print lisp renders one trace's projection; pass --trace <id>, or use --print json|tab for the dataset list"
    );
  }

  const selected = await openTargetSource(
    {
      target,
      project,
      env: proc.env,
      cwd: proc.cwd(),
      ...(args.project === undefined ? {} : { projectId: args.project })
    },
    deps.source ?? {}
  );
  if (!selected.ok) return fail(selected.exitCode, selected.message.replace(/^kosmo-tui: /, ""));
  const source = selected.source;

  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  const deadlineMs = deps.stdinDeadlineMs ?? PRINT_STDIN_DEADLINE_MS;
  const timer = target.kind === "stdin" ? setTimeout(() => controller.abort(DEADLINE), deadlineMs) : null;

  try {
    let opened: SourceOpenResult;
    try {
      opened = await source.open(controller.signal);
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason === DEADLINE) {
        return fail(
          EXIT_SOURCE,
          `stdin stream did not reach end within ${deadlineMs / 1_000} s; --print needs a finite stream (incomplete input, nothing printed)`
        );
      }
      throw error;
    }
    if (timer !== null) clearTimeout(timer);

    if (source.kind === "stream") {
      if (opened.offers.follow.available) {
        return fail(
          EXIT_SOURCE,
          "unavailable(follow-stream): --print accepts only a finite stream (follow:false); run the producer without follow"
        );
      }
      const completeness = (source as StreamSource).completeness();
      if (completeness.state !== "complete") {
        const reasons = completeness.state === "incomplete" ? completeness.reasons.join(",") : completeness.state;
        return fail(EXIT_SOURCE, `stdin stream is incomplete(${reasons}); nothing printed`);
      }
    }

    const caps = effectiveCapabilities(opened, source, { readOnly: args.readOnly, noEval: true, print: true });
    const built =
      traceId === undefined
        ? await datasetList(source, opened, controller.signal)
        : await traceResult(args, traceId, source, opened, caps, controller.signal);
    if (!built.ok) return fail(built.exitCode, built.message);
    let serialized;
    try {
      serialized = serializeResult(built.result, format);
    } catch (error) {
      return fail(EXIT_SOURCE, `serialization failed: ${describe(error)}; nothing printed`);
    }
    if (!serialized.ok) return fail(EXIT_USAGE, serialized.message);

    // Everything is validated and serialized: the first and only stdout write.
    const failed = await writeOnce(proc.stdout as unknown as SinkLike, serialized.text);
    if (failed !== null) {
      const code = (failed as NodeJS.ErrnoException).code ?? failed.message;
      return fail(EXIT_SOURCE, `output ended early (${code}); bytes already written cannot be taken back`);
    }
    return EXIT_OK;
  } catch (error) {
    if (signal.aborted) throw error;
    return fail(EXIT_SOURCE, describe(error));
  } finally {
    if (timer !== null) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    try {
      await source.close();
    } catch {
      // Best effort: nothing more can be printed.
    }
  }
}
