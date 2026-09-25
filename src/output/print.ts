/**
 * `--print` (spec 7.1): one-shot output, never a terminal, never a write to disk.
 *
 *   | --format | without --trace                        | with --trace <id>                          |
 *   | text     | exit 1 (parseArgv refuses it)          | kosmo-text/v1 (7.2), --detail 0|1          |
 *   | json     | normalized kosmo-trace/v1 of the whole | the trace and every link with an end in it |
 *   |          | dataset, no byte cap                   | (4.12), no byte cap                        |
 *   | tab      | id\tname\tspans\tstatus                 | one row per span in DFS order              |
 *
 *  - stdin is read to EOF without a deadline (SIGINT/SIGTERM still stop it through `signal`);
 *  - a stopped stream prints nothing: stderr names the line and the reason, exit 2;
 *  - everything is computed before the first byte and written once; text and tab keep the
 *    51 200 B cap of their renderers;
 *  - SQLite values are read lazily: text reads them only for the spans that can fit under
 *    the cap, json reads all of them.
 *
 * Exit codes (spec 6.8): 0; 1 for a path that does not exist or is a directory; 2 for
 * everything the readers refuse, an unknown trace id, a stopped stream and a failed write.
 */
import type { TraceModel } from "../format/model.js";
import { spanKey, type LinkRow, type SpanValues, type TraceSummary } from "../format/types.js";
import { EXIT_OK, EXIT_SOURCE, describeError, exitCodeForReaderError, type Proc, type Writable } from "../proc.js";
import { nodeReaderFs } from "../readers/node-fs.js";
import { openTarget } from "../readers/open.js";
import { loadSqliteModule } from "../readers/sqlite-loader.js";
import type { OpenedDataset, Origin, ReaderDeps, ReaderError } from "../readers/types.js";
import type { PrintArgs } from "../args.js";
import { escapeTerminalControls } from "../sanitize.js";
import { renderDatasetJson, renderTraceSliceJson } from "./json.js";
import { OUTPUT_BYTE_CAP, renderKosmoText, walkDfs, type ValuesLookup } from "./kosmo-text.js";
import { renderSpansTab, renderTraceListTab } from "./tab.js";

/**
 * Spans of one trace whose values `text --detail 1` may need. The smallest group is 50 B: a
 * span line of 20 B (`✓ ""  a:1  [a]  -\n`; every glyph but `?` is 3 B, and `?` always comes
 * with an `unknown(…)` mark) and a detail line of 30 B (`    args=0  return=0  error=0\n`).
 * So no more than 51 200 / 50 = 1 024 groups ever fit under the cap.
 */
export const TEXT_VALUE_SPANS = Math.ceil(OUTPUT_BYTE_CAP / 50);

export type PrintInput = { readonly args: PrintArgs; readonly proc: Proc; readonly signal: AbortSignal };
export type PrintDeps = { readonly reader?: ReaderDeps };

type Built = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: ReaderError };

const NO_VALUES: ValuesLookup = () => undefined;

export async function runPrint(input: PrintInput, deps: PrintDeps = {}): Promise<number> {
  const { args, proc, signal } = input;
  const fail = (code: number, text: string): number => {
    // One line of at most 2 000 characters (describeError) before escaping: a message may carry data.
    proc.stderr.write(`kosmo-tui: ${escapeTerminalControls(describeError(text))}\n`);
    return code;
  };
  const reader: ReaderDeps = deps.reader ?? {
    fs: nodeReaderFs,
    stdin: proc.stdin as unknown as AsyncIterable<Uint8Array>,
    loadSqlite: () => loadSqliteModule()
  };
  const origin: Origin = args.target === "-" ? "stdin" : { path: args.target };
  const opened = await openTarget(origin, reader, signal);
  if (!opened.ok) return fail(exitCodeForReaderError(opened.error), opened.error.message);
  const dataset = opened.dataset;
  try {
    // Spec 4.5: under --print a stopped stream prints nothing.
    for (const notice of dataset.notices) {
      if (notice.kind !== "stream-stopped") continue;
      const where = notice.line === null ? "stream stopped" : `stream stopped at line ${notice.line}`;
      return fail(EXIT_SOURCE, `${where}: ${notice.reason}`);
    }
    const built = await build(args, dataset, signal);
    if (!built.ok) return fail(exitCodeForReaderError(built.error), built.error.message);
    const failed = await writeOnce(proc.stdout, built.text);
    if (failed !== null) return fail(EXIT_SOURCE, `output ended early (${describeWriteError(failed)})`);
    return EXIT_OK;
  } finally {
    await dataset.close().catch(() => undefined);
  }
}

