/**
 * The TUI event loop (spec 5.4, 6.1–6.8, 12):
 *
 *   keyboard chunk → splitKeys → decodeKey → update → effects (through the ports) → renderFrame → paint
 *
 * The session starts without a dataset. With an argv target it opens that target at once;
 * otherwise it shows the start screen (found traces and recent.json). Rules it keeps:
 *
 *  - Keys work from the first frame, also while a stream is still being read: `q` quits and
 *    Ctrl+C exits 130 while `reading… N spans` is on screen (review focus 5). Quitting aborts
 *    the read, which releases stdin, so a producer on the other end gets EPIPE.
 *  - An open error of the argv target ends the session with exit 1 (missing path, directory)
 *    or 2 (everything else, spec 6.8). An open error of a file chosen on the start screen is a
 *    banner, and the user stays there (spec 5.4).
 *  - Progress of a stream is shown at most every `refreshMs` (≤ 250 ms); answers to user
 *    actions are painted at once.
 *  - Late answers never land on the wrong thing: a replaced open, a replaced dataset, a
 *    changed root, or Esc back to the start screen (the `closeDataset` effect) drops them.
 *    A dataset that opens after that is closed immediately; close() awaits every close.
 *  - The terminal is restored exactly once, before anything is written to stdout/stderr:
 *    q, Ctrl+C, SIGINT (130), SIGTERM (143), SIGHUP (129), a render failure or a throw
 *    inside update or an effect (2, spec 13.2).
 *
 * All I/O goes through `SessionDeps`; this module imports no node:fs and no process.
 */
import path from "node:path";
import { resolveRoot, type RootFs, type RootResolution } from "../code/root.js";
import { loadSnippet, type Snippet, type SnippetFs } from "../code/snippet.js";
import { utf8Bytes } from "../format/bytes.js";
import { spanKey, type Location, type SpanRef } from "../format/types.js";
import {
  EXIT_OK,
  EXIT_SIGINT,
  EXIT_SOURCE,
  describeError,
  exitCodeForReaderError,
  exitCodeForSignal
} from "../proc.js";
import { openTarget, reopen } from "../readers/open.js";
import type { OpenResult, OpenedDataset, Origin, ReaderDeps, ReaderError } from "../readers/types.js";
import { escapeTerminalControls } from "../sanitize.js";
import { loadStartRows, recentPath, recordRecent, type StartFs } from "../start.js";
import type { Terminal } from "../terminal.js";
import { decodeKey } from "./keys.js";
import { renderFrame, type RenderEnv } from "./render.js";
import {
  initialState,
  update,
  type Action,
  type DatasetView,
  type Effect,
  type ViewNotice,
  type ViewState
} from "./state.js";

/** Upper bound for coalescing background repaints (stream progress). */
export const SESSION_REFRESH_MS = 250;

