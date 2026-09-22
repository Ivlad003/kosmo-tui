/**
 * Trusted local JS eval (spec trace-programmable-access: «Локальний довірений JS eval»,
 * design D12).
 *
 * `kosmo-tui eval '<expression>'` runs the user's OWN code over a bounded, sanitized
 * snapshot. It is explicit local-code execution, not a read-only or hostile-code sandbox:
 * `node:vm` only gives the code a separate JS context. What this module does guarantee:
 *
 *  - the code runs in a child process (eval-child.ts) with a 64 MiB V8 heap and a
 *    128 MiB resident-memory budget (off-heap ArrayBuffers are not covered by the heap
 *    flags; the parent polls the child's RSS and SIGKILLs it above the budget), a minimal
 *    allowlisted environment (no inherited auth variables, tokens or NODE_OPTIONS) and
 *    only the serialized snapshot — no source handles, tokens or host callbacks;
 *  - the parent enforces a 2 s wall-clock deadline and SIGKILLs the child on expiry,
 *    including busy loops and endless microtask chains, and waits for it to be reaped;
 *  - result serialization (user getters/toJSON) happens inside the timed child, the
 *    output is capped at 51,200 UTF-8 bytes and a failure never yields partial JSON;
 *  - masked values stay masked: the snapshot never carries a backing value for them;
 *  - the result is a `value` JSON envelope with provenance `computed-local`.
 *
 * `-r` and `--no-eval` disable the action before any child is spawned.
 */

import { execFile, spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TraceDatasetSnapshot } from "@kosmo-callflow/query/snapshot";
import { importPortableExport } from "@kosmo-callflow/replay";
import { sanitizeEvidenceText, sanitizeStructuredEvidence } from "@kosmo-callflow/trace-artifacts";
import { EXIT_OK, EXIT_SOURCE, EXIT_USAGE, type EvalArgs, type Invocation } from "./cli.js";
import { spanDetailFromEvents, spanRowsFromEvents, type TraceEventView } from "./detail.js";
import { spanKey, spanRefOf, type DetailValue, type SpanRef } from "./view-state.js";

export const EVAL_DEADLINE_MS = 2_000;
export const EVAL_HEAP_MB = 64;
/**
 * The whole V8 heap (old + young generation) is bounded, not only old space: newer V8
 * (Node 25) sizes the young generation far larger by default, so `--max-old-space-size`
 * alone left a 256 MiB heap limit. Young = 3 × semi-space; old gets the rest.
 */
export const EVAL_SEMI_SPACE_MB = 1;
export const EVAL_HEAP_FLAGS = [
  `--max-semi-space-size=${EVAL_SEMI_SPACE_MB}`,
  `--max-old-space-size=${EVAL_HEAP_MB - 3 * EVAL_SEMI_SPACE_MB}`
] as const;
/**
 * Resident-memory budget of the child. The heap flags bound the V8 heap only; typed-array
 * backing stores live off-heap, so the parent polls the child's RSS every
 * `EVAL_RSS_POLL_MS` and SIGKILLs it above this (and the child checks once more before it
 * answers). A bare child sits near 45 MiB and a full 64 MiB heap near 100 MiB.
 */
export const EVAL_RSS_MAX_MB = 128;
export const EVAL_RSS_POLL_MS = 50;
export const EVAL_OUTPUT_MAX_BYTES = 51_200;
/** Snapshot bounds; a larger scope is rejected, never silently sampled. */
export const EVAL_SNAPSHOT_MAX_SPANS = 20_000;
export const EVAL_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
/** Raw export file bound, checked before the file is read. */
export const EVAL_SOURCE_MAX_BYTES = 32 * 1024 * 1024;
const STDERR_KEEP_BYTES = 8 * 1024;

export const EVAL_RESULT_VERSION = "kosmo.eval-result/v1";
export const EVAL_SNAPSHOT_VERSION = "kosmo.eval-snapshot/v1";

