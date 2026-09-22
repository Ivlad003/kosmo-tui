/**
 * Pure key decoding for the interactive viewer, ported from kosmo-callflow
 * `packages/cli/src/connect/keys.ts`.
 *
 * Kept free of any terminal I/O so the whole key map is unit-testable: the impure layer
 * reads bytes and hands them here, and gets back an Action or undefined for input it
 * should ignore. The Action vocabulary is the reducer's own, so the two cannot drift.
 */

import type { Action } from "./view-state.js";

export type { Action } from "./view-state.js";

const escapeSequences = new Map<string, Action>([
  ["\u001b[A", { kind: "move", delta: -1 }],
  ["\u001b[B", { kind: "move", delta: 1 }],
  ["\u001b[D", { kind: "collapse" }],
  ["\u001b[C", { kind: "expand" }],
  ["\u001b[5~", { kind: "move", delta: -10 }],
  ["\u001b[6~", { kind: "move", delta: 10 }],
  ["\u001b[H", { kind: "moveTo", edge: "first" }],
  ["\u001b[F", { kind: "moveTo", edge: "last" }]
]);

const plainKeys = new Map<string, Action>([
  ["k", { kind: "move", delta: -1 }],
  ["j", { kind: "move", delta: 1 }],
  ["h", { kind: "collapse" }],
  ["l", { kind: "expand" }],
  ["g", { kind: "moveTo", edge: "first" }],
  ["G", { kind: "moveTo", edge: "last" }],
  [" ", { kind: "toggleExpand" }],
  ["\r", { kind: "focus", pane: "detail" }],
  ["\n", { kind: "focus", pane: "detail" }],
  ["\t", { kind: "focus", pane: "list" }],
  ["p", { kind: "togglePause" }],
  // Replay stepping. `L` is the only way back to live; nothing does it implicitly.
  ["n", { kind: "replayStep", delta: 1 }],
  ["b", { kind: "replayStep", delta: -1 }],
  ["L", { kind: "returnToLive" }],
  ["v", { kind: "toggleView" }],
  ["d", { kind: "toggleDsl" }],
  ["/", { kind: "search" }],
  ["e", { kind: "filterErrorsOnly" }],
  ["q", { kind: "quit" }],
  ["\u0003", { kind: "quit" }],
  ["\u001b", { kind: "clearSelection" }]
]);

export function decodeKey(input: string): Action | undefined {
  const escape = escapeSequences.get(input);
  if (escape) return escape;
  return plainKeys.get(input);
}

/**
 * Decode a key while the `/` search prompt is open.
 *
 * Typing must not be re-interpreted as a command: while the prompt is open, "q" is the
 * letter q, not quit. Only Enter, Escape, Backspace and ctrl-c keep a meaning of their
 * own, and everything unprintable is ignored rather than inserted as control bytes.
 */
export function decodeSearchKey(input: string): Action | undefined {
  if (input === "\u0003") return { kind: "quit" };
  if (input === "\r" || input === "\n") return { kind: "searchCommit" };
  if (input === "\u001b") return { kind: "searchCancel" };
  if (input === "\u007f" || input === "\b") return { kind: "searchBackspace" };
  if (input.length === 0 || /[\u0000-\u001f\u007f-\u009f]/.test(input)) return undefined;
  return { kind: "searchInput", text: input };
}
