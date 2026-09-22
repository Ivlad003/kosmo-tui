/**
 * The TraceSource contract (design D4): pages carry coverage/truncated and an opaque
 * cursor bound to source, snapshot, projection version, filter and retention epoch.
 */
import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, filterKey, type CursorBinding } from "../src/source.js";
import { createFakeSource } from "./source-fake.js";
import { trace } from "./view-fixtures.js";

const binding: CursorBinding = {
  sourceId: "export:/tmp/a.json",
  snapshotId: "snap-1",
  retentionEpoch: 3,
  projectionVersion: 2,
  filter: { errorsOnly: true, nodeId: "src/a.ts#run" }
};

describe("opaque cursor", () => {
  it("round-trips only under its own binding", () => {
    const cursor = encodeCursor(binding, "40");
    expect(decodeCursor(cursor, binding)).toEqual({ ok: true, position: "40" });
    // Key order of the filter is not part of the identity.
    expect(decodeCursor(cursor, { ...binding, filter: { nodeId: "src/a.ts#run", errorsOnly: true } })).toEqual({
      ok: true,
      position: "40"
    });
  });

  it.each([
    [{ sourceId: "sqlite:/tmp/b.db" }, "foreign-source"],
    [{ snapshotId: "snap-2" }, "snapshot-changed"],
    [{ retentionEpoch: 4 }, "epoch-changed"],
    [{ projectionVersion: 1 as const }, "version-changed"],
    [{ filter: { errorsOnly: true } }, "filter-changed"]
  ])("rejects a cursor after %o changes (%s)", (change, reason) => {
    const cursor = encodeCursor(binding, "40");
    expect(decodeCursor(cursor, { ...binding, ...change })).toEqual({ ok: false, reason });
  });

  it("rejects garbage as malformed rather than starting over", () => {
    expect(decodeCursor("not-a-cursor", binding)).toEqual({ ok: false, reason: "malformed" });
    expect(decodeCursor(Buffer.from('{"v":2}').toString("base64url"), binding)).toEqual({
      ok: false,
      reason: "malformed"
    });
  });

  it("treats absent, undefined and false filter fields alike", () => {
    expect(filterKey({ errorsOnly: false, search: undefined })).toBe(filterKey({}));
    expect(filterKey({ errorsOnly: true })).not.toBe(filterKey({}));
  });
});

describe("fake source", () => {
  const rows = Array.from({ length: 5 }, (_, i) => trace(`t-${i}`, i, i % 2 === 0 ? "errored" : "complete"));

  it("pages with coverage, truncated and a cursor that another source refuses", async () => {
    const source = createFakeSource({ traces: rows, pageSize: 2 });
    const signal = new AbortController().signal;
    const opened = await source.open(signal);
    expect(opened.firstPage.items).toHaveLength(2);
    expect(opened.firstPage.truncated).toBe(true);
    expect(opened.firstPage.coverage).toEqual({ scope: "partial", loaded: 2, total: 5 });

    const next = await source.traces(opened.snapshot, { limit: 2, cursor: opened.firstPage.cursor }, signal);
    expect(next.items.map((row) => row.traceId)).toEqual(["t-2", "t-3"]);

    const other = createFakeSource({ traces: rows, pageSize: 2, sourceId: "fake:other" });
    await expect(other.traces(opened.snapshot, { limit: 2, cursor: opened.firstPage.cursor }, signal)).rejects.toThrow(
      "foreign-source"
    );
    // The same source after a retention epoch change refuses the old cursor too.
    await expect(
      source.traces({ ...opened.snapshot, retentionEpoch: 2 }, { limit: 2, cursor: opened.firstPage.cursor }, signal)
    ).rejects.toThrow("epoch-changed");
    // And a cursor issued without a filter is not valid for a filtered page.
    await expect(
      source.traces(
        opened.snapshot,
        { limit: 2, cursor: opened.firstPage.cursor, filter: { errorsOnly: true } },
        signal
      )
    ).rejects.toThrow("filter-changed");
  });

  it("honours an aborted signal and counts close calls", async () => {
    const source = createFakeSource();
    const controller = new AbortController();
    controller.abort("stop");
    await expect(source.open(controller.signal)).rejects.toBe("stop");
    await source.close();
    await source.close();
    expect(source.closeCalls()).toBe(2);
    expect(source.records).toBeUndefined();
  });
});
