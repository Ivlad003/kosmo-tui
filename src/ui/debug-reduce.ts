import { parameterNames } from "../code/params.js";
import type { ConfirmRequest, DebugCommand, DebugEvent, PointRuntime } from "../debug/port.js";
import type { TargetRow } from "../debug/scan.js";
import { spanKey, type SpanRef } from "../format/types.js";
import { PROMPT_MAX, type Effect, type ViewState } from "./state.js";

export type CapturePrompt = {
  readonly kind: "tp" | "bp";
  readonly file: string;
  readonly line: number;
  readonly endLine?: number;
  readonly snippet?: string;
  readonly text: string;
  readonly sameCase: boolean;
  readonly spanKey: string | null;
  readonly runtime: PointRuntime;
};

export type DebugPoint = {
  readonly id: number;
  readonly kind: "tp" | "bp";
  readonly spanKey: string | null;
  readonly file: string;
  readonly line: number;
  readonly runtime: PointRuntime;
  /** `pending`, `resolved (N scripts)`, `failed(…)`, `removed: cap N reached` (spec 9.5 p.8). */
  readonly state: string;
};

export type DebugView = {
  readonly targets: readonly TargetRow[];
  /** Open `y`/`n` screen; `y` dispatches `confirm.command`. */
  readonly confirm: ConfirmRequest | null;
  readonly nodeLabel: string | null;
  readonly browserLabel: string | null;
  readonly pausedText: string | null;
  readonly pausedFrames: readonly string[];
  readonly pausedScopes: readonly string[];
  readonly hits: readonly string[];
  readonly capture: CapturePrompt | null;
  readonly points: readonly DebugPoint[];
  readonly nextId: number;
  readonly cap: number;
  readonly status: string | null;
};

export const HITS_MAX = 1000;
export const CAP_MAX = 100000;

export const EMPTY_DEBUG: DebugView = {
  targets: [],
  confirm: null,
  nodeLabel: null,
  browserLabel: null,
  pausedText: null,
  pausedFrames: [],
  pausedScopes: [],
  hits: [],
  capture: null,
  points: [],
  nextId: 1,
  cap: 100,
  status: null
};

export type DebugAction =
  | { readonly type: "openTargets" }
  | { readonly type: "openHits" }
  | { readonly type: "openPaused" }
  | { readonly type: "rescan"; readonly wildcard: boolean }
  | { readonly type: "activateTarget" }
  /** `yes` runs the request; `no` runs its `declined` command if any; `cancel` (Esc) drops it. */
  | { readonly type: "confirm"; readonly answer: "yes" | "no" | "cancel" }
  | { readonly type: "togglePoint"; readonly kind: "tp" | "bp" }
  | { readonly type: "removePoint"; readonly id: number; readonly kind: "tp" | "bp" }
  | { readonly type: "setCap"; readonly cap: number }
  | { readonly type: "captureInput"; readonly text: string }
  | { readonly type: "captureBackspace" }
  | { readonly type: "captureToggleSame" }
  | { readonly type: "captureSubmit" }
  | { readonly type: "captureCancel" }
  | { readonly type: "step"; readonly command: "resume" | "over" | "out" | "into" }
  | { readonly type: "suspend" }
  | { readonly type: "event"; readonly event: DebugEvent }
  | { readonly type: "command"; readonly command: DebugCommand };

type Result = readonly [ViewState, readonly Effect[]];

export function reduceDebug(state: ViewState, action: DebugAction): Result {
  // Ctrl+Z is about the terminal, not the debugger: it works under `-r` too.
  if (state.readOnly && action.type !== "event" && action.type !== "suspend") {
    return [banner(state, "error", "debug: unavailable(read-only)"), []];
  }
  switch (action.type) {
    case "openTargets":
      return [
        { ...state, pane: "targets", paneCursor: 0 },
        [{ kind: "debug", command: { type: "scan", root: state.root, wildcard: false } }]
      ];
    case "openHits":
      return [{ ...state, pane: "hits", paneCursor: Math.max(0, state.debug.hits.length - 1) }, []];
    case "openPaused":
      return state.debug.pausedText === null
        ? [banner(state, "info", "not paused"), []]
        : [{ ...state, pane: "paused", paneCursor: 0 }, []];
    case "rescan":
      return [state, [{ kind: "debug", command: { type: "scan", root: state.root, wildcard: action.wildcard } }]];
    case "activateTarget":
      return activateTarget(state);
    case "confirm":
      return confirm(state, action.answer);
    case "togglePoint":
      return togglePoint(state, action.kind);
    case "removePoint":
      return removePoint(state, action.id, action.kind);
    case "setCap":
      if (!Number.isInteger(action.cap) || action.cap < 1 || action.cap > CAP_MAX) {
        return [banner(state, "error", `tp-cap: expected 1..${CAP_MAX}`), []];
      }
      return [
        { ...withDebug(state, { cap: action.cap }), banner: { level: "info", text: `tp-cap ${action.cap}` } },
        []
      ];
    case "captureInput":
      return state.debug.capture === null
        ? [state, []]
        : [
            withDebug(state, {
              capture: {
                ...state.debug.capture,
                text: Array.from(state.debug.capture.text + action.text)
                  .slice(0, PROMPT_MAX)
                  .join("")
              }
            }),
            []
          ];
    case "captureBackspace":
      return state.debug.capture === null
        ? [state, []]
        : [
            withDebug(state, {
              capture: { ...state.debug.capture, text: Array.from(state.debug.capture.text).slice(0, -1).join("") }
            }),
            []
          ];
    case "captureToggleSame":
      return state.debug.capture === null
        ? [state, []]
        : [withDebug(state, { capture: { ...state.debug.capture, sameCase: !state.debug.capture.sameCase } }), []];
    case "captureSubmit":
      return submitCapture(state);
    case "captureCancel":
      return [withDebug(state, { capture: null }), []];
    case "step":
      return state.debug.pausedText === null
        ? [state, []]
        : [state, [{ kind: "debug", command: { type: "step", command: action.command } }]];
    case "suspend":
      return [state, [{ kind: "suspend" }]];
    case "event":
      return applyEvent(state, action.event);
    case "command":
      return command(state, action.command);
    default:
      return [state, []];
  }
}

