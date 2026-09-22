/** Durable record builders for pinned-replay tests (shape of @kosmo-callflow/protocol records). */
import type { ReplayRecord } from "@kosmo-callflow/replay";

export type EventSpec = {
  seq: number;
  type?: "enter" | "exit" | "error" | "suspend" | "commit";
  sessionId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string | null;
  nodeId?: string;
  payload?: Record<string, unknown>;
  clock?: { domain: "monotonic" | "wall"; value: number } | null;
};

export function event(spec: EventSpec): ReplayRecord {
  const sessionId = spec.sessionId ?? "s-1";
  const record: Record<string, unknown> = {
    v: 1,
    projectId: "p",
    localSeq: spec.seq,
    sessionId,
    traceId: spec.traceId ?? "t-1",
    spanId: spec.spanId ?? "sp-1",
    parentSpanId: spec.parentSpanId ?? null,
    type: spec.type ?? "enter",
    nodeId: spec.nodeId ?? "src/cart.ts#checkout",
    kind: "function",
    runtime: "node",
    serviceName: "api",
    ts: spec.seq,
    level: "full",
    payload: spec.payload ?? {},
    flags: {},
    seq: spec.seq,
    committedAtWall: 1_700_000_000_000 + spec.seq
  };
  if (spec.clock !== null) record.clock = spec.clock ?? { domain: "monotonic", value: spec.seq * 10 };
  return record as unknown as ReplayRecord;
}

export function supplement(
  seq: number,
  payload: Record<string, unknown>,
  spanId = "sp-1",
  traceId = "t-1"
): ReplayRecord {
  return {
    v: 1,
    projectId: "p",
    sessionId: "s-1",
    observationSeq: seq,
    traceId,
    spanId,
    type: "payload-supplement",
    originalLocalSeq: 1,
    payload,
    seq
  } as unknown as ReplayRecord;
}

/** enter@10 (args), exit@18 (ret), error@20 on a child, supplement@25 with a late value. */
export function checkoutRecords(): ReplayRecord[] {
  return [
    event({ seq: 10, type: "enter", payload: { args: ["cart-1"] } }),
    event({ seq: 12, type: "enter", spanId: "sp-2", parentSpanId: "sp-1", nodeId: "src/pay.ts#charge" }),
    event({ seq: 18, type: "exit", payload: { ret: { ok: true } } }),
    event({
      seq: 20,
      type: "error",
      spanId: "sp-2",
      parentSpanId: "sp-1",
      nodeId: "src/pay.ts#charge",
      payload: { error: { message: "card declined" } }
    }),
    supplement(25, { args: ["cart-1", { late: "supplement" }] })
  ];
}