/** Environment variables a child may inherit. Everything else — tokens included — is dropped. */
export const EVAL_ENV_ALLOWLIST = ["TZ", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "SYSTEMROOT"] as const;

export type EvalScope = {
  source: "export" | "sqlite";
  datasetId: string;
  projectId: string;
  traceId: string | null;
};

export type EvalCoverage = { scope: "complete" | "partial"; loaded: number; total: number | null; reason?: string };

export type EvalSpan = {
  /** Opaque qualified ref, unique within the snapshot. */
  id: string;
  ref: SpanRef;
  parentId: string | null;
  /** The recorded parent is not in the snapshot (retention, loss or not loaded). */
  orphan: boolean;
  nodeId: string;
  depth: number;
  errored: boolean;
  firstSeq: number;
  lastSeq: number;
  values: { args: DetailValue; ret: DetailValue; error: DetailValue };
};

export type EvalSnapshot = {
  version: typeof EVAL_SNAPSHOT_VERSION;
  scope: EvalScope;
  coverage: EvalCoverage;
  capabilities: { replay: false };
  spans: EvalSpan[];
};

export type EvalTruncation = { reason: "output-bytes"; shownItems: number; totalItems: number };

export type EvalEnvelope = {
  version: typeof EVAL_RESULT_VERSION;
  kind: "value";
  provenance: "computed-local";
  scope: EvalScope;
  coverage: EvalCoverage;
  truncated: boolean;
  truncation?: EvalTruncation;
  value: unknown;
};

export type EvalFailureCode =
  | "disabled"
  | "dataset-too-large"
  | "timeout"
  | "heap-exceeded"
  | "child-failed"
  | "output-too-large"
  | "unsupported-result"
  | "user-error"
  | "syntax-error"
  | "protocol-error"
  | "aborted";

export type EvalOutcome =
  | { ok: true; envelope: EvalEnvelope; json: string; pid: number | undefined }
  | { ok: false; code: EvalFailureCode; message: string; pid: number | undefined };

/** Build the child's environment from an allowlist; nothing is inherited by default. */
export function evalChildEnv(parent: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of EVAL_ENV_ALLOWLIST) {
    const value = parent[name];
    if (typeof value === "string") env[name] = value;
  }
  return env;
}

/** The compiled child next to this module; tests running from src use the built copy. */
export function defaultEvalChildScript(): string {
  const here = fileURLToPath(import.meta.url);
  if (here.endsWith(".ts")) return path.join(path.dirname(here), "..", "dist", "eval-child.js");
  return path.join(path.dirname(here), "eval-child.js");
}

/** A value the export redacted on the way out; like `[masked]`, it has no readable backing. */
function containsRedaction(value: unknown): boolean {
  if (value === "[masked]") return true;
  if (Array.isArray(value)) return value.some(containsRedaction);
  if (value !== null && typeof value === "object") {
    if ((value as { $type?: unknown }).$type === "redacted") return true;
    return Object.values(value).some(containsRedaction);
  }
  return false;
}

function maskedIfRedacted(value: DetailValue, raw: unknown): DetailValue {
  return containsRedaction(raw) ? { state: "masked" } : value;
}

function sanitize(text: string): string {
  return sanitizeEvidenceText(text).value;
}

function payloadOf(events: TraceEventView[], type: TraceEventView["type"]): Record<string, unknown> | undefined {
  return events.find((event) => event.type === type)?.payload;
}

/**
 * Freeze recorded events into the snapshot the child receives. Values come from the
 * same detail extraction the viewer uses, so masked stays `{state:"masked"}` with no
 * backing text, and every recorded string is already sanitized.
 */
