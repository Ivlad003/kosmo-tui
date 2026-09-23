/**
 * Review fixes on the live source and the pinned replay:
 *  - R-M5: records past the pinned watermark (ingested after the pin) never reach a replay;
 *  - R-M6: a live-merged `payload.supplement` (no seq of its own) is stripped before the watermark;
 *  - S-L2 / SEC-L7: the discovered token only goes to loopback or the configured origin, only
 *    from a token file inside the data directory, and never over plain http off loopback;
 *  - a chunked response without content-length is cut at the byte cap while streaming.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { ReplayRecord } from "@kosmo-callflow/replay";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pinReplay, seekPinned } from "../src/replay-pin.js";
import { SourceError } from "../src/source-common.js";
import { createLiveSource, LIVE_RESPONSE_MAX_BYTES, resolveLiveConfig, type LiveConfig } from "../src/source-live.js";
import { event } from "./replay-records.js";

const TOKEN = "review-token-7a1f";
const WATERMARK = 20;

type Route = (url: URL, response: import("node:http").ServerResponse) => void;

async function serve(route: Route): Promise<{ origin: string; close(): Promise<void> }> {
  const server: Server = createServer((request, response) =>
    route(new URL(request.url ?? "/", "http://127.0.0.1"), response)
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

function json(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const dataset = { projectId: "p", datasetId: "live:p", graphRevision: "g", watermarkSeq: WATERMARK, retentionEpoch: 1 };

function config(origin: string): LiveConfig {
  return {
    baseUrl: `${origin}/`,
    allowedOrigins: [origin],
    projectId: "p",
    traceId: null,
    endpointSource: "target",
    authSource: "none"
  };
}

const signal = () => new AbortController().signal;

describe("R-M5 a pinned replay never sees records ingested after the pin", () => {
  let daemon: Awaited<ReturnType<typeof serve>>;
  let ingested: ReplayRecord[];
  beforeEach(async () => {
    ingested = [
      event({ seq: 10, type: "enter", payload: { args: ["cart-1"] } }),
      event({ seq: 18, type: "exit", payload: { ret: 1 } })
    ];
    daemon = await serve((url, response) => {
      if (url.pathname === "/api/v1/live/snapshot") {
        return json(response, 200, {
          dataset,
          items: [{ traceId: "t-1", sessionId: "s-1", status: "complete", spansCount: 1, firstSeq: 10 }],
          cursor: "d-0"
        });
      }
      if (url.pathname === "/api/v1/traces/t-1") {
        return json(response, 200, { items: ingested.map((record) => ({ ...record, projectId: undefined })) });
      }
      if (url.pathname.startsWith("/api/v1/traces/")) return json(response, 200, { items: [] });
      if (url.pathname === "/api/v1/probes") return json(response, 200, { items: [] });
      return json(response, 404, { error: "not_found" });
    });
  });
  afterEach(async () => daemon.close());

  it("filters records by the snapshot watermark and keeps the range within it", async () => {
    const source = createLiveSource({ config: config(daemon.origin) });
    const opened = await source.open(signal());
    expect(opened.snapshot.watermark).toBe(WATERMARK);
    // The live store keeps ingesting after the pin, before the replay reads its records.
    ingested.push(
      event({ seq: 25, type: "enter", spanId: "sp-late", nodeId: "src/late.ts#late" }),
      event({ seq: 30, type: "exit", spanId: "sp-late", nodeId: "src/late.ts#late" })
    );
    const ref = opened.firstPage.items[0]!;
    const page = await source.records!(opened.snapshot, { kind: "trace", ref }, { limit: 100 }, signal());
    expect(page.items.map((record) => record.seq)).toEqual([10, 18]);
    expect(page.coverage.reason).toBe("excluded-after-watermark(2)");

    const pin = pinReplay(page.items, opened.snapshot);
    expect(pin.range).toEqual({ first: 10, last: WATERMARK });
    const late = seekPinned(pin, 25);
    expect(late).toMatchObject({ ok: false, reason: "out-of-range" });
    // Even records handed in directly past the watermark are not part of the pin.
    const direct = pinReplay([...page.items, ...ingested.slice(2)], opened.snapshot);
    expect(direct.seqs).toEqual([10, 18]);
    expect(direct.range!.last).toBe(WATERMARK);
    await source.close();
  });
});

describe("R-M6 live-merged supplements before the watermark", () => {
  function spanPayload(outcome: ReturnType<typeof seekPinned>): Record<string, unknown> | undefined {
    if (!outcome.ok) throw new Error(outcome.notice);
    const trace = Object.values(outcome.state.traces)[0]!;
    return Object.values(trace.spans)[0]!.payload as Record<string, unknown> | undefined;
  }

  it("strips payload.supplement from reducer input when the cutoff is before the watermark", () => {
    const records = [
      event({
        seq: 10,
        type: "enter",
        payload: { args: ["a"], supplement: { framework: { name: "next", route: "/late" } } }
      }),
      event({ seq: 18, type: "exit", payload: { ret: 1 } })
    ];
    const pin = pinReplay(records, {
      datasetId: "local",
      projectId: "p",
      revision: "r",
      watermark: WATERMARK,
      retentionEpoch: 1,
      snapshotId: "s"
    });
    expect(spanPayload(seekPinned(pin, 12))).not.toHaveProperty("supplement");
    expect(JSON.stringify(seekPinned(pin, 18))).not.toContain("/late");
    // At the watermark the merged value is what the pinned read holds.
    expect(JSON.stringify(seekPinned(pin, WATERMARK))).toContain("/late");
  });
});

describe("S-L2 / SEC-L7 token origin and token file rules", () => {
  let tmp: string;
  let data: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "kt-review-"));
    data = path.join(tmp, ".kosmo-callflow");
    await mkdir(data, { recursive: true });
    await writeFile(path.join(data, "project-token"), `${TOKEN}\n`);
  });
  afterEach(async () => rm(tmp, { recursive: true, force: true }));

  async function projectJson(document: Record<string, unknown>) {
    await writeFile(path.join(data, "project.json"), JSON.stringify(document));
    return { projectId: "p", root: tmp, configPath: path.join(data, "project.json") };
  }

  it("refuses the discovered token for a typed non-loopback endpoint that is not the configured one", async () => {
    const project = await projectJson({
      endpoints: { cli: "https://collector.team.example:8443" },
      auth: { projectTokenFile: "project-token" }
    });
    for (const input of [
      { target: { kind: "live-endpoint" as const, url: "https://elsewhere.example/" }, env: {} },
      { target: { kind: "live-project" as const }, env: { KOSMO_CALLFLOW_ENDPOINT: "https://elsewhere.example" } }
    ]) {
      const resolved = await resolveLiveConfig({ ...input, project, cwd: tmp });
      expect(resolved).toMatchObject({ ok: false, code: "auth-origin" });
      expect(JSON.stringify(resolved)).not.toContain(TOKEN);
    }
    const configured = await resolveLiveConfig({
      target: { kind: "live-endpoint", url: "https://collector.team.example:8443/" },
      project,
      env: {},
      cwd: tmp
    });
    expect(configured).toMatchObject({ ok: true, token: TOKEN });
    const loopback = await resolveLiveConfig({
      target: { kind: "live-endpoint", url: "http://127.0.0.1:9/" },
      project,
      env: {},
      cwd: tmp
    });
    expect(loopback).toMatchObject({ ok: true, token: TOKEN });
  });

  it("reads auth.projectTokenFile only inside the data directory", async () => {
    const outside = path.join(tmp, "git-credentials");
    await writeFile(outside, "https://user:secret@example\n");
    for (const ref of [outside, "../git-credentials"]) {
      const project = await projectJson({
        endpoints: { cli: "http://127.0.0.1:41729" },
        auth: { projectTokenFile: ref }
      });
      const resolved = await resolveLiveConfig({ target: { kind: "live-project" }, project, env: {}, cwd: tmp });
      expect(resolved).toMatchObject({ ok: false, code: "auth-token-file-outside-data" });
    }
    await symlink(outside, path.join(data, "linked-token"));
    const linked = await projectJson({
      endpoints: { cli: "http://127.0.0.1:41729" },
      auth: { projectTokenFile: "linked-token" }
    });
    expect(
      await resolveLiveConfig({ target: { kind: "live-project" }, project: linked, env: {}, cwd: tmp })
    ).toMatchObject({
      ok: false,
      code: "auth-token-file-outside-data"
    });
  });

  it("never sends a token over plain http to a non-loopback endpoint", async () => {
    const override = path.join(tmp, "explicit-token");
    await writeFile(override, `${TOKEN}\n`);
    const resolved = await resolveLiveConfig({
      target: { kind: "live-endpoint", url: "http://collector.example:8080/" },
      project: null,
      env: { KOSMO_CALLFLOW_PROJECT_TOKEN_FILE: override },
      cwd: tmp
    });
    expect(resolved).toMatchObject({ ok: false, code: "auth-insecure-endpoint" });
  });
});

describe("response byte cap while streaming", () => {
  it("aborts a chunked response without content-length at the cap", async () => {
    let written = 0;
    const planned = LIVE_RESPONSE_MAX_BYTES + 32 * 1024 * 1024;
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    const daemon = await serve((url, response) => {
      if (url.pathname !== "/api/v1/live/snapshot") return json(response, 404, {});
      response.writeHead(200, { "content-type": "application/json" });
      const pump = (): void => {
        while (written < planned && !response.destroyed) {
          written += chunk.byteLength;
          if (!response.write(chunk)) return void response.once("drain", pump);
        }
        if (!response.destroyed) response.end();
      };
      pump();
    });
    try {
      const source = createLiveSource({ config: config(daemon.origin) });
      const failure = await source.open(signal()).then(
        () => null,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(SourceError);
      expect(failure).toMatchObject({ code: "response-too-large" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(written).toBeLessThan(planned);
      await source.close();
    } finally {
      await daemon.close();
    }
  }, 60_000);
});
