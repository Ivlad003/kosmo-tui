/**
 * Tasks 5.1/5.3 wiring: the session loads canonical v2 pages for the loaded traces, so the
 * request selector and `--depth`/`:depth` render from the same shared projection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderFrame } from "../src/render.js";
import { createSession } from "../src/session.js";
import type { TraceSelection } from "../src/source.js";
import { flush, liveFake } from "./session-fakes.js";
import { DATASET, PROJECT, distributedTrace } from "./request-fixtures.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const trace = { datasetId: DATASET, projectId: PROJECT, sessionId: "s-api", traceId: "t-dist" };

function withCanonical(versions: Array<1 | 2>) {
  const fake = liveFake({
    offers: { projectionVersions: versions },
    opens: [
      {
        snapshot: { datasetId: DATASET, projectId: PROJECT },
        traces: [{ ...trace, status: "complete", startedAt: 1, spanCount: 5 }]
      }
    ]
  });
  const selections: TraceSelection[] = [];
  fake.source.canonical = async (_snapshot, selection, options) => {
    selections.push(selection);
    if (options.version !== 2) throw new Error("v1 not served");
    return {
      version: 2,
      envelope: distributedTrace(),
      coverage: { scope: "complete", loaded: 5, total: 5 },
      truncated: false,
      cursor: null
    };
  };
  return { fake, selections };
}

describe("session canonical pages", () => {
  it("loads the v2 page per loaded trace and shows one row per inbound request", async () => {
    const { fake, selections } = withCanonical([1, 2]);
    const session = createSession({ source: fake.source, random: () => 0.5 });
    await session.start();
    await flush();
    expect(selections).toEqual([{ kind: "trace", ref: trace }]);
    const frame = renderFrame(session.state(), 160, 30).join("\n");
    expect(frame).toContain("#4 GET /cart/:id 200 12ms node complete");
    expect(frame).toContain("#5 POST /orders 201 30ms node complete");
    await session.close();
  });

  it("--depth opens grouped rows from the shared projector", async () => {
    const { fake } = withCanonical([2]);
    const session = createSession({ source: fake.source, random: () => 0.5, depth: "module" });
    await session.start();
    await flush();
    expect(session.state().depth).toBe("module");
    const frame = renderFrame(session.state(), 200, 30).join("\n");
    expect(frame).toContain("depth module");
    expect(frame).toMatch(/\[module\] src\/ui spans=3/);
    await session.close();
  });

  it("a v1-only source keeps the trace-summary list and reads no v2 page", async () => {
    const { fake, selections } = withCanonical([1]);
    const session = createSession({ source: fake.source, random: () => 0.5 });
    await session.start();
    await flush();
    expect(selections).toEqual([]);
    expect(session.state().canonical).toEqual([]);
    expect(renderFrame(session.state(), 160, 30).join("\n")).not.toContain("#4 GET");
    await session.close();
  });
});
