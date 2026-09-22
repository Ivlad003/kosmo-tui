/**
 * Task 5b.1: the `:` command line itself — tokenizer and qualified-ref syntax, prompt
 * editing (backspace, ctrl-u, esc, enter, bounded history), the footer prompt, and the
 * viewer loop running a submitted line.
 */
import { describe, expect, it } from "vitest";
import {
  COMMAND_HISTORY_CAP,
  COMMAND_LINE_MAX,
  parseCommandLine,
  parseSpanRef,
  parseTraceRef,
  pushHistory,
  tokenize,
  type Token
} from "../src/command-line.js";
import { decodeCommandLineKey, decodeKey } from "../src/keys.js";
import { renderFrame } from "../src/render.js";
import { applyAction, applyDelta, initialViewState, type ViewState } from "../src/view-state.js";
import { startViewer } from "../src/viewer.js";
import { connected, ref, span, trace } from "./view-fixtures.js";
import { fakeTimers, fakeViewerTerminal } from "./viewer-fakes.js";

const ESC = String.fromCharCode(27);
const CTRL_U = String.fromCharCode(21);
const CTRL_C = String.fromCharCode(3);
const DEL = String.fromCharCode(127);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;

function tokens(line: string): Token[] {
  const result = tokenize(line);
  if (!result.ok) throw new Error(result.error);
  return result.tokens;
}

function one(line: string): Token {
  return tokens(line)[0]!;
}

describe("tokenizer", () => {
  it("splits bare words on whitespace", () => {
    expect(tokens("path  a   b").map((token) => token.text)).toEqual(["path", "a", "b"]);
  });

  it("single quotes are literal, double quotes understand escapes", () => {
    expect(one("'a b\\n'").text).toBe("a b\\n");
    expect(one('"a \\"b\\" \\\\ c\\n"').text).toBe('a "b" \\ c\n');
    expect(one("a\\ b").text).toBe("a b");
  });

  it("only unquoted colons split a ref into parts", () => {
    expect(one("s-1:t-1:a").parts).toEqual(["s-1", "t-1", "a"]);
    expect(one('"sess:1":t-1:a').parts).toEqual(["sess:1", "t-1", "a"]);
    expect(one("x\\:y:z").parts).toEqual(["x:y", "z"]);
  });

  it("a regex literal may contain spaces, quotes and escaped slashes", () => {
    const token = one("/a b'\\/c/i");
    expect(token.regex).toEqual({ source: "a b'\\/c", flags: "i" });
  });

  it("reports unterminated quotes and regexes instead of guessing", () => {
    expect(tokenize("'abc").ok).toBe(false);
    expect(tokenize('"abc').ok).toBe(false);
    expect(tokenize("/abc").ok).toBe(false);
    expect(tokenize("abc\\").ok).toBe(false);
    expect(tokenize("/a/x!").ok).toBe(false);
  });

  it("separates --flags from args; a quoted --flag is an arg", () => {
    const parsed = parseCommandLine(":callers src/a.ts#run --static '--literal'");
    expect(parsed.ok).toBe(true);
    if (parsed.ok !== true) return;
    expect(parsed.command.name).toBe("callers");
    expect([...parsed.command.flags]).toEqual(["static"]);
    expect(parsed.command.args.map((arg) => arg.text)).toEqual(["src/a.ts#run", "--literal"]);
  });

  it("a blank line is empty, not an error", () => {
    expect(parseCommandLine("   ").ok).toBe("empty");
    expect(parseCommandLine(":").ok).toBe("empty");
  });
});

