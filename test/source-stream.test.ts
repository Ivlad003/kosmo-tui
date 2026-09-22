import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  CONNECT_FRAME_MAX_BYTES,
  connectSnapshotId,
  connectTraceRef,
  encodeCanonicalChunks,
  gapFrame,
  headerFrame,
  headerFrameV2,
  noticeFrame,
  traceFrame,
  type ConnectSnapshotInput,
  type ConnectSnapshotManifestEntry
} from "@kosmo-callflow/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkCommand, effectiveCapabilities } from "../src/capabilities.js";
import { createSession } from "../src/session.js";
import { SourceError } from "../src/source-common.js";
import { openTargetSource } from "../src/source-open.js";
import { createStreamSource, type StreamInput } from "../src/source-stream.js";
import { canonicalV2 } from "./source-fixtures.js";
import { checkoutRecords, event } from "./replay-records.js";

const POLICY = { readOnly: false, noEval: false, print: false };
const signal = () => new AbortController().signal;
const KC_CLI = fileURLToPath(new URL("../../kosmo-callflow/packages/cli/dist/index.js", import.meta.url));

const snap: ConnectSnapshotInput = {
  dataset: { projectId: "p", datasetId: "local", graphRevision: "g-1", watermarkSeq: 25, retentionEpoch: 1 },
  cursor: "http://127.0.0.1:41729/api/v1/live/deltas?cursor=c-0"
};
const summary = (
  traceId: string,
  firstSeq = 10,
  status: "running" | "complete" | "errored" = "complete",
  sessionId = "s-1"
) =>
  traceFrame({
    traceId,
    sessionId,
    status,
    spansCount: 2,
    firstSeq,
    lastSeq: firstSeq + 5,
    hasMissingExit: false,
    hasLossRecords: false
  });
const endV1 = (reason = "complete") => ({ type: "end", reason, resume: { cursor: "c-9", watermarkSeq: 25 } });
const endV2 = (snapshots: ConnectSnapshotManifestEntry[], reason = "complete") => ({
  ...endV1(reason),
  manifest: { snapshots, omittedTraces: 0, unavailableTraces: 0 }
});
const lines = (...frames: unknown[]) => frames.map((frame) => `${JSON.stringify(frame)}\n`).join("");

/** Chunks of one trace's canonical page, split small so a set has several frames. */
function chunks(traceId: string, maxFrameBytes = 2_048, sessionId = "s-1") {
  const page = canonicalV2(traceId);
  const ref = connectTraceRef(snap, { sessionId, traceId });
  const snapshotId = connectSnapshotId(snap, ref);
  const entry: ConnectSnapshotManifestEntry = { snapshotId, ref };
  return { snapshotId, entry, frames: encodeCanonicalChunks({ snapshotId, ref, page, maxFrameBytes }) };
}

function input(...parts: Array<string | Uint8Array>): StreamInput {
  return (async function* () {
    for (const part of parts) yield part;
  })();
}

async function failure(promise: Promise<unknown>): Promise<SourceError> {
  try {
    await promise;
  } catch (error) {
    return error as SourceError;
  }
  throw new Error("expected a failure");
}

let fetchSpy: { mockRestore(): void };
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  // The stream source never reads a daemon, whatever the frames say.
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

