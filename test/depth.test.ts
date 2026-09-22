/**
 * Task 5.3: depth/focus through the shared v2 depth projector. Focus is a group identity
 * plus membership and mapping revision (src/cart never includes src/cart-admin), logical
 * Nest modules only with a nest-adapter mapping (else a marked file fallback), inclusive
 * sums labelled as sums with unavailable(no-duration-evidence), and CLI parity at every
 * level against the kosmo-callflow projector path the daemon/CLI use.
 */
import {
  projectTraceTextDocumentV2,
  renderTraceTextV2,
  type CanonicalPageEnvelopeV2,
  type CanonicalV2SourceEvent
} from "@kosmo-callflow/protocol";
import { createTraceDatasetSnapshot, projectCanonicalPage } from "@kosmo-callflow/query/snapshot";
import { describe, expect, it } from "vitest";
import { runCommandLine } from "../src/commands.js";
import {
  DEPTH_ORDER,
  depthView,
  focusOn,
  focusText,
  formatDepthRow,
  type DepthGroupRow,
  type DepthMapping
} from "../src/depth.js";
import { decodeKey } from "../src/keys.js";
import { renderFrame } from "../src/render.js";
import {
  applyAction,
  applyDelta,
  currentDepthView,
  initialViewState,
  spanKey,
  type SpanRow,
  type ViewState
} from "../src/view-state.js";
import { connected } from "./view-fixtures.js";
import { DATASET, PROJECT, event, project } from "./request-fixtures.js";

const T = "t-cart";
const s = { sessionId: "s", traceId: T } as const;
const NODES = {
  a: "src/cart/cart.service.ts#CartService.add",
  b: "src/cart/cart.repo.ts#CartRepo.save",
  c: "src/cart-admin/admin.service.ts#Admin.list",
  d: "src/cart-admin/admin.repo.ts#AdminRepo.find"
};

function cartEvents(): CanonicalV2SourceEvent[] {
  return [
    event({ ...s, seq: 1, spanId: "a", parentSpanId: null, type: "enter", kind: "handler", nodeId: NODES.a }),
    event({ ...s, seq: 2, spanId: "b", parentSpanId: "a", type: "enter", kind: "method", nodeId: NODES.b }),
    event({
      ...s,
      seq: 3,
      spanId: "b",
      parentSpanId: "a",
      type: "exit",
      kind: "method",
      nodeId: NODES.b,
      payload: { durationMs: 2 }
    }),
    event({
      ...s,
      seq: 4,
      spanId: "a",
      parentSpanId: null,
      type: "exit",
      kind: "handler",
      nodeId: NODES.a,
      payload: { durationMs: 5 }
    }),
    event({ ...s, seq: 5, spanId: "c", parentSpanId: null, type: "enter", kind: "handler", nodeId: NODES.c }),
    event({ ...s, seq: 6, spanId: "d", parentSpanId: "c", type: "enter", kind: "wizard", nodeId: NODES.d }),
    event({ ...s, seq: 7, spanId: "d", parentSpanId: "c", type: "exit", kind: "wizard", nodeId: NODES.d }),
    event({ ...s, seq: 8, spanId: "c", parentSpanId: null, type: "exit", kind: "handler", nodeId: NODES.c })
  ];
}

const page = project(T, cartEvents());
const key = (spanId: string) => spanKey({ datasetId: DATASET, projectId: PROJECT, sessionId: "s", traceId: T, spanId });

function groups(view: ReturnType<typeof depthView>): DepthGroupRow[] {
  return view.rows.filter((row): row is DepthGroupRow => row.kind === "group");
}

function byLabel(view: ReturnType<typeof depthView>, label: string): DepthGroupRow {
  const row = groups(view).find((candidate) => candidate.label === label);
  if (!row)
    throw new Error(
      `no group ${label}: ${groups(view)
        .map((g) => g.label)
        .join(", ")}`
    );
  return row;
}

describe("module rows and durations", () => {
  const view = depthView([page], "module");

  it("groups src/cart and src/cart-admin apart, with byKind and the unknown bucket", () => {
    expect(
      groups(view)
        .map((row) => row.label)
        .sort()
    ).toEqual(["src/cart", "src/cart-admin"]);
    const cart = byLabel(view, "src/cart");
    expect(cart.spans).toBe(2);
    expect(cart.byKind).toEqual([
      { spanKind: "handler", spans: 1 },
      { spanKind: "method", spans: 1 },
      { spanKind: "unknown", spans: 0 }
    ]);
    expect(byLabel(view, "src/cart-admin").byKind).toContainEqual({ spanKind: "unknown", spans: 1 });
  });

  it("labels the inclusive duration as a sum, never wall time, and never shows zero for no evidence", () => {
    const cart = formatDepthRow(byLabel(view, "src/cart"));
    expect(cart).toContain("sum(inclusive)=7ms over 2 span(s)");
    expect(cart).toContain("wall=unavailable(nested-overlap-not-summed)");
    expect(cart).not.toMatch(/elapsed|wall=\d/);
    const admin = formatDepthRow(byLabel(view, "src/cart-admin"));
    expect(admin).toContain("sum(inclusive)=unavailable(no-duration-evidence)");
    expect(admin).not.toMatch(/\b0ms/);
  });

  it("marks file-based module groups as a fallback when no logical mapping exists", () => {
    expect(byLabel(view, "src/cart").mapping).toEqual({
      revision: "default",
      source: "file",
      fallback: "no-logical-mapping"
    });
    expect(formatDepthRow(byLabel(view, "src/cart"))).toContain("file-fallback(no-logical-mapping)@default");
    // app/symbol are file-based by nature, not a fallback.
    expect(groups(depthView([page], "app"))[0]!.mapping.fallback).toBeNull();
  });
});