async function build(args: PrintArgs, dataset: OpenedDataset, signal: AbortSignal): Promise<Built> {
  if (args.trace === undefined) {
    const traces = await allTraces(dataset, signal);
    if (args.format === "tab") return { ok: true, text: renderTraceListTab(traces) };
    const models: TraceModel[] = [];
    for (const summary of traces) {
      const loaded = await dataset.loadTrace(summary.id, signal);
      if (!loaded.ok) return loaded;
      models.push(loaded.model);
    }
    const values = await preloadValues(dataset, models, Number.POSITIVE_INFINITY, signal);
    return { ok: true, text: renderDatasetJson({ dataset: dataset.info, traces, models, values }) };
  }
  const loaded = await dataset.loadTrace(args.trace, signal);
  if (!loaded.ok) return loaded;
  const model = loaded.model;
  if (args.format === "tab") return { ok: true, text: renderSpansTab(model) };
  if (args.format === "json") {
    const values = await preloadValues(dataset, [model], Number.POSITIVE_INFINITY, signal);
    return {
      ok: true,
      text: renderTraceSliceJson({ dataset: dataset.info, model, values, links: linksOfModel(model) })
    };
  }
  const values = args.detail === 1 ? await preloadValues(dataset, [model], TEXT_VALUE_SPANS, signal) : NO_VALUES;
  return { ok: true, text: renderKosmoText(model, { detail: args.detail, values }) };
}

/** Every page of the trace list (SQLite pages by 200; the others have one page). */
async function allTraces(dataset: OpenedDataset, signal: AbortSignal): Promise<TraceSummary[]> {
  const traces = [...dataset.traces.items];
  let hasMore = dataset.traces.hasMore;
  while (hasMore && dataset.loadMoreTraces !== undefined && !signal.aborted) {
    const page = await dataset.loadMoreTraces(signal);
    traces.push(...page.items);
    hasMore = page.hasMore;
  }
  return traces;
}

/**
 * Lazy SQLite values of the first `limit` spans per model in DFS order (the order the
 * renderers write). A span whose values cannot be read prints `not-recorded(read-error…)`,
 * as in the TUI; json and ndjson carry their values in the model and read nothing here.
 */
async function preloadValues(
  dataset: OpenedDataset,
  models: readonly TraceModel[],
  limit: number,
  signal: AbortSignal
): Promise<ValuesLookup> {
  if (dataset.loadValues === undefined) return NO_VALUES;
  const values = new Map<string, SpanValues>();
  for (const model of models) {
    let taken = 0;
    for (const { ref } of walkDfs(model, model.roots())) {
      if (taken >= limit || signal.aborted) break;
      taken += 1;
      if (model.get(ref)?.values !== undefined) continue;
      try {
        values.set(spanKey(ref), await dataset.loadValues(ref, signal));
      } catch (error) {
        const failed = { state: "not-recorded", reason: `read-error: ${describeError(error)}` } as const;
        values.set(spanKey(ref), { args: failed, return: failed, error: failed });
      }
    }
  }
  return (ref) => values.get(spanKey(ref));
}

/**
 * The links of one trace for `--format json --trace` (spec 4.12): every outgoing link of
 * its spans, plus incoming links from spans outside it (inside ones are already outgoing).
 */
export function linksOfModel(model: TraceModel): LinkRow[] {
  const links: LinkRow[] = [];
  for (const { ref } of walkDfs(model, model.roots())) {
    const { out, in: incoming } = model.links(ref);
    for (const link of out) links.push({ from: ref, to: link.other, kind: link.kind });
    for (const link of incoming) {
      if (model.get(link.other) === undefined) links.push({ from: link.other, to: ref, kind: link.kind });
    }
  }
  return links;
}

/**
 * Write once. A real stream (it has `writable`) is awaited through its write callback, and an
 * error listener stays attached so a late EPIPE never crashes the process.
 */
async function writeOnce(stdout: Writable, text: string): Promise<Error | null> {
  let failed: Error | null = null;
  stdout.on?.("error", ((error: Error) => {
    failed ??= error;
  }) as (...args: never[]) => void);
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
      failed ??= error instanceof Error ? error : new Error(String(error));
      resolve();
    }
  });
  return failed;
}

function describeWriteError(error: Error): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : describeError(error);
}
