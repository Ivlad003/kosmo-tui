import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type RecordInput = {
  seq: number;
  spanId: string;
  parentSpanId: string | null;
  type: "enter" | "exit" | "error";
  nodeId: string;
  payload?: Record<string, unknown>;
  traceId?: string;
  sessionId?: string;
};

/**
 * One trace, session s1 / t1:
 *   a src/app.ts#handle            args ["req"], ret "ok"
 *   └ b src/cart.ts#load           args {apiToken} (redacted by the export), error "boom"
 *     └ c src/db.ts#query          args ["[masked]"], ret 42
 *   d src/late.ts#x (parent "gone" is not in the export: an orphan)
 */
export const BASE_RECORDS: RecordInput[] = [
  { seq: 1, spanId: "a", parentSpanId: null, type: "enter", nodeId: "src/app.ts#handle", payload: { args: ["req"] } },
  {
    seq: 2,
    spanId: "b",
    parentSpanId: "a",
    type: "enter",
    nodeId: "src/cart.ts#load",
    payload: { args: { apiToken: "tok-live-7f3a9c" } }
  },
  { seq: 3, spanId: "b", parentSpanId: "a", type: "error", nodeId: "src/cart.ts#load", payload: { message: "boom" } },
  { seq: 4, spanId: "c", parentSpanId: "b", type: "enter", nodeId: "src/db.ts#query", payload: { args: ["[masked]"] } },
  { seq: 5, spanId: "c", parentSpanId: "b", type: "exit", nodeId: "src/db.ts#query", payload: { ret: 42 } },
  { seq: 6, spanId: "a", parentSpanId: null, type: "exit", nodeId: "src/app.ts#handle", payload: { ret: "ok" } },
  { seq: 7, spanId: "d", parentSpanId: "gone", type: "enter", nodeId: "src/late.ts#x", payload: { args: [] } }
];

export function portableExport(records: RecordInput[] = BASE_RECORDS): Record<string, unknown> {
  const traces = [...new Set(records.map((record) => `${record.sessionId ?? "s1"}\u0000${record.traceId ?? "t1"}`))];
  return {
    formatVersion: 1,
    datasetId: "ds",
    projectId: "shop",
    rootMode: "portable",
    completeness: { retentionEpoch: 1, earliestSeq: 1, gaps: [] },
    graph: {},
    traces: traces.map((key) => {
      const [sessionId, traceId] = key.split("\u0000") as [string, string];
      const own = records.filter((r) => (r.sessionId ?? "s1") === sessionId && (r.traceId ?? "t1") === traceId);
      return {
        traceId,
        sessionId,
        projectId: "shop",
        firstSeq: Math.min(...own.map((r) => r.seq)),
        lastSeq: Math.max(...own.map((r) => r.seq)),
        spans: {},
        errors: [],
        gaps: []
      };
    }),
    records: records.map((record) => ({
      seq: record.seq,
      localSeq: record.seq,
      sessionId: record.sessionId ?? "s1",
      traceId: record.traceId ?? "t1",
      spanId: record.spanId,
      parentSpanId: record.parentSpanId,
      type: record.type,
      nodeId: record.nodeId,
      ts: record.seq * 10,
      payload: record.payload ?? {}
    }))
  };
}

export async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "kosmo-tui-eval-"));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function writeExport(
  dir: string,
  value: unknown = portableExport(),
  name = "export.json"
): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

/** True while a process with this pid exists (including an unreaped zombie). */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