describe("stream v1: summaries only (4.3)", () => {
  it("lists summaries and offers no spans, values, replay or probes", async () => {
    const source = createStreamSource({
      input: input(
        lines(
          headerFrame(snap, { interactive: false, eventsCount: 3 }),
          summary("t-1"),
          summary("t-2", 30, "errored"),
          endV1()
        )
      )
    });
    const opened = await source.open(signal());
    expect(source.version()).toBe(1);
    expect(opened.firstPage.items.map((row) => row.traceId)).toEqual(["t-2", "t-1"]);
    expect(opened.firstPage.coverage).toEqual({ scope: "complete", loaded: 2, total: 2 });
    expect(opened.stableDataset).toBe(false);
    const caps = effectiveCapabilities(opened, source, POLICY);
    expect(caps).toMatchObject({
      projectionVersions: [],
      projection: { available: false, reason: "summary-only-stream" },
      replay: { available: false, reason: "no-replay-records" },
      values: { available: false, level: "none" },
      probes: { available: false },
      follow: { available: false, reason: "finite-stream" }
    });
    expect(checkCommand(caps, "depth")).toMatchObject({ ok: false, notice: "depth: unavailable(summary-only-stream)" });
    const ref = opened.firstPage.items[0]!;
    // Nothing reconstructs spans from a summary.
    expect(
      await failure(source.canonical!(opened.snapshot, { kind: "trace", ref }, { version: 2 }, signal()))
    ).toMatchObject({
      code: "unavailable"
    });
    expect(source.completeness()).toEqual({ state: "complete" });
  });

  it("rejects a canonical frame on v1 with its line number", async () => {
    const { frames } = chunks("t-1");
    const source = createStreamSource({
      input: input(lines(headerFrame(snap, { interactive: false, eventsCount: 1 }), summary("t-1"), frames[0]))
    });
    const error = await failure(source.open(signal()));
    expect(error).toMatchObject({ code: "stream-unknown-frame" });
    expect(error.message).toMatch(/line 3/);
  });

  it("shows reset:true as a gap and never claims completeness", async () => {
    const source = createStreamSource({
      input: input(
        lines(
          headerFrame(snap, { interactive: false, eventsCount: 1 }),
          { ...summary("t-1"), reset: true, droppedFrames: 4 },
          endV1()
        )
      )
    });
    const opened = await source.open(signal());
    expect(source.completeness()).toMatchObject({ state: "incomplete", reasons: ["gap"] });
    expect(opened.firstPage.coverage).toMatchObject({ scope: "partial", reason: "incomplete(gap)" });
  });
});