export function buildEvalSnapshot(
  events: TraceEventView[],
  scope: EvalScope,
  options: { gaps?: number } = {}
): { ok: true; snapshot: EvalSnapshot } | { ok: false; message: string } {
  const datasetScope = { datasetId: scope.datasetId, projectId: scope.projectId };
  const rows = spanRowsFromEvents(events, datasetScope);
  if (rows.length > EVAL_SNAPSHOT_MAX_SPANS) {
    return {
      ok: false,
      message: `dataset-too-large: ${rows.length} spans exceed the eval snapshot budget of ${EVAL_SNAPSHOT_MAX_SPANS}; narrow it with --trace`
    };
  }
  const grouped = new Map<string, TraceEventView[]>();
  for (const event of events) {
    const key = JSON.stringify([event.sessionId, event.traceId, event.spanId]);
    const list = grouped.get(key) ?? [];
    list.push(event);
    grouped.set(key, list);
  }
  // Parent links resolve exactly like the shared graph selectors (`@kosmo-callflow/query/graph`)
  // behind `:ancestors`: the same session first, else a UNIQUE span with that id in the same
  // trace (another session), else no link (missing or ambiguous).
  const bySession = new Set(rows.map((row) => JSON.stringify([row.sessionId, row.traceId, row.spanId])));
  const byTraceSpan = new Map<string, SpanRef[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.traceId, row.spanId]);
    const list = byTraceSpan.get(key) ?? [];
    list.push(spanRefOf(row));
    byTraceSpan.set(key, list);
  }
  const parentOf = (ref: SpanRef, parentSpanId: string | null): string | null => {
    if (parentSpanId === null) return null;
    if (bySession.has(JSON.stringify([ref.sessionId, ref.traceId, parentSpanId]))) {
      return spanKey({ ...ref, spanId: parentSpanId });
    }
    const candidates = byTraceSpan.get(JSON.stringify([ref.traceId, parentSpanId])) ?? [];
    return candidates.length === 1 ? spanKey(candidates[0]!) : null;
  };
  const spans: EvalSpan[] = rows.map((row) => {
    const ref = spanRefOf(row);
    const own = grouped.get(JSON.stringify([row.sessionId, row.traceId, row.spanId])) ?? [];
    const detail = spanDetailFromEvents(own, ref, null);
    const recordedParent = own.find((event) => event.parentSpanId !== null)?.parentSpanId ?? null;
    const parentId = parentOf(ref, recordedParent);
    const seqs = own.map((event) => event.seq);
    return {
      id: spanKey(ref),
      ref,
      parentId,
      orphan: parentId === null && recordedParent !== null,
      nodeId: sanitize(row.nodeId),
      depth: row.depth,
      errored: row.errored,
      firstSeq: Math.min(...seqs),
      lastSeq: Math.max(...seqs),
      values: {
        args: maskedIfRedacted(detail?.args ?? { state: "not-recorded" }, payloadOf(own, "enter")?.args),
        ret: maskedIfRedacted(detail?.ret ?? { state: "not-recorded" }, payloadOf(own, "exit")?.ret),
        error: maskedIfRedacted(detail?.error ?? { state: "not-recorded" }, payloadOf(own, "error"))
      }
    };
  });
  const partial = (options.gaps ?? 0) > 0;
  return {
    ok: true,
    snapshot: {
      version: EVAL_SNAPSHOT_VERSION,
      scope: {
        source: scope.source,
        datasetId: sanitize(scope.datasetId),
        projectId: sanitize(scope.projectId),
        traceId: scope.traceId === null ? null : sanitize(scope.traceId)
      },
      coverage: partial
        ? { scope: "partial", loaded: spans.length, total: null, reason: "the export records retention gaps" }
        : { scope: "complete", loaded: spans.length, total: spans.length },
      capabilities: { replay: false },
      spans
    }
  };
}

function envelopeFor(snapshot: EvalSnapshot, value: unknown, truncation: EvalTruncation | undefined): EvalEnvelope {
  return {
    version: EVAL_RESULT_VERSION,
    kind: "value",
    provenance: "computed-local",
    scope: snapshot.scope,
    coverage: snapshot.coverage,
    truncated: truncation !== undefined,
    ...(truncation !== undefined ? { truncation } : {}),
    value
  };
}

