/**
 * The interactive viewer loop, ported from kosmo-callflow
 * `packages/cli/src/connect/viewer.ts` (tasks 27.3/27.4 there).
 *
 * Everything decision-shaped already lives in view-state.ts and render.ts; this module
 * only turns keys and poll results into reducer input and paints the result. The
 * terminal, the clock and the poll function are all injected, so the loop — including
 * pause, refresh cadence and teardown — is unit-testable without a PTY or a daemon.
 */

import { parseDurationMs } from "./duration.js";
import { renderFrame } from "./render.js";
import type { Terminal } from "./terminal.js";
import { decodeKey, decodeSearchKey } from "./keys.js";
import {
  applyAction,
  applyDelta,
  initialViewState,
  type ConnectionState,
  type Delta,
  type ReplaySession,
  type ViewState
} from "./view-state.js";

/** 250ms is the spec's PROPOSED default pending calibration, not a latency guarantee. */
export const CONNECT_PROPOSED_REFRESH_MS = 250;

export type ViewerPoll = () => Promise<Delta[]>;

export type ViewerTimers = {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

export type ViewerOptions = {
  terminal: Terminal;
  poll: ViewerPoll;
  timers: ViewerTimers;
  refreshMs?: number;
  initial?: Delta[];
  connection?: ConnectionState;
  /** Starts the viewer in `--replay` mode over a recorded timeline (27.5). */
  replay?: ReplaySession;
  /** Injected clock, so scheduled replay stepping is testable without real sleeps. */
  now?: () => number;
  onExit?: () => void;
};

export type Viewer = {
  state(): ViewState;
  /** Run one refresh tick by hand; the interval calls the same path. */
  tick(): Promise<void>;
  close(): void;
};

export function parseRefreshMs(value: string): number | undefined {
  // A refresh faster than 16ms cannot be drawn and only burns CPU; a refresh slower
  // than a minute is indistinguishable from a hang.
  return parseDurationMs(value, 16, 60_000);
}

/**
 * The viewer-time delay owed before the NEXT frame, or null when nothing is scheduled.
 *
 * In `speed` mode the delay is the recorded same-domain interval divided by the
 * multiplier, so it varies per frame; the fixed-interval modes owe the same delay every
 * time, and manual mode owes nothing because the user drives it.
 */
function scheduledDelayMs(session: ReplaySession): number | null {
  switch (session.schedule.mode) {
    case "manual":
      return null;
    case "step-interval":
    case "speed-fallback":
      return session.schedule.intervalMs;
    case "speed":
      return session.schedule.delaysMs[session.index + 1] ?? null;
  }
}

export function startViewer(options: ViewerOptions): Viewer {
  const refreshMs = options.refreshMs ?? CONNECT_PROPOSED_REFRESH_MS;
  const size = options.terminal.size();
  const clock = options.now ?? (() => Date.now());
  let state = initialViewState({
    viewportHeight: Math.max(1, size.rows - 4),
    ...(options.connection ? { connection: options.connection } : {}),
    ...(options.replay ? { replay: options.replay } : {})
  });
  let lastStepAt = clock();
  for (const delta of options.initial ?? []) {
    state = applyDelta(state, delta);
  }
  let closed = false;

  paint();

  options.terminal.onResize((next) => {
    state = applyDelta(state, { kind: "resize", viewportHeight: Math.max(1, next.rows - 4) });
    paint();
  });

  options.terminal.onKey((key) => {
    // A keypress can arrive after teardown (a held key, or a burst already buffered by
    // the tty). Without this guard a second `q` fires onExit again and the caller exits
    // twice.
    if (closed) return;
    // While the `/` prompt is open the keyboard belongs to the prompt, so a typed "q"
    // is a letter rather than quit.
    const action = state.searchInput === null ? decodeKey(key) : decodeSearchKey(key);
    if (!action) return;
    if (action.kind === "quit") {
      close();
      options.onExit?.();
      return;
    }
    state = applyAction(state, action);
    paint();
  });

  const handle = options.timers.setInterval(() => {
    void tick();
  }, refreshMs);

  return { state: () => state, tick, close };

  async function tick(): Promise<void> {
    if (closed) return;
    // Poll even while paused: pause freezes the VIEW, not the subscription. The reducer
    // parks incoming deltas in a bounded backlog and applies them on resume, so pausing
    // never drops data and never changes capture.
    const deltas = await options.poll();
    if (closed) return;
    for (const delta of deltas) {
      state = applyDelta(state, delta);
    }
    advanceReplay();
    paint();
  }

  /**
   * Advance a scheduled replay, if one is due.
   *
   * The cadence is checked on the refresh tick rather than on its own timer, so it can
   * never be finer than the redraw rate — which is itself a proposed default, not a
   * latency guarantee. Reaching the last recorded frame parks there: returning to live
   * is an explicit user action and is never done for them.
   */
  function advanceReplay(): void {
    const session = state.replay;
    if (!session) return;
    const due = scheduledDelayMs(session);
    if (due === null) return;
    if (session.index >= session.timeline.frames.length - 1) return;
    const now = clock();
    if (now - lastStepAt < due) return;
    lastStepAt = now;
    state = applyAction(state, { kind: "replayStep", delta: 1 });
  }

  function paint(): void {
    if (closed) return;
    const current = options.terminal.size();
    options.terminal.paint(renderFrame(state, current.cols, current.rows));
  }

  function close(): void {
    if (closed) return;
    closed = true;
    options.timers.clearInterval(handle);
    options.terminal.close();
  }
}