function withDebug(state: ViewState, patch: Partial<DebugView>): ViewState {
  return { ...state, debug: { ...state.debug, ...patch } };
}

function command(state: ViewState, cmd: DebugCommand): Result {
  switch (cmd.type) {
    case "arm": {
      // `:tp file:line` — remembered like a `b` point so `:untp <id>` and detach/reattach can find it.
      const point: DebugPoint = {
        id: cmd.id,
        kind: cmd.kind,
        spanKey: null,
        file: cmd.file,
        line: cmd.line,
        runtime: cmd.runtime,
        state: "pending"
      };
      return [
        withDebug(state, { nextId: Math.max(state.debug.nextId, cmd.id + 1), points: [...state.debug.points, point] }),
        [{ kind: "debug", command: { ...cmd, root: cmd.root ?? state.root } }]
      ];
    }
    case "reloadArmed":
      if (cmd.confirmed === true) return [state, [{ kind: "debug", command: cmd }]];
      if (state.debug.browserLabel === null) return [banner(state, "error", "no browser attached"), []];
      return [
        withDebug(state, {
          confirm: {
            title: "Reload page?",
            lines: [
              "reloads the page so armed tracepoints see mount-time calls",
              `browser: ${state.debug.browserLabel}`
            ],
            command: { type: "reloadArmed", confirmed: true }
          }
        }),
        []
      ];
    case "detach": {
      if (cmd.which !== "both") return [state, [{ kind: "debug", command: cmd }]];
      const attached = [state.debug.nodeLabel, state.debug.browserLabel].filter((label) => label !== null);
      if (attached.length === 0) return [banner(state, "info", "nothing attached"), []];
      if (attached.length === 1) return [state, [{ kind: "debug", command: cmd }]];
      return [
        withDebug(state, {
          confirm: { title: "Detach both?", lines: attached as string[], command: cmd }
        }),
        []
      ];
    }
    default:
      return [state, [{ kind: "debug", command: cmd }]];
  }
}

function activateTarget(state: ViewState): Result {
  const row = state.debug.targets[state.paneCursor];
  if (row === undefined) return [banner(state, "info", "no targets; r rescan"), []];
  // The controller answers with a `confirm` event (probe results, replace note) before attaching.
  return [state, [{ kind: "debug", command: { type: "attach", targetId: row.id } }]];
}

function confirm(state: ViewState, answer: "yes" | "no" | "cancel"): Result {
  const request = state.debug.confirm;
  const next = withDebug(state, { confirm: null });
  if (request === null || answer === "cancel") return [next, []];
  if (answer === "yes") return [next, [{ kind: "debug", command: request.command }]];
  return [next, request.declined === undefined ? [] : [{ kind: "debug", command: request.declined }]];
}

function togglePoint(state: ViewState, kind: "tp" | "bp"): Result {
  const span = state.trace && state.selected ? state.trace.get(state.selected) : undefined;
  const key = span === undefined ? null : spanKey(span.ref);
  const existing = state.debug.points.find((point) => point.kind === kind && point.spanKey === key && key !== null);
  if (existing !== undefined) return removePoint(state, existing.id, kind);
  const location = span?.location;
  if (span === undefined || location === undefined) return [banner(state, "error", "no location"), []];
  // Routing by the span's runtime (spec 9.3): browser spans need the browser, the rest (including a
  // span without a runtime) need Node. Only `:tp`/`:bp` without a span (`null`) go everywhere.
  const runtime: PointRuntime = span.runtime ?? "node";
  if (runtime === "other") return [banner(state, "error", "runtime-not-attached"), []];
  if (runtime === "browser" && state.debug.browserLabel === null) {
    return [banner(state, "error", "runtime-not-attached (browser) · A to launch one"), []];
  }
  if (runtime !== "browser" && state.debug.nodeLabel === null) {
    return [banner(state, "error", "not-attached · A to pick a target"), []];
  }
  const snippet = state.snippets.get(spanKey(span.ref));
  const text =
    snippet !== undefined && snippet !== "loading"
      ? parameterNames(
          snippet.lines.map((line) => line.text).join("\n"),
          location.line - (snippet.lines[0]?.n ?? location.line) + 1
        ).join(", ")
      : "";
  return [
    withDebug(state, {
      capture: {
        kind,
        file: location.file,
        line: location.line,
        ...(location.endLine === undefined ? {} : { endLine: location.endLine }),
        ...(location.snippet === undefined ? {} : { snippet: location.snippet }),
        text,
        sameCase: false,
        spanKey: key,
        runtime
      }
    }),
    []
  ];
}