/** Bytes the child may spend on the value so the whole envelope line fits the cap. */
function valueBudget(snapshot: EvalSnapshot): number {
  const skeleton = envelopeFor(snapshot, 0, {
    reason: "output-bytes",
    shownItems: 999_999_999,
    totalItems: 999_999_999
  });
  // The skeleton's one-byte value placeholder pays for the trailing newline.
  return EVAL_OUTPUT_MAX_BYTES - Buffer.byteLength(JSON.stringify(skeleton), "utf8");
}

export type EvalRunOptions = {
  code: string;
  snapshot: EvalSnapshot;
  /** Parent environment the allowlist is applied to; defaults to process.env. */
  env?: Record<string, string | undefined>;
  deadlineMs?: number;
  /** Child entry override (tests use probes); defaults to the compiled eval-child.js. */
  childScript?: string;
  signal?: AbortSignal;
};

/** The child's resident set in bytes, or null where it cannot be read (the heap flags still apply). */
async function residentBytes(pid: number): Promise<number | null> {
  if (process.platform === "linux") {
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
      return match ? Number(match[1]) * 1024 : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") return null;
  return await new Promise((resolve) => {
    execFile("ps", ["-o", "rss=", "-p", String(pid)], { timeout: 1_000, windowsHide: true }, (error, stdout) => {
      const kib = Number(String(stdout).trim());
      resolve(error || !Number.isFinite(kib) || kib <= 0 ? null : kib * 1024);
    });
  });
}

type ChildMessage =
  | { ok: true; truncation: EvalTruncation | null; value: unknown }
  | { ok: false; code: EvalFailureCode; message: string };

/**
 * Run one expression in a fresh child. Resolves only after the child has exited and
 * been reaped, so a returned outcome never leaves a process behind.
 */
export async function runLocalEval(options: EvalRunOptions): Promise<EvalOutcome> {
  const snapshotText = JSON.stringify(options.snapshot);
  if (Buffer.byteLength(snapshotText, "utf8") > EVAL_SNAPSHOT_MAX_BYTES) {
    return {
      ok: false,
      code: "dataset-too-large",
      message: `the eval snapshot exceeds ${EVAL_SNAPSHOT_MAX_BYTES} bytes; narrow it with --trace`,
      pid: undefined
    };
  }
  const budget = valueBudget(options.snapshot);
  const deadlineMs = options.deadlineMs ?? EVAL_DEADLINE_MS;
  const stdoutLimit = EVAL_OUTPUT_MAX_BYTES + 4_096;

  const child = spawn(
    process.execPath,
    [...EVAL_HEAP_FLAGS, "--disallow-code-generation-from-strings", options.childScript ?? defaultEvalChildScript()],
    {
      env: evalChildEnv(options.env ?? process.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    }
  );
  const pid = child.pid;

  return await new Promise<EvalOutcome>((resolve) => {
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    let failure: { code: EvalFailureCode; message: string } | undefined;
    let settled = false;

    const kill = (code: EvalFailureCode, message: string): void => {
      failure ??= { code, message };
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => kill("timeout", `eval exceeded the ${deadlineMs} ms deadline; the child process was killed`),
      deadlineMs
    );
    const memoryMessage = `eval exceeded the ${EVAL_RSS_MAX_MB} MiB memory budget (resident set; ${EVAL_HEAP_MB} MiB heap); the child process was killed`;
    let watching = true;
    const watch = async (): Promise<void> => {
      while (watching && pid !== undefined) {
        const rss = await residentBytes(pid);
        if (!watching) return;
        if (rss !== null && rss > EVAL_RSS_MAX_MB * 1024 * 1024) {
          kill("heap-exceeded", memoryMessage);
          return;
        }
        await new Promise((resume) => setTimeout(resume, EVAL_RSS_POLL_MS).unref());
      }
    };
    void watch();
    const onAbort = (): void => kill("aborted", "eval was interrupted; the child process was killed");
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > stdoutLimit) {
        kill("output-too-large", `the result exceeds ${EVAL_OUTPUT_MAX_BYTES} bytes`);
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length < STDERR_KEEP_BYTES) err += chunk.toString("utf8").slice(0, STDERR_KEEP_BYTES - err.length);
    });
    child.stdin.on("error", () => {
      // The child exited before reading everything; its exit status says why.
    });
    child.on("error", (error) => kill("child-failed", `could not start the eval child: ${error.message}`));
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      watching = false;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (failure !== undefined) {
        resolve({ ok: false, ...failure, pid });
        return;
      }
      if (exitCode !== 0) {
        const oom = /heap out of memory|Allocation failed|Reached heap limit/i.test(err);
        resolve({
          ok: false,
          code: oom ? "heap-exceeded" : "child-failed",
          message: oom
            ? `eval exceeded the ${EVAL_HEAP_MB} MiB heap budget; the child process died`
            : `the eval child failed (${signal !== null ? `signal ${signal}` : `exit code ${String(exitCode)}`})`,
          pid
        });
        return;
      }
      const outcome = finish(Buffer.concat(out).toString("utf8"), options.snapshot, pid);
      resolve(!outcome.ok && outcome.code === "heap-exceeded" ? { ...outcome, message: memoryMessage } : outcome);
    });

    const rssBudget = EVAL_RSS_MAX_MB * 1024 * 1024;
    child.stdin.end(`${JSON.stringify({ code: options.code, valueBudget: budget, rssBudget })}\n${snapshotText}`);
  });
}

