/**
 * The default `openViewer` of the composition root (design D2/D3/D9/D15): wires the real
 * adapters for one interactive session and owns its lifecycle.
 *
 *   keyboard port (terminal-input.ts; the controlling TTY when stdin carries data)
 *   → source (source-open.ts) → effective capabilities (session policy from -r/--no-eval)
 *   → session (session.ts) with the terminal, the replay/depth/refresh/projection flags,
 *     a lazily opened review (review.ts: `resolveReviewCapability` + `openReviewSession`),
 *     `:` command deps (shared `@kosmo-callflow/query/graph` selectors over the pinned
 *     snapshot for sqlite/export via `commandDepsForSource`, `:sql` for sqlite) and the
 *     `:js` snapshot (sqlite/export only; live and stream answer `unavailable(reason)`).
 *
 * Every way out — `q`, Ctrl+C, SIGINT/SIGTERM, a source failure, a render failure — ends
 * in one `finally`: the session closes (timers, reads, review lock, source) and restores
 * the terminal exactly once; only then is a bounded error written to stderr.
 */

import path from "node:path";
import {
  EXIT_OK,
  EXIT_SIGINT,
  EXIT_SIGTERM,
  EXIT_SOURCE,
  defaultReadProjectConfig,
  type Invocation,
  type ViewerArgs
} from "./cli.js";
import type { CommandDeps } from "./commands.js";
import { discoverProjectCandidates, selectProject, type ProjectConfigReader, type ResolvedTarget } from "./detect.js";
import { evalSnapshotFromDataset } from "./eval.js";
import { openReviewSession, resolveReviewCapability, type ReviewEnv, type ReviewFs } from "./review.js";
import { createSession, type EvalSnapshotSource, type ReviewPort, type SessionTimers } from "./session.js";
import { commandDepsForSource, type SnapshotSource } from "./snapshot-selectors.js";
import { openTargetSource, type OpenTargetDeps } from "./source-open.js";
import type { SourceOpenResult, TraceSource } from "./source.js";
import { createTerminal, type Terminal, type TerminalInput, type TerminalOutput } from "./terminal.js";
import { openKeyboardInput, type KeyboardDeps, type KeyboardResult } from "./terminal-input.js";

export type ViewerDeps = {
  source?: OpenTargetDeps;
  keyboard?: (deps: KeyboardDeps) => KeyboardResult;
  createTerminal?: (input: TerminalInput, output: TerminalOutput) => Terminal;
  readProjectConfig?: ProjectConfigReader;
  reviewFs?: ReviewFs;
  reviewEnv?: ReviewEnv;
  timers?: SessionTimers;
};

type Outcome = { code: number; error?: string };

const CTRL_C = String.fromCharCode(3);
const MAX_ERROR_CHARS = 2_000;

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^kosmo-tui: /, "")
    .slice(0, MAX_ERROR_CHARS);
}

/** Display label for the review frontmatter; review.ts sanitizes it again before writing. */
export function sourceLabel(target: ResolvedTarget): string {
  switch (target.kind) {
    case "export":
    case "sqlite":
      return `${target.kind}:${path.basename(target.path)}`;
    case "stdin":
      return "stream:stdin";
    case "live-trace":
      return `live:trace ${target.traceId}`;
    case "live-endpoint":
      return "live:endpoint";
    case "live-project":
      return "live:project";
  }
}

function isSnapshotSource(source: TraceSource): source is TraceSource & SnapshotSource {
  return (
    (source.kind === "sqlite" || source.kind === "export") &&
    typeof (source as Partial<SnapshotSource>).datasetSnapshot === "function"
  );
}

/** `:` deps: shared graph selectors (and `:sql` for sqlite) over the pinned offline snapshot. */
export function commandDepsFor(source: TraceSource): CommandDeps {
  return isSnapshotSource(source) ? commandDepsForSource(source, { liveSeek: true }) : { liveSeek: true };
}

/** `:js` reads the pinned offline snapshot; live and stream sources have none to freeze. */
export function evalSnapshotFor(source: TraceSource): EvalSnapshotSource {
  if (!isSnapshotSource(source)) return () => ({ unavailable: `eval-needs-offline-snapshot(${source.kind})` });
  const kind = source.kind as "sqlite" | "export";
  return () => {
    try {
      const built = evalSnapshotFromDataset(source.datasetSnapshot(), kind);
      return built.ok ? built.snapshot : { unavailable: built.message };
    } catch (error) {
      return { unavailable: describe(error) };
    }
  };
}

/** The project root reviews go under: the live project, else the cwd's unambiguous project. */
async function reviewRoot(invocation: Invocation<ViewerArgs>, readConfig: ProjectConfigReader): Promise<string | null> {
  if (invocation.project !== null) return invocation.project.root;
  try {
    const candidates = await discoverProjectCandidates({ cwd: invocation.proc.cwd(), readConfig });
    const selection = selectProject(candidates, invocation.args.project);
    return selection.ok && selection.project !== null ? selection.project.root : null;
  } catch {
    return null;
  }
}

