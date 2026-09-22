/** Shared fixtures for the concrete source tests: a real portable export and its v2 pages. */
import { createInitialReplayState, createPortableExport, replayTo, type ReplayRecord } from "@kosmo-callflow/replay";
import { projectCanonicalPage, snapshotFromPortableExport } from "@kosmo-callflow/query/snapshot";
import type { CanonicalPageEnvelopeV2 } from "@kosmo-callflow/protocol";
import { checkoutRecords } from "./replay-records.js";

/** A portable export written by the shared exporter (so it is already export-redacted). */
export function portableExport(records: ReplayRecord[] = checkoutRecords()): Record<string, unknown> {
  const state = replayTo(records, Number.MAX_SAFE_INTEGER, createInitialReplayState({ datasetId: "local" }));
  const exported = createPortableExport({ datasetId: "local", projectId: "p", rootMode: "portable", records, state });
  return JSON.parse(JSON.stringify(exported)) as Record<string, unknown>;
}

/** The v2 canonical page of one trace, projected by the shared pure projector. */
export function canonicalV2(traceId = "t-1", records: ReplayRecord[] = checkoutRecords()): CanonicalPageEnvelopeV2 {
  return projectCanonicalPage(snapshotFromPortableExport(portableExport(records)), { projectionVersion: 2, traceId });
}