function finish(raw: string, snapshot: EvalSnapshot, pid: number | undefined): EvalOutcome {
  let message: ChildMessage;
  try {
    message = JSON.parse(raw.trimEnd()) as ChildMessage;
  } catch {
    return { ok: false, code: "protocol-error", message: "the eval child returned no valid result", pid };
  }
  if (!message.ok) {
    return { ok: false, code: message.code, message: sanitize(String(message.message)).slice(0, 2_000), pid };
  }
  const value = sanitizeStructuredEvidence(message.value).value;
  const envelope = envelopeFor(snapshot, value, message.truncation ?? undefined);
  const json = JSON.stringify(envelope);
  if (Buffer.byteLength(json, "utf8") + 1 > EVAL_OUTPUT_MAX_BYTES) {
    return { ok: false, code: "output-too-large", message: `the result exceeds ${EVAL_OUTPUT_MAX_BYTES} bytes`, pid };
  }
  return { ok: true, envelope, json, pid };
}

function isRuntimeRecord(record: Record<string, unknown>): boolean {
  return (
    typeof record.seq === "number" &&
    typeof record.sessionId === "string" &&
    typeof record.traceId === "string" &&
    typeof record.spanId === "string" &&
    typeof record.nodeId === "string" &&
    typeof record.type === "string" &&
    ["enter", "exit", "error", "suspend", "commit"].includes(record.type)
  );
}

/** Portable export records → the event rows the snapshot builder reads. Pure data. */
export function eventsFromExportRecords(records: Array<Record<string, unknown>>): TraceEventView[] {
  return records.filter(isRuntimeRecord).map((record) => ({
    seq: record.seq as number,
    sessionId: record.sessionId as string,
    traceId: record.traceId as string,
    spanId: record.spanId as string,
    parentSpanId: typeof record.parentSpanId === "string" ? record.parentSpanId : null,
    type: record.type as TraceEventView["type"],
    nodeId: record.nodeId as string,
    ts: typeof record.ts === "number" ? record.ts : 0,
    ...(record.payload !== null && typeof record.payload === "object" && !Array.isArray(record.payload)
      ? { payload: record.payload as Record<string, unknown> }
      : {})
  }));
}

