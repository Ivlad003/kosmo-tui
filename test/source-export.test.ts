import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkCommand, effectiveCapabilities } from "../src/capabilities.js";
import { SourceError } from "../src/source-common.js";
import { createExportSource, EXPORT_MAX_BYTES, type ExportFs } from "../src/source-export.js";
import { openTargetSource } from "../src/source-open.js";
import { portableExport } from "./source-fixtures.js";
import { checkoutRecords, event } from "./replay-records.js";

const POLICY = { readOnly: false, noEval: false, print: false };
const signal = () => new AbortController().signal;

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "kosmo-tui-export-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function file(value: unknown, name = "trace.json"): Promise<string> {
  const target = path.join(tmp, name);
  await writeFile(target, typeof value === "string" ? value : JSON.stringify(value));
  return target;
}

async function failure(promise: Promise<unknown>): Promise<SourceError> {
  try {
    await promise;
  } catch (error) {
    return error as SourceError;
  }
  throw new Error("expected a failure");
}

describe("portable export source (4.2)", () => {
  it("normalizes the export through the shared importer into a projected, replayable snapshot", async () => {
    const source = createExportSource({ path: await file(portableExport()) });
    const opened = await source.open(signal());
    expect(opened.snapshot.datasetId).toMatch(/^export-[0-9a-f]{16}:local$/);
    expect(opened.stableDataset).toBe(true);
    expect(opened.firstPage.items).toEqual([
      expect.objectContaining({
        traceId: "t-1",
        sessionId: "s-1",
        datasetId: opened.snapshot.datasetId,
        status: "errored",
        spanCount: 2
      })
    ]);
    const caps = effectiveCapabilities(opened, source, POLICY);
    expect(caps).toMatchObject({
      projectionVersions: [1, 2],
      replay: { available: true },
      follow: { available: false, reason: "static-snapshot" },
      probes: { available: false, reason: "no-probe-records" }
    });

    const ref = opened.firstPage.items[0]!;
    const v2 = await source.canonical!(opened.snapshot, { kind: "trace", ref }, { version: 2 }, signal());
    expect(v2.version).toBe(2);
    expect(v2.envelope.dataset).toMatchObject({ source: "imported", datasetId: opened.snapshot.datasetId });
    const v1 = await source.canonical!(opened.snapshot, { kind: "trace", ref }, { version: 1 }, signal());
    expect(v1.envelope.projectionVersion).toBe(1);

    const records = await source.records!(opened.snapshot, { kind: "trace", ref }, { limit: 3 }, signal());
    expect(records.items.map((record) => record.seq)).toEqual([10, 12, 18]);
    const more = await source.records!(
      opened.snapshot,
      { kind: "trace", ref },
      { limit: 3, cursor: records.cursor },
      signal()
    );
    expect(more.items.map((record) => record.seq)).toEqual([20, 25]);
    expect(more.cursor).toBeNull();

    const evidence = await source.details!(opened.snapshot, { ...ref, spanId: "sp-2" }, signal());
    expect(evidence).toMatchObject({ status: "errored", nodeId: "src/pay.ts#charge", ref: { spanId: "sp-2" } });
  });

  it("keeps span refs across reopening an unchanged file and gives changed content a new identity", async () => {
    const target = await file(portableExport());
    const first = await createExportSource({ path: target }).open(signal());
    const again = await createExportSource({ path: target }).open(signal());
    expect(again.snapshot).toEqual(first.snapshot);
    expect(again.firstPage.items).toEqual(first.firstPage.items);
    const changed = await createExportSource({
      path: await file(portableExport(checkoutRecords().slice(0, 3)), "b.json")
    }).open(signal());
    expect(changed.snapshot.datasetId).not.toBe(first.snapshot.datasetId);
  });

  it("reports unsupported export versions and importer rejections explicitly", async () => {
    const future = await failure(
      createExportSource({ path: await file({ ...portableExport(), formatVersion: 2 }) }).open(signal())
    );
    expect(future).toMatchObject({ code: "unsupported-export-version" });
    expect(future.message).toMatch(/formatVersion 2 is not supported; supported: 1/);
    const missing = await failure(
      createExportSource({ path: await file({ records: [] }, "none.json") }).open(signal())
    );
    expect(missing.message).toMatch(/formatVersion null is not supported/);
    const broken = await failure(
      createExportSource({ path: await file({ ...portableExport(), rootMode: "absolute" }, "c.json") }).open(signal())
    );
    expect(broken).toMatchObject({ code: "invalid-export" });
    expect(broken.message).toMatch(/rejected by the shared importer/);
    expect(await failure(createExportSource({ path: await file("{not json", "d.json") }).open(signal()))).toMatchObject(
      { code: "invalid-export" }
    );
  });

  it("checks the 64 MiB cap before reading or parsing the file", async () => {
    expect(EXPORT_MAX_BYTES).toBe(64 * 1024 * 1024);
    const calls: string[] = [];
    const fs: ExportFs = {
      async size() {
        calls.push("size");
        return EXPORT_MAX_BYTES + 1;
      },
      async readBounded() {
        calls.push("read");
        throw new Error("must not read an oversized export");
      }
    };
    const error = await failure(createExportSource({ path: "/x/huge.json", fs }).open(signal()));
    expect(error).toMatchObject({ code: "export-too-large" });
    expect(error.message).toMatch(/it was not parsed/);
    expect(calls).toEqual(["size"]);

    // A file that grows between stat and read is caught by the bounded read.
    const growing: ExportFs = {
      size: async () => 10,
      readBounded: async (_path, max) => new Uint8Array(max + 1)
    };
    expect(
      await failure(createExportSource({ path: "/x/grow.json", fs: growing, maxBytes: 64 }).open(signal()))
    ).toMatchObject({
      code: "export-too-large"
    });

    // And a real file over a small cap never reaches JSON.parse (it is not even JSON).
    const big = await file(`{${"x".repeat(200)}`, "big.json");
    expect(await failure(createExportSource({ path: big, maxBytes: 100 }).open(signal()))).toMatchObject({
      code: "export-too-large"
    });
  });

  it("preserves the export redaction of the shared importer", async () => {
    const records = [
      event({ seq: 1, type: "enter", payload: { args: [{ token: "tok-live-123" }, "sk-abcdef123456", "[masked]"] } }),
      event({ seq: 2, type: "exit", payload: { ret: "Bearer eyJhbGciOi.secret" } })
    ];
    // Written raw (not through createPortableExport), so only the importer can redact it.
    const raw = { ...portableExport(records), records: JSON.parse(JSON.stringify(records)) };
    const source = createExportSource({ path: await file(raw) });
    const opened = await source.open(signal());
    const ref = { ...opened.firstPage.items[0]!, spanId: "sp-1" };
    const evidence = await source.details!(opened.snapshot, ref, signal());
    const text = JSON.stringify(evidence);
    for (const secret of ["tok-live-123", "sk-abcdef123456", "eyJhbGciOi.secret"]) expect(text).not.toContain(secret);
    expect(text).toContain("redacted");
    const replay = JSON.stringify(
      (await source.records!(opened.snapshot, { kind: "trace", ref }, { limit: 10 }, signal())).items
    );
    for (const secret of ["tok-live-123", "sk-abcdef123456", "eyJhbGciOi.secret"]) expect(replay).not.toContain(secret);
  });

  it("offers no replay when the export has no records, and probes when it carries probe records", async () => {
    const empty = { ...portableExport(), records: [] };
    const source = createExportSource({ path: await file(empty) });
    const opened = await source.open(signal());
    const caps = effectiveCapabilities(opened, source, POLICY);
    expect(caps.replay).toEqual({ available: false, reason: "no-replay-records" });
    expect(checkCommand(caps, "seek")).toMatchObject({ ok: false, notice: "seek: unavailable(no-replay-records)" });

    const withProbe = portableExport();
    (withProbe.records as unknown[]).push({
      seq: 30,
      localSeq: 30,
      sessionId: "s-1",
      traceId: "t-1",
      spanId: "sp-1",
      probeId: "pr-1",
      ordinal: 0,
      expression: "cart.total",
      status: "recorded",
      value: 42
    });
    const probing = createExportSource({ path: await file(withProbe, "probe.json") });
    const probeOpen = await probing.open(signal());
    expect(effectiveCapabilities(probeOpen, probing, POLICY).probes).toEqual({ available: true });
    const ref = probeOpen.firstPage.items[0]!;
    const probes = await probing.probes!(probeOpen.snapshot, { kind: "trace", ref }, { limit: 10 }, signal());
    expect(probes.items).toEqual([
      expect.objectContaining({
        probeId: "pr-1",
        probeSeq: 30,
        label: "cart.total",
        value: { state: "recorded", text: "42" }
      })
    ]);
    // Probe records never leak into the replay timeline.
    const records = await probing.records!(probeOpen.snapshot, { kind: "trace", ref }, { limit: 100 }, signal());
    expect(records.items.map((record) => record.seq)).toEqual([10, 12, 18, 20, 25]);
  });

  it("is what openTargetSource opens for an export target", async () => {
    const opened = await openTargetSource({
      target: { kind: "export", path: await file(portableExport()) },
      project: null,
      env: {},
      cwd: tmp
    });
    expect(opened.ok && opened.source.kind).toBe("export");
    const sqlite = await openTargetSource({
      target: { kind: "sqlite", path: "/x.sqlite" },
      project: null,
      env: {},
      cwd: tmp
    });
    expect(sqlite).toMatchObject({ ok: false, code: "sqlite-reader-pending", exitCode: 2 });
  });
});