/** `deps.openViewer` default. */
export async function openViewerSession(invocation: Invocation<ViewerArgs>, deps: ViewerDeps = {}): Promise<number> {
  const { args, target, project, proc, signal } = invocation;
  const platform = proc.platform ?? process.platform;
  const keyboard = (deps.keyboard ?? openKeyboardInput)({
    platform,
    stdin: proc.stdin as unknown as TerminalInput,
    stdinCarriesData: target.kind === "stdin"
  });
  if (!keyboard.ok) {
    proc.stderr.write(`${keyboard.message}\n`);
    return keyboard.exitCode;
  }

  let outcome: Outcome | undefined;
  let settle: (value: Outcome) => void = () => undefined;
  const done = new Promise<Outcome>((resolve) => {
    settle = resolve;
  });
  const finish = (value: Outcome): void => {
    if (outcome !== undefined) return;
    outcome = value;
    settle(value);
  };
  const onAbort = (): void => finish({ code: signal.reason === "SIGTERM" ? EXIT_SIGTERM : EXIT_SIGINT });

  let session: ReturnType<typeof createSession> | null = null;
  try {
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
    if (!selected.ok) {
      proc.stderr.write(`${selected.message}\n`);
      return selected.exitCode;
    }
    const source = selected.source;
    const root = await reviewRoot(invocation, deps.readProjectConfig ?? defaultReadProjectConfig);

    const raw = (deps.createTerminal ?? createTerminal)(keyboard.port.input, proc.stdout as unknown as TerminalOutput);
    // Ctrl+C in raw mode is a keystroke, not a signal: it still exits 130.
    raw.onKey((key) => {
      if (key.includes(CTRL_C)) finish({ code: EXIT_SIGINT });
    });
    const terminal: Terminal = {
      ...raw,
      paint(frame) {
        if (outcome !== undefined) return;
        try {
          raw.paint(frame);
        } catch (error) {
          finish({ code: EXIT_SOURCE, error: `render failed: ${describe(error)}` });
        }
      }
    };

    const openReview = async (opened: SourceOpenResult): Promise<ReviewPort> => {
      const capability = await resolveReviewCapability({
        readOnly: args.readOnly,
        oneShot: false,
        ...(root === null ? {} : { projectRoot: root }),
        ...(args.reviewDir === undefined ? {} : { reviewDir: args.reviewDir }),
        cwd: proc.cwd(),
        ...(deps.reviewFs ? { fs: deps.reviewFs } : {})
      });
      const versions = opened.offers.projectionVersions;
      const version = args.projectionVersion ?? (versions.includes(2) || versions.length === 0 ? 2 : 1);
      return openReviewSession({
        capability,
        sourceRef: opened.stableDataset
          ? {
              projectId: opened.snapshot.projectId,
              datasetId: opened.snapshot.datasetId,
              sourceRevision: opened.snapshot.revision
            }
          : null,
        sourceLabel: sourceLabel(target),
        dialect: "lisp",
        traceTextVersion: version,
        noResume: args.noResume,
        ...(deps.reviewFs ? { fs: deps.reviewFs } : {}),
        ...(deps.reviewEnv ? { env: deps.reviewEnv } : {})
      });
    };

    const replay =
      args.replay || args.speed !== undefined || args.stepIntervalMs !== undefined
        ? {
            ...(args.speed === undefined ? {} : { speed: args.speed }),
            ...(args.stepIntervalMs === undefined ? {} : { stepIntervalMs: args.stepIntervalMs })
          }
        : undefined;

    session = createSession({
      source,
      policy: { readOnly: args.readOnly, noEval: args.noEval, print: false },
      terminal,
      ...(deps.timers ? { timers: deps.timers } : {}),
      ...(args.refreshMs === undefined ? {} : { refreshMs: args.refreshMs }),
      ...(args.projectionVersion === undefined ? {} : { projectionVersion: args.projectionVersion }),
      ...(args.depth === undefined ? {} : { depth: args.depth }),
      ...(args.detail === undefined ? {} : { detail: args.detail }),
      ...(args.values ? { values: true } : {}),
      ...(replay === undefined ? {} : { replay }),
      clipboard: { platform: platform as NodeJS.Platform, env: { ...proc.env }, stdout: proc.stdout },
      review: openReview,
      commands: commandDepsFor(source),
      evalSnapshot: evalSnapshotFor(source),
      evalEnv: { ...proc.env },
      onExit: () => finish({ code: EXIT_OK })
    });

    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    session.start().then(
      () => undefined,
      (error: unknown) => finish({ code: EXIT_SOURCE, error: `source failed: ${describe(error)}` })
    );
    return (await done).code;
  } finally {
    signal.removeEventListener("abort", onAbort);
    // Restores raw mode/cursor/alt screen once, releases the review lock, closes the source.
    await session?.close();
    keyboard.port.close();
    if (outcome?.error !== undefined) proc.stderr.write(`kosmo-tui: ${outcome.error}\n`);
  }
}
