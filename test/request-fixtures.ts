/**
 * Canonical v2 fixtures for the request selector, labels and depth tests (tasks 5.1-5.3).
 *
 * Every page here is produced by the kosmo-callflow protocol projector
 * (`projectCanonicalTraceV2`) from durable runtime records, never written by hand, so the
 * tests read exactly what a daemon, export or stream source would hand the TUI.
 */
import {
  projectCanonicalTraceV2,
  type CanonicalPageEnvelopeV2,
  type CanonicalSpanProjectionItemV2,
  type CanonicalTraceV2Input,
  type CanonicalV2SourceEvent
} from "@kosmo-callflow/protocol";

export const PROJECT = "shop";
export const DATASET = `live:${PROJECT}`;

type EventInput = Omit<
  CanonicalV2SourceEvent,
  "projectId" | "serviceName" | "localSeq" | "nodeId" | "runtime" | "level" | "payload" | "flags"
> &
  Partial<CanonicalV2SourceEvent>;

export function event(input: EventInput): CanonicalV2SourceEvent {
  return {
    projectId: PROJECT,
    serviceName: "api",
    localSeq: input.seq,
    nodeId: "src/app.ts#handler",
    runtime: "node",
    level: "shallow",
    payload: {},
    flags: {},
    ...input
  };
}

export function dataset(
  watermarkSeq: number,
  options: { retentionEpoch?: number; source?: "live" | "imported" } = {}
): CanonicalTraceV2Input["dataset"] {
  return {
    datasetId: DATASET,
    projectId: PROJECT,
    source: options.source ?? "live",
    graphRevision: `static-0:seq-${watermarkSeq}`,
    watermarkSeq,
    retentionEpoch: options.retentionEpoch ?? 0
  };
}

export function project(
  traceId: string,
  events: CanonicalV2SourceEvent[],
  options: {
    retentionEpoch?: number;
    source?: "live" | "imported";
    lossRanges?: CanonicalTraceV2Input["lossRanges"];
    supplements?: CanonicalTraceV2Input["supplements"];
  } = {}
): CanonicalPageEnvelopeV2 {
  const watermark = Math.max(0, ...events.map((entry) => entry.seq), ...(options.supplements ?? []).map((s) => s.seq));
  return projectCanonicalTraceV2({
    dataset: dataset(watermark, options),
    traceId,
    events,
    ...(options.lossRanges ? { lossRanges: options.lossRanges } : {}),
    ...(options.supplements ? { supplements: options.supplements } : {})
  });
}

export function spanItem(
  page: CanonicalPageEnvelopeV2,
  spanId: string,
  sessionId?: string
): CanonicalSpanProjectionItemV2 {
  const item = page.items.find(
    (candidate): candidate is CanonicalSpanProjectionItemV2 =>
      candidate.kind === "span" &&
      candidate.span.spanId === spanId &&
      (sessionId === undefined || candidate.span.sessionId === sessionId)
  );
  if (item === undefined) throw new Error(`fixture: no span ${spanId}`);
  return item;
}

/**
 * One browser click that caused two inbound requests with the same traceId: the browser
 * session holds the click and two fetches; the api session holds the two requests.
 */
export function distributedTrace(): CanonicalPageEnvelopeV2 {
  const t = "t-dist";
  const browser = { sessionId: "s-web", traceId: t, runtime: "browser", serviceName: "web" } as const;
  const api = { sessionId: "s-api", traceId: t } as const;
  return project(t, [
    event({
      ...browser,
      seq: 1,
      spanId: "click",
      parentSpanId: null,
      type: "enter",
      kind: "component",
      nodeId: "src/ui/Cart.tsx#Cart.onCheckout"
    }),
    event({
      ...browser,
      seq: 2,
      spanId: "f1",
      parentSpanId: "click",
      type: "enter",
      kind: "fetch",
      nodeId: "src/ui/api.ts#getCart"
    }),
    event({
      ...browser,
      seq: 3,
      spanId: "f2",
      parentSpanId: "click",
      type: "enter",
      kind: "fetch",
      nodeId: "src/ui/api.ts#postOrder"
    }),
    event({
      ...api,
      seq: 4,
      spanId: "r1",
      parentSpanId: "f1",
      type: "enter",
      kind: "http",
      nodeId: "http#GET",
      payload: { framework: { name: "nest", role: "request", transport: "http", method: "GET" } }
    }),
    event({
      ...api,
      seq: 5,
      spanId: "r2",
      parentSpanId: "f2",
      type: "enter",
      kind: "http",
      nodeId: "http#POST",
      payload: { framework: { name: "nest", role: "request", transport: "http", method: "POST", route: "/orders" } }
    }),
    event({
      ...api,
      seq: 6,
      spanId: "r1",
      parentSpanId: "f1",
      type: "exit",
      kind: "http",
      nodeId: "http#GET",
      payload: { durationMs: 12, framework: { name: "nest", route: "/cart/:id", status: 200, completion: "finish" } }
    }),
    event({
      ...api,
      seq: 7,
      spanId: "r2",
      parentSpanId: "f2",
      type: "exit",
      kind: "http",
      nodeId: "http#POST",
      payload: { durationMs: 30, framework: { name: "nest", status: 201, completion: "finish" } }
    }),
    event({
      ...browser,
      seq: 8,
      spanId: "f1",
      parentSpanId: "click",
      type: "exit",
      kind: "fetch",
      nodeId: "src/ui/api.ts#getCart"
    }),
    event({
      ...browser,
      seq: 9,
      spanId: "f2",
      parentSpanId: "click",
      type: "exit",
      kind: "fetch",
      nodeId: "src/ui/api.ts#postOrder"
    }),
    event({
      ...browser,
      seq: 10,
      spanId: "click",
      parentSpanId: null,
      type: "exit",
      kind: "component",
      nodeId: "src/ui/Cart.tsx#Cart.onCheckout"
    })
  ]);
}