type LoadResult = { ok: true; snapshot: EvalSnapshot } | { ok: false; message: string };

/**
 * The `:js` snapshot of a viewer's pinned offline dataset (export or sqlite): the same
 * records the view reads, frozen through `buildEvalSnapshot`. Retention, loss or a cut
 * scope make the coverage partial rather than being hidden.
 */
export function evalSnapshotFromDataset(
  dataset: TraceDatasetSnapshot,
  source: EvalScope["source"],
  traceId?: string
): LoadResult {
  let events = eventsFromExportRecords(dataset.records as unknown as Array<Record<string, unknown>>);
  if (traceId !== undefined) events = events.filter((event) => event.traceId === traceId);
  const { completeness, identity } = dataset;
  const gaps = completeness.retention || completeness.loss || completeness.truncated ? 1 : 0;
  return buildEvalSnapshot(
    events,
    { source, datasetId: identity.datasetId, projectId: identity.projectId, traceId: traceId ?? null },
    { gaps }
  );
}

async function loadExportSnapshot(file: string, traceId: string | undefined): Promise<LoadResult> {
  const info = await stat(file);
  if (info.size > EVAL_SOURCE_MAX_BYTES) {
    return { ok: false, message: `dataset-too-large: the export exceeds ${EVAL_SOURCE_MAX_BYTES} bytes` };
  }
  let dataset: ReturnType<typeof importPortableExport>["dataset"];
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    dataset = importPortableExport(value, { namespace: "export", maxBytes: EVAL_SOURCE_MAX_BYTES }).dataset;
  } catch (error) {
    return { ok: false, message: `not a valid portable export: ${(error as Error).message.slice(0, 500)}` };
  }
  let events = eventsFromExportRecords(dataset.records);
  if (traceId !== undefined) {
    events = events.filter((event) => event.traceId === traceId);
    if (events.length === 0) return { ok: false, message: `trace ${traceId} is not in the export` };
  }
  return buildEvalSnapshot(
    events,
    { source: "export", datasetId: dataset.datasetId, projectId: dataset.projectId, traceId: traceId ?? null },
    { gaps: dataset.completeness.gaps.length }
  );
}

/** `deps.runEval` default: the `kosmo-tui eval` subcommand. */
export async function runEvalCommand(
  invocation: Invocation<EvalArgs>,
  options: Pick<EvalRunOptions, "childScript" | "deadlineMs"> = {}
): Promise<number> {
  const { args, target, proc } = invocation;
  const error = (text: string): void => {
    proc.stderr.write(`kosmo-tui: ${text}\n`);
  };
  if (args.readOnly === true || args.noEval === true) {
    error(
      `eval is unavailable: local eval is disabled by ${args.readOnly === true ? "-r" : "--no-eval"} (unavailable(local-eval-disabled)); no code was run`
    );
    return EXIT_SOURCE;
  }
  if (args.format !== undefined && args.format !== "json") {
    error(`eval returns a computed-local value; --format ${args.format} is unsupported (use json)`);
    return EXIT_USAGE;
  }
  if (target.kind !== "export") {
    error(`eval is unavailable for a ${target.kind} source in this build; pass --source ./export.json`);
    return EXIT_SOURCE;
  }
  const loaded = await loadExportSnapshot(target.path, args.trace);
  if (!loaded.ok) {
    error(loaded.message);
    return EXIT_SOURCE;
  }
  const outcome = await runLocalEval({
    code: args.code,
    snapshot: loaded.snapshot,
    env: proc.env,
    signal: invocation.signal,
    ...options
  });
  if (!outcome.ok) {
    error(`eval failed: ${outcome.code}: ${outcome.message}`);
    return EXIT_SOURCE;
  }
  proc.stdout.write(`${outcome.json}\n`);
  return EXIT_OK;
}