describe("focus is group identity + membership, not a nodeId prefix", () => {
  it("src/cart does not include src/cart-admin down to call depth", () => {
    // The naive prefix really would pull the neighbour in: the fixture exercises the bug.
    expect(Object.values(NODES).filter((node) => node.startsWith("src/cart")).length).toBe(4);
    const cart = byLabel(depthView([page], "module"), "src/cart");
    const focus = focusOn([page], "module", {}, cart.id)!;
    expect(focus).toMatchObject({
      groupId: cart.id,
      depth: "module",
      mappingRevision: "default",
      mappingSource: "file"
    });
    expect(focus.members).toEqual([key("a"), key("b")].sort());
    const symbols = groups(depthView([page], "symbol", {}, focus));
    expect(symbols.map((row) => row.groupNode).sort()).toEqual([`symbol:${NODES.b}`, `symbol:${NODES.a}`].sort());
    const calls = depthView([page], "call", {}, focus).rows;
    expect(calls.map((row) => (row.kind === "call" ? row.ref.spanId : null)).sort()).toEqual(["a", "b"]);
  });

  it("a focus taken under another mapping revision is reported stale, membership kept", () => {
    const cart = byLabel(depthView([page], "module", { mappingRevision: "r1" }), "src/cart");
    const focus = focusOn([page], "module", { mappingRevision: "r1" }, cart.id)!;
    const view = depthView([page], "call", { mappingRevision: "r2" }, focus);
    expect(view.focus).toMatchObject({ stale: true, mappingRevision: "r1", currentRevision: "r2" });
    expect(focusText(view.focus!)).toContain("mapping now r2: membership kept from r1");
    expect(view.rows).toHaveLength(2);
  });
});

describe("logical Nest module mapping", () => {
  const logicalMapping = {
    revision: "nest-r1",
    modules: [
      { nodeId: NODES.a, module: "CartModule", feature: "Shop" },
      { nodeId: NODES.b, module: "CartModule", feature: "Shop" }
    ]
  };

  it("uses logical modules only with the nest-adapter capability; unmapped nodes are a marked fallback", () => {
    const mapping: DepthMapping = { logical: { mapping: logicalMapping, capability: "nest-adapter" } };
    const view = depthView([page], "module", mapping);
    const cart = byLabel(view, "CartModule");
    expect(cart.mapping).toEqual({ revision: "nest-r1", source: "logical", fallback: null });
    expect(cart.spans).toBe(2);
    expect(byLabel(view, "src/cart-admin").mapping.fallback).toBe("unmapped-node");
    expect(byLabel(depthView([page], "feature", mapping), "Shop").mapping.source).toBe("logical");
    const focus = focusOn([page], "module", mapping, cart.id)!;
    expect(focus).toMatchObject({ mappingSource: "logical", mappingRevision: "nest-r1" });
    expect(focus.members).toEqual([key("a"), key("b")].sort());
  });

  it("without the nest-adapter capability the mapping is ignored and the fallback says why", () => {
    const view = depthView([page], "module", { logical: { mapping: logicalMapping, capability: "analyzer" } });
    expect(groups(view).some((row) => row.mapping.source === "logical")).toBe(false);
    expect(byLabel(view, "src/cart").mapping.fallback).toBe("logical-mapping-needs-nest-adapter");
  });
});