/** A single inbound request with only an enter record. */
export function openRequest(traceId: string, options: Parameters<typeof project>[2] = {}): CanonicalPageEnvelopeV2 {
  return project(
    traceId,
    [
      event({
        seq: 1,
        sessionId: "s-api",
        traceId,
        spanId: "req",
        parentSpanId: null,
        type: "enter",
        kind: "http",
        nodeId: "http#GET",
        payload: { framework: { name: "express", role: "request", method: "GET" } }
      })
    ],
    options
  );
}

/** Nest request: guard, interceptor invocation (exit carries phase post) and handler. */
export function nestTrace(): CanonicalPageEnvelopeV2 {
  const t = "t-nest";
  const s = { sessionId: "s-api", traceId: t } as const;
  return project(t, [
    event({
      ...s,
      seq: 1,
      spanId: "req",
      parentSpanId: null,
      type: "enter",
      kind: "http",
      nodeId: "http#GET",
      payload: { framework: { name: "nest", role: "request", transport: "http", method: "GET" } }
    }),
    event({
      ...s,
      seq: 2,
      spanId: "guard",
      parentSpanId: "req",
      type: "enter",
      kind: "guard",
      nodeId: "src/auth/auth.guard.ts#AuthGuard.canActivate",
      payload: { framework: { name: "nest", role: "step", component: "AuthGuard" } }
    }),
    event({
      ...s,
      seq: 3,
      spanId: "guard",
      parentSpanId: "req",
      type: "exit",
      kind: "guard",
      nodeId: "src/auth/auth.guard.ts#AuthGuard.canActivate",
      payload: { ret: true }
    }),
    event({
      ...s,
      seq: 4,
      spanId: "icpt",
      parentSpanId: "req",
      type: "enter",
      kind: "interceptor",
      nodeId: "src/logging.interceptor.ts#LoggingInterceptor.intercept",
      payload: { framework: { name: "nest", role: "step", component: "LoggingInterceptor", phase: "pre" } }
    }),
    event({
      ...s,
      seq: 5,
      spanId: "handler",
      parentSpanId: "icpt",
      type: "enter",
      kind: "handler",
      nodeId: "src/users/users.controller.ts#UsersController.findOne",
      payload: {
        framework: { name: "nest", role: "step", class: "UsersController", handler: "findOne", route: "/users/:id" }
      }
    }),
    event({
      ...s,
      seq: 6,
      spanId: "handler",
      parentSpanId: "icpt",
      type: "exit",
      kind: "handler",
      nodeId: "src/users/users.controller.ts#UsersController.findOne",
      payload: { ret: null }
    }),
    event({
      ...s,
      seq: 7,
      spanId: "icpt",
      parentSpanId: "req",
      type: "exit",
      kind: "interceptor",
      nodeId: "src/logging.interceptor.ts#LoggingInterceptor.intercept",
      payload: { framework: { name: "nest", phase: "post", completion: "completed" } }
    }),
    event({
      ...s,
      seq: 8,
      spanId: "req",
      parentSpanId: null,
      type: "exit",
      kind: "http",
      nodeId: "http#GET",
      payload: { framework: { name: "nest", route: "/users/:id", status: 200, completion: "finish" } }
    })
  ]);
}
