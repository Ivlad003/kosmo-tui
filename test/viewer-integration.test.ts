/**
 * The composition root's interactive wiring (open-viewer.ts + session.ts): review keys
 * f/t/R write through the real review session with the SAME snapshot evidence `y`
 * copies; `:` lines run in the session with the shared graph selectors of
 * `@kosmo-callflow/query/graph` for offline sources (5b.1); `:js` evaluates over the pinned
 * offline snapshot; source completeness shows in the header; and `openViewerSession`
 * restores the terminal once on q, Ctrl+C, SIGTERM and source failure.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { headerFrame, traceFrame, type ConnectSnapshotInput } from "@kosmo-callflow/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgv, type Invocation, type ViewerArgs } from "../src/cli.js";
import { localGraphSelectors } from "../src/commands.js";
import { commandDepsFor, evalSnapshotFor, openViewerSession, sourceLabel } from "../src/open-viewer.js";
import { renderFrame } from "../src/render.js";
import { openReviewSession, parseReview, resolveReviewCapability } from "../src/review.js";
import { createSession, type SessionOptions, type SessionTimers } from "../src/session.js";
import { createExportSource } from "../src/source-export.js";
import { createSqliteSource } from "../src/source-sqlite.js";
import { createStreamSource, type StreamInput } from "../src/source-stream.js";
import type { SourceOpenResult, TraceSource } from "../src/source.js";
import { ENTER_SEQUENCE, RESTORE_SEQUENCE, createTerminal } from "../src/terminal.js";
import { fakeProc } from "./helpers.js";
import { removeDir, tempDir } from "./review-helpers.js";
import { portableExport } from "./source-fixtures.js";
import { fakeTerminalIo } from "./terminal-fakes.js";

const frozen: SessionTimers = { setTimeout: () => ({}), clearTimeout: () => undefined };
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

let root: string;
let exportPath: string;
beforeEach(async () => {
  root = await tempDir();
  await mkdir(path.join(root, ".kosmo-callflow"), { recursive: true });
  await writeFile(path.join(root, ".kosmo-callflow", "project.json"), JSON.stringify({ projectId: "p" }));
  exportPath = path.join(root, "trace.json");
  await writeFile(exportPath, JSON.stringify(portableExport()));
});
afterEach(async () => {
  await removeDir(root);
});

function reviewFactory(options: { readOnly?: boolean; projectRoot?: string | null } = {}) {
  return async (opened: SourceOpenResult) =>
    openReviewSession({
      capability: await resolveReviewCapability({
        readOnly: options.readOnly ?? false,
        oneShot: false,
        ...(options.projectRoot === null ? {} : { projectRoot: options.projectRoot ?? root }),
        cwd: root
      }),
      sourceRef: {
        projectId: opened.snapshot.projectId,
        datasetId: opened.snapshot.datasetId,
        sourceRevision: opened.snapshot.revision
      },
      sourceLabel: "export:trace.json",
      dialect: "lisp",
      traceTextVersion: 2
    });
}

async function exportSession(
  extra: Partial<SessionOptions> = {},
  source: TraceSource = createExportSource({ path: exportPath })
) {
  const session = createSession({
    source,
    timers: frozen,
    commands: commandDepsFor(source),
    evalSnapshot: evalSnapshotFor(source),
    ...extra
  });
  await session.start();
  await settle();
  return session;
}

async function reviewFiles(): Promise<string[]> {
  const dir = path.join(root, ".kosmo-callflow", "reviews");
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((name) => name.endsWith(".md"));
}

describe("offline span rows", () => {
  it("an export session shows its spans from the canonical v2 page, with full refs and parents", async () => {
    const session = await exportSession();
    const spans = session.state().spans;
    expect(spans.map((row) => [row.spanId, row.parentSpanId, row.depth, row.errored])).toEqual([
      ["sp-1", null, 0, false],
      ["sp-2", "sp-1", 1, true]
    ]);
    expect(spans[0]!.datasetId).toBe(session.snapshot()!.datasetId);
    expect(renderFrame(session.state(), 120, 24).join("\n")).toContain("src/cart.ts#checkout");
    await session.close();
  });
});

describe("review keys f / t / R", () => {
  it("f records the selection's snapshot evidence — the same document y copies — then t and R", async () => {
    let copied = "";
    const session = await exportSession({
      review: reviewFactory(),
      clipboard: {
        platform: "linux",
        env: { WAYLAND_DISPLAY: "wayland-0" },
        spawn: async (_command, input) => {
          copied = input;
        },
        stdout: { write: () => true }
      }
    });
    expect(renderFrame(session.state(), 240, 24).at(-1)).toContain("f/t review");
    session.press("j");
    expect(session.state().selection?.spanId).toBe("sp-1");

    session.press("f");
    expect(session.state().commandLine?.text).toBe("finding ");
    session.press("checkout returns ok");
    session.press("\r");
    await settle(80);
    expect(session.state().notice).toMatch(/^finding saved: .*\.md \(revision 1, editing\)$/);

    const [file] = await reviewFiles();
    expect(file).toBeDefined();
    const text = await readFile(path.join(root, ".kosmo-callflow", "reviews", file!), "utf8");
    expect(text).toContain("checkout returns ok");
    expect(text).toContain(`"snapshotId":"${session.snapshot()!.snapshotId}"`);
    expect(text).toContain('"spanId":"sp-1"');

    await session.yank();
    expect(copied.startsWith("(kosmo.trace-text/v2")).toBe(true);
    // The review's evidence is byte-identical to what `y` copied: one buildEvidence path.
    const parsed = parseReview(text);
    expect(parsed.ok && parsed.value.findings[0]!.evidence.text).toBe(copied);

    session.press("t");
    session.press("check retries");
    session.press("\r");
    await settle(80);
    expect(session.state().notice).toMatch(/^todo saved: .*\(revision 2, editing\)$/);

    session.press("R");
    await settle(80);
    expect(session.state().notice).toMatch(/^review ready: /);
    expect(await readFile(path.join(root, ".kosmo-callflow", "reviews", file!), "utf8")).toContain("status: ready");
    await session.close();
  });

  it("-r: f/t/R are hidden and answer `review disabled: <reason>`; nothing is created", async () => {
    const session = await exportSession({
      policy: { readOnly: true, noEval: false, print: false },
      review: reviewFactory({ readOnly: true })
    });
    expect(renderFrame(session.state(), 240, 24).at(-1)).not.toContain("f/t review");
    session.press("j");
    session.press("f");
    expect(session.state().commandLine).toBeNull();
    expect(session.state().notice).toBe("review disabled: read-only(-r)");
    session.press("R");
    await settle();
    expect(session.state().notice).toBe("review disabled: read-only(-r)");
    expect(existsSync(path.join(root, ".kosmo-callflow", "reviews"))).toBe(false);
    await session.close();
  });

  it("without a project root the review capability's own reason is shown", async () => {
    const session = await exportSession({ review: reviewFactory({ projectRoot: null }) });
    session.press("t");
    expect(session.state().notice).toBe("review disabled: no project root; pass --review-dir <dir> to write reviews");
    await session.close();
  });
});

describe(": commands in the session", () => {
  it("offline sources get the shared graph selectors; :ancestors runs through them", async () => {
    const source = createExportSource({ path: exportPath });
    const deps = commandDepsFor(source);
    expect(deps.selectors).toBeDefined();
    expect(deps.selectors).not.toBe(localGraphSelectors);
    expect(deps.liveSeek).toBe(true);
    expect(deps.sql).toBeUndefined();
    expect(typeof commandDepsFor(createSqliteSource({ path: path.join(root, "x.sqlite") })).sql).toBe("function");

    const session = await exportSession({}, source);
    session.press(":");
    session.press("ancestors sp-2");
    session.press("\r");
    await settle();
    const result = session.state().commandResult;
    expect(result).toMatchObject({ kind: "projection", command: "ancestors" });
    expect(result?.kind === "projection" && result.spans.map((row) => row.spanId)).toEqual(["sp-2", "sp-1"]);
    await session.close();
  });

  it(":sql on an export is unavailable with the export's own reason", async () => {
    const session = await exportSession();
    session.press(":");
    session.press("sql select 1");
    session.press("\r");
    await settle();
    expect(session.state().notice).toBe(":sql: unavailable(sql-needs-sqlite-source)");
    await session.close();
  });

  it(":q quits through the session", async () => {
    let exited = 0;
    const session = await exportSession({ onExit: () => (exited += 1) });
    session.press(":");
    session.press("q");
    session.press("\r");
    await settle();
    expect(exited).toBe(1);
  });

  it(":js evaluates over the pinned export snapshot as a computed-local value", async () => {
    const session = await exportSession();
    session.press(":");
    session.press("js trace.spans().length");
    session.press("\r");
    for (let attempt = 0; attempt < 100 && session.state().commandResult === null; attempt += 1) await settle(50);
    expect(session.state().commandResult).toMatchObject({
      kind: "value",
      command: "js",
      envelope: { provenance: "computed-local", value: 2, scope: { source: "export" } }
    });
    expect(renderFrame(session.state(), 120, 30).join("\n")).toContain(
      "js: computed-local value (not recorded evidence)"
    );
    await session.close();
  }, 20_000);

  it(":js is refused before any child starts with --no-eval, and for a stream", async () => {
    const noEval = await exportSession({ policy: { readOnly: false, noEval: true, print: false } });
    noEval.press(":");
    noEval.press("js 1");
    noEval.press("\r");
    await settle();
    expect(noEval.state().notice).toBe("eval: unavailable(eval-disabled(--no-eval))");
    await noEval.close();

    const stream = createStreamSource({ input: v1Stream(true) });
    const session = await exportSession({}, stream);
    session.press(":");
    session.press("js 1");
    session.press("\r");
    await settle();
    expect(session.state().notice).toBe("eval: unavailable(eval-needs-offline-snapshot(stream))");
    await session.close();
  });
});

const snap: ConnectSnapshotInput = {
  dataset: { projectId: "p", datasetId: "local", graphRevision: "g-1", watermarkSeq: 25, retentionEpoch: 1 },
  cursor: "http://127.0.0.1:41729/api/v1/live/deltas?cursor=c-0"
};

function v1Stream(withEnd: boolean): StreamInput {
  const frames: unknown[] = [
    headerFrame(snap, { interactive: false, eventsCount: 1 }),
    traceFrame({
      traceId: "t-1",
      sessionId: "s-1",
      status: "complete",
      spansCount: 2,
      firstSeq: 10,
      lastSeq: 15,
      hasMissingExit: false,
      hasLossRecords: false
    })
  ];
  if (withEnd) frames.push({ type: "end", reason: "complete", resume: { cursor: "c-9", watermarkSeq: 25 } });
  const text = frames.map((frame) => `${JSON.stringify(frame)}\n`).join("");
  return (async function* () {
    yield text;
  })();
}

describe("source completeness in the header", () => {
  it("a stream that ended without `end` says incomplete in the scope/header", async () => {
    const session = await exportSession({}, createStreamSource({ input: v1Stream(false) }));
    expect(session.state().scope?.reason).toMatch(/^incomplete\(/);
    expect(renderFrame(session.state(), 200, 24)[0]).toMatch(/coverage: incomplete\(/);
    await session.close();
  });
});

/* ------------------------------------------------------------------ openViewerSession */

