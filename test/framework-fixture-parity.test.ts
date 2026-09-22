/**
 * Task 8.5 (framework fixture parity): the recorded Express / Nest / Next(+Edge) fixtures that
 * kosmo-callflow publishes inside `@kosmo-callflow/protocol` (`fixtures/paired/**`) are read
 * from the INSTALLED package (the tarball boundary, not the kosmo-callflow source tree) and
 * rendered through the generic TUI: request rows, semantic labels and depth. The fixtures
 * are reproduced by the installed projector first, so the TUI reads exactly what a daemon,
 * export or stream source hands it.
 *
 * Next Node's paired fixture (`next-node-action-request`, shaped from a real
 * `next-otel-lifecycle` recording: an action POST request the OTel bridge gives `role:
 * request` and `requestType: action`, its RSC render and a cache-unknown `AppRender.fetch`
 * child) is read the same way as the Express/Nest/Edge pairs, not built inline.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalPageEnvelopeV2Schema,
  projectCanonicalTraceV2,
  type CanonicalPageEnvelopeV2,
  type CanonicalTraceV2Input
} from "@kosmo-callflow/protocol";
import { describe, expect, it } from "vitest";
import { depthView, formatDepthRow, type DepthGroupRow } from "../src/depth.js";
import { fieldText, frameworkField, spanLabelsV2 } from "../src/labels.js";
import { renderFrame } from "../src/render.js";
import { formatSelectorRow, requestRowsFromPage, selectorRows } from "../src/requests.js";
import { applyDelta, initialViewState, spanKey, type TraceRow } from "../src/view-state.js";
import { event, project, spanItem } from "./request-fixtures.js";
import { connected } from "./view-fixtures.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocolDir = path.dirname(
  createRequire(path.join(root, "package.json")).resolve("@kosmo-callflow/protocol/package.json")
);

type Manifest = { paired: Array<{ name: string; source: string; canonical: { v1: string; v2: string } }> };
const manifest = JSON.parse(readFileSync(path.join(protocolDir, "fixtures/manifest.json"), "utf8")) as Manifest;

function pair(name: string): { page: CanonicalPageEnvelopeV2; input: CanonicalTraceV2Input } {
  const entry = manifest.paired.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`published fixture missing: ${name}`);
  const read = (file: string) => JSON.parse(readFileSync(path.join(protocolDir, "fixtures", file), "utf8")) as unknown;
  const source = read(entry.source) as { input: CanonicalTraceV2Input };
  return { page: canonicalPageEnvelopeV2Schema.parse(read(entry.canonical.v2)), input: source.input };
}

function labels(page: CanonicalPageEnvelopeV2): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, label] of spanLabelsV2(page)) {
    const ref = JSON.parse(key) as string[];
    out[`${ref[2]}/${ref[4]}`] = `${label.text} | ${label.framework}`;
  }
  return out;
}

function groupRows(page: CanonicalPageEnvelopeV2): DepthGroupRow[] {
  return depthView([page], "module").rows.filter((row): row is DepthGroupRow => row.kind === "group");
}

function traceRowsOf(page: CanonicalPageEnvelopeV2): TraceRow[] {
  const seen = new Map<string, TraceRow>();
  for (const item of page.items) {
    if (item.kind !== "span") continue;
    const { datasetId, projectId, sessionId, traceId } = item.span;
    seen.set(`${sessionId}/${traceId}`, {
      datasetId,
      projectId,
      sessionId,
      traceId,
      status: "complete",
      startedAt: 1,
      spanCount: 1
    });
  }
  return [...seen.values()];
}

const EXPRESS = "express-late-route-count-middleware";
const NEST = "nest-guard-interceptor-request";
const EDGE = "edge-runtime-identity-collision";
const NEXT_NODE = "next-node-action-request";

describe("published framework fixtures come from the installed package", () => {
  it("the installed protocol ships the Express, Nest, Next/Edge and Next Node pairs", () => {
    expect(protocolDir).toContain(path.join("node_modules", "@kosmo-callflow", "protocol"));
    expect(manifest.paired.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([EXPRESS, NEST, EDGE, NEXT_NODE])
    );
  });

  it.each([EXPRESS, NEST, EDGE, NEXT_NODE])("%s: the installed projector reproduces the published v2 page", (name) => {
    const { page, input } = pair(name);
    expect(projectCanonicalTraceV2(input)).toEqual(page);
  });
});

describe("Express 4/5 recorded fixture in the TUI", () => {
  const { page } = pair(EXPRESS);

  it("one request row with the composed route, method and status; no invented duration", () => {
    const rows = requestRowsFromPage(page);
    expect(rows.map(formatSelectorRow)).toEqual([
      "#1 GET /api/users/:id 200 unavailable(no-duration-evidence) node complete"
    ]);
  });

  it("labels: http request, count-level middleware, masked route step, invalid metadata stays explicit", () => {
    expect(labels(page)).toEqual({
      "s-web/root": "http | framework: express method=GET route=/api/users/:id status=200 completion=finish",
      "s-web/mw": "middleware | framework: not-recorded(count-level)",
      "s-web/route": "route | framework: express route=masked",
      "s-web/bad": "handler | framework: unavailable(invalid-framework-metadata)"
    });
  });

  it("depth: module groups by kind with coverage markers, call depth shows pending steps as pending", () => {
    const rows = groupRows(page);
    const routes = rows.find((row) => row.label === "src/routes")!;
    expect(routes.byKind).toEqual([
      { spanKind: "handler", spans: 1 },
      { spanKind: "route", spans: 1 },
      { spanKind: "unknown", spans: 0 }
    ]);
    expect(formatDepthRow(routes)).toContain("coverage=masked");
    expect(formatDepthRow(rows.find((row) => row.label === "src")!)).toContain("coverage=count");
    const calls = depthView([page], "call").rows.map(formatDepthRow);
    expect(calls).toContain("route src/routes/users.ts#getUser running unavailable(pending)");
  });
});

describe("Nest 11 HTTP (Express platform) recorded fixture in the TUI", () => {
  const { page } = pair(NEST);

  it("one request row carrying the producer's lifecycle issue", () => {
    expect(requestRowsFromPage(page).map(formatSelectorRow)).toEqual([
      "#1 GET /users/:id 200 unavailable(no-duration-evidence) node complete issues=headers-already-sent"
    ]);
  });

  it("guard / interceptor invocation / handler labels with component and class.handler", () => {
    expect(labels(page)).toEqual({
      "s-api/req": "http | framework: nest method=GET route=/users/:id status=200 completion=finish",
      "s-api/guard": "guard | framework: nest AuthGuard",
      // phase post without a recorded phase-pre parent invocation is not a subscription return.
      "s-api/icpt": "interceptor | framework: nest LoggingInterceptor phase=post completion=completed",
      "s-api/handler": "handler | framework: nest UsersController.findOne route=/users/:id"
    });
    expect(fieldText(frameworkField(spanItem(page, "handler").framework, "contextId"))).toBe("ctx-7");
  });

  it("depth: file-based module fallback (no nest-adapter mapping) with recorded durations only", () => {
    const rows = groupRows(page);
    expect(formatDepthRow(rows.find((row) => row.label === "src/users")!)).toContain(
      "sum(inclusive)=4.5ms over 1 span(s)"
    );
    expect(formatDepthRow(rows.find((row) => row.label === "src")!)).toContain(
      "sum(inclusive)=unavailable(no-duration-evidence)"
    );
    expect(rows.every((row) => row.mapping.fallback === "no-logical-mapping")).toBe(true);
  });
});

describe("Next Edge gate + Node action recorded fixture in the TUI", () => {
  const { page } = pair(EDGE);

  it("keeps runtime edge, and the two sessions that reuse spanId same-span as two identities", () => {
    expect(spanItem(page, "mw-edge").runtime).toBe("edge");
    const a = spanKey(spanItem(page, "same-span", "s-a").span);
    const b = spanKey(spanItem(page, "same-span", "s-b").span);
    expect(a).not.toBe(b);
  });

  it("labels from spanKind: middleware(edge), rsc, server-action, fetch", () => {
    expect(labels(page)).toEqual({
      "s-edge/mw-edge": "middleware | framework: next rewrite=/internal/users",
      "s-a/same-span": "rsc | framework: not-recorded(no-framework-metadata)",
      "s-b/same-span": "server-action | framework: next requestType=action actionId=act-1 cache=unknown",
      "s-c/child": "fetch | framework: not-recorded(no-framework-metadata)"
    });
    // Next-specific evidence is readable field by field (not only in the summary phrase).
    expect(fieldText(frameworkField(spanItem(page, "same-span", "s-b").framework, "requestType"))).toBe("action");
    expect(fieldText(frameworkField(spanItem(page, "mw-edge").framework, "rewrite"))).toBe("/internal/users");
  });

  it("no inbound request metadata: every trace ref stays a trace summary, no request row is invented", () => {
    expect(requestRowsFromPage(page)).toEqual([]);
    const selector = selectorRows([page], traceRowsOf(page));
    expect(selector.every((row) => row.mode === "trace-summary")).toBe(true);
    expect(selector.map((row) => formatSelectorRow(row))).toContain(
      "trace trace-edge-collision complete (1 spans) [trace summary: no-request-metadata]"
    );
  });

  it("retention-cut Edge evidence stays unknown(retention) in depth, never complete or 0ms", () => {
    const calls = depthView([page], "call").rows.map(formatDepthRow);
    expect(calls).toContain("middleware middleware.ts#middleware unknown unavailable(retention)");
    for (const row of groupRows(page)) expect(formatDepthRow(row)).toContain("coverage=retention,unknown");
  });
});

describe("Next 15.5 Node request (published next-node-action-request fixture) in the TUI", () => {
  const { page } = pair(NEXT_NODE);

  it("one request row for the action POST; the requestType is on the request evidence and its row", () => {
    expect(requestRowsFromPage(page).map(formatSelectorRow)).toEqual([
      expect.stringMatching(/^#1 POST \/cart 200 .* node complete requestType=action$/)
    ]);
    expect(fieldText(frameworkField(spanItem(page, "req").framework, "requestType"))).toBe("action");
    expect(fieldText(frameworkField(spanItem(page, "fetch").framework, "cache"))).toBe('{"status":"unknown"}');
  });

  it("an action and a prefetch of the same route no longer look the same in the request row", () => {
    const T = "t-next-prefetch";
    const s = { sessionId: "s-next-prefetch", traceId: T } as const;
    const prefetchPage = project(T, [
      event({
        ...s,
        seq: 1,
        spanId: "req-prefetch",
        parentSpanId: null,
        type: "enter",
        kind: "http",
        nodeId: "http#GET",
        payload: {
          framework: { name: "next", role: "request", transport: "http", method: "GET", requestType: "prefetch" }
        }
      }),
      event({
        ...s,
        seq: 2,
        spanId: "req-prefetch",
        parentSpanId: null,
        type: "exit",
        kind: "http",
        nodeId: "http#GET",
        payload: { framework: { name: "next", completion: "finish", route: "/cart", status: 200 } }
      })
    ]);
    const [actionRow] = requestRowsFromPage(page).map(formatSelectorRow);
    const [prefetchRow] = requestRowsFromPage(prefetchPage).map(formatSelectorRow);
    expect(actionRow).toContain("requestType=action");
    expect(prefetchRow).toContain("requestType=prefetch");
    expect(actionRow).not.toBe(prefetchRow);
  });

  it("labels rsc and fetch from spanKind, fetch carrying the cache-unknown evidence", () => {
    const text = labels(page);
    expect(text["s-next-node/rsc"]).toBe("rsc | framework: not-recorded(no-framework-metadata)");
    expect(text["s-next-node/fetch"]).toBe("fetch | framework: next cache=unknown");
  });
});

describe("the viewer frame renders the framework request rows", () => {
  it("Express and Nest pages loaded together give two request lines; the Edge page stays a summary", () => {
    const pages = [pair(EXPRESS).page, pair(NEST).page, pair(EDGE).page];
    let state = applyDelta(initialViewState(), connected());
    state = applyDelta(state, { kind: "traces", rows: pages.flatMap(traceRowsOf) });
    state = applyDelta(state, { kind: "canonical", pages });
    const frame = renderFrame(state, 160, 30).join("\n");
    expect(frame).toContain("GET /api/users/:id 200");
    expect(frame).toContain("GET /users/:id 200");
    expect(frame).toContain("issues=headers-already-sent");
    expect(frame).toContain("trace-edge-collision");
  });
});
