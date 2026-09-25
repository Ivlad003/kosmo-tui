/**
 * Task 22: the TUI event loop over fake ports (spec 5.4, 6.1–6.8, 12, 13.4; review focus 5).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildTraceModel, type TraceModel } from "../../src/format/model.js";
import { validateDocument } from "../../src/format/validate.js";
import { renderKosmoText } from "../../src/output/kosmo-text.js";
import { EXIT_OK, EXIT_SIGHUP, EXIT_SIGINT, EXIT_SIGTERM, EXIT_SOURCE, EXIT_USAGE } from "../../src/proc.js";
import { nodeReaderFs } from "../../src/readers/node-fs.js";
import { openTarget } from "../../src/readers/open.js";
import { loadSqliteModule } from "../../src/readers/sqlite-loader.js";
import type { OpenResult, OpenedDataset, TraceListPage } from "../../src/readers/types.js";
import { SESSION_REFRESH_MS, runSession, splitKeys } from "../../src/ui/session.js";
import { RECIPES, fixtureFile } from "../fixture-recipes.js";
import { chunks, memoryFs, neverEnding } from "../readers/reader-fakes.js";
import { dataset, recorded } from "../trace-builder.js";
import { NODE_SQLITE_AVAILABLE, cleanupTempDirs, tempDir, toNdjsonLines, writeSqlite } from "../trace-writers.js";
import {
  fakeClipboard,
  fakeTerminal,
  memoryRootFs,
  memorySnippetFs,
  memoryStartFs,
  sessionDeps,
  until
} from "./session-fakes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASIC = readFileSync(fixtureFile("kosmo-trace/basic"), "utf8");
const CART = readFileSync(path.join(here, "../fixtures/project/src/cart.ts"), "utf8");
const TRACE_FILE = "/w/basic.kosmo-trace.json";
const NDJSON = toNdjsonLines(RECIPES["kosmo-trace/basic"]!()).map((line) => `${line}\n`);

describe("splitKeys", () => {
  it("keeps escape sequences whole and splits everything else per key", () => {
    expect(splitKeys("jjk")).toEqual(["j", "j", "k"]);
    expect(splitKeys("\u001b[Bq")).toEqual(["\u001b[B", "q"]);
    expect(splitKeys("\u001b[6~\u001bOA")).toEqual(["\u001b[6~", "\u001bOA"]);
    expect(splitKeys("\u001bq")).toEqual(["\u001b", "q"]);
    expect(splitKeys("\r\n")).toEqual(["\r"]);
    expect(splitKeys("д😀")).toEqual(["д", "😀"]);
  });
});

describe("start screen (spec 6.1)", () => {
  it("lists found and recent traces without opening any of them", async () => {
    const terminal = fakeTerminal();
    const startFs = memoryStartFs({
      "/w/traces/a.kosmo-trace.json": { text: "{}", mtimeMs: 10 },
      "/home/me/.config/kosmo-tui/recent.json": {
        text: JSON.stringify([{ path: "/gone/crash.kosmo-trace.ndjson", openedAt: "2026-09-24T10:00:00.000Z" }]),
        mtimeMs: 1
      }
    });
    const session = runSession(sessionDeps(terminal, { startFs }));
    await until(() => terminal.screen().includes("Recent"), "start rows");
    expect(terminal.screen()).toContain(" Found in ./ (depth 2)");
    expect(terminal.screen()).toContain("traces/a.kosmo-trace.json");
    expect(terminal.screen()).toContain("file-not-found");
    expect(startFs.calls.filter((call) => call.startsWith("readFile")).map((call) => call.slice(9))).toEqual([
      "/home/me/.config/kosmo-tui/recent.json"
    ]);
    terminal.key("q");
    expect(await session).toBe(EXIT_OK);
    expect(terminal.closes).toBe(1);
  });

  it("an open error of a file chosen there is a banner, and the user stays (spec 5.4)", async () => {
    const terminal = fakeTerminal();
    const startFs = memoryStartFs({ "/w/bad.kosmo-trace.json": { text: "{}", mtimeMs: 1 } });
    const deps = sessionDeps(terminal, {
      startFs,
      reader: { fs: memoryFs({ "bad.kosmo-trace.json": '{"format":"other","version":1}' }) }
    });
    const session = runSession(deps);
    await until(() => terminal.screen().includes("bad.kosmo-trace.json"), "start row");
    terminal.key("\r");
    await until(() => terminal.screen().includes("! not-a-kosmo-trace"), "error banner");
    expect(terminal.screen()).toContain(" Found in ./ (depth 2)");
    terminal.key("q");
    expect(await session).toBe(EXIT_OK);
    expect(deps.stderrText()).toBe("");
  });
});

describe("the argv target", () => {
  it("one trace opens the trace screen at once, with the code of the selected span from the root", async () => {
    const terminal = fakeTerminal();
    const deps = sessionDeps(terminal, {
      origin: { path: TRACE_FILE },
      reader: { fs: memoryFs({ [TRACE_FILE]: BASIC }) },
      rootFs: memoryRootFs({ files: ["/w/package.json"] }),
      snippetFs: memorySnippetFs({ "/w/src/cart.ts": CART })
    });
    const session = runSession(deps);
    await until(() => terminal.screen().includes("GET /cart · 4 spans · errored"), "trace screen");
    // Down twice: sp_1 → sp_2 → sp_3 (calculateLineTotal, src/cart.ts:12).
    terminal.key("jj");
    await until(() => terminal.screen().includes("│▶ 12  export async function calculateLineTotal"), "snippet");
    terminal.key("q");
    expect(await session).toBe(EXIT_OK);
  });

  it("records recent.json, but -r writes nothing", async () => {
    for (const readOnly of [false, true]) {
      const terminal = fakeTerminal();
      const startFs = memoryStartFs();
      const deps = sessionDeps(terminal, {
        origin: { path: TRACE_FILE },
        reader: { fs: memoryFs({ [TRACE_FILE]: BASIC }) },
        startFs,
        readOnly,
        tmpToken: "t1"
      });
      const session = runSession(deps);
      await until(() => terminal.screen().includes("4 spans"), "trace screen");
      terminal.key("q");
      await session;
      const writes = startFs.calls.filter((call) => /^(mkdir|writeFile|rename)/.test(call));
      expect(writes, `readOnly=${readOnly}`).toEqual(
        readOnly
          ? []
          : [
              "mkdir /home/me/.config/kosmo-tui",
              "writeFile /home/me/.config/kosmo-tui/recent.json.t1.tmp",
              "rename /home/me/.config/kosmo-tui/recent.json.t1.tmp -> /home/me/.config/kosmo-tui/recent.json"
            ]
      );
    }
  });

  it("an open error ends the session: 1 for a missing path, 2 for a format error; terminal first, then stderr", async () => {
    const cases: Array<[string, string | null, number, string]> = [
      ["/w/nope.json", null, EXIT_USAGE, "kosmo-tui: file-not-found: /w/nope.json\n"],
      ["/w/x.json", '{"format":"kosmo-trace","version":2,"dataset":{"id":"d"},"spans":[]}', EXIT_SOURCE, ""]
    ];
    for (const [file, text, code, message] of cases) {
      const terminal = fakeTerminal();
      const deps = sessionDeps(terminal, {
        origin: { path: file },
        reader: { fs: memoryFs(text === null ? {} : { [file]: text }) }
      });
      expect(await runSession(deps)).toBe(code);
      if (message !== "") expect(deps.stderrText()).toBe(message);
      else expect(deps.stderrText()).toMatch(/^kosmo-tui: unsupported-version\(/);
      expect(terminal.closes).toBe(1);
      expect(terminal.log[0]).toBe("terminal:close");
      expect(terminal.log.at(-1)).toMatch(/^stderr:kosmo-tui: /);
    }
  });

  it("a reader message quoting the input is escaped before it reaches stderr", async () => {
    const terminal = fakeTerminal();
    const file = "/w/evil\u001b[2J.json";
    const deps = sessionDeps(terminal, { origin: { path: file }, reader: { fs: memoryFs() } });
    expect(await runSession(deps)).toBe(EXIT_USAGE);
    expect(deps.stderrText()).toBe("kosmo-tui: file-not-found: /w/evil\\u001b[2J.json\n");
  });
});

describe("stdin (spec 4.5, 6.8; review focus 5)", () => {
  it("a stream that never ends shows reading… N spans, and q still quits and releases stdin", async () => {
    const terminal = fakeTerminal();
    const stdin = neverEnding(NDJSON.slice(0, 4));
    const deps = sessionDeps(terminal, { origin: "stdin", reader: { fs: memoryFs(), stdin } });
    const session = runSession(deps);
    expect(terminal.screen()).toContain(" reading… 0 spans");
    await until(() => {
      deps.timers.runAll();
      return terminal.screen().includes(" reading… 2 spans");
    }, "progress");
    terminal.key("q");
    expect(await session).toBe(EXIT_OK);
    expect(stdin.returned).toBe(true);
    expect(terminal.closes).toBe(1);
  });

  it("Ctrl+C while reading exits 130", async () => {
    const terminal = fakeTerminal();
    const stdin = neverEnding(NDJSON.slice(0, 1));
    const session = runSession(sessionDeps(terminal, { origin: "stdin", reader: { fs: memoryFs(), stdin } }));
    terminal.key("\u0003");
    expect(await session).toBe(EXIT_SIGINT);
    expect(stdin.returned).toBe(true);
  });

  it("progress repaints are coalesced to the refresh cadence (≤ 250 ms)", async () => {
    expect(SESSION_REFRESH_MS).toBe(250);
    const terminal = fakeTerminal();
    const stdin = neverEnding(NDJSON.slice(0, 5));
    const deps = sessionDeps(terminal, { origin: "stdin", reader: { fs: memoryFs(), stdin } });
    const session = runSession(deps);
    await until(() => deps.timers.pending > 0, "progress timer");
    const before = terminal.frames.length;
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    // Five chunks were read, but only one repaint is pending.
    expect(deps.timers.pending).toBe(1);
    expect(terminal.frames.length).toBe(before);
    deps.timers.runAll();
    expect(terminal.frames.length).toBe(before + 1);
    terminal.key("q");
    await session;
  });

  it("a finite stream opens; r answers reload: unavailable(stdin-stream)", async () => {
    const terminal = fakeTerminal();
    const deps = sessionDeps(terminal, { origin: "stdin", reader: { fs: memoryFs(), stdin: chunks(NDJSON) } });
    const session = runSession(deps);
    await until(() => terminal.screen().includes("GET /cart · 4 spans"), "trace screen");
    expect(terminal.screen()).not.toContain("r reload");
    terminal.key("r");
    expect(terminal.screen()).toContain("! reload: unavailable(stdin-stream)");
    terminal.key("q");
    expect(await session).toBe(EXIT_OK);
  });

  it("a stream stopped by a bad line keeps what was read and says where (spec 4.5)", async () => {
    const terminal = fakeTerminal();
    const stdin = chunks([...NDJSON.slice(0, 3), "{oops\n"]);
    const session = runSession(sessionDeps(terminal, { origin: "stdin", reader: { fs: memoryFs(), stdin } }));
    await until(() => terminal.screen().includes("1 spans"), "partial trace");
    expect(terminal.screen()).toMatch(/stream stopped at line 4: /);
    terminal.key("q");
    expect(await session).toBe(EXIT_OK);
  });
});

describe("reload, root and copy", () => {
  it("r re-reads a file and keeps the open trace and the selected span", async () => {
    const terminal = fakeTerminal();
    const fs = memoryFs({ [TRACE_FILE]: BASIC });
    const session = runSession(sessionDeps(terminal, { origin: { path: TRACE_FILE }, reader: { fs } }));
    await until(() => terminal.screen().includes("GET /cart · 4 spans"), "trace screen");
    terminal.key("j");
    expect(terminal.screen()).toMatch(/▸ .*loadCart/);
    fs.files.set(TRACE_FILE, new TextEncoder().encode(BASIC.replace('"name":"GET /cart"}', '"name":"GET /basket"}')));
    terminal.key("r");
    await until(() => terminal.screen().includes("GET /basket · 4 spans"), "reloaded trace");
    expect(terminal.screen()).toMatch(/▸ .*loadCart/);
    terminal.key("q");
    expect(await session).toBe(EXIT_OK);
  });

  it(":root <dir> checks the directory and re-reads the snippet from there", async () => {
    const terminal = fakeTerminal();
    const other = CART.replace(
      "export async function calculateLineTotal",
      "export async function   calculateLineTotal"
    );
    const deps = sessionDeps(terminal, {
      origin: { path: TRACE_FILE },
      reader: { fs: memoryFs({ [TRACE_FILE]: BASIC }) },
      rootFs: memoryRootFs({ dirs: ["/other"], files: ["/w/package.json"] }),
      snippetFs: memorySnippetFs({ "/w/src/cart.ts": CART, "/other/src/cart.ts": other })
    });
    const roots: string[] = [];
    const session = runSession({ ...deps, onRootChange: (root) => roots.push(root) });
    await until(() => terminal.screen().includes("4 spans"), "trace screen");
    terminal.key("jj");
    await until(() => terminal.screen().includes("│▶ 12  export async function calculateLineTotal"), "snippet");
    for (const key of [":", ..."root /nowhere", "\r"]) terminal.key(key);
    await until(() => terminal.screen().includes("! root: not a directory: /nowhere"), "refusal");
    for (const key of [":", ..."root /other", "\r"]) terminal.key(key);
    await until(() => terminal.screen().includes("function   calculateLineTotal"), "snippet from /other");
    expect(roots).toEqual(["/w", "/other"]);
    terminal.key("q");
    expect(await session).toBe(EXIT_OK);
  });

  it("y copies kosmo-text/v1 of the selected subtree; without a clipboard it is printed after the terminal is restored", async () => {
    const terminal = fakeTerminal();
    const clipboard = fakeClipboard(
      { copied: false, reason: "no clipboard adapter for this platform/display" },
      terminal.log
    );
    const session = runSession(
      sessionDeps(terminal, {
        origin: { path: TRACE_FILE },
        reader: { fs: memoryFs({ [TRACE_FILE]: BASIC }) },
        clipboard
      })
    );
    await until(() => terminal.screen().includes("4 spans"), "trace screen");
    terminal.key("jjy");
    await until(() => clipboard.queued.length === 1, "fallback");
    const parsed = validateDocument(JSON.parse(BASIC));
    if (!parsed.ok) throw new Error("fixture");
    const model = buildTraceModel({ id: "t_cart", name: "GET /cart" }, parsed.acc.spansOf("t_cart"), []);
    const expected = renderKosmoText(model, {
      detail: 0,
      values: () => undefined,
      subtree: { trace: "t_cart", session: "s1", id: "sp_3" }
    });
    expect(clipboard.copied).toEqual([expected]);
    expect(clipboard.queued).toEqual([expected]);
    expect(terminal.screen()).toContain("copy: no clipboard adapter for this platform/display");
    terminal.key("q");
    await session;
    expect(terminal.log.slice(-2)).toEqual(["terminal:close", "fallback:flush 1"]);
  });
});

describe("lifecycle (spec 13.2: terminal restored on every way out)", () => {
  it("SIGINT, SIGTERM and SIGHUP end with 130, 143 and 129, restoring once", async () => {
    for (const [reason, code] of [
      ["SIGINT", EXIT_SIGINT],
      ["SIGTERM", EXIT_SIGTERM],
      ["SIGHUP", EXIT_SIGHUP]
    ] as const) {
      const terminal = fakeTerminal();
      const controller = new AbortController();
      const session = runSession(sessionDeps(terminal, { signal: controller.signal }));
      controller.abort(reason);
      expect(await session, reason).toBe(code);
      expect(terminal.closes).toBe(1);
    }
  });

  it("an already aborted signal still closes exactly once", async () => {
    const terminal = fakeTerminal();
    const controller = new AbortController();
    controller.abort("SIGTERM");
    expect(await runSession(sessionDeps(terminal, { signal: controller.signal }))).toBe(EXIT_SIGTERM);
    expect(terminal.closes).toBe(1);
  });

  it("a render failure restores the terminal once, then writes one bounded line to stderr, exit 2", async () => {
    const terminal = fakeTerminal({ cols: 80, rows: 24 }, 2);
    const deps = sessionDeps(terminal);
    const session = runSession(deps);
    terminal.key("j");
    expect(await session).toBe(EXIT_SOURCE);
    expect(deps.stderrText()).toBe("kosmo-tui: render failed: boom second line\n");
    expect(terminal.log).toEqual([
      "terminal:close",
      "fallback:flush 0",
      "stderr:kosmo-tui: render failed: boom second line\n"
    ]);
  });

  it("a throw inside update or an effect restores the terminal once, then one line to stderr, exit 2", async () => {
    // A buggy model stands in for any internal error: spec 13.2 wants the terminal back on an uncaught error.
    for (const armedAtStart of [true, false]) {
      let armed = armedAtStart;
      const explosive = (model: TraceModel): TraceModel =>
        new Proxy(model, {
          get(target, key) {
            const value: unknown = Reflect.get(target, key);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              if (armed) throw new Error("model bug");
              return (value as (...inner: unknown[]) => unknown).apply(target, args);
            };
          }
        });
      const terminal = fakeTerminal();
      const deps = sessionDeps(terminal, {
        origin: { path: TRACE_FILE },
        reader: { fs: memoryFs({ [TRACE_FILE]: BASIC }) },
        open: async (origin, reader, signal) => {
          const result = await openTarget(origin, reader, signal);
          if (!result.ok) return result;
          const opened = result.dataset;
          const loadTrace: typeof opened.loadTrace = async (id, loadSignal) => {
            const loaded = await opened.loadTrace(id, loadSignal);
            return loaded.ok ? { ok: true, model: explosive(loaded.model) } : loaded;
          };
          return { ok: true, dataset: { ...opened, loadTrace } };
        }
      });
      const session = runSession(deps);
      if (!armedAtStart) {
        await until(() => terminal.screen().includes("GET /cart · 4 spans"), "trace screen");
        armed = true;
        // `j` walks the model's rows inside update, so the throw happens in the key handler.
        terminal.key("j");
      }
      // Armed at start, the throw happens in the loadTrace effect (a detached promise).
      expect(await session, `armed at start: ${armedAtStart}`).toBe(EXIT_SOURCE);
      expect(deps.stderrText()).toBe("kosmo-tui: session failed: model bug\n");
      expect(terminal.closes).toBe(1);
      expect(terminal.log[0]).toBe("terminal:close");
    }
  });

  it("a resize repaints; below 40x10 the frame is 'terminal too small'", async () => {
    const terminal = fakeTerminal();
    const session = runSession(sessionDeps(terminal));
    terminal.resize({ cols: 30, rows: 8 });
    expect(terminal.screen()).toContain("terminal too small");
    terminal.resize({ cols: 80, rows: 24 });
    expect(terminal.screen()).toContain("kosmo-tui");
    terminal.key("q");
    expect(await session).toBe(EXIT_OK);
  });

  it("an answer for a replaced open is dropped and its dataset closed", async () => {
    const terminal = fakeTerminal();
    let release: (result: OpenResult) => void = () => undefined;
    const closed: string[] = [];
    const slow = new Promise<OpenResult>((resolve) => (release = resolve));
    const startFs = memoryStartFs({
      "/w/a.kosmo-trace.json": { text: "{}", mtimeMs: 2 },
      "/w/b.kosmo-trace.json": { text: "{}", mtimeMs: 1 }
    });
    const fs = memoryFs({ "b.kosmo-trace.json": BASIC });
    const deps = sessionDeps(terminal, {
      startFs,
      reader: { fs },
      open: (origin, reader, signal) => {
        if (origin !== "stdin" && origin.path === "a.kosmo-trace.json") return slow;
        return openTarget(origin, reader, signal);
      }
    });
    const session = runSession(deps);
    await until(() => terminal.screen().includes("b.kosmo-trace.json"), "start rows");
    terminal.key("\r");
    terminal.key("j\r");
    await until(() => terminal.screen().includes("GET /cart · 4 spans"), "b opened");
    const late = await openTarget({ path: "b.kosmo-trace.json" }, { fs }, new AbortController().signal);
    if (!late.ok) throw new Error("fixture");
    release({ ok: true, dataset: { ...late.dataset, close: async () => void closed.push("a") } });
    await until(() => closed.length === 1, "late dataset closed");
    expect(terminal.screen()).toContain("GET /cart · 4 spans");
    terminal.key("q");
    expect(await session).toBe(EXIT_OK);
  });

  it("Esc back to the start screen drops a late traceLoaded and stays there (spec 6.2)", async () => {
    const terminal = fakeTerminal();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const startFs = memoryStartFs({
      "/w/basic.kosmo-trace.json": { text: "{}", mtimeMs: 1 }
    });
    const deps = sessionDeps(terminal, {
      startFs,
      reader: { fs: memoryFs({ "basic.kosmo-trace.json": BASIC }) },
      open: async (origin, reader, signal) => {
        const result = await openTarget(origin, reader, signal);
        if (!result.ok) return result;
        const opened = result.dataset;
        const loadTrace: typeof opened.loadTrace = async (id, loadSignal) => {
          await gate;
          return opened.loadTrace(id, loadSignal);
        };
        return { ok: true, dataset: { ...opened, loadTrace } };
      }
    });
    const session = runSession(deps);
    await until(() => terminal.screen().includes("basic.kosmo-trace.json"), "start row");
    terminal.key("\r");
    await until(() => terminal.screen().includes("loading trace"), "trace loading");
    terminal.key("\u001b");
    expect(terminal.screen()).toContain(" Found in ./ (depth 2)");
    expect(terminal.screen()).not.toContain("4 spans");
    release();
    for (let turn = 0; turn < 30; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(terminal.screen()).toContain(" Found in ./ (depth 2)");
    expect(terminal.screen()).not.toContain("4 spans");
    terminal.key("q");
    expect(await session).toBe(EXIT_OK);
  });

  /** Start rows a (first) and b; each opens BASIC as a paged list, so Enter stays on the trace list. */
  function pagedStart(
    terminal: ReturnType<typeof fakeTerminal>,
    wrap: (name: string, dataset: OpenedDataset) => OpenedDataset
  ): ReturnType<typeof sessionDeps> {
    const startFs = memoryStartFs({
      "/w/a.kosmo-trace.json": { text: "{}", mtimeMs: 2 },
      "/w/b.kosmo-trace.json": { text: "{}", mtimeMs: 1 }
    });
    const fs = memoryFs({ "a.kosmo-trace.json": BASIC, "b.kosmo-trace.json": BASIC });
    return sessionDeps(terminal, {
      startFs,
      reader: { fs },
      open: async (origin, reader, signal) => {
        const result = await openTarget(origin, reader, signal);
        if (!result.ok || origin === "stdin") return result;
        const paged = { ...result.dataset, traces: { ...result.dataset.traces, hasMore: true } };
        return { ok: true, dataset: wrap(origin.path, paged) };
      }
    });
  }

  it("close() waits for the close of a dataset abandoned with Esc, after the terminal and the fallback", async () => {
    const terminal = fakeTerminal();
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    let closeCalls = 0;
    const deps = pagedStart(terminal, (_name, opened) => ({
      ...opened,
      close: async () => {
        closeCalls += 1;
        await slow;
        terminal.log.push("dataset:closed");
      }
    }));
    const session = runSession(deps);
    await until(() => terminal.screen().includes("b.kosmo-trace.json"), "start rows");
    terminal.key("\r");
    await until(() => terminal.screen().includes("GET /cart"), "trace list");
    terminal.key("\u001b");
    expect(terminal.screen()).toContain(" Found in ./ (depth 2)");
    expect(closeCalls).toBe(1);
    let settled = false;
    void session.then(() => (settled = true));
    terminal.key("q");
    for (let turn = 0; turn < 30; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(terminal.closes).toBe(1);
    release();
    expect(await session).toBe(EXIT_OK);
    expect(closeCalls).toBe(1);
    expect(terminal.log.slice(-3)).toEqual(["terminal:close", "fallback:flush 0", "dataset:closed"]);
  });

  it("a page load in flight when Esc abandons the dataset does not block > on the next one", async () => {
    const terminal = fakeTerminal();
    const asked: string[] = [];
    const deps = pagedStart(terminal, (name, opened) => ({
      ...opened,
      loadMoreTraces: (): Promise<TraceListPage> => {
        asked.push(name);
        // a never answers; b answers with an empty last page.
        return name === "a.kosmo-trace.json"
          ? new Promise(() => undefined)
          : Promise.resolve({ items: [], hasMore: false });
      }
    }));
    const session = runSession(deps);
    await until(() => terminal.screen().includes("b.kosmo-trace.json"), "start rows");
    terminal.key("\r");
    await until(() => terminal.screen().includes("GET /cart"), "a listed");
    terminal.key(">");
    await until(() => asked.length === 1, "a asked for a page");
    terminal.key("\u001b");
    terminal.key("j\r");
    await until(() => terminal.screen().includes("GET /cart"), "b listed");
    terminal.key(">");
    await until(() => asked.length === 2, "b asked for a page");
    expect(asked).toEqual(["a.kosmo-trace.json", "b.kosmo-trace.json"]);
    terminal.key("q");
    expect(await session).toBe(EXIT_OK);
  });
});

describe.skipIf(!NODE_SQLITE_AVAILABLE)("SQLite (spec 4.6): pages of traces and lazy values", () => {
  afterAll(() => cleanupTempDirs());

  it("> loads the next page; selecting a span reads its values once", async () => {
    const builder = dataset("ds_many");
    for (let index = 0; index < 205; index += 1) {
      builder.trace(`t${String(index).padStart(3, "0")}`, `GET /item/${index}`);
      builder.span("r", "handler", { args: recorded([index]) });
    }
    const file = path.join(tempDir(), "many.kosmo-trace.sqlite");
    writeSqlite(file, builder.build());
    const terminal = fakeTerminal();
    const deps = sessionDeps(terminal, {
      origin: { path: file },
      reader: { fs: nodeReaderFs, loadSqlite: () => loadSqliteModule() }
    });
    const session = runSession(deps);
    await until(() => terminal.screen().includes("200+ traces"), "first page");
    terminal.key(">");
    await until(() => terminal.screen().includes("205 traces"), "second page");
    terminal.key("\r");
    await until(() => terminal.screen().includes("args    [0]"), "lazy values");
    terminal.key("q");
    expect(await session).toBe(EXIT_OK);
  });
});