function viewerInvocation(argv: string[], signal = new AbortController().signal): Invocation<ViewerArgs> {
  const parsed = parseArgv(argv);
  if (!parsed.ok || parsed.args.command !== "viewer") throw new Error("bad argv");
  const target = parsed.args.target!;
  return {
    args: parsed.args,
    target: { kind: "export", path: path.resolve(root, target) },
    project: null,
    proc: fakeProc(argv, { cwd: root }),
    signal
  };
}

function viewerDeps() {
  const io = fakeTerminalIo({ cols: 120, rows: 30 });
  let portCloses = 0;
  return {
    io,
    portCloses: () => portCloses,
    deps: {
      keyboard: () => ({
        ok: true as const,
        port: {
          input: io.input,
          source: "stdin" as const,
          close: () => {
            portCloses += 1;
          }
        }
      }),
      createTerminal: () => createTerminal(io.input, io.output)
    }
  };
}

const count = (writes: string[], needle: string) => writes.join("").split(needle).length - 1;

describe("openViewerSession lifecycle", () => {
  it("q exits 0; the terminal is taken over and restored exactly once; the keyboard port is closed", async () => {
    const { io, deps, portCloses } = viewerDeps();
    const invocation = viewerInvocation(["trace.json"]);
    const running = openViewerSession(invocation, deps);
    for (let attempt = 0; attempt < 50 && !io.writes.join("").includes("checkout"); attempt += 1) await settle(20);
    expect(io.writes.join("")).toContain("src/cart.ts#checkout");
    io.key("q");
    expect(await running).toBe(0);
    expect(count(io.writes, ENTER_SEQUENCE)).toBe(1);
    expect(count(io.writes, RESTORE_SEQUENCE)).toBe(1);
    expect(io.rawModeCalls).toEqual([true, false]);
    expect(portCloses()).toBe(1);
  });

  it("Ctrl+C exits 130 and SIGTERM exits 143, both restoring once", async () => {
    const ctrl = viewerDeps();
    const first = openViewerSession(viewerInvocation(["trace.json"]), ctrl.deps);
    await settle(50);
    ctrl.io.key(String.fromCharCode(3));
    expect(await first).toBe(130);
    expect(count(ctrl.io.writes, RESTORE_SEQUENCE)).toBe(1);

    const term = viewerDeps();
    const controller = new AbortController();
    const second = openViewerSession(viewerInvocation(["trace.json"], controller.signal), term.deps);
    await settle(50);
    controller.abort("SIGTERM");
    expect(await second).toBe(143);
    expect(count(term.io.writes, RESTORE_SEQUENCE)).toBe(1);
  });

  it("a source failure exits 2 and reports it on stderr only after the terminal is restored", async () => {
    const { io, deps } = viewerDeps();
    const invocation = viewerInvocation(["missing.json"]);
    const code = await openViewerSession(invocation, deps);
    expect(code).toBe(2);
    expect(count(io.writes, RESTORE_SEQUENCE)).toBe(1);
    const proc = invocation.proc as ReturnType<typeof fakeProc>;
    expect(proc.err).toMatch(/^kosmo-tui: source failed: /);
  });

  it("labels sources for the review frontmatter without host paths", () => {
    expect(sourceLabel({ kind: "export", path: "/home/me/secret/trace.json" })).toBe("export:trace.json");
    expect(sourceLabel({ kind: "stdin" })).toBe("stream:stdin");
  });
});
