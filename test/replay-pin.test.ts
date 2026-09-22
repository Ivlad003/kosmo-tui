/**
 * Task 5.5: replay on a pinned snapshot — seq cutoff (not an index), stepping over
 * holes, explicit out-of-range refusal, future supplements invisible, full identity,
 * and speed only on comparable clocks.
 */
import { createTraceDatasetSnapshot, projectCanonicalPage } from "@kosmo-callflow/query/snapshot";
import { describe, expect, it } from "vitest";
import {
  delayAfter,
  detailAtCutoff,
  pinReplay,
  pinnedSchedule,
  seekPinned,
  stepSeq,
  type SeekOutcome
} from "../src/replay-pin.js";
import { evidenceFromCanonicalV2 } from "../src/source-common.js";
import { checkoutRecords, event, supplement } from "./replay-records.js";
import { snapshotRef } from "./session-fakes.js";

const REF = { datasetId: "local", projectId: "p", sessionId: "s-1", traceId: "t-1", spanId: "sp-1" };
const CHILD = { ...REF, spanId: "sp-2" };

function ok(outcome: SeekOutcome): Extract<SeekOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error(`seek refused: ${outcome.notice}`);
  return outcome;
}

describe("seq N is a cutoff over records, not an index", () => {
  it("reduces exactly the records with seq <= N", () => {
    const pin = pinReplay(checkoutRecords(), snapshotRef({ watermark: 30 }));
    const at12 = ok(seekPinned(pin, 12));
    expect(at12.applied).toBe(12);
    expect(at12.index).toBe(1);
    expect(at12.rows.spans.map((span) => span.spanId).sort()).toEqual(["sp-1", "sp-2"]);
    const at10 = ok(seekPinned(pin, 10));
    expect(at10.rows.spans.map((span) => span.spanId)).toEqual(["sp-1"]);
    // Index 0 would also be "the first frame"; the cutoff semantics are what matter.
    expect(ok(seekPinned(pin, 11)).applied).toBe(10);
  });

  it("a step to 19 sees neither the error at 20 nor the supplement at 25", () => {
    const pin = pinReplay(checkoutRecords(), snapshotRef({ watermark: 30 }));
    const at19 = ok(seekPinned(pin, 19));
    const parent = detailAtCutoff(at19.state, REF)!;
    const child = detailAtCutoff(at19.state, CHILD)!;
    expect(child.error).toEqual({ state: "not-recorded" });
    expect(child.status).toBe("running");
    expect(at19.rows.traces[0]!.status).toBe("running");
    expect(parent.args).toEqual({ state: "recorded", text: '["cart-1"]' });
    expect(JSON.stringify(parent)).not.toContain("supplement");
    // ret was recorded at 18, so at 19 it is recorded; at 15 it is not.
    expect(parent.ret).toEqual({ state: "recorded", text: '{"ok":true}' });
    expect(detailAtCutoff(ok(seekPinned(pin, 15)).state, REF)!.ret).toEqual({ state: "not-recorded" });

    const at25 = ok(seekPinned(pin, 25));
    expect(detailAtCutoff(at25.state, CHILD)!.error).toEqual({ state: "recorded", text: "card declined" });
    expect(detailAtCutoff(at25.state, REF)!.args).toMatchObject({
      state: "recorded",
      text: expect.stringContaining("supplement")
    });
  });

  it("reports a hole with requested and applied seq and the next record", () => {
    const pin = pinReplay(checkoutRecords(), snapshotRef({ watermark: 30 }));
    const outcome = ok(seekPinned(pin, 15));
    expect(outcome.hole).toEqual({ requested: 15, applied: 12, nextRecord: 18 });
    expect(ok(seekPinned(pin, 18)).hole).toBeNull();
  });

  it("refuses seqs outside the pinned range instead of clamping", () => {
    const pin = pinReplay(checkoutRecords(), snapshotRef({ watermark: 30, snapshotId: "snap-A" }));
    for (const seq of [9, 31, 1_000]) {
      const outcome = seekPinned(pin, seq);
      expect(outcome.ok, String(seq)).toBe(false);
      expect(outcome.ok === false && outcome.reason).toBe("out-of-range");
      expect(outcome.ok === false && outcome.notice).toContain("snap-A holds 10..30");
    }
    // Beyond the last record but inside the watermark is a valid cutoff.
    expect(ok(seekPinned(pin, 30)).applied).toBe(25);
    expect(seekPinned(pin, -1)).toMatchObject({ ok: false, reason: "invalid" });
    expect(seekPinned(pin, 1.5)).toMatchObject({ ok: false, reason: "invalid" });
    expect(seekPinned(pinReplay([], snapshotRef()), 1)).toMatchObject({ ok: false, reason: "empty" });
  });

  it("names the truncation in the out-of-range notice when records were cut", () => {
    const pin = pinReplay(checkoutRecords(), snapshotRef({ watermark: 30 }), { truncatedReason: "record staging cap" });
    expect(pin.range).toEqual({ first: 10, last: 25 });
    const outcome = seekPinned(pin, 26);
    expect(outcome.ok === false && outcome.notice).toContain("records truncated: record staging cap");
  });
});

