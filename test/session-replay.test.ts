/**
 * Task 5.5 in the session: replay pinned to one snapshot never applies live deltas,
 * `L` explicitly loads a live baseline, a retention reset during replay is a notice and
 * not a jump, autoplay speed/pause, and speed unavailable across unsynced clocks while
 * stepping still works. Task 5.9 in the session: `y` end to end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTraceTextV2 } from "@kosmo-callflow/protocol";
import { createSession } from "../src/session.js";
import { createTerminal, RESTORE_SEQUENCE } from "../src/terminal.js";
import { renderFrame } from "../src/render.js";
import { checkoutRecords, event } from "./replay-records.js";
import {
  canonicalPageV2,
  canonicalSpanV2,
  deltaBody,
  flush,
  httpError,
  liveFake,
  snapshotRef,
  spanRow,
  traceRow
} from "./session-fakes.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function replaying(
  records = checkoutRecords(),
  request = {},
  extra: Partial<Parameters<typeof createSession>[0]> = {}
) {
  const fake = liveFake({
    records,
    opens: [{ snapshot: { watermark: 30 }, traces: [traceRow("t-1")] }, { traces: [traceRow("t-live", 50)] }]
  });
  const session = createSession({ source: fake.source, ...extra });
  await session.start();
  await session.enterReplay(request);
  return { fake, session };
}

describe("pinned replay in the session", () => {
  it("starts at the first record and steps with n/b over holes", async () => {
    const { session } = await replaying();
    expect(session.state().replay?.index).toBe(0);
    session.press("n");
    session.press("n");
    expect(session.state().replay?.timeline.frames[session.state().replay!.index]!.seq).toBe(18);
    session.press("b");
    expect(session.state().replay?.timeline.frames[session.state().replay!.index]!.seq).toBe(12);
    expect(renderFrame(session.state(), 160, 24)[0]).toContain("REPLAY 2/5 seq=12");
    await session.close();
  });

  it("a seq inside a hole shows requested and applied; out of range is refused without moving", async () => {
    const { session } = await replaying();
    session.dispatch({ kind: "replaySeek", seq: 15 });
    expect(session.state().notice).toBe("seq 15: no record; showing state after seq 12, next record at seq 18");
    const index = session.state().replay!.index;
    session.dispatch({ kind: "replaySeek", seq: 999 });
    expect(session.state().notice).toContain("seq 999 out of range");
    expect(session.state().replay!.index).toBe(index);
    await session.close();
  });

  it("the frame at 19 carries no future error or supplement in its detail", async () => {
    const { session } = await replaying();
    session.seek(19);
    session.press("j"); // select sp-1 (depth 0)
    session.press("l"); // expand it so its child is visible
    const detail = session.state().detail!;
    expect(detail.spanId).toBe("sp-1");
    expect(JSON.stringify(detail)).not.toContain("supplement");
    session.press("j"); // sp-2, errored at 20
    expect(session.state().detail!.error).toEqual({ state: "not-recorded" });
    session.seek(20);
    expect(session.state().detail!.error).toEqual({ state: "recorded", text: "card declined" });
    await session.close();
  });

  it("never applies live deltas while replaying, then L loads the live baseline", async () => {
    const { fake, session } = await replaying();
    session.seek(12);
    const before = session.state().spans;
    await vi.advanceTimersByTimeAsync(250);
    fake.deltaCalls.at(-1)!.resolve(deltaBody({ spans: [spanRow("t-1", "live-span")], traces: [traceRow("t-9", 99)] }));
    await flush();
    expect(session.state().spans).toBe(before);
    expect(session.state().behindLive).toBe(true);
    expect(fake.log.filter((line) => line.startsWith("details"))).toEqual([]);

    session.press("L");
    await flush();
    expect(fake.opens()).toBe(2);
    expect(session.state().replay).toBeNull();
    expect(session.state().traces.map((row) => row.traceId)).toEqual(["t-live"]);
    expect(session.state().behindLive).toBe(false);
    expect(session.state().notice).toBe("live baseline loaded");
    await session.close();
  });

  it("a retention reset during replay is a notice, not a jump", async () => {
    const { fake, session } = await replaying();
    session.seek(18);
    const frame = session.state().replay!.index;
    const spans = session.state().spans;
    await vi.advanceTimersByTimeAsync(250);
    fake.deltaCalls
      .at(-1)!
      .resolve(deltaBody({ reset: true, snapshot: snapshotRef({ retentionEpoch: 2 }), traces: [] }));
    await flush();
    expect(session.state().replay!.index).toBe(frame);
    expect(session.state().spans).toBe(spans);
    expect(session.state().notice).toContain("retention reset on the live source (epoch 1 → 2)");
    expect(session.state().notice).toContain("replay stays on pinned snapshot snap-1");
    session.press("L");
    await flush();
    expect(session.state().retentionGap).toBe(true);
    expect(session.state().notice).toContain("after a retention reset");
    await session.close();
  });

  it("a 409 during replay stops polling until L, then polling resumes", async () => {
    const { fake, session } = await replaying();
    await vi.advanceTimersByTimeAsync(250);
    fake.deltaCalls.at(-1)!.reject(httpError(409));
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.deltaCalls).toHaveLength(1);
    expect(session.state().replay).not.toBeNull();
    expect(session.state().notice).toContain("replay stays on pinned snapshot");
    session.press("L");
    await flush();
    await vi.advanceTimersByTimeAsync(250);
    expect(fake.deltaCalls).toHaveLength(2);
    await session.close();
  });

  it("autoplays at a fixed interval, p pauses and resumes it, and it parks at the end", async () => {
    const { session } = await replaying(checkoutRecords(), { stepIntervalMs: 100 });
    const seqNow = () => session.state().replay!.timeline.frames[session.state().replay!.index]!.seq;
    expect(seqNow()).toBe(10);
    await vi.advanceTimersByTimeAsync(100);
    expect(seqNow()).toBe(12);
    session.press("p");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seqNow()).toBe(12);
    session.press("p");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seqNow()).toBe(25);
    expect(session.state().replay).not.toBeNull();
    await session.close();
  });

  it("speed follows one session's clock", async () => {
    const records = [
      event({ seq: 1, clock: { domain: "monotonic", value: 0 } }),
      event({ seq: 2, type: "exit", clock: { domain: "monotonic", value: 1_000 } })
    ];
    const { session } = await replaying(records, { speed: 2 });
    await vi.advanceTimersByTimeAsync(499);
    expect(session.state().replay!.index).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(session.state().replay!.index).toBe(1);
    await session.close();
  });

  it("speed is unavailable across sessions without a shared clock; stepping still works", async () => {
    const records = [
      event({ seq: 1, sessionId: "browser", clock: { domain: "monotonic", value: 1 } }),
      event({ seq: 2, sessionId: "node", clock: { domain: "monotonic", value: 5_000_000 } })
    ];
    const { session } = await replaying(records, { speed: 3 });
    expect(session.state().notice).toContain("speed: unavailable(unsynced clock domains");
    expect(renderFrame(session.state(), 200, 24)[0]).toContain("speed x3 unavailable");
    session.press("n");
    expect(session.state().replay!.index).toBe(1);
    session.setReplaySpeed(20);
    expect(session.state().notice).toContain("must be in 0.1..10");
    await session.close();
  });

  it("replay without the capability answers unavailable(reason)", async () => {
    const fake = liveFake({ offers: { replay: { available: false, reason: "legacy-api-no-records" } } });
    const session = createSession({ source: fake.source });
    await session.start();
    await session.enterReplay();
    expect(session.state().notice).toBe("seek: unavailable(legacy-api-no-records)");
    expect(session.state().replay).toBeNull();
    await session.close();
  });
});

describe("y in the session", () => {
  const SELECTED = { datasetId: "local", projectId: "p", sessionId: "s-1", traceId: "t-1", spanId: "a" };

  async function withSelection(
    clipboard: Parameters<typeof createSession>[0]["clipboard"],
    terminal?: ReturnType<typeof createTerminal>
  ) {
    const fake = liveFake({
      canonical: (ref) => ({
        version: 2,
        envelope: canonicalPageV2([
          canonicalSpanV2(ref, {
            ret: { state: "recorded", value: `esc${String.fromCharCode(27)}]0;title` },
            node: {
              datasetId: "local",
              projectId: "p",
              graphRevision: "g",
              nodeId: "src/a.ts#a",
              displayName: "a",
              // No recorded location: the document must say the line is unavailable.
              identityConfidence: "runtime"
            }
          } as never),
          canonicalSpanV2({ ...ref, spanId: "other" })
        ]),
        coverage: { scope: "complete", loaded: 2, total: 2 },
        truncated: false,
        cursor: null
      })
    });
    const session = createSession({
      source: fake.source,
      ...(terminal ? { terminal } : {}),
      ...(clipboard ? { clipboard } : {})
    });
    await session.start();
    await vi.advanceTimersByTimeAsync(250);
    fake.deltaCalls[0]!.resolve(deltaBody({ spans: [spanRow("t-1", "a")] }));
    await flush();
    session.press("j");
    expect(session.state().selection).toEqual(SELECTED);
    return { fake, session };
  }

  it("copies the full v2 document of the selected span via the clipboard adapter", async () => {
    const copied: string[] = [];
    const { session } = await withSelection({
      platform: "darwin",
      env: {},
      stdout: { write: () => undefined },
      spawn: async (_command, input) => {
        copied.push(input);
      }
    });
    session.press("y");
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(session.state().notice).toMatch(
      /^yank: copied kosmo\.trace-text\/v2 lisp \(\d+ bytes\) via pbcopy; source line unavailable$/
    );
    expect(copied).toHaveLength(1);
    const parsed = parseTraceTextV2(copied[0]!, { dialect: "lisp" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.items).toHaveLength(1);
      expect(parsed.data.items[0]!.kind === "span" && parsed.data.items[0]!.ref).toEqual(SELECTED);
    }
    expect(copied[0]).not.toContain(String.fromCharCode(27));
    await session.close();
  });

  it("without a clipboard prints the document only after the terminal is restored", async () => {
    const log: string[] = [];
    const output = {
      isTTY: true,
      columns: 100,
      rows: 30,
      write: (chunk: string) => {
        log.push(chunk);
      },
      on: () => undefined,
      off: () => undefined
    };
    const input = { isTTY: true, setRawMode: () => undefined, on: () => undefined, off: () => undefined };
    const terminal = createTerminal(input, output);
    const { session } = await withSelection({ platform: "linux", env: {}, stdout: output }, terminal);
    session.press("y");
    await flush();
    expect(session.state().notice).toContain("will be printed to stdout after exit");
    expect(log.join("")).not.toContain("(kosmo.trace-text/v2");
    await session.close();
    const text = log.join("");
    const restoredAt = text.lastIndexOf(RESTORE_SEQUENCE);
    const documentAt = text.indexOf("(kosmo.trace-text/v2");
    expect(restoredAt).toBeGreaterThan(-1);
    expect(documentAt).toBeGreaterThan(restoredAt);
    expect(parseTraceTextV2(text.slice(documentAt).trimEnd(), { dialect: "lisp" }).ok).toBe(true);
  });

  it("is unavailable in a replay frame, with nothing selected, and without a port", async () => {
    const spawn = vi.fn(async () => undefined);
    const clipboard = { platform: "darwin" as const, env: {}, stdout: { write: () => undefined }, spawn };
    const { session } = await replaying(checkoutRecords(), {}, { clipboard });
    await session.yank();
    expect(session.state().notice).toBe("yank: nothing selected");
    session.press("j");
    await session.yank();
    expect(session.state().notice).toContain("yank: unavailable(replay frame");
    expect(spawn).not.toHaveBeenCalled();
    await session.close();

    const bare = createSession({ source: liveFake().source });
    await bare.start();
    await bare.yank();
    expect(bare.state().notice).toBe("yank: unavailable(no clipboard or stdout port)");
    await bare.close();
  });
});