describe("stream v2: atomic canonical snapshots (4.3)", () => {
  it("reads split UTF-8 and CRLF frames, commits full chunk sets and serves typed evidence", async () => {
    const one = chunks("t-1");
    expect(one.frames.length).toBeGreaterThan(1);
    const text = lines(
      headerFrameV2(snap, { eventsCount: 5 }),
      summary("t-1"),
      ...one.frames,
      noticeFrame("no-events"),
      endV2([one.entry])
    ).replace(/\n/g, "\r\n");
    // Split into 7-byte pieces, cutting through multi-byte characters and CRLF pairs.
    const bytes = new TextEncoder().encode(text.replace("checkout", "chéckout✓"));
    const pieces: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.length; offset += 7) pieces.push(bytes.subarray(offset, offset + 7));
    const source = createStreamSource({ input: input(...pieces) });
    const opened = await source.open(signal());
    expect(source.completeness()).toEqual({ state: "complete" });
    const caps = effectiveCapabilities(opened, source, POLICY);
    expect(caps).toMatchObject({
      projectionVersions: [2],
      projection: { available: true },
      values: { available: true },
      replay: { available: false, reason: "no-replay-records" }
    });
    const ref = opened.firstPage.items[0]!;
    const page = await source.canonical!(opened.snapshot, { kind: "trace", ref }, { version: 2 }, signal());
    expect(page.envelope.items.length).toBe(canonicalV2("t-1").items.length);
    const evidence = await source.details!(
      opened.snapshot,
      { ...ref, datasetId: page.envelope.dataset.datasetId, spanId: "sp-2" },
      signal()
    );
    expect(evidence).toMatchObject({ status: "errored", ref: { spanId: "sp-2" } });
    expect(
      await failure(source.canonical!(opened.snapshot, { kind: "trace", ref }, { version: 1 }, signal()))
    ).toMatchObject({
      code: "projection-version-unavailable"
    });
  });

  it("keeps the last full snapshot when a chunk is missing and reports it at end", async () => {
    const one = chunks("t-1");
    const source = createStreamSource({
      input: input(
        lines(
          headerFrameV2(snap, { eventsCount: 5 }),
          summary("t-1"),
          ...one.frames.filter((_, index) => index !== 1),
          endV2([one.entry])
        )
      )
    });
    const opened = await source.open(signal());
    expect(source.completeness()).toMatchObject({
      state: "incomplete",
      reasons: ["missing-snapshots"],
      missingSnapshotIds: [one.snapshotId]
    });
    expect(opened.firstPage.coverage.reason).toMatch(/missing-snapshots; 1 snapshot\(s\) missing/);
    const ref = opened.firstPage.items[0]!;
    expect(
      (await failure(source.canonical!(opened.snapshot, { kind: "trace", ref }, { version: 2 }, signal()))).message
    ).toMatch(/no-canonical-snapshot/);
  });

  it("discards staged chunks on a gap and treats EOF without end as incomplete-stream", async () => {
    const one = chunks("t-1");
    const source = createStreamSource({
      input: input(
        lines(
          headerFrameV2(snap, { eventsCount: 5 }),
          summary("t-1"),
          one.frames[0],
          gapFrame(2),
          ...one.frames.slice(1)
        )
      )
    });
    const opened = await source.open(signal());
    expect(source.completeness()).toMatchObject({
      state: "incomplete",
      reasons: expect.arrayContaining(["incomplete-stream", "gap"])
    });
    expect(opened.firstPage.items.map((row) => row.traceId)).toEqual(["t-1"]);
    const ref = opened.firstPage.items[0]!;
    expect(
      await failure(source.canonical!(opened.snapshot, { kind: "trace", ref }, { version: 2 }, signal()))
    ).toMatchObject({
      code: "unavailable"
    });
  });

  it("keeps two sessions that reuse one traceId as two rows with their own snapshots (full ref)", async () => {
    const a = chunks("t-1", 2_048, "s-a");
    const b = chunks("t-1", 2_048, "s-b");
    expect(a.snapshotId).not.toBe(b.snapshotId);
    const source = createStreamSource({
      input: input(
        lines(
          headerFrameV2(snap, { eventsCount: 5 }),
          summary("t-1", 10, "complete", "s-a"),
          summary("t-1", 20, "errored", "s-b"),
          ...a.frames,
          ...b.frames.filter((_, index) => index !== 1),
          endV2([a.entry, b.entry])
        )
      )
    });
    const opened = await source.open(signal());
    expect(opened.firstPage.items.map((row) => [row.sessionId, row.traceId])).toEqual([
      ["s-b", "t-1"],
      ["s-a", "t-1"]
    ]);
    // s-b's set lost a chunk: only s-b is missing, s-a's committed snapshot does not stand in for it.
    expect(source.completeness()).toMatchObject({
      state: "incomplete",
      reasons: ["missing-snapshots"],
      missingSnapshotIds: [b.snapshotId]
    });
    const [rowB, rowA] = opened.firstPage.items;
    const pageA = await source.canonical!(opened.snapshot, { kind: "trace", ref: rowA! }, { version: 2 }, signal());
    expect(pageA.envelope.items.length).toBe(canonicalV2("t-1").items.length);
    expect(
      (await failure(source.canonical!(opened.snapshot, { kind: "trace", ref: rowB! }, { version: 2 }, signal())))
        .message
    ).toMatch(/no-canonical-snapshot.*session s-b/);
  });

  it("fails an oversized, malformed or unknown-version frame with the line number", async () => {
    const huge = lines(headerFrameV2(snap, { eventsCount: 5 })) + `${"x".repeat(CONNECT_FRAME_MAX_BYTES + 10)}\n`;
    expect(await failure(createStreamSource({ input: input(huge) }).open(signal()))).toMatchObject({
      code: "stream-frame-too-large",
      message: expect.stringContaining("line 2")
    });
    expect(
      await failure(createStreamSource({ input: input('{"type":"connect","v":3}\n') }).open(signal()))
    ).toMatchObject({
      code: "stream-unsupported-version"
    });
    expect(await failure(createStreamSource({ input: input(lines(summary("t-1"))) }).open(signal()))).toMatchObject({
      code: "stream-missing-header"
    });
    expect(await failure(createStreamSource({ input: input("") }).open(signal()))).toMatchObject({
      code: "stream-missing-header"
    });
  });

  it("follows only when the producer declared follow:true, applying frames as deltas", async () => {
    const pipe = new PassThrough();
    const source = createStreamSource({ input: pipe });
    pipe.write(lines({ ...headerFrameV2(snap, { eventsCount: 5 }), follow: true }, summary("t-1")));
    const opened = await source.open(signal());
    expect(effectiveCapabilities(opened, source, POLICY).follow).toEqual({ available: true });
    pipe.write(lines(summary("t-2", 40)));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const delta = await source.deltas!(opened.deltaCursor!, signal());
    expect(delta).toMatchObject({ reset: false, gap: false });
    expect(delta.traces.map((row) => row.traceId)).toEqual(["t-2"]);
    pipe.write(lines(gapFrame(2), summary("t-3", 50)));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reset = await source.deltas!(delta.cursor, signal());
    expect(reset).toMatchObject({ reset: true, gap: true });
    expect(reset.traces.map((row) => row.traceId).sort()).toEqual(["t-1", "t-2", "t-3"]);
    await source.close();
  });
});