describe("stepping moves between available records", () => {
  it("skips holes and parks at both ends", () => {
    const pin = pinReplay(checkoutRecords(), snapshotRef());
    expect(pin.seqs).toEqual([10, 12, 18, 20, 25]);
    expect(stepSeq(pin, -1, 1)).toBe(10);
    expect(stepSeq(pin, -1, -1)).toBeNull();
    expect(stepSeq(pin, 1, 1)).toBe(18);
    expect(stepSeq(pin, 1, -1)).toBe(10);
    expect(stepSeq(pin, 4, 1)).toBeNull();
    expect(stepSeq(pin, 0, -1)).toBeNull();
  });
});

describe("full identity across sessions", () => {
  it("keeps equal traceId/spanId from two sessions apart", () => {
    const records = [
      event({ seq: 1, sessionId: "s-a", payload: { args: ["a"] } }),
      event({ seq: 2, sessionId: "s-b", payload: { args: ["b"] } })
    ];
    const outcome = ok(seekPinned(pinReplay(records, snapshotRef()), 2));
    expect(outcome.rows.spans.map((span) => span.sessionId).sort()).toEqual(["s-a", "s-b"]);
    expect(detailAtCutoff(outcome.state, { ...REF, sessionId: "s-a" })!.args).toEqual({
      state: "recorded",
      text: '["a"]'
    });
    expect(detailAtCutoff(outcome.state, { ...REF, sessionId: "s-b" })!.args).toEqual({
      state: "recorded",
      text: '["b"]'
    });
    expect(detailAtCutoff(outcome.state, { ...REF, datasetId: "other" })).toBeNull();
  });
});

describe("speed needs a comparable source clock", () => {
  it("plays one session at the recorded clock divided by the multiplier", () => {
    const pin = pinReplay(
      [
        event({ seq: 1, clock: { domain: "monotonic", value: 100 } }),
        event({ seq: 2, type: "exit", clock: { domain: "monotonic", value: 500 } })
      ],
      snapshotRef()
    );
    const schedule = pinnedSchedule(pin, { speed: 2 });
    expect(schedule.mode).toBe("speed");
    expect(delayAfter(pin, schedule, 0)).toBe(200);
    expect(delayAfter(pin, schedule, 1)).toBeNull();
  });

  it("a supplement without a clock does not make one session unaligned", () => {
    const pin = pinReplay([event({ seq: 1 }), supplement(2, { x: 1 }), event({ seq: 3, type: "exit" })], snapshotRef());
    expect(pin.timeline.alignment.kind).toBe("aligned");
  });

  it("falls back to fixed stepping with the reason across sessions without a shared clock", () => {
    const pin = pinReplay(
      [
        event({ seq: 1, sessionId: "browser", clock: { domain: "monotonic", value: 5 } }),
        event({ seq: 2, sessionId: "node", clock: { domain: "monotonic", value: 9_000_000 } })
      ],
      snapshotRef()
    );
    const schedule = pinnedSchedule(pin, { speed: 4 });
    expect(schedule).toMatchObject({ mode: "speed-fallback", speed: 4 });
    expect(schedule.mode === "speed-fallback" && schedule.reason).toContain("unsynced clock domains");
    // Monotonic values of two processes are never subtracted into a delay.
    expect(delayAfter(pin, schedule, 0)).toBe(schedule.mode === "speed-fallback" ? schedule.intervalMs : -1);
    // Stepping is independent of the clock.
    expect(stepSeq(pin, 0, 1)).toBe(2);
  });
});

describe("a partially masked value reads the same in a replay frame and in the snapshot view", () => {
  it("shows the recorded part with the [masked] marker in place instead of masking the whole value", () => {
    const records = [
      event({ seq: 10, type: "enter", payload: { args: [{ card: "[masked]", sku: "sku-1" }, 2] } }),
      event({ seq: 12, type: "exit", payload: { ret: "[masked]" } })
    ];
    const frame = detailAtCutoff(ok(seekPinned(pinReplay(records, snapshotRef({ watermark: 12 })), 12)).state, REF)!;
    const page = projectCanonicalPage(
      createTraceDatasetSnapshot({
        identity: {
          datasetId: REF.datasetId,
          projectId: REF.projectId,
          source: "live",
          watermarkSeq: 12,
          retentionEpoch: 0
        },
        records: records as never
      }),
      { projectionVersion: 2, traceId: REF.traceId }
    );
    const snapshot = evidenceFromCanonicalV2(page, REF, snapshotRef({ watermark: 12 }))!;

    // Partial: recorded, the withheld field still reads [masked], the rest is visible.
    expect(frame.args).toEqual({ state: "recorded", text: '[{"card":"[masked]","sku":"sku-1"},2]' });
    expect(frame.args).toEqual(snapshot.args);
    // Whole: masked in both.
    expect(frame.ret).toEqual({ state: "masked" });
    expect(snapshot.ret).toEqual({ state: "masked" });
  });
});