export type SessionTimers = {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type CopyOutcome =
  { readonly copied: true; readonly via: string } | { readonly copied: false; readonly reason: string };

/** `copyToClipboard` + `StdoutFallback` from clipboard.ts in production. */
export type SessionClipboard = {
  copy(text: string): Promise<CopyOutcome>;
  /** Holds what could not be copied; flushed right after the terminal is restored. */
  readonly fallback: { queue(text: string): void; flush(): void };
};

export type SessionDeps = {
  /** Already in raw mode on the alternate screen; the session closes it exactly once. */
  readonly terminal: Terminal;
  /** fs, stdin and loadSqlite for the readers; the session adds `onProgress`. */
  readonly reader: ReaderDeps;
  readonly snippetFs: SnippetFs;
  readonly rootFs: RootFs;
  readonly startFs: StartFs;
  readonly clipboard: SessionClipboard;
  readonly render: RenderEnv;
  readonly cwd: string;
  /**
   * The user's home directory; null when it is unknown (os.homedir() failed or was empty). Then
   * recent.json works only under `$XDG_CONFIG_HOME`, and the automatic code root has no home check (spec 4.8).
   */
  readonly home: string | null;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `-r`: recent.json is never written. */
  readonly readOnly: boolean;
  /** `--root <dir>` (spec 4.8 rule 1). */
  readonly rootFlag?: string;
  /** The argv target; absent → the start screen. */
  readonly origin?: Origin;
  /** Aborted by SIGINT / SIGTERM / SIGHUP; the reason is the signal name. */
  readonly signal?: AbortSignal;
  readonly stderr: { write(chunk: string): unknown };
  readonly timers?: SessionTimers;
  readonly now?: () => Date;
  readonly refreshMs?: number;
  /** Suffix of recent.json's temp file (the time and a random part in production, ui/open.ts). */
  readonly tmpToken?: string;
  /**
   * Called with the project root whenever it changes (the paint guard validates OSC 8 against it);
   * null: no root (none yet, or spec 4.8 left none), so no link passes.
   */
  readonly onRootChange?: (root: string | null) => void;
  /** Injection points for tests; default to the readers' `openTarget` / `reopen`. */
  readonly open?: (origin: Origin, deps: ReaderDeps, signal: AbortSignal) => Promise<OpenResult>;
  readonly reopen?: (dataset: OpenedDataset, deps: ReaderDeps, signal: AbortSignal) => Promise<OpenResult> | null;
};

const ESC = "\u001b";
const CTRL_C = "\u0003";

const defaultTimers: SessionTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/**
 * One terminal read can carry several keys (fast typing, a paste). Split it into what
 * `decodeKey` takes: one character, or one escape sequence (CSI `ESC [ … final`, SS3
 * `ESC O x`). `ESC` followed by anything else is a lone Esc and then that key; `\r\n` is one
 * Enter.
 */
export function splitKeys(chunk: string): string[] {
  const chars = Array.from(chunk);
  const keys: string[] = [];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    const next = chars[index + 1];
    if (char === ESC && next === "[") {
      let end = index + 2;
      while (end < chars.length && !/[@-~]/.test(chars[end]!)) end += 1;
      keys.push(chars.slice(index, end + 1).join(""));
      index = end;
      continue;
    }
    if (char === ESC && next === "O" && index + 2 < chars.length) {
      keys.push(chars.slice(index, index + 3).join(""));
      index += 2;
      continue;
    }
    if (char === "\r" && next === "\n") {
      keys.push("\r");
      index += 1;
      continue;
    }
    keys.push(char);
  }
  return keys;
}

function readError(error: unknown): ReaderError {
  return { code: "read-error", message: `read-error: ${describeError(error)}` };
}

function datasetView(dataset: OpenedDataset, resolution: RootResolution): DatasetView {
  const { ignored, unset } = resolution;
  const rootNotice: ViewNotice[] = [];
  if (unset !== undefined) rootNotice.push({ kind: "code-root-unset", reason: unset.reason });
  if (ignored !== undefined) {
    rootNotice.push({
      kind: "dataset-root-ignored",
      datasetRoot: ignored.datasetRoot,
      reason: ignored.reason,
      stdin: dataset.origin === "stdin"
    });
  }
  return {
    info: dataset.info,
    kind: dataset.kind,
    origin: dataset.origin,
    traces: dataset.traces.items,
    hasMore: dataset.traces.hasMore,
    notices: [...rootNotice, ...dataset.notices],
    reloadable: dataset.origin !== "stdin"
  };
}

/** Spec 6.1: without a home directory recent.json lives only under `$XDG_CONFIG_HOME`. */
export const RECENT_DISABLED_BANNER = "recent: disabled (no home directory; set XDG_CONFIG_HOME to keep a recent list)";

type Outcome = { readonly code: number; readonly error?: string };