describe("CLI parity: the same envelope at every level", () => {
  const records = cartEvents();
  const logicalMapping = { revision: "nest-r1", modules: [{ nodeId: NODES.a, module: "CartModule" }] };
  const snapshot = (withLogical: boolean) =>
    createTraceDatasetSnapshot({
      identity: { datasetId: DATASET, projectId: PROJECT, source: "live", watermarkSeq: 8, retentionEpoch: 0 },
      records,
      ...(withLogical ? { depthMappings: { logicalMapping } } : {})
    });
  const lisp = (grouped: CanonicalPageEnvelopeV2, level: (typeof DEPTH_ORDER)[number]) =>
    renderTraceTextV2(projectTraceTextDocumentV2(grouped, { detail: 2, depth: level, values: false }), {
      dialect: "lisp"
    });

  for (const withLogical of [false, true]) {
    for (const level of DEPTH_ORDER) {
      it(`${level}${withLogical ? " with a logical mapping" : ""}: TUI rows come from the envelope the CLI prints`, () => {
        // What `kosmo-callflow trace --projection-version 2 --depth <level>` reads.
        const cli = projectCanonicalPage(snapshot(withLogical), { projectionVersion: 2, traceId: T, depth: level });
        // What the TUI holds (the call-level page) run through its own depth path.
        const callPage = projectCanonicalPage(snapshot(withLogical), { projectionVersion: 2, traceId: T });
        const mapping: DepthMapping = withLogical
          ? { logical: { mapping: logicalMapping, capability: "nest-adapter" } }
          : {};
        const tui = depthView([callPage], level, mapping);
        expect(tui.pages).toHaveLength(1);
        expect(tui.pages[0]).toEqual(cli);
        expect(lisp(tui.pages[0]!, level)).toBe(lisp(cli, level));
        const cliGroups = cli.items.filter((item) => item.kind === "group");
        if (level === "call") {
          expect(tui.rows.every((row) => row.kind === "call")).toBe(true);
          expect(tui.rows).toHaveLength(4);
        } else {
          expect(groups(tui).map((row) => [row.id, row.spans, row.inclusiveSum])).toEqual(
            cliGroups.map((item) => [item.id, item.metrics.spans, item.metrics.inclusiveDuration])
          );
        }
      });
    }
  }
});

describe(":depth, - and + drive the rendered rows", () => {
  function spanRows(): SpanRow[] {
    return page.items.flatMap((item) =>
      item.kind === "span"
        ? [
            {
              ...item.span,
              parentSpanId: item.parent.state === "known" ? item.parent.span.spanId : null,
              nodeId: item.node.nodeId,
              depth: 0,
              errored: false,
              ...(item.spanKind ? { spanKind: item.spanKind } : {})
            }
          ]
        : []
    );
  }

  function loaded(): ViewState {
    let state = applyDelta(initialViewState(), connected());
    state = applyDelta(state, { kind: "spans", rows: spanRows() });
    return applyDelta(state, { kind: "canonical", pages: [page] });
  }

  const text = (state: ViewState) => renderFrame(state, 200, 40).join("\n");

  it(":depth module sets the level and the frame shows grouped rows", async () => {
    const state = loaded();
    const outcome = await runCommandLine(state, "depth module");
    expect(outcome).not.toBeNull();
    const next = outcome!.actions.reduce(applyAction, state);
    expect(next.depth).toBe("module");
    const frame = text(next);
    expect(frame).toContain("[module] src/cart spans=2");
    expect(frame).toContain("[module] src/cart-admin spans=2");
    expect(frame).not.toContain(NODES.a); // span rows are replaced by groups
  });

  it("+ focuses the highlighted group and goes finer; - goes coarser and releases it", () => {
    let state = applyAction(loaded(), { kind: "setDepth", level: "module" });
    const cartIndex = currentDepthView(state).rows.findIndex((row) => row.kind === "group" && row.label === "src/cart");
    state = applyAction(state, { kind: "move", delta: cartIndex });
    state = applyAction(state, decodeKey("+")!);
    expect(state.depth).toBe("symbol");
    expect(state.depthFocus?.members).toEqual([key("a"), key("b")].sort());
    expect(text(state)).toContain("focus module:workspace/package/src/cart (2 spans, file@default)");
    expect(text(state)).not.toContain(NODES.c);
    // Down to call with the module focus kept (`:depth call`), every cart span is listed.
    state = applyAction(state, { kind: "setDepth", level: "call" });
    state = applyAction(state, { kind: "moveTo", edge: "first" });
    state = applyAction(state, { kind: "expand" });
    expect(state.depthFocus?.groupNode).toBe("module:workspace/package/src/cart");
    const frame = text(state);
    expect(frame).toContain(NODES.a);
    expect(frame).toContain(NODES.b);
    expect(frame).not.toContain(NODES.c);
    expect(frame).not.toContain(NODES.d);
    state = applyAction(state, decodeKey("-")!); // symbol: still finer than the focus
    expect(state.depthFocus).not.toBeNull();
    state = applyAction(state, decodeKey("-")!); // module: the focus is moot
    expect(state.depth).toBe("module");
    expect(state.depthFocus).toBeNull();
    expect(text(state)).toContain("src/cart-admin");
  });

  it("- and + are gated like :depth: without a projection they answer with a notice", () => {
    const yes = { available: true } as const;
    const caps: NonNullable<ViewState["caps"]> = {
      projectionVersions: [],
      projection: { available: false, reason: "no-span-projection" },
      follow: yes,
      replay: yes,
      values: { available: true, level: "full" },
      probes: yes,
      staticGraph: yes,
      sql: yes,
      review: yes,
      localEval: yes,
      interactive: yes
    };
    const state = applyAction({ ...loaded(), caps }, decodeKey("-")!);
    expect(state.depth).toBeNull();
    expect(state.notice).toBe("depth: unavailable(no-span-projection)");
  });
});