describe("interactive EOF freezes the view (4.3)", () => {
  it("keeps a frozen, marked view after EOF and the keyboard keeps working", async () => {
    const pipe = new PassThrough();
    const source = createStreamSource({ input: pipe });
    pipe.end(lines(headerFrame(snap, { interactive: false, eventsCount: 2 }), summary("t-1"), summary("t-2", 30)));
    const session = createSession({ source, policy: POLICY });
    await session.start();
    // Frozen: the source finished at EOF and says why the view is not complete.
    expect(source.completeness()).toMatchObject({ state: "incomplete", reasons: ["incomplete-stream"] });
    const page = await source.traces(session.snapshot()!, { limit: 50 }, signal());
    expect(page.coverage).toMatchObject({ scope: "partial", reason: "incomplete(incomplete-stream)" });
    const before = session.state();
    expect(before.traces.map((row) => row.traceId).sort()).toEqual(["t-1", "t-2"]);
    // The data pipe is at EOF; keys still drive the session.
    session.press("/");
    expect(session.state().searchInput).toBe("");
    session.press("t");
    expect(session.state().searchInput).toBe("t");
    session.press("\u001b");
    expect(session.state().searchInput).toBeNull();
    await session.close();
  });
});

describe("real pipe from the kosmo-callflow producer (4.3)", () => {
  let server: Server;
  let origin: string;
  let requests: string[];
  let tmp: string;

  beforeEach(async () => {
    requests = [];
    tmp = await mkdtemp(path.join(os.tmpdir(), "kosmo-tui-pipe-"));
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      requests.push(url.pathname);
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (url.pathname === "/api/v1/live/snapshot") {
        return send(200, {
          dataset: snap.dataset,
          items: [
            {
              traceId: "t-1",
              sessionId: "s-1",
              status: "errored",
              spansCount: 2,
              firstSeq: 10,
              lastSeq: 25,
              hasMissingExit: false,
              hasLossRecords: false
            },
            {
              traceId: "t-big",
              sessionId: "s-1",
              status: "complete",
              spansCount: 40,
              firstSeq: 30,
              lastSeq: 90,
              hasMissingExit: false,
              hasLossRecords: false
            }
          ],
          markers: { truncated: false, gap: false, retentionEpoch: 1 },
          cursor: "cursor-0"
        });
      }
      if (url.pathname === "/api/v1/status")
        return send(200, { data: { connected: true, pluginConnected: true, eventsCount: 60 } });
      const canonical = /^\/api\/v1\/traces\/([^/]+)\/canonical$/.exec(url.pathname);
      if (canonical && url.searchParams.get("projectionVersion") === "2") {
        const traceId = decodeURIComponent(canonical[1]!);
        if (traceId === "t-1") return send(200, canonicalV2("t-1"));
        // A big trace: many spans with large values, so the producer must chunk it.
        const records = Array.from({ length: 40 }, (_, index) => [
          event({
            seq: 30 + index * 2,
            traceId: "t-big",
            spanId: `b-${index}`,
            payload: { args: ["é".repeat(3_000)] }
          }),
          event({ seq: 31 + index * 2, type: "exit", traceId: "t-big", spanId: `b-${index}`, payload: { ret: index } })
        ]).flat();
        return send(200, canonicalV2("t-big", records));
      }
      return send(404, { error: "not_found" });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tmp, { recursive: true, force: true });
  });

  function producer(args: string[]) {
    return spawn(
      process.execPath,
      [KC_CLI, "connect", "--no-interactive", "--format", "ndjson", ...args, "--endpoint", origin],
      {
        cwd: tmp,
        env: { PATH: process.env.PATH ?? "", HOME: tmp },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
  }

  it.skipIf(!existsSync(KC_CLI))(
    "reads `connect --stream-version 2` through an OS pipe with no daemon read of its own",
    async () => {
      const child = producer(["--stream-version", "2"]);
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
      const opened = await openTargetSource(
        { target: { kind: "stdin" }, project: null, env: {}, cwd: tmp },
        { stdinData: child.stdout as unknown as StreamInput }
      );
      if (!opened.ok) throw new Error(opened.message);
      const source = opened.source as ReturnType<typeof createStreamSource>;
      const result = await source.open(signal());
      expect(await exited).toBe(0);
      expect(stderr).toBe("");
      const producerReads = requests.length;

      expect(source.version()).toBe(2);
      expect(source.completeness()).toEqual({ state: "complete" });
      expect(result.firstPage.items.map((row) => row.traceId)).toEqual(["t-big", "t-1"]);
      const caps = effectiveCapabilities(result, source, POLICY);
      expect(caps.projectionVersions).toEqual([2]);
      expect(caps.replay).toEqual({ available: false, reason: "no-replay-records" });

      const big = result.firstPage.items[0]!;
      const page = await source.canonical!(result.snapshot, { kind: "trace", ref: big }, { version: 2 }, signal());
      expect(page.envelope.items.filter((item) => item.kind === "span")).toHaveLength(40);
      const small = await source.canonical!(
        result.snapshot,
        { kind: "trace", ref: result.firstPage.items[1]! },
        { version: 2 },
        signal()
      );
      expect(JSON.stringify(small.envelope.items)).toBe(JSON.stringify(canonicalV2("t-1").items));
      // The cursor in the frames points at a daemon; the stream source never used it.
      expect(requests.length).toBe(producerReads);
      await source.close();
    }
  );

  it.skipIf(!existsSync(KC_CLI))("reads the default v1 producer as summaries only", async () => {
    const child = producer([]);
    const source = createStreamSource({ input: child.stdout as unknown as StreamInput });
    const opened = await source.open(signal());
    expect(source.version()).toBe(1);
    expect(source.completeness()).toEqual({ state: "complete" });
    expect(opened.firstPage.items.map((row) => row.traceId).sort()).toEqual(["t-1", "t-big"]);
    expect(effectiveCapabilities(opened, source, POLICY).projection.available).toBe(false);
    expect(requests.some((pathname) => pathname.endsWith("/canonical"))).toBe(false);
  });
});

// Keep the fixture helper honest: the checkout records project to two spans.
it("fixture sanity: the canonical page of t-1 has the checkout spans", () => {
  expect(canonicalV2("t-1", checkoutRecords()).items.filter((item) => item.kind === "span")).toHaveLength(2);
});

describe("follow deltas stay bounded on a long stream (review)", () => {
  it("tracks 100k trace frames in linear time and keeps one pending change per trace", async () => {
    const later: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const source = createStreamSource({
      input: (async function* () {
        yield lines({ ...headerFrameV2(snap, { eventsCount: 5 }), follow: true }, summary("t-0"));
        // One frame per chunk: the worst case for a per-chunk copy of the whole trace map.
        for (let index = 0; index < 100_000; index += 1) {
          yield `${JSON.stringify(summary(`t-${index % 20_000}`, 100 + index))}\n`;
        }
        await gate;
        for (const line of later) yield line;
      })()
    });
    const opened = await source.open(signal());
    const started = performance.now();
    const lastOf = async () => {
      const body = await source.deltas!(opened.deltaCursor!, signal());
      return { body, last: body.traces.find((row) => row.traceId === "t-19999")?.startedAt };
    };
    let { body: delta, last } = await lastOf();
    while (last !== 100 + 99_999) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      ({ body: delta, last } = await lastOf());
    }
    expect(performance.now() - started).toBeLessThan(10_000);
    // 100k updates over 20k traces: one pending change per trace, not one per frame.
    expect(source.pendingChanges()).toBe(20_000);
    expect(delta.traces).toHaveLength(20_000);
    expect(delta).toMatchObject({ reset: false, gap: false });
    // Only what changed after the returned cursor comes back next time.
    later.push(lines(summary("t-7", 999_999)));
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const next = await source.deltas!(delta.cursor, signal());
    expect(next.traces.map((row) => [row.traceId, row.startedAt])).toEqual([["t-7", 999_999]]);
    await source.close();
  }, 30_000);

  it("fails the source with an explicit error when a reader cap is hit, never silently", async () => {
    const pipe = new PassThrough();
    const source = createStreamSource({ input: pipe, reader: { maxFrameBytes: 512 } });
    pipe.write(lines({ ...headerFrameV2(snap, { eventsCount: 5 }), follow: true }, summary("t-1")));
    const opened = await source.open(signal());
    pipe.write(`${JSON.stringify({ ...summary("t-2"), pad: "x".repeat(1_000) })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await failure(source.deltas!(opened.deltaCursor!, signal()))).toMatchObject({
      code: "stream-frame-too-large"
    });
    await source.close();
  });
});
