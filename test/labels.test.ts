/**
 * Task 5.2: semantic labels from the recorded spanKind, Nest interceptor invocation vs
 * subscription (`interceptor↩` only with terminal evidence of a real subscription),
 * count-level / masked / missing framework data, and the v1 fallback.
 */
import { describe, expect, it } from "vitest";
import {
  RETURN_MARK,
  fieldText,
  frameworkField,
  frameworkSummary,
  legacySpanLabel,
  spanLabelsV2
} from "../src/labels.js";
import { spanKey } from "../src/view-state.js";
import { event, nestTrace, project, spanItem } from "./request-fixtures.js";

function labelOf(page: ReturnType<typeof project>, spanId: string): string {
  return spanLabelsV2(page).get(spanKey(spanItem(page, spanId).span))!.text;
}

describe("labels from the recorded spanKind", () => {
  const page = nestTrace();

  it("reads guard/handler/http from spanKind, never from the item discriminator", () => {
    expect(spanItem(page, "guard").kind).toBe("span");
    expect(labelOf(page, "guard")).toBe("guard");
    expect(labelOf(page, "handler")).toBe("handler");
    expect(labelOf(page, "req")).toBe("http");
  });

  it("every framework kind keeps its own label", () => {
    const kinds = [
      "middleware",
      "guard",
      "interceptor",
      "pipe",
      "handler",
      "filter",
      "route",
      "server-action",
      "rsc",
      "fetch"
    ];
    const t = "t-kinds";
    const events = kinds.map((kind, index) =>
      event({
        seq: index + 1,
        sessionId: "s",
        traceId: t,
        spanId: `k${index}`,
        parentSpanId: null,
        type: "enter",
        kind,
        nodeId: `src/${kind}.ts#run`
      })
    );
    const kindsPage = project(t, events);
    expect(kinds.map((_, index) => labelOf(kindsPage, `k${index}`))).toEqual(
      kinds.map((kind) => (kind === "interceptor" ? "interceptor" : kind))
    );
  });

  it("an interceptor invocation whose exit says phase post is NOT shown as a return", () => {
    expect(labelOf(page, "icpt")).toBe("interceptor");
    expect(labelOf(page, "icpt")).not.toContain(RETURN_MARK);
  });

  it("an unknown recorded kind is unavailable(no-span-kind), never a guessed function", () => {
    const t = "t-odd";
    const odd = project(t, [
      event({ seq: 1, sessionId: "s", traceId: t, spanId: "w", parentSpanId: null, type: "enter", kind: "wizard" })
    ]);
    expect(spanItem(odd, "w").spanKind).toBeNull();
    expect(labelOf(odd, "w")).toBe("unavailable(no-span-kind)");
  });
});

describe("Nest subscription nesting", () => {
  const t = "t-sub";
  const s = { sessionId: "s-api", traceId: t } as const;
  const icpt = "src/timing.interceptor.ts#TimingInterceptor.intercept";
  const invocation = [
    event({
      ...s,
      seq: 1,
      spanId: "req",
      parentSpanId: null,
      type: "enter",
      kind: "http",
      payload: { framework: { name: "nest", role: "request" } }
    }),
    event({
      ...s,
      seq: 2,
      spanId: "inv",
      parentSpanId: "req",
      type: "enter",
      kind: "interceptor",
      nodeId: icpt,
      payload: { framework: { name: "nest", role: "step", component: "TimingInterceptor", phase: "pre" } }
    }),
    event({ ...s, seq: 3, spanId: "inv", parentSpanId: "req", type: "exit", kind: "interceptor", nodeId: icpt }),
    event({
      ...s,
      seq: 4,
      spanId: "sub",
      parentSpanId: "inv",
      type: "enter",
      kind: "interceptor",
      nodeId: icpt,
      payload: { framework: { name: "nest", role: "step", component: "TimingInterceptor", phase: "stream" } }
    })
  ];

  it("a finished subscription is interceptor↩, its invocation stays interceptor", () => {
    const page = project(t, [
      ...invocation,
      event({
        ...s,
        seq: 5,
        spanId: "sub",
        parentSpanId: "inv",
        type: "exit",
        kind: "interceptor",
        nodeId: icpt,
        payload: { framework: { name: "nest", phase: "finalize", completion: "completed" } }
      })
    ]);
    expect(labelOf(page, "inv")).toBe("interceptor");
    expect(labelOf(page, "sub")).toBe(`interceptor${RETURN_MARK}`);
    expect(RETURN_MARK.codePointAt(0)).toBe(0x21a9);
    const sub = spanLabelsV2(page).get(spanKey(spanItem(page, "sub").span))!;
    expect(sub.interceptor).toEqual({ role: "subscription", terminal: true });
  });

  it("a subscription without terminal evidence is not a return", () => {
    const page = project(t, invocation);
    expect(labelOf(page, "sub")).toBe("interceptor(stream, pending)");
    const retained = project(t, invocation, { retentionEpoch: 1 });
    expect(labelOf(retained, "sub")).toBe("interceptor(stream, unknown(retention))");
  });

  it("a nested interceptor's invocation inside an outer subscription is an invocation", () => {
    const inner = "src/cache.interceptor.ts#CacheInterceptor.intercept";
    const page = project(t, [
      ...invocation,
      event({
        ...s,
        seq: 5,
        spanId: "inv2",
        parentSpanId: "sub",
        type: "enter",
        kind: "interceptor",
        nodeId: inner,
        payload: { framework: { name: "nest", role: "step", component: "CacheInterceptor", phase: "pre" } }
      }),
      event({
        ...s,
        seq: 6,
        spanId: "inv2",
        parentSpanId: "sub",
        type: "exit",
        kind: "interceptor",
        nodeId: inner,
        payload: { framework: { name: "nest", phase: "post" } }
      }),
      event({
        ...s,
        seq: 7,
        spanId: "sub",
        parentSpanId: "inv",
        type: "exit",
        kind: "interceptor",
        nodeId: icpt,
        payload: { framework: { name: "nest", phase: "post", completion: "completed" } }
      })
    ]);
    expect(labelOf(page, "inv2")).toBe("interceptor");
    expect(labelOf(page, "sub")).toBe(`interceptor${RETURN_MARK}`);
  });
});

