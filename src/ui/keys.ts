/**
 * Key map of stage 1 (spec 6.7). Pure: bytes from the terminal in, one Action (or undefined for a
 * key that means nothing here) out.
 *
 * Precedence, highest first:
 *  1. the open prompt (`/` or `:`): typing is text, so `q` is the letter q;
 *  2. the focused pane: the detail scrolls, an aux pane (areas, stack, bookmarks, results) moves its
 *     own cursor and takes Enter/Esc/Tab;
 *  3. global keys.
 *
 * Stage 1 frees `n b L p = w f t R - +` without a replacement, and stage-2 keys (`A B H P c o`) are
 * not bound yet: they all decode to undefined.
 */

import { parseCommandLine } from "./commands.js";
import { PAGE_STEP, type Action, type ViewState } from "./state.js";

const ESC = "\u001b";
const CTRL_C = "\u0003";
const CTRL_U = "\u0015";
const DEL = "\u007f";
const BS = "\u0008";

type Nav = { delta: number } | { edge: "first" | "last" };

/** Navigation keys: CSI and SS3 forms of the arrows, Home/End in the xterm and VT220 spellings. */
const NAV = new Map<string, Nav>([
  ["j", { delta: 1 }],
  ["k", { delta: -1 }],
  [`${ESC}[B`, { delta: 1 }],
  [`${ESC}[A`, { delta: -1 }],
  [`${ESC}OB`, { delta: 1 }],
  [`${ESC}OA`, { delta: -1 }],
  [`${ESC}[6~`, { delta: PAGE_STEP }],
  [`${ESC}[5~`, { delta: -PAGE_STEP }],
  ["g", { edge: "first" }],
  ["G", { edge: "last" }],
  [`${ESC}[H`, { edge: "first" }],
  [`${ESC}[F`, { edge: "last" }],
  [`${ESC}OH`, { edge: "first" }],
  [`${ESC}OF`, { edge: "last" }],
  [`${ESC}[1~`, { edge: "first" }],
  [`${ESC}[4~`, { edge: "last" }]
]);

const GLOBAL = new Map<string, Action>([
  ["h", { type: "collapse" }],
  ["l", { type: "expand" }],
  // ← → are kept from the old map as aliases of h / l.
  [`${ESC}[D`, { type: "collapse" }],
  [`${ESC}[C`, { type: "expand" }],
  [" ", { type: "toggleExpand" }],
  ["T", { type: "back" }],
  [DEL, { type: "back" }],
  [BS, { type: "back" }],
  ["v", { type: "toggleTable" }],
  ["d", { type: "toggleText" }],
  ["/", { type: "openPrompt", kind: "search" }],
  ["e", { type: "toggleErrors" }],
  ["a", { type: "openPane", pane: "areas" }],
  ["s", { type: "openPane", pane: "stack" }],
  ["m", { type: "toggleBookmark" }],
  ["'", { type: "openPane", pane: "bookmarks" }],
  ["y", { type: "copySubtree" }],
  [">", { type: "loadMore" }],
  ["r", { type: "reload" }],
  [":", { type: "openPrompt", kind: "command" }],
  ["q", { type: "quit" }]
]);

export function decodeKey(state: ViewState, input: string): Action | undefined {
  if (input === CTRL_C) return { type: "quit" };
  if (state.prompt !== null) return decodePromptKey(state, input);
  const nav = NAV.get(input);
  const enter = input === "\r" || input === "\n";
  if (state.screen === "trace" && state.pane === "detail") {
    if (nav !== undefined) {
      return "delta" in nav ? { type: "scrollDetail", delta: nav.delta } : { type: "scrollDetailTo", edge: nav.edge };
    }
    if (input === "\t" || input === ESC) return { type: "focusTree" };
    if (enter) return undefined;
  } else if (state.screen === "trace" && state.pane !== "tree") {
    if (nav !== undefined) {
      return "delta" in nav ? { type: "paneMove", delta: nav.delta } : { type: "paneMoveTo", edge: nav.edge };
    }
    if (enter) return { type: "paneActivate" };
    if (input === "\t" || input === ESC) return { type: "closePane" };
  } else {
    if (nav !== undefined)
      return "delta" in nav ? { type: "move", delta: nav.delta } : { type: "moveTo", edge: nav.edge };
    if (enter) return { type: "activate" };
    if (input === ESC) return { type: "escape" };
    if (input === "\t") return state.screen === "trace" ? { type: "focusTree" } : undefined;
  }
  return GLOBAL.get(input);
}

/**
 * Keys while the prompt is open. Enter submits (`:` lines are parsed here, so the reducer never
 * imports the command parser), Esc cancels, Backspace deletes one character, Ctrl+U clears. Other
 * escape sequences are ignored; a pasted chunk loses its control characters instead of inserting them.
 */
function decodePromptKey(state: ViewState, input: string): Action | undefined {
  const prompt = state.prompt!;
  if (input === "\r" || input === "\n") {
    return prompt.kind === "command"
      ? { type: "runCommand", result: parseCommandLine(state, prompt.text) }
      : { type: "promptSubmit" };
  }
  if (input === ESC) return { type: "promptCancel" };
  if (input === DEL || input === BS) return { type: "promptBackspace" };
  if (input === CTRL_U) return { type: "promptClear" };
  if (input.startsWith(ESC)) return undefined;
  const text = Array.from(input)
    .filter((char) => {
      const code = char.codePointAt(0)!;
      return !(code < 0x20 || (code >= 0x7f && code <= 0x9f));
    })
    .join("");
  return text.length === 0 ? undefined : { type: "promptInput", text };
}