function removePoint(state: ViewState, id: number, kind: "tp" | "bp"): Result {
  const existing = state.debug.points.find((point) => point.id === id && point.kind === kind);
  if (existing === undefined) return [banner(state, "error", `${kind === "tp" ? "untp" : "unbp"}: no point ${id}`), []];
  return [
    {
      ...withDebug(state, { points: state.debug.points.filter((point) => point.id !== id) }),
      banner: { level: "info", text: `${kind} ${id} removed` }
    },
    [{ kind: "debug", command: { type: "disarm", id } }]
  ];
}

function submitCapture(state: ViewState): Result {
  const capture = state.debug.capture;
  if (capture === null) return [state, []];
  const id = state.debug.nextId;
  const names = capture.text.split(/[,\s]+/).filter((name) => name !== "");
  const point: DebugPoint = {
    id,
    kind: capture.kind,
    spanKey: capture.spanKey,
    file: capture.file,
    line: capture.line,
    runtime: capture.runtime,
    state: "pending"
  };
  return [
    withDebug(state, { capture: null, nextId: id + 1, points: [...state.debug.points, point] }),
    [
      {
        kind: "debug",
        command: {
          type: "arm",
          id,
          kind: capture.kind,
          file: capture.file,
          root: state.root,
          line: capture.line,
          ...(capture.endLine === undefined ? {} : { endLine: capture.endLine }),
          ...(capture.snippet === undefined ? {} : { snippet: capture.snippet }),
          names,
          sameCase: capture.sameCase,
          cap: state.debug.cap,
          runtime: capture.runtime
        }
      }
    ]
  ];
}

function applyEvent(state: ViewState, event: DebugEvent): Result {
  switch (event.type) {
    case "targets":
      return [
        {
          ...withDebug(state, { targets: event.rows }),
          paneCursor: Math.min(state.paneCursor, Math.max(0, event.rows.length - 1))
        },
        []
      ];
    case "status":
      return [withDebug(state, { status: event.text }), []];
    case "banner":
      return [banner(state, event.level, event.text), []];
    case "confirm":
      return [withDebug(state, { confirm: event.request }), []];
    case "pointState":
      return [
        withDebug(state, {
          points: state.debug.points.map((point) => (point.id === event.id ? { ...point, state: event.state } : point))
        }),
        []
      ];
    case "hit": {
      const hits = [...state.debug.hits, event.text].slice(-HITS_MAX);
      // Follow the newest hit unless the user has scrolled up inside the Hits pane.
      const follow = state.pane !== "hits" || state.paneCursor >= state.debug.hits.length - 1;
      return [
        {
          ...withDebug(state, { hits }),
          paneCursor: follow && state.pane === "hits" ? hits.length - 1 : state.paneCursor
        },
        []
      ];
    }
    case "paused": {
      const paused = event.text !== null;
      const busy = state.debug.capture !== null || state.debug.confirm !== null || state.prompt !== null;
      const pane = paused
        ? busy || state.pane === "paused"
          ? state.pane
          : "paused"
        : state.pane === "paused"
          ? "tree"
          : state.pane;
      return [
        {
          ...withDebug(state, { pausedText: event.text, pausedFrames: event.frames, pausedScopes: event.scopes }),
          pane,
          paneCursor: pane === state.pane ? state.paneCursor : 0
        },
        []
      ];
    }
    case "attached": {
      const status = [event.node, event.browser].filter((part) => part !== null).join(" · ");
      return [
        withDebug(state, {
          nodeLabel: event.node,
          browserLabel: event.browser,
          status: status === "" ? null : status
        }),
        []
      ];
    }
    default:
      return [state, []];
  }
}

function banner(state: ViewState, level: "info" | "error", text: string): ViewState {
  return { ...state, banner: { level, text } };
}

export function debugItemCount(state: ViewState): number {
  if (state.pane === "targets") return state.debug.targets.length;
  if (state.pane === "hits") return state.debug.hits.length;
  if (state.pane === "paused") return pausedRows(state).length;
  return 0;
}

/** Rows of the Paused view: live frames, then the scope sections of the top frame (spec 9.7). */
export function pausedRows(state: ViewState): string[] {
  const scopes = state.debug.pausedScopes;
  return scopes.length === 0
    ? [...state.debug.pausedFrames]
    : [...state.debug.pausedFrames, "── scope (top frame) ──", ...scopes];
}

export function selectedRefKey(ref: SpanRef | null): string | null {
  return ref === null ? null : spanKey(ref);
}
