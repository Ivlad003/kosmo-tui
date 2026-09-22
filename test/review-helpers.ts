import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseTraceText,
  type TraceTextDocumentV1,
  type TraceTextDocumentV2,
  type TraceTextSpanItemV2
} from "@kosmo-callflow/protocol";
import { nodeReviewEnv, nodeReviewFs, type ReviewEnv, type ReviewFs } from "../src/review.js";
import type { FindingInput } from "../src/review.js";

export const ESC = String.fromCharCode(27);

export async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "kosmo-tui-review-"));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Every path under `root` (relative, sorted) with file contents; directories end with `/`. */
export async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const name of (await readdir(dir)).sort()) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full);
      if ((await stat(full)).isDirectory()) {
        out[`${rel}/`] = "";
        await walk(full);
      } else out[rel] = await readFile(full, "utf8");
    }
  };
  await walk(root);
  return out;
}

export type FsFault = { op: keyof ReviewFs; code: string; match?: (file: string) => boolean; times?: number };

/** Real filesystem with injectable errno failures and a call log. */
export function faultyFs(faults: FsFault[] = [], calls: string[] = []): ReviewFs & { faults: FsFault[] } {
  const fs = { faults } as ReviewFs & { faults: FsFault[] };
  for (const op of Object.keys(nodeReviewFs) as Array<keyof ReviewFs>) {
    (fs as Record<string, unknown>)[op] = async (...args: string[]) => {
      calls.push(`${op} ${path.basename(args[0] ?? "")}`);
      const fault = fs.faults.find(
        (candidate) => candidate.op === op && (candidate.match?.(args[0] ?? "") ?? true) && (candidate.times ?? 1) > 0
      );
      if (fault !== undefined) {
        fault.times = (fault.times ?? 1) - 1;
        throw Object.assign(new Error(`${fault.code}: injected ${op}`), { code: fault.code });
      }
      return (nodeReviewFs[op] as (...a: string[]) => Promise<unknown>)(...args);
    };
  }
  return fs;
}

export function fakeEnv(overrides: Partial<ReviewEnv> = {}): ReviewEnv & { clock: { now: Date } } {
  const clock = { now: new Date("2026-09-22T16:40:00.000Z") };
  return {
    ...nodeReviewEnv,
    now: () => new Date(clock.now),
    clock,
    ...overrides
  };
}

export function v2Span(overrides: Partial<TraceTextSpanItemV2> = {}): TraceTextSpanItemV2 {
  const ref = { datasetId: "imported:shop", projectId: "shop", sessionId: "s1", traceId: "t1", spanId: "sp1" };
  const none = { state: "not-recorded" as const, reason: null, value: null };
  return {
    kind: "span",
    ref,
    spanKind: null,
    node: "src/cart.ts#checkout",
    display: "checkout",
    runtime: "node",
    service: null,
    firstSeq: 41,
    lastSeq: 42,
    state: "complete",
    stateReason: null,
    parent: { state: "root", relation: null, ref: null, requested: null, reason: null },
    coverage: "full",
    markers: ["masked"],
    source: { state: "available", file: "src/cart.ts", line: 12, column: 3 },
    framework: {
      state: "not-recorded",
      reason: null,
      name: null,
      role: null,
      transport: null,
      phase: null,
      completion: null,
      route: null,
      method: null,
      status: null,
      class: null,
      handler: null,
      component: null,
      scope: null,
      contextId: null,
      cacheStatus: null,
      cacheReason: null,
      requestType: null,
      actionId: null,
      routeType: null,
      routePath: null,
      renderSource: null,
      revalidateReason: null,
      digest: null,
      rewrite: null,
      redirect: null,
      headersMutated: [],
      masked: [],
      unsupported: [],
      ignored: 0
    },
    args: { state: "masked", reason: null, value: null },
    ret: { state: "recorded", reason: null, value: '{"ok":true}' },
    error: none,
    duration: { state: "unavailable", reason: "no-duration-evidence", ms: null, source: null, domain: null },
    issues: [],
    causal: [],
    ...overrides
  };
}

export function v2Document(items: TraceTextSpanItemV2[] = [v2Span()], watermark = 5010): TraceTextDocumentV2 {
  return {
    dialect: "kosmo.trace-text/v2",
    projectionVersion: 2,
    ordering: "causal",
    depth: "call",
    detail: 2,
    values: "requested",
    truncated: false,
    dataset: {
      datasetId: "imported:shop",
      project: "shop",
      sourceRevision: "rev-42",
      traceId: "t1",
      watermark,
      cutoff: null
    },
    coverage: { state: "full", gaps: [] },
    items,
    cursor: null,
    cursorIdentity: null
  };
}

const V1_LISP = `(kosmo.trace-text/v1
  :projection-version 1
  :ordering seq
  :dataset (dataset :project "shop" :source-revision "rev-42" :trace-id (trace-ref "t1") :watermark 5010)
  :coverage (coverage :state truncated :gaps ((gap :reason output-byte-cap :limit 51200)))
  :items (
    (span :ref (span-ref "t1" "sp1") :node (node-ref "src/cart.ts#checkout") :callsite nil :seq 41 :state success :event exit :parent (parent :state root :ref nil :requested nil :reason nil) :coverage truncated :value (masked :reason secret) :causal () :markers (masked truncated))
  )
  :cursor "cursor:after-sp1"
  :cursor-identity "cursor-identity:v1:project=shop:trace=t1:watermark=5010:retention=7")`;

export function v1Document(): TraceTextDocumentV1 {
  const parsed = parseTraceText(V1_LISP, { dialect: "lisp" });
  if (!parsed.ok) throw new Error(`fixture does not parse: ${parsed.reason}`);
  return parsed.data;
}

export const SOURCE_REF = { projectId: "shop", datasetId: "imported:shop", sourceRevision: "rev-42" };

export function findingInput(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    note: "checkout returns ok while the cart is empty",
    ref: { datasetId: "imported:shop", projectId: "shop", sessionId: "s1", traceId: "t1", spanId: "sp1" },
    node: "src/cart.ts#checkout",
    snapshot: { snapshotId: "snap-1", watermark: 5010, retentionEpoch: 7, seq: 41 },
    source: { file: "src/cart.ts", line: 12, column: 3 },
    evidence: v2Document(),
    ...overrides
  };
}