export async function runSession(deps: SessionDeps): Promise<number> {
  const timers = deps.timers ?? defaultTimers;
  const now = deps.now ?? (() => new Date());
  const refreshMs = Math.min(SESSION_REFRESH_MS, Math.max(1, deps.refreshMs ?? SESSION_REFRESH_MS));
  const open = deps.open ?? openTarget;
  const reopenDataset = deps.reopen ?? reopen;
  const terminal = deps.terminal;
  const lifetime = new AbortController();

  // Spec 4.8 rule 1 before any dataset is open; rules 2–4 are applied per dataset (no root until then).
  // Every stored root is a realpath: loadSnippet refuses a root whose realpath is no longer itself.
  // `--root` is resolved once below (settleFlag); until then no dataset is open, so nothing is read.
  let rootOverride = deps.rootFlag !== undefined && deps.rootFlag !== "" ? path.resolve(deps.cwd, deps.rootFlag) : null;
  let state: ViewState = initialState({ root: rootOverride, readOnly: deps.readOnly });
  let dataset: OpenedDataset | null = null;
  let closed = false;
  let outcome: Outcome | null = null;
  let settle: (value: Outcome) => void = () => undefined;
  const done = new Promise<Outcome>((resolve) => {
    settle = resolve;
  });

  let openGeneration = 0;
  let openController: AbortController | null = null;
  /** Opens and reloads in flight; close() awaits every one of them. */
  const pendingOpens = new Set<Promise<void>>();
  /** Closes of replaced and abandoned datasets; close() awaits them before it returns. */
  const closing = new Set<Promise<void>>();
  let traceGeneration = 0;
  /** The dataset a `>` page load is in flight for; another dataset may page at once. */
  let loadingMoreFor: OpenedDataset | null = null;
  let progress: number | null = null;
  let progressTimer: unknown = null;

  function finish(code: number, error?: string): void {
    if (outcome !== null) return;
    outcome = error === undefined ? { code } : { code, error };
    settle(outcome);
  }

  function paint(): void {
    if (closed || outcome !== null) return;
    try {
      terminal.paint(renderFrame(state, terminal.size(), deps.render));
    } catch (error) {
      finish(EXIT_SOURCE, `render failed: ${describeError(error)}`);
    }
  }

  /** A throw in update or an effect ends the session like a render failure (spec 13.2). */
  function fail(error: unknown): void {
    finish(EXIT_SOURCE, `session failed: ${describeError(error)}`);
  }

  function guarded(step: () => void): void {
    try {
      step();
    } catch (error) {
      fail(error);
    }
  }

  /** Effects run detached; a rejection is a session failure, never an unhandled rejection. */
  function background(work: Promise<void>): void {
    work.catch(fail);
  }

  function dispatch(action: Action): void {
    if (closed || outcome !== null) return;
    const before = state.root;
    const [next, effects] = update(state, action);
    state = next;
    if (state.root !== before) deps.onRootChange?.(state.root);
    for (const effect of effects) runEffect(effect);
  }

  /** `closeDataset`: the view no longer has a dataset (Esc, spec 6.2). Late replies must not bring it back. */
  function abandonDataset(): void {
    const previous = dataset;
    dataset = null;
    traceGeneration += 1;
    openGeneration += 1;
    openController?.abort();
    loadingMoreFor = null;
    clearProgress();
    if (previous !== null) retire(previous);
    // Spec 4.8: the closed dataset's root goes with it; dispatch tells the paint guard.
    dispatch({ type: "rootReset", root: rootOverride });
  }

  /** The realpath of a directory the user chose; the resolved path when it cannot be resolved. */
  async function realDir(dir: string): Promise<string> {
    try {
      const real = await deps.rootFs.realpath(dir);
      return path.isAbsolute(real) ? path.resolve(real) : dir;
    } catch {
      return dir;
    }
  }

  /** `--root` as its realpath, once per session; opened() waits for it before resolving the root. */
  async function settleFlag(given: string): Promise<void> {
    const real = await realDir(given);
    // A :root chosen in the meantime wins.
    if (rootOverride !== given || real === given) return;
    rootOverride = real;
    if (closed || dataset !== null || state.root !== given) return;
    guarded(() => dispatch({ type: "rootReset", root: real }));
  }

  /** Close a dataset nobody shows any more; close() awaits it. Close errors are ignored, as everywhere. */
  function retire(old: OpenedDataset): Promise<void> {
    const running = old.close().catch(() => undefined);
    closing.add(running);
    void running.finally(() => closing.delete(running));
    return running;
  }

  function clearProgress(): void {
    if (progressTimer !== null) timers.clearTimeout(progressTimer);
    progressTimer = null;
    progress = null;
  }

  /** Stream progress: at most one repaint per `refreshMs`. */
  function reportProgress(generation: number, spans: number): void {
    if (closed || generation !== openGeneration) return;
    progress = spans;
    if (progressTimer !== null) return;
    progressTimer = timers.setTimeout(() => {
      progressTimer = null;
      if (closed || generation !== openGeneration || progress === null) return;
      const spans = progress;
      guarded(() => dispatch({ type: "readingProgress", spans }));
      paint();
    }, refreshMs);
  }

  function runEffect(effect: Effect): void {
    switch (effect.kind) {
      case "quit":
        finish(EXIT_OK);
        return;
      case "open":
        startOpen(effect.origin, { fromArgv: false, record: true });
        return;
      case "reload":
        startReload();
        return;
      case "loadTrace":
        background(loadTrace(effect.id));
        return;
      case "loadMoreTraces":
        background(loadMore());
        return;
      case "loadValues":
        background(loadValues(effect.ref));
        return;
      case "loadSnippet":
        background(loadSnippetFor(effect.ref, effect.location));
        return;
      case "copy":
        background(copy(effect.text));
        return;
      case "setRoot":
        background(setRoot(effect.dir));
        return;
      case "closeDataset":
        abandonDataset();
        return;
    }
  }

  type Read = { readonly generation: number; readonly controller: AbortController; readonly reader: ReaderDeps };

  function nextRead(): Read {
    const generation = openGeneration + 1;
    const reader: ReaderDeps = { ...deps.reader, onProgress: (spans) => reportProgress(generation, spans) };
    return { generation, controller: new AbortController(), reader };
  }

  /** The new read replaces any read in flight: its answer, when it comes, is dropped. */
  function commitRead(read: Read): void {
    openController?.abort();
    clearProgress();
    openController = read.controller;
    openGeneration = read.generation;
    dispatch({ type: "readingProgress", spans: 0 });
  }

  function startOpen(origin: Origin, options: { fromArgv: boolean; record: boolean }): void {
    const read = nextRead();
    commitRead(read);
    const reading = open(origin, read.reader, read.controller.signal).catch((error: unknown) => ({
      ok: false as const,
      error: readError(error)
    }));
    track(reading.then((result) => opened(origin, options, read.generation, result)));
  }

  /** `r`: read the same origin again (spec 6.7); a stdin stream cannot be re-read. */
  function startReload(): void {
    const current = dataset;
    if (current === null) return;
    const read = nextRead();
    const reading = reopenDataset(current, read.reader, read.controller.signal);
    if (reading === null) {
      dispatch({ type: "showBanner", level: "error", text: "reload: unavailable(stdin-stream)" });
      paint();
      return;
    }
    commitRead(read);
    const safe = reading.catch((error: unknown) => ({ ok: false as const, error: readError(error) }));
    track(safe.then((result) => opened(current.origin, { fromArgv: false, record: false }, read.generation, result)));
  }

  function track(work: Promise<void>): void {
    const running = work.catch(fail);
    pendingOpens.add(running);
    void running.finally(() => pendingOpens.delete(running));
  }

  async function opened(
    origin: Origin,
    options: { fromArgv: boolean; record: boolean },
    generation: number,
    result: OpenResult
  ): Promise<void> {
    if (closed || outcome !== null || generation !== openGeneration) {
      if (result.ok) await retire(result.dataset);
      return;
    }
    clearProgress();
    if (!result.ok) {
      // Spec 5.4/6.8: exit codes apply to the argv target only; the start screen gets a banner.
      if (options.fromArgv) {
        finish(exitCodeForReaderError(result.error), result.error.message);
        return;
      }
      dispatch({ type: "datasetFailed", error: result.error });
      paint();
      return;
    }
    const recentFile = recentPath(deps.env, deps.home);
    if (options.record && origin !== "stdin" && recentFile !== null) {
      void recordRecent(
        {
          file: recentFile,
          opened: origin.path,
          cwd: deps.cwd,
          now: now(),
          readOnly: deps.readOnly,
          ...(deps.tmpToken === undefined ? {} : { tmpToken: deps.tmpToken })
        },
        deps.startFs
      );
    }
    await flagSettled;
    const resolution = await resolveRoot(
      {
        cwd: deps.cwd,
        home: deps.home,
        ...(rootOverride === null ? {} : { flag: rootOverride }),
        ...(result.dataset.info.root === undefined ? {} : { datasetRoot: result.dataset.info.root }),
        ...(origin === "stdin" ? {} : { traceFile: origin.path })
      },
      deps.rootFs
    );
    // Publish only once the answer is still current, so an in-flight loadValues/loadSnippet
    // is not dropped while the view still shows "loading" for the previous dataset.
    if (closed || outcome !== null || generation !== openGeneration) {
      await retire(result.dataset);
      return;
    }
    const previous = dataset;
    dataset = result.dataset;
    if (previous !== null && previous !== result.dataset) void retire(previous);
    const { root, unset } = resolution;
    if (root !== state.root || (unset?.reason ?? null) !== state.rootUnset) {
      dispatch({ type: "rootChanged", root, ...(unset === undefined ? {} : { unset: unset.reason }) });
    }
    dispatch({ type: "datasetOpened", dataset: datasetView(result.dataset, resolution) });
    paint();
  }

  async function loadTrace(id: string): Promise<void> {
    const current = dataset;
    if (current === null) return;
    const generation = ++traceGeneration;
    const result = await current
      .loadTrace(id, lifetime.signal)
      .catch((error: unknown) => ({ ok: false as const, error: readError(error) }));
    if (closed || current !== dataset || generation !== traceGeneration) return;
    dispatch(
      result.ok ? { type: "traceLoaded", model: result.model } : { type: "traceFailed", id, error: result.error }
    );
    paint();
  }

  async function loadMore(): Promise<void> {
    const current = dataset;
    if (current === null || loadingMoreFor === current) return;
    if (current.loadMoreTraces === undefined) {
      dispatch({ type: "tracesPage", page: { items: [], hasMore: false } });
      paint();
      return;
    }
    loadingMoreFor = current;
    try {
      const page = await current.loadMoreTraces(lifetime.signal);
      if (closed || current !== dataset) return;
      dispatch({ type: "tracesPage", page });
    } catch (error) {
      if (closed || current !== dataset) return;
      dispatch({ type: "tracesPageFailed", error: readError(error) });
    } finally {
      if (loadingMoreFor === current) loadingMoreFor = null;
    }
    paint();
  }

  async function loadValues(ref: SpanRef): Promise<void> {
    const current = dataset;
    if (current === null) {
      if (stillLoading(ref, "values")) {
        dispatch({ type: "valuesFailed", ref, reason: "values: unavailable(no-dataset)" });
        paint();
      }
      return;
    }
    if (current.loadValues === undefined) {
      dispatch({ type: "valuesFailed", ref, reason: "values: unavailable(not-lazy)" });
      paint();
      return;
    }
    try {
      const values = await current.loadValues(ref, lifetime.signal);
      if (!deliverValues(ref, current)) return;
      dispatch({ type: "valuesLoaded", ref, values });
    } catch (error) {
      if (!deliverValues(ref, current)) return;
      dispatch({ type: "valuesFailed", ref, reason: describeError(error) });
    }
    paint();
  }

  /**
   * Settle on the dataset that asked, or — if that dataset is gone and the key is still
   * "loading" — so update does not keep a request it will never evict or repeat.
   * A replaced dataset is left alone: datasetOpened installs a fresh map.
   */
  function deliverValues(ref: SpanRef, current: OpenedDataset): boolean {
    if (closed) return false;
    if (current === dataset) return true;
    return dataset === null && stillLoading(ref, "values");
  }

  function stillLoading(ref: SpanRef, kind: "values" | "snippets"): boolean {
    const map = kind === "values" ? state.values : state.snippets;
    return map.get(spanKey(ref)) === "loading";
  }

  async function loadSnippetFor(ref: SpanRef, location: Location): Promise<void> {
    const root = state.root;
    // update never asks without a root; a stray request is not read anywhere.
    if (root === null) return;
    const current = dataset;
    const snippet: Snippet = await loadSnippet(root, location, deps.snippetFs).catch(() => ({
      state: "unreadable" as const,
      file: location.file,
      lines: [],
      target: location.line
    }));
    // A changed root re-asks for every snippet (rootChanged); another dataset has its own keys.
    if (closed) return;
    const same = state.root === root && dataset === current;
    const leftover = dataset === null && state.root === root && stillLoading(ref, "snippets");
    if (!same && !leftover) return;
    dispatch({ type: "snippetLoaded", ref, snippet });
    paint();
  }

  async function copy(text: string): Promise<void> {
    let result: CopyOutcome;
    try {
      result = await deps.clipboard.copy(text);
    } catch (error) {
      result = { copied: false, reason: describeError(error) };
    }
    if (!result.copied) deps.clipboard.fallback.queue(text);
    if (closed) return;
    dispatch({
      type: "showBanner",
      level: "info",
      text: result.copied
        ? `copied ${utf8Bytes(text)} B of kosmo-text/v1 via ${result.via}`
        : `copy: ${result.reason}; kosmo-text/v1 is printed after exit`
    });
    paint();
  }

  async function setRoot(dir: string): Promise<void> {
    const resolved = path.resolve(deps.cwd, dir);
    const ok = await deps.rootFs.isDirectory(resolved).catch(() => false);
    if (closed) return;
    if (!ok) {
      dispatch({ type: "showBanner", level: "error", text: `root: not a directory: ${dir}` });
      paint();
      return;
    }
    const real = await realDir(resolved);
    if (closed) return;
    rootOverride = real;
    dispatch({ type: "rootChanged", root: real });
    paint();
  }

  async function loadStart(): Promise<void> {
    try {
      const rows = await loadStartRows({ cwd: deps.cwd, env: deps.env, home: deps.home }, deps.startFs);
      if (closed) return;
      dispatch({ type: "startRows", rows });
      if (recentPath(deps.env, deps.home) === null) {
        dispatch({ type: "showBanner", level: "info", text: RECENT_DISABLED_BANNER });
      }
      paint();
    } catch {
      // An unreadable cwd or config leaves the start screen empty; it never ends the session.
    }
  }

  const onAbort = (): void => finish(exitCodeForSignal(deps.signal?.reason));

  async function close(): Promise<void> {
    closed = true;
    deps.signal?.removeEventListener("abort", onAbort);
    clearProgress();
    lifetime.abort();
    openController?.abort();
    // Terminal first (raw mode, cursor, main screen), then what could not be copied.
    terminal.close();
    deps.clipboard.fallback.flush();
    // An aborted stream read settles at once and releases stdin (the producer gets EPIPE).
    await Promise.all([...pendingOpens]);
    // Then the open dataset and every replaced or abandoned one still closing; stderr comes after.
    const current = dataset;
    dataset = null;
    if (current !== null) retire(current);
    await Promise.all([...closing]);
  }

  terminal.onKey((chunk) => {
    if (closed || outcome !== null) return;
    guarded(() => {
      for (const key of splitKeys(chunk)) {
        // Ctrl+C in raw mode is a keystroke, not a signal: it still exits 130.
        if (key === CTRL_C) {
          finish(EXIT_SIGINT);
          return;
        }
        const action = decodeKey(state, key);
        if (action !== undefined) dispatch(action);
        if (outcome !== null) return;
      }
    });
    paint();
  });
  terminal.onResize(() => paint());
  deps.onRootChange?.(state.root);
  const flagSettled = rootOverride === null ? Promise.resolve() : settleFlag(rootOverride);
  if (deps.signal?.aborted === true) onAbort();
  else deps.signal?.addEventListener("abort", onAbort, { once: true });
  if (outcome === null) {
    if (deps.origin !== undefined) startOpen(deps.origin, { fromArgv: true, record: true });
    else void loadStart();
  }
  paint();

  const result = await done;
  await close();
  // Reader messages may quote the input (a path, a line): escaped like every other data string.
  if (result.error !== undefined) deps.stderr.write(`kosmo-tui: ${escapeTerminalControls(result.error)}\n`);
  return result.code;
}