describe("framework evidence", () => {
  const t = "t-fw";
  const s = { sessionId: "s-web", traceId: t } as const;
  const page = project(t, [
    event({
      ...s,
      seq: 1,
      spanId: "mw",
      parentSpanId: null,
      type: "enter",
      kind: "middleware",
      level: "count",
      nodeId: "src/server.ts#cors"
    }),
    event({
      ...s,
      seq: 2,
      spanId: "mw",
      parentSpanId: null,
      type: "exit",
      kind: "middleware",
      level: "count",
      nodeId: "src/server.ts#cors"
    }),
    event({
      ...s,
      seq: 3,
      spanId: "route",
      parentSpanId: null,
      type: "enter",
      kind: "route",
      payload: { framework: { name: "express", role: "step", route: "[masked]", method: "GET" } }
    }),
    event({
      ...s,
      seq: 4,
      spanId: "whole",
      parentSpanId: null,
      type: "enter",
      kind: "handler",
      payload: { framework: "[masked]" }
    }),
    event({ ...s, seq: 5, spanId: "none", parentSpanId: null, type: "enter", kind: "pipe" }),
    event({
      ...s,
      seq: 6,
      spanId: "bad",
      parentSpanId: null,
      type: "enter",
      kind: "handler",
      payload: { framework: { name: "express", status: 999 } }
    })
  ]);

  it("count level: kind shown, framework and args not-recorded(count-level)", () => {
    const item = spanItem(page, "mw");
    expect(labelOf(page, "mw")).toBe("middleware");
    expect(frameworkSummary(item.framework)).toBe("framework: not-recorded(count-level)");
    expect(fieldText(frameworkField(item.framework, "route"))).toBe("not-recorded(count-level)");
    expect(item.args).toEqual({ state: "not-recorded", reason: "count-level" });
  });

  it("a masked field and masked metadata read masked, not as a route", () => {
    const route = spanItem(page, "route");
    expect(fieldText(frameworkField(route.framework, "route"))).toBe("masked");
    expect(fieldText(frameworkField(route.framework, "method"))).toBe("GET");
    expect(frameworkSummary(route.framework)).toContain("route=masked");
    const whole = spanItem(page, "whole");
    expect(frameworkSummary(whole.framework)).toBe("framework: masked");
    expect(fieldText(frameworkField(whole.framework, "route"))).toBe("masked");
  });

  it("missing and invalid metadata are explicit", () => {
    expect(frameworkSummary(spanItem(page, "none").framework)).toBe("framework: not-recorded(no-framework-metadata)");
    expect(frameworkSummary(spanItem(page, "bad").framework)).toBe(
      "framework: unavailable(invalid-framework-metadata)"
    );
    // A recorded payload that simply lacks a field says so rather than inventing one.
    expect(fieldText(frameworkField(spanItem(page, "route").framework, "status"))).toBe(
      "unavailable(not-recorded-field)"
    );
  });
});

describe("v1 fallback", () => {
  const ref = { datasetId: "d", projectId: "p", sessionId: "s", traceId: "t", spanId: "x" };

  it("labels a legacy kind as such and says when there is none", () => {
    expect(legacySpanLabel({ ...ref, spanKind: "function" })).toMatchObject({
      text: "function (v1)",
      source: "legacy-kind"
    });
    expect(legacySpanLabel({ ...ref, spanKind: "http" }).text).toBe("http (v1)");
    const none = legacySpanLabel(ref);
    expect(none).toMatchObject({ spanKind: null, text: "unavailable(v1-no-span-kind)", source: "unavailable" });
    expect(none.text).not.toBe("function");
  });
});