describe("qualified ref syntax", () => {
  it("accepts span, trace:span, session:trace:span and the full five-part ref", () => {
    expect(parseSpanRef(one("a"))).toEqual({ ok: true, spec: { kind: "ref", spanId: "a" } });
    expect(parseSpanRef(one("t:a"))).toEqual({ ok: true, spec: { kind: "ref", traceId: "t", spanId: "a" } });
    expect(parseSpanRef(one("s:t:a"))).toEqual({
      ok: true,
      spec: { kind: "ref", sessionId: "s", traceId: "t", spanId: "a" }
    });
    expect(parseSpanRef(one("d:p:s:t:a"))).toEqual({
      ok: true,
      spec: { kind: "ref", datasetId: "d", projectId: "p", sessionId: "s", traceId: "t", spanId: "a" }
    });
    expect(parseSpanRef(one("."))).toEqual({ ok: true, spec: { kind: "selection" } });
    expect(parseSpanRef(one("'.'"))).toEqual({ ok: true, spec: { kind: "ref", spanId: "." } });
  });

  it("rejects four-part span refs and empty parts", () => {
    expect(parseSpanRef(one("p:s:t:a")).ok).toBe(false);
    expect(parseSpanRef(one("s::a")).ok).toBe(false);
  });

  it("trace refs are trace, session:trace or dataset:project:session:trace", () => {
    expect(parseTraceRef(one("t"))).toEqual({ ok: true, spec: { traceId: "t" } });
    expect(parseTraceRef(one("s:t"))).toEqual({ ok: true, spec: { sessionId: "s", traceId: "t" } });
    expect(parseTraceRef(one("d:p:s:t")).ok).toBe(true);
    expect(parseTraceRef(one("p:s:t")).ok).toBe(false);
  });
});

function withPrompt(): ViewState {
  let state = initialViewState();
  state = applyDelta(state, connected());
  return applyAction(state, decodeKey(":")!);
}

function type(state: ViewState, text: string): ViewState {
  return applyAction(state, decodeCommandLineKey(text)!);
}

describe("prompt editing", () => {
  it("':' opens an empty prompt and typed keys are text, not commands", () => {
    let state = withPrompt();
    expect(state.commandLine?.text).toBe("");
    for (const key of ["q", "j", " ", "/"]) state = type(state, key);
    expect(state.commandLine?.text).toBe("qj /");
    expect(decodeCommandLineKey("q")).toEqual({ kind: "commandInput", text: "q" });
  });

  it("backspace deletes one code point, ctrl-u clears, esc cancels", () => {
    let state = type(withPrompt(), "ab😀");
    state = type(state, DEL);
    expect(state.commandLine?.text).toBe("ab");
    state = type(state, CTRL_U);
    expect(state.commandLine?.text).toBe("");
    state = type(type(state, "x"), ESC);
    expect(state.commandLine).toBeNull();
    expect(state.commandHistory).toEqual([]);
  });

  it("pasted control bytes are dropped; unknown escape sequences are ignored", () => {
    expect(decodeCommandLineKey(`a${String.fromCharCode(7)}b`)).toEqual({ kind: "commandInput", text: "ab" });
    expect(decodeCommandLineKey(`${ESC}[C`)).toBeUndefined();
    expect(decodeCommandLineKey(CTRL_C)).toEqual({ kind: "quit" });
  });

  it("the line is bounded", () => {
    const state = type(withPrompt(), "x".repeat(COMMAND_LINE_MAX + 50));
    expect(state.commandLine?.text.length).toBe(COMMAND_LINE_MAX);
  });

  it("enter closes the prompt and records the line; up/down walk history and restore the draft", () => {
    let state = withPrompt();
    state = type(type(state, "seq 1"), "\r");
    expect(state.commandLine).toBeNull();
    state = applyAction(state, decodeKey(":")!);
    state = type(type(state, "seq 2"), "\r");
    expect(state.commandHistory).toEqual(["seq 1", "seq 2"]);
    state = applyAction(state, decodeKey(":")!);
    state = type(state, "dra");
    state = type(state, UP);
    expect(state.commandLine?.text).toBe("seq 2");
    state = type(state, UP);
    expect(state.commandLine?.text).toBe("seq 1");
    state = type(state, UP);
    expect(state.commandLine?.text).toBe("seq 1");
    state = type(state, DOWN);
    state = type(state, DOWN);
    expect(state.commandLine?.text).toBe("dra");
  });

  it("history drops blanks and immediate repeats and keeps only the newest entries", () => {
    expect(pushHistory(["a"], "a")).toEqual(["a"]);
    expect(pushHistory(["a"], "  ")).toEqual(["a"]);
    let history: string[] = [];
    for (let index = 0; index < COMMAND_HISTORY_CAP + 7; index += 1) history = pushHistory(history, `c${index}`);
    expect(history.length).toBe(COMMAND_HISTORY_CAP);
    expect(history[0]).toBe("c7");
  });

  it("the footer shows the prompt in place of the hints without changing the frame height", () => {
    const closed = renderFrame(initialViewState(), 100, 20);
    const state = type(withPrompt(), "path a b");
    const frame = renderFrame(state, 100, 20);
    expect(frame.length).toBe(closed.length);
    expect(frame.at(-1)).toContain(":path a b_");
    expect(frame.at(-1)).toContain("esc cancel");
  });

  it("recorded control characters in the prompt are escaped, never emitted", () => {
    const state = applyAction(withPrompt(), { kind: "commandInput", text: `x${ESC}[2Jy` });
    expect(renderFrame(state, 100, 20).at(-1)).not.toContain(ESC);
  });

  it("without the interactive capability ':' is unavailable, not silent", () => {
    const state = applyAction(
      initialViewState({
        caps: {
          projectionVersions: [2],
          projection: { available: true },
          follow: { available: true },
          replay: { available: true },
          values: { available: true, level: "full" },
          probes: { available: true },
          staticGraph: { available: true },
          sql: { available: true },
          review: { available: true },
          localEval: { available: true },
          interactive: { available: false, reason: "one-shot(--print)" }
        }
      }),
      decodeKey(":")!
    );
    expect(state.commandLine).toBeNull();
    expect(state.notice).toBe("commandLine: unavailable(one-shot(--print))");
  });
});

