/**
 * Task 23: the TUI entry (spec 5.2 open-viewer invariants, 6.8): checks before the terminal is
 * taken, keys from the controlling terminal for `-`, raw mode reclaimed after data EOF, `q`
 * before the dataset is open, Ctrl+C 130, stdin destroyed on the way out (EPIPE for the producer).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TuiArgs } from "../../src/args.js";
import { EXIT_OK, EXIT_SIGINT, EXIT_USAGE } from "../../src/proc.js";
import { openKeyboardInput } from "../../src/terminal-input.js";
import type { TerminalOptions } from "../../src/terminal.js";
import { RECLAIM_AFTER_EOF_MS, openTui, type OpenTuiDeps } from "../../src/ui/open.js";
import { RECIPES, fixtureFile } from "../fixture-recipes.js";
import { chunks, memoryFs, neverEnding } from "../readers/reader-fakes.js";
import { toNdjsonLines } from "../trace-writers.js";
import { fakeProc, fakeStdin, type FakeProc } from "./proc-fakes.js";
import {
  fakeClipboard,
  fakeTerminal,
  manualTimers,
  memoryRootFs,
  memorySnippetFs,
  memoryStartFs,
  until
} from "./session-fakes.js";

const BASIC = readFileSync(fixtureFile("kosmo-trace/basic"), "utf8");
const NDJSON = toNdjsonLines(RECIPES["kosmo-trace/basic"]!()).map((line) => `${line}\n`);

function setup(options: { files?: Record<string, string | null>; proc?: FakeProc } = {}) {
  const terminal = fakeTerminal();
  const created: TerminalOptions[] = [];
  const closedPorts: string[] = [];
  const timers = manualTimers();
  const deps: OpenTuiDeps = {
    keyboard: () => ({
      ok: true,
      port: { input: fakeStdin(undefined, true), source: "controlling-tty", close: () => closedPorts.push("tty") }
    }),
    createTerminal: (_input, _output, terminalOptions) => {
      created.push(terminalOptions ?? {});
      return terminal;
    },
    reader: { fs: memoryFs(options.files ?? {}) },
    snippetFs: memorySnippetFs({}),
    rootFs: memoryRootFs({ dirs: ["/w/src"] }),
    startFs: memoryStartFs(),
    clipboard: fakeClipboard({ copied: true, via: "pbcopy" }, terminal.log),
    timers,
    homedir: () => "/home/me"
  };
  return { terminal, created, closedPorts, timers, deps };
}

const tui = (target?: string, extra: Partial<TuiArgs> = {}): TuiArgs => ({
  command: "tui",
  readOnly: true,
  ...(target === undefined ? {} : { target }),
  ...extra
});

async function run(args: TuiArgs, proc: FakeProc, deps: OpenTuiDeps): Promise<number> {
  return openTui({ args, proc, signal: new AbortController().signal }, deps);
}

describe("checks before the terminal is taken", () => {
  it("a missing path or a directory is exit 1 and nothing is drawn", async () => {
    for (const [target, message] of [
      ["nope.json", "kosmo-tui: file-not-found: nope.json\n"],
      ["traces", "kosmo-tui: is-directory: traces\n"]
    ] as const) {
      const s = setup({ files: { traces: null } });
      const proc = fakeProc([]);
      expect(await run(tui(target), proc, s.deps)).toBe(EXIT_USAGE);
      expect(proc.err).toBe(message);
      expect(s.created).toHaveLength(0);
    }
  });

  it("--root must be a directory", async () => {
    const s = setup();
    const proc = fakeProc([]);
    expect(await run(tui(undefined, { root: "missing" }), proc, s.deps)).toBe(EXIT_USAGE);
    expect(proc.err).toBe("kosmo-tui: --root is not a directory: missing\n");
    expect(s.created).toHaveLength(0);
  });

  it("stdout that is not a TTY is exit 1 with the --print hint", async () => {
    const s = setup();
    const proc = fakeProc([], { stdoutTty: false });
    expect(await run(tui(), proc, s.deps)).toBe(EXIT_USAGE);
    expect(proc.err).toMatch(
      /^kosmo-tui: no-controlling-terminal: interactive terminal required: stdout is not a TTY\. Use --print /
    );
    expect(s.created).toHaveLength(0);
  });

  it("`-` without a controlling terminal is exit 1 with the --print hint", async () => {
    const s = setup();
    const proc = fakeProc([], { stdin: fakeStdin(chunks(NDJSON)) });
    const deps: OpenTuiDeps = {
      ...s.deps,
      keyboard: (keyboardDeps) =>
        openKeyboardInput({
          ...keyboardDeps,
          openFd: () => {
            throw Object.assign(new Error("ENXIO"), { code: "ENXIO" });
          }
        })
    };
    expect(await run(tui("-"), proc, deps)).toBe(EXIT_USAGE);
    expect(proc.err).toMatch(
      /^kosmo-tui: no-controlling-terminal: interactive terminal required: stdin carries data and no controlling terminal/
    );
    expect(proc.err).toMatch(/--print/);
    expect(s.created).toHaveLength(0);
  });
});

describe("kosmo-tui - (spec 5.2 open-viewer invariants)", () => {
  it("reclaims raw mode at data EOF and once more after RECLAIM_AFTER_EOF_MS", async () => {
    const s = setup();
    const stdin = fakeStdin(chunks(NDJSON));
    const proc = fakeProc([], { stdin });
    const session = run(tui("-"), proc, s.deps);
    await until(() => s.terminal.screen().includes("GET /cart · 4 spans"), "trace screen");
    stdin.emitEnd();
    expect(s.terminal.reclaims).toBe(1);
    expect(RECLAIM_AFTER_EOF_MS).toBe(300);
    s.timers.runAll();
    expect(s.terminal.reclaims).toBe(2);
    s.terminal.key("q");
    expect(await session).toBe(EXIT_OK);
    expect(stdin.destroyed).toBe(true);
    expect(s.closedPorts).toEqual(["tty"]);
  });

  it("q before the dataset is open quits and destroys stdin, so the producer gets EPIPE", async () => {
    const s = setup();
    const data = neverEnding(NDJSON.slice(0, 1));
    const stdin = fakeStdin(data);
    const session = run(tui("-"), fakeProc([], { stdin }), s.deps);
    await until(() => s.terminal.screen().includes("reading…"), "reading");
    s.terminal.key("q");
    expect(await session).toBe(EXIT_OK);
    expect(data.returned).toBe(true);
    expect(stdin.destroyed).toBe(true);
    expect(s.terminal.closes).toBe(1);
  });

  it("Ctrl+C is exit 130", async () => {
    const s = setup();
    const session = run(tui("-"), fakeProc([], { stdin: fakeStdin(neverEnding([])) }), s.deps);
    s.terminal.key("\u0003");
    expect(await session).toBe(EXIT_SIGINT);
  });
});

describe("a file target", () => {
  it("opens it; the paint guard validates OSC 8 against the session's root", async () => {
    const s = setup({ files: { "/w/x.kosmo-trace.json": BASIC } });
    const proc = fakeProc([], { env: { KOSMO_TUI_LINKS: "1" } });
    const session = run(tui("/w/x.kosmo-trace.json"), proc, s.deps);
    await until(() => s.terminal.screen().includes("GET /cart · 4 spans"), "trace screen");
    const guard = s.created[0]!.guard!;
    const inside = "\u001b]8;;file:///w/src/a.ts\u001b\\a.ts\u001b]8;;\u001b\\";
    expect(guard(inside)).toBe(inside);
    expect(guard("\u001b]8;;file:///etc/passwd\u001b\\x\u001b]8;;\u001b\\")).toContain("\\u001b]8;;");
    s.terminal.key("q");
    expect(await session).toBe(EXIT_OK);
    expect(proc.stdin.destroyed).toBe(false);
  });

  it("frames go through the terminal port only: nothing is written to stdout directly", async () => {
    const s = setup({ files: { "/w/x.kosmo-trace.json": BASIC } });
    const proc = fakeProc([]);
    const session = run(tui("/w/x.kosmo-trace.json"), proc, s.deps);
    await until(() => s.terminal.frames.length > 1, "frames");
    s.terminal.key("q");
    await session;
    expect(proc.out).toBe("");
  });
});

describe("an uncaught error (spec 13.2)", () => {
  it("a throw that escapes the session restores the terminal before it propagates", async () => {
    const s = setup();
    const broken = {
      ...s.terminal,
      onKey: () => {
        throw new Error("onKey broke");
      }
    };
    const deps: OpenTuiDeps = { ...s.deps, createTerminal: () => broken };
    await expect(run(tui(), fakeProc([]), deps)).rejects.toThrow("onKey broke");
    expect(s.terminal.closes).toBe(1);
    expect(s.closedPorts).toEqual(["tty"]);
  });
});
