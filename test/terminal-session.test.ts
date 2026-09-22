import { describe, expect, it } from "vitest";
import { EXIT_OK, EXIT_SIGINT, EXIT_SIGTERM, EXIT_SOURCE, run, type Invocation, type ViewerArgs } from "../src/cli.js";
import { ENTER_SEQUENCE, RESTORE_SEQUENCE, createTerminal, type Terminal } from "../src/terminal.js";
import { runTerminalSession, type SessionOptions } from "../src/terminal-session.js";
import { fakeProc } from "./helpers.js";
import { fakeTerminalIo, type FakeTerminalIo } from "./terminal-fakes.js";

const FRAME_ROW1 = "\u001b[1;1H\u001b[2Kviewer";

function setup(overrides: Partial<SessionOptions> = {}, size: { cols?: number; rows?: number } = {}) {
  const io = fakeTerminalIo(size);
  const real = createTerminal(io.input, io.output);
  let closes = 0;
  const terminal: Terminal = {
    ...real,
    close() {
      closes += 1;
      real.close();
    }
  };
  const stderr = { write: (chunk: string) => io.log.push(`err:${chunk}`) };
  const session = runTerminalSession({ terminal, render: () => ["viewer"], stderr, ...overrides });
  return { io, session, closes: () => closes };
}

/** Exactly: raw on, enter, first frame, ...extra, raw off, restore, then any stderr. */
function expectCleanLifecycle(io: FakeTerminalIo, closes: number, tail: string[] = []) {
  expect(closes).toBe(1);
  expect(io.rawModeCalls).toEqual([true, false]);
  expect(io.log).toEqual([
    "raw:true",
    `out:${ENTER_SEQUENCE}`,
    `out:${FRAME_ROW1}`,
    "raw:false",
    `out:${RESTORE_SEQUENCE}`,
    ...tail
  ]);
  expect(io.dataListeners).toHaveLength(0);
  expect(io.resizeListeners).toHaveLength(0);
}

describe("terminal session lifecycle", () => {
  it("q exits 0 and restores once", async () => {
    const s = setup();
    s.io.key("q");
    s.io.key("q");
    expect(await s.session).toBe(EXIT_OK);
    expectCleanLifecycle(s.io, s.closes());
  });

  it("Ctrl+C in raw mode exits 130 and restores once", async () => {
    const s = setup();
    s.io.key("\u0003");
    expect(await s.session).toBe(EXIT_SIGINT);
    expectCleanLifecycle(s.io, s.closes());
  });

  it("SIGINT abort exits 130 and SIGTERM abort exits 143, each restoring once", async () => {
    for (const [reason, code] of [
      ["SIGINT", EXIT_SIGINT],
      ["SIGTERM", EXIT_SIGTERM]
    ] as const) {
      const controller = new AbortController();
      const s = setup({ signal: controller.signal });
      controller.abort(reason);
      expect(await s.session).toBe(code);
      expectCleanLifecycle(s.io, s.closes());
    }
  });

  it("render failure exits 2, restores once, then writes a bounded one-line error", async () => {
    let calls = 0;
    const s = setup({
      render: () => {
        calls += 1;
        if (calls > 1) throw new Error(`boom\n${"x".repeat(5_000)}`);
        return ["viewer"];
      }
    });
    s.io.key("j");
    expect(await s.session).toBe(EXIT_SOURCE);
    const err = s.io.log.at(-1)!;
    expect(err.startsWith("err:kosmo-tui: render failed: boom x")).toBe(true);
    expect(err.split("\n")).toHaveLength(2);
    expect(err.length).toBeLessThan(2_100);
    expectCleanLifecycle(s.io, s.closes(), [err]);
  });

  it("render failure on the very first frame still restores once", async () => {
    const s = setup({
      render: () => {
        throw new Error("first");
      }
    });
    expect(await s.session).toBe(EXIT_SOURCE);
    expect(s.closes()).toBe(1);
    expect(s.io.log).toEqual([
      "raw:true",
      `out:${ENTER_SEQUENCE}`,
      "raw:false",
      `out:${RESTORE_SEQUENCE}`,
      "err:kosmo-tui: render failed: first\n"
    ]);
  });

  it("source failure exits 2, restores once, error after restore", async () => {
    const s = setup({ source: Promise.reject(new Error("daemon went away")) });
    expect(await s.session).toBe(EXIT_SOURCE);
    expectCleanLifecycle(s.io, s.closes(), ["err:kosmo-tui: source failed: daemon went away\n"]);
  });

  it("a finished source (EOF) keeps the session and keyboard alive", async () => {
    let rows = ["loading"];
    const s = setup({ source: Promise.resolve().then(() => (rows = ["viewer"])), render: () => rows });
    await new Promise((resolve) => setImmediate(resolve));
    s.io.key("q");
    expect(await s.session).toBe(EXIT_OK);
    expect(s.io.writes).toContain(FRAME_ROW1);
    expect(s.closes()).toBe(1);
  });

  it("below 40x10 shows 'terminal too small' without calling render, and redraws after growing", async () => {
    let renders = 0;
    const s = setup(
      {
        render: () => {
          renders += 1;
          return ["viewer"];
        }
      },
      { cols: 30, rows: 8 }
    );
    expect(renders).toBe(0);
    expect(s.io.writes.join("")).toContain("terminal too small");
    s.io.output.columns = 80;
    s.io.output.rows = 24;
    s.io.resize();
    expect(renders).toBe(1);
    expect(s.io.writes.at(-1)).toContain("viewer");
    s.io.key("q");
    expect(await s.session).toBe(EXIT_OK);
    expect(s.closes()).toBe(1);
  });

  it("an already-aborted signal still closes exactly once", async () => {
    const controller = new AbortController();
    controller.abort("SIGTERM");
    const s = setup({ signal: controller.signal });
    expect(await s.session).toBe(EXIT_SIGTERM);
    expect(s.closes()).toBe(1);
    expect(s.io.writes.filter((w) => w === RESTORE_SEQUENCE)).toHaveLength(1);
  });
});

describe("run() signal wiring into the session", () => {
  it("SIGTERM from the process exits 143 with the terminal restored once", async () => {
    const io = fakeTerminalIo();
    const proc = fakeProc(["-"], { stdinTty: false });
    let started: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => (started = resolve));
    const pending = run(proc, {
      terminalInputAvailable: () => true,
      openViewer: async (invocation: Invocation<ViewerArgs>) => {
        const terminal = createTerminal(io.input, io.output);
        const session = runTerminalSession({
          terminal,
          render: () => ["viewer"],
          signal: invocation.signal,
          stderr: proc.stderr
        });
        started();
        return session;
      }
    });
    await ready;
    proc.emit("SIGTERM");
    expect(await pending).toBe(EXIT_SIGTERM);
    expect(io.rawModeCalls).toEqual([true, false]);
    expect(io.writes).toEqual([ENTER_SEQUENCE, FRAME_ROW1, RESTORE_SEQUENCE]);
    expect(proc.listeners.get("SIGTERM")?.size ?? 0).toBe(0);
  });
});