describe("the viewer runs a submitted line", () => {
  function start() {
    const term = fakeViewerTerminal(30, 120);
    const timers = fakeTimers();
    let exits = 0;
    const viewer = startViewer({
      terminal: term.terminal,
      poll: async () => [],
      timers: timers.timers,
      initial: [
        connected(),
        { kind: "traces", rows: [trace("t-1", 1)] },
        {
          kind: "spans",
          rows: [span("t-1", "root"), span("t-1", "child", { parentSpanId: "root", depth: 1, nodeId: "src/c.ts#go" })]
        }
      ],
      onExit: () => {
        exits += 1;
      }
    });
    const typeLine = (line: string) => {
      term.press(":");
      for (const char of line) term.press(char);
      term.press("\r");
    };
    return { term, viewer, typeLine, exits: () => exits };
  }

  it("a typed 'q' inside the prompt is a letter; ':q' then quits", async () => {
    const { term, viewer, typeLine, exits } = start();
    term.press(":");
    term.press("q");
    expect(exits()).toBe(0);
    expect(viewer.state().commandLine?.text).toBe("q");
    term.press(ESC);
    typeLine("q");
    await viewer.settled();
    expect(exits()).toBe(1);
  });

  it("a query result is painted in the result pane and esc closes it without dropping the selection", async () => {
    const { term, viewer, typeLine } = start();
    term.press("j");
    const selected = viewer.state().selection;
    typeLine("ancestors t-1:child");
    await viewer.settled();
    expect(viewer.state().commandResult?.kind).toBe("projection");
    expect(term.last()).toContain("ancestors of src/c.ts#go");
    expect(term.last()).toContain("coverage complete");
    term.press(ESC);
    expect(viewer.state().commandResult).toBeNull();
    expect(viewer.state().selection).toEqual(selected);
  });

  it("an unknown command shows a notice listing what is available", async () => {
    const { term, viewer, typeLine } = start();
    typeLine("(eval (quit))");
    await viewer.settled();
    expect(viewer.state().notice).toMatch(/^unknown command: \(eval; available: :seq .*:ancestors/);
    expect(term.last()).toContain("unknown command");
    expect(viewer.state().commandHistory).toEqual(["(eval (quit))"]);
  });

  it("a view action lands as a receipt and changes view state", async () => {
    const { viewer, typeLine } = start();
    typeLine("trace t-1");
    await viewer.settled();
    expect(viewer.state().selection).toEqual(ref("t-1", "root"));
    expect(viewer.state().notice).toBe("trace t-1: selected src/root.ts#run");
    expect(viewer.state().commandResult).toBeNull();
  });
});
