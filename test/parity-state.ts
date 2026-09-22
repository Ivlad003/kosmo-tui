/**
 * Builds the kosmo-tui ViewState for a frame-parity case (task 3.3).
 *
 * The cases are written in kosmo-callflow's bare-id vocabulary so the same file drives
 * both renderers (see scripts/parity-kc.mjs). Here every row is given its full identity:
 * one local dataset, project "p", and session "s-1" unless the row names its own
 * sessionId. A bare-id retention drop becomes a drop of every loaded ref with that
 * traceId, which is exactly what kosmo-callflow's bare-id drop did.
 */
import { parseTraceText, type TraceTextDocumentV1 } from "@kosmo-callflow/protocol";
import { buildReplayTimeline, planReplaySchedule, type ReplayFrameInput } from "../src/replay.js";
import { renderFrame } from "../src/render.js";
import {
  applyAction,
  applyDelta,
  initialViewState,
  traceKey,
  type Action,
  type Delta,
  type SpanRow,
  type TraceRef,
  type TraceRow,
  type ViewState
} from "../src/view-state.js";
import type { ParityCase } from "../scripts/parity-kc.mjs";

const SCOPE = { datasetId: "local", projectId: "p" };
const DEFAULT_SESSION = "s-1";

type Bare = { traceId: string; sessionId?: string };
type Step = {
  include?: string;
  delta?: Record<string, unknown> & { kind: string };
  action?: Action;
  select?: Bare & { spanId: string };
  detail?: Record<string, unknown> & Bare & { spanId: string; documentLisp: string | null };
  replay?: {
    frames: Array<Omit<ReplayFrameInput, "state"> & { state: { traces: Bare[]; spans: Bare[] } }>;
    requestedSeqs: number[];
    plan: { speed?: number; stepIntervalMs?: number };
    index: number;
  };
};

function identify<T extends Bare>(row: T): T & { datasetId: string; projectId: string; sessionId: string } {
  return { ...row, ...SCOPE, sessionId: row.sessionId ?? DEFAULT_SESSION };
}

function document(text: string | null): TraceTextDocumentV1 | null {
  if (text === null) return null;
  const parsed = parseTraceText(text, { dialect: "lisp" });
  if (!parsed.ok) throw new Error("fixture trace-text does not parse");
  return parsed.data;
}

function expand(cases: ParityCase[], steps: unknown[]): Step[] {
  return (steps as Step[]).flatMap((step) => {
    if (step.include === undefined) return [step];
    const included = cases.find((candidate) => candidate.name === step.include);
    if (!included) throw new Error(`unknown include ${step.include}`);
    return expand(cases, included.steps);
  });
}

function mapDelta(state: ViewState, delta: NonNullable<Step["delta"]>): Delta {
  switch (delta.kind) {
    case "traces":
      return { kind: "traces", rows: (delta.rows as Bare[]).map(identify) as TraceRow[] };
    case "spans":
      return { kind: "spans", rows: (delta.rows as Bare[]).map(identify) as SpanRow[] };
    case "retention": {
      const ids = new Set(delta.droppedTraceIds as string[]);
      const dropped = new Map<string, TraceRef>();
      for (const row of [...state.traces, ...state.spans]) {
        if (ids.has(row.traceId)) dropped.set(traceKey(row), row);
      }
      return { kind: "retention", dropped: [...dropped.values()] };
    }
    default:
      return delta as unknown as Delta;
  }
}

export function ktState(cases: ParityCase[], testCase: ParityCase, rows: number): ViewState {
  let state = initialViewState({ viewportHeight: Math.max(1, rows - 4) });
  for (const step of expand(cases, testCase.steps)) {
    if (step.delta) state = applyDelta(state, mapDelta(state, step.delta));
    else if (step.action) state = applyAction(state, step.action);
    else if (step.select) {
      const { datasetId, projectId, sessionId, traceId, spanId } = identify(step.select);
      state = { ...state, selection: { datasetId, projectId, sessionId, traceId, spanId } };
      state = applyAction(state, { kind: "move", delta: 0 });
    } else if (step.detail) {
      const { documentLisp, ...detail } = step.detail;
      state = applyDelta(state, {
        kind: "detail",
        detail: { ...identify(detail), document: document(documentLisp) } as never
      });
    } else if (step.replay) {
      const frames = step.replay.frames.map((frame) => ({
        ...frame,
        state: {
          traces: frame.state.traces.map(identify) as TraceRow[],
          spans: frame.state.spans.map(identify) as SpanRow[]
        }
      }));
      const timeline = buildReplayTimeline({ frames, requestedSeqs: step.replay.requestedSeqs });
      const schedule = planReplaySchedule(timeline, step.replay.plan);
      state = { ...state, replay: { timeline, schedule, index: step.replay.index } };
    } else throw new Error(`unknown step ${JSON.stringify(step)}`);
  }
  return state;
}

export function ktFrame(cases: ParityCase[], testCase: ParityCase, cols: number, rows: number): string[] {
  return renderFrame(ktState(cases, testCase, rows), cols, rows);
}
