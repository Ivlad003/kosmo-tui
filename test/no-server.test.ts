/**
 * Data-only formats and no REPL/listening server (spec trace-programmable-access
 * «Data-only формати та відсутність REPL server», task 5b.5).
 *
 * Program-looking data must stay a literal: trace-text v1/v2 parsing and portable export
 * import never evaluate strings or pollute prototypes. The socket checks observe real
 * listen/bind calls (a preloaded spy in a spawned kosmo-tui plus in-process spies) and
 * actual OS sockets via lsof, rather than inferring from process.getActiveResourcesInfo().
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import dgram from "node:dgram";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseTraceText,
  parseTraceTextV2,
  renderTraceText,
  renderTraceTextV2,
  type TraceTextDocumentV1
} from "@kosmo-callflow/protocol";
import { importPortableExport } from "@kosmo-callflow/replay";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EXIT_OK, run } from "../src/cli.js";
import { spanDetailFromEvents } from "../src/detail.js";
import { buildEvalSnapshot, eventsFromExportRecords } from "../src/eval.js";
import { portableExport, removeDir, tempDir, writeExport, type RecordInput } from "./eval-fixtures.js";
import { fakeProc } from "./helpers.js";
import { v1Document, v2Document, v2Span } from "./review-helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const bin = path.join(root, "bin", "kosmo-tui.js");
const spy = path.join(here, "fixtures", "listen-spy.mjs");

const PROGRAMS = [
  "(() => process.exit(9))()",
  "(eval (process.exit 9))",
  'globalThis.__kosmoPwned = 1; require("child_process").execSync("touch pwned.txt")',
  "${process.exit(9)}",
  "#=(process.exit 9)"
];

function assertNothingRan(): void {
  expect((globalThis as { __kosmoPwned?: unknown }).__kosmoPwned).toBeUndefined();
  expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined();
  expect((Array.prototype as { polluted?: unknown }).polluted).toBeUndefined();
}

describe("v1/v2 trace-text stays data-only", () => {
  it("v2: program-looking strings round-trip as escaped literals in lisp and tab", () => {
    const doc = v2Document(
      PROGRAMS.map((program, index) =>
        v2Span({
          ref: { datasetId: "imported:shop", projectId: "shop", sessionId: "s1", traceId: "t1", spanId: `sp${index}` },
          display: program,
          node: `src/x.ts#${index}`,
          ret: { state: "recorded", reason: null, value: program }
        })
      )
    );
    for (const dialect of ["lisp", "tab"] as const) {
      const text = renderTraceTextV2(doc, { dialect });
      const parsed = parseTraceTextV2(text, { dialect });
      expect(parsed.ok, dialect).toBe(true);
      if (!parsed.ok) continue;
      const items = parsed.data.items as Array<{ display?: string; ret?: { value: string | null } }>;
      expect(items.map((item) => item.display)).toEqual(PROGRAMS);
      expect(items.map((item) => item.ret?.value)).toEqual(PROGRAMS);
    }
    // The Lisp text carries the program as a quoted string, not as a form.
    const lisp = renderTraceTextV2(doc, { dialect: "lisp" });
    expect(lisp).toContain(JSON.stringify("(eval (process.exit 9))"));
    assertNothingRan();
  });

  it("v1: an `(eval ...)` form where data belongs is rejected, not run", () => {
    const text = renderTraceText(v1Document(), { dialect: "lisp" });
    const injected = text.replace(':cursor "cursor:after-sp1"', ":cursor (eval (process.exit 9))");
    expect(injected).not.toBe(text);
    const parsed = parseTraceText(injected, { dialect: "lisp" });
    expect(parsed.ok).toBe(false);
    // As a string it is just data.
    const quoted = text.replace('"cursor:after-sp1"', JSON.stringify("(eval (process.exit 9))"));
    const ok = parseTraceText(quoted, { dialect: "lisp" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect((ok.data as TraceTextDocumentV1).cursor).toBe("(eval (process.exit 9))");
    assertNothingRan();
  });

  it("v2: prototype-pollution keys in a JSON document are inert", () => {
    const json = JSON.stringify(v2Document()).replace(
      '"truncated":false',
      '"truncated":false,"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}'
    );
    const ir: unknown = JSON.parse(json);
    expect(Object.prototype.hasOwnProperty.call(ir, "__proto__")).toBe(true);
    // Rendering the JSON IR back to Lisp either accepts or rejects the extra keys;
    // it never follows them into a prototype.
    let rendered: string | undefined;
    try {
      rendered = renderTraceTextV2(ir as ReturnType<typeof v2Document>, { dialect: "lisp" });
    } catch {
      rendered = undefined;
    }
    if (rendered !== undefined) expect(parseTraceTextV2(rendered, { dialect: "lisp" }).ok).toBe(true);
    assertNothingRan();
  });
});

describe("portable export import stays data-only", () => {
  const hostile: RecordInput[] = [
    {
      seq: 1,
      spanId: "a",
      parentSpanId: null,
      type: "enter",
      nodeId: PROGRAMS[0]!,
      payload: { args: [PROGRAMS[1], PROGRAMS[2]] }
    },
    { seq: 2, spanId: "a", parentSpanId: null, type: "exit", nodeId: PROGRAMS[0]!, payload: { ret: PROGRAMS[3] } }
  ];

  it("JS-looking strings, __proto__ and constructor keys never execute or pollute", () => {
    const raw = JSON.stringify(portableExport(hostile)).replace(
      '"payload":{"args"',
      '"payload":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"args"'
    );
    expect(raw).toContain('"__proto__"');
    const { dataset } = importPortableExport(JSON.parse(raw), { namespace: "export", maxBytes: 1 << 20 });
    const events = eventsFromExportRecords(dataset.records);
    const built = buildEvalSnapshot(events, {
      source: "export",
      datasetId: dataset.datasetId,
      projectId: dataset.projectId,
      traceId: null
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const [span] = built.snapshot.spans;
    expect(span!.nodeId).toBe(PROGRAMS[0]);
    expect(span!.values.args).toEqual({ state: "recorded", text: JSON.stringify([PROGRAMS[1], PROGRAMS[2]]) });
    expect(span!.values.ret).toEqual({ state: "recorded", text: PROGRAMS[3] });
    const detail = spanDetailFromEvents(events, span!.ref, null);
    expect(detail?.nodeId).toBe(PROGRAMS[0]);
    assertNothingRan();
  });

  it("opening the export with the eval subcommand runs only the explicit expression", async () => {
    const dir = await tempDir();
    try {
      const file = await writeExport(dir, portableExport(hostile));
      const proc = fakeProc(["eval", "trace.spans().map((s) => s.nodeId)", "--source", file], {
        stdoutTty: false,
        cwd: dir
      });
      expect(await run(proc)).toBe(EXIT_OK);
      expect(JSON.parse(proc.out).value).toEqual([PROGRAMS[0]]);
      assertNothingRan();
    } finally {
      await removeDir(dir);
    }
  });
});

type Calls = string[];

function spyOnListeners(calls: Calls): () => void {
  const spies = [
    vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (this: net.Server) {
      calls.push("net.Server.listen");
      return this;
    }),
    vi.spyOn(dgram.Socket.prototype, "bind").mockImplementation(function (this: dgram.Socket) {
      calls.push("dgram.Socket.bind");
      return this;
    }),
    vi.spyOn(http, "createServer").mockImplementation((() => {
      calls.push("http.createServer");
      return new net.Server() as unknown as http.Server;
    }) as never),
    vi.spyOn(https, "createServer").mockImplementation((() => {
      calls.push("https.createServer");
      return new net.Server() as unknown as https.Server;
    }) as never),
    vi.spyOn(net, "createServer").mockImplementation((() => {
      calls.push("net.createServer");
      return new net.Server();
    }) as never)
  ];
  return () => {
    for (const s of spies) s.mockRestore();
  };
}

describe("no listening server in-process", () => {
  let dir: string;
  let file: string;
  beforeAll(async () => {
    dir = await tempDir();
    file = await writeExport(dir);
  });
  afterAll(async () => {
    await removeDir(dir);
  });
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("the spies catch a listen when one happens (positive control)", () => {
    const calls: Calls = [];
    restore = spyOnListeners(calls);
    http.createServer().listen(0);
    expect(calls).toEqual(["http.createServer", "net.Server.listen"]);
  });

  it("help, version, target detection, --print and eval never create or bind a server", async () => {
    const calls: Calls = [];
    restore = spyOnListeners(calls);
    const argvs = [
      ["--help"],
      ["--version"],
      [file, "--print", "json"],
      [file, "--print", "lisp", "--trace", "t1"],
      ["eval", "trace.spans().length", "--source", file],
      ["eval", "while (true) {}", "--source", file],
      ["eval", "1", "--source", file, "--no-eval"]
    ];
    for (const argv of argvs) await run(fakeProc(argv, { stdoutTty: false, stdinTty: false, cwd: dir }));
    expect(calls).toEqual([]);
  });
});

const lsofAvailable =
  process.platform !== "win32" && spawnSync("lsof", ["-v"], { stdio: "ignore" }).error === undefined;
const distReady = existsSync(path.join(root, "dist", "cli.js")) && existsSync(path.join(root, "dist", "eval-child.js"));

/** Every listening TCP socket and every UDP socket the processes hold, per lsof. */
function osSockets(pids: number[]): string[] {
  if (pids.length === 0) return [];
  const list = pids.join(",");
  const lines: string[] = [];
  for (const args of [
    ["-nP", "-a", "-p", list, "-iTCP", "-sTCP:LISTEN"],
    ["-nP", "-a", "-p", list, "-iUDP"]
  ]) {
    try {
      lines.push(
        ...execFileSync("lsof", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
          .split("\n")
          .slice(1)
          .filter((line) => line.trim() !== "")
      );
    } catch (error) {
      // lsof exits 1 when nothing matches.
      if ((error as { status?: number }).status !== 1) throw error;
    }
  }
  return lines;
}

function childPids(pid: number): number[] {
  const result = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  return result.stdout
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

(lsofAvailable && distReady ? describe : describe.skip)("no listening socket at the OS level", () => {
  let dir: string;
  let file: string;
  beforeAll(async () => {
    dir = await tempDir();
    file = await writeExport(dir);
  });
  afterAll(async () => {
    await removeDir(dir);
  });

  it("lsof sees a real listener (positive control)", async () => {
    const server = spawn(
      process.execPath,
      ["-e", "require('node:net').createServer().listen(0, '127.0.0.1', () => console.log('up'))"],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    try {
      await new Promise<void>((resolve) => server.stdout.once("data", () => resolve()));
      expect(osSockets([server.pid!]).join("\n")).toMatch(/LISTEN/);
    } finally {
      server.kill("SIGKILL");
    }
  });

  it.each([
    ["eval (busy child, parent waits on the deadline)", ["eval", "while (true) {}", "--source", "<file>"]],
    ["--print", ["<file>", "--print", "json"]]
  ])(
    "a spawned kosmo-tui %s opens no listening/bound socket",
    async (_label, template) => {
      const spyOut = path.join(dir, `spy-${Date.now()}.log`);
      const argv = template.map((arg) => (arg === "<file>" ? file : arg));
      const kt = spawn(process.execPath, ["--import", spy, bin, ...argv], {
        cwd: dir,
        env: { PATH: process.env.PATH ?? "", KOSMO_TUI_LISTEN_SPY: spyOut },
        stdio: ["ignore", "pipe", "pipe"]
      });
      const exited = new Promise<number | null>((resolve) => kt.on("close", (code) => resolve(code)));
      let open = true;
      void exited.then(() => {
        open = false;
      });

      const seen: string[] = [];
      let samples = 0;
      let sawChild = false;
      while (open) {
        const pids = [kt.pid!, ...childPids(kt.pid!)];
        if (pids.length > 1) sawChild = true;
        seen.push(...osSockets(pids));
        samples += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await exited;

      expect(seen).toEqual([]);
      expect(samples).toBeGreaterThan(0);
      const log = readFileSync(spyOut, "utf8").trim().split("\n");
      expect(log[0]).toMatch(/^installed \d+$/);
      expect(log.slice(1)).toEqual([]);
      if (argv[0] === "eval") {
        // The eval child was alive while we sampled it too.
        expect(sawChild).toBe(true);
        expect(samples).toBeGreaterThan(5);
      }
    },
    20_000
  );
});
