import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectiveCapabilities } from "../src/capabilities.js";
import { classifyFailure } from "../src/session.js";
import { SourceError } from "../src/source-common.js";
import { createLiveSource, resolveLiveConfig, type LiveConfig, type LiveFetch } from "../src/source-live.js";
import { openTargetSource } from "../src/source-open.js";
import { canonicalV2 } from "./source-fixtures.js";
import { checkoutRecords } from "./replay-records.js";

const TOKEN = "project-token-5ecr3t-9d1e";
const POLICY = { readOnly: false, noEval: false, print: false };

type Handler = (
  url: URL,
  request: IncomingMessage
) => { status: number; body?: unknown; headers?: Record<string, string> };
type FakeDaemon = {
  origin: string;
  requests: Array<{ url: URL; token: string | undefined }>;
  close(): Promise<void>;
  handle: { current: Handler };
};

async function startDaemon(handler: Handler): Promise<FakeDaemon> {
  const requests: FakeDaemon["requests"] = [];
  const handle = { current: handler };
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const token = request.headers["x-kosmo-token"];
    requests.push({ url, token: typeof token === "string" ? token : undefined });
    const answer = handle.current(url, request);
    response.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
    response.end(answer.body === undefined ? "" : JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    handle,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

const dataset = (epoch = 1, watermark = 25) => ({
  projectId: "p",
  datasetId: "live:p",
  source: "live",
  graphRevision: "g-1",
  watermarkSeq: watermark,
  retentionEpoch: epoch
});
const row = (traceId: string, firstSeq: number, status = "complete") => ({
  traceId,
  sessionId: "s-1",
  status,
  spansCount: 2,
  hasMissingExit: false,
  hasLossRecords: false,
  lossRecordsCount: 0,
  firstSeq,
  lastSeq: firstSeq + 5
});

function events() {
  return checkoutRecords()
    .filter((record) => "nodeId" in record)
    .map((record) => ({ ...record, projectId: undefined }));
}

/** A daemon that serves every read API the live source uses. */
function fullDaemon(): Handler {
  return (url) => {
    const p = url.pathname;
    if (p === "/api/v1/live/snapshot") {
      return {
        status: 200,
        body: {
          projectionVersion: 1,
          kind: "snapshot",
          dataset: dataset(),
          cursorIdentity: "ci",
          order: "seq",
          items:
            url.searchParams.get("errors") === "true"
              ? [row("t-2", 30, "errored")]
              : [row("t-1", 10), row("t-2", 30, "errored")],
          markers: { truncated: false, gap: false, retentionEpoch: 1 },
          pageCursor: "page-2",
          cursor: "delta-0"
        }
      };
    }
    if (p === "/api/v1/live/page") {
      if (url.searchParams.get("cursor") !== "page-2") return { status: 400, body: { status: "invalid-cursor" } };
      return {
        status: 200,
        body: { kind: "page", dataset: dataset(), items: [row("t-3", 40)], markers: { truncated: false } }
      };
    }
    if (p === "/api/v1/live/deltas") {
      const cursor = url.searchParams.get("cursor");
      if (cursor === "delta-0")
        return {
          status: 200,
          body: { kind: "delta", dataset: dataset(1, 30), items: [row("t-4", 50)], cursor: "delta-1" }
        };
      if (cursor === "delta-1") {
        return {
          status: 409,
          body: {
            status: "reset",
            reason: "retention-epoch-changed",
            gap: true,
            snapshot: {
              dataset: dataset(2, 60),
              items: [row("t-9", 55)],
              markers: { truncated: false, gap: true },
              cursor: "delta-e2"
            }
          }
        };
      }
      return { status: 400, body: { status: "invalid-cursor" } };
    }
    if (p === "/api/v1/probes") {
      return {
        status: 200,
        body: {
          items:
            url.searchParams.get("traceId") === "t-1"
              ? [
                  {
                    seq: 11,
                    sessionId: "s-1",
                    traceId: "t-1",
                    spanId: "sp-1",
                    nodeId: "n",
                    probeId: "pr-1",
                    ordinal: 0,
                    expression: "cart.total",
                    sourceRevision: "r",
                    status: "recorded",
                    value: 42
                  },
                  {
                    seq: 12,
                    sessionId: "s-1",
                    traceId: "t-1",
                    spanId: "sp-1",
                    nodeId: "n",
                    probeId: "pr-2",
                    ordinal: 1,
                    expression: "user.email",
                    sourceRevision: "r",
                    status: "masked"
                  }
                ]
              : [],
          truncated: false,
          revisions: ["r"]
        }
      };
    }
    const canonical = /^\/api\/v1\/traces\/([^/]+)\/canonical$/.exec(p);
    if (canonical) {
      if (url.searchParams.get("projectionVersion") === "2")
        return { status: 200, body: canonicalV2(decodeURIComponent(canonical[1]!)) };
      return {
        status: 200,
        body: { projectionVersion: 1, dataset: dataset(), order: "causal", items: [], truncated: false }
      };
    }
    const trace = /^\/api\/v1\/traces\/([^/]+)$/.exec(p);
    if (trace) {
      const all = decodeURIComponent(trace[1]!) === "t-1" ? events() : [];
      const max = Number(url.searchParams.get("maxEvents") ?? "50");
      const start = Number(url.searchParams.get("cursor") ?? "0");
      const items = all.slice(start, start + max);
      const next = start + items.length < all.length ? String(start + items.length) : undefined;
      return { status: 200, body: { items, truncated: next !== undefined, ...(next ? { cursor: next } : {}) } };
    }
    return { status: 404, body: { error: "not_found" } };
  };
}

function config(origin: string, extra: Partial<LiveConfig> = {}): LiveConfig {
  return {
    baseUrl: `${origin}/`,
    allowedOrigins: [origin],
    projectId: "p",
    traceId: null,
    endpointSource: "target",
    authSource: "token-file",
    ...extra
  };
}

/** Every string a source hands back or throws, for the secret-free assertions. */
const seen: string[] = [];
function record<T>(value: T): T {
  seen.push(JSON.stringify(value));
  return value;
}
async function failure(promise: Promise<unknown>): Promise<SourceError> {
  try {
    await promise;
  } catch (error) {
    seen.push(String((error as Error).message), JSON.stringify(error));
    return error as SourceError;
  }
  throw new Error("expected a failure");
}

let daemon: FakeDaemon;
let tmp: string;
beforeEach(async () => {
  daemon = await startDaemon(fullDaemon());
  tmp = await mkdtemp(path.join(os.tmpdir(), "kosmo-tui-live-"));
});
afterEach(async () => {
  await daemon.close();
  await rm(tmp, { recursive: true, force: true });
  for (const text of seen.splice(0)) expect(text).not.toContain(TOKEN);
});

describe("live config/auth resolution (4.1)", () => {
  async function project(config: Record<string, unknown>, tokenFile = "project-token") {
    const data = path.join(tmp, ".kosmo-callflow");
    await mkdir(data, { recursive: true });
    await writeFile(path.join(data, "project.json"), JSON.stringify(config));
    await writeFile(path.join(data, tokenFile), `${TOKEN}\n`);
    return { projectId: "p", root: tmp, configPath: path.join(data, "project.json") };
  }

  it("reads the token from auth.projectTokenFile (relative to the data dir) and the endpoint from endpoints.cli", async () => {
    const candidate = await project({ endpoints: { cli: daemon.origin }, auth: { projectTokenFile: "project-token" } });
    const resolved = await resolveLiveConfig({
      target: { kind: "live-project" },
      project: candidate,
      env: {},
      cwd: tmp
    });
    expect(resolved).toMatchObject({
      ok: true,
      token: TOKEN,
      config: {
        baseUrl: `${daemon.origin}/`,
        allowedOrigins: [daemon.origin],
        endpointSource: "discovery",
        authSource: "token-file"
      }
    });
    if (!resolved.ok) return;
    expect(resolved.config.tokenFile).toBe(path.join(tmp, ".kosmo-callflow", "project-token"));
    record(resolved.config);
  });

  it("never falls back to a hardcoded project.token", async () => {
    const data = path.join(tmp, ".kosmo-callflow");
    await mkdir(data, { recursive: true });
    await writeFile(path.join(data, "project.token"), TOKEN);
    await writeFile(path.join(data, "project.json"), JSON.stringify({ endpoints: { cli: daemon.origin }, auth: {} }));
    const resolved = await resolveLiveConfig({ target: { kind: "live-project" }, project: null, env: {}, cwd: tmp });
    expect(resolved).toMatchObject({ ok: true, token: undefined, config: { authSource: "none" } });
  });

  it("lets KOSMO_CALLFLOW_PROJECT_TOKEN_FILE and KOSMO_CALLFLOW_ENDPOINT override discovery", async () => {
    const candidate = await project({
      endpoints: { cli: "http://127.0.0.1:1" },
      auth: { projectTokenFile: "project-token" }
    });
    const override = path.join(tmp, "other-token");
    await writeFile(override, "override-token\n");
    const resolved = await resolveLiveConfig({
      target: { kind: "live-project" },
      project: candidate,
      env: { KOSMO_CALLFLOW_ENDPOINT: daemon.origin, KOSMO_CALLFLOW_PROJECT_TOKEN_FILE: override },
      cwd: tmp
    });
    expect(resolved).toMatchObject({
      ok: true,
      token: "override-token",
      config: { baseUrl: `${daemon.origin}/`, endpointSource: "env" }
    });
  });

  it("takes endpoint, origins and auth from the connect launcher context", async () => {
    const tokenPath = path.join(tmp, "ctx-token");
    await writeFile(tokenPath, TOKEN);
    const context = (auth: unknown) =>
      JSON.stringify({
        v: 1,
        source: "kosmo-callflow connect",
        projectId: "p",
        projectDir: tmp,
        endpoint: daemon.origin,
        endpointExplicit: true,
        allowedCollectorOrigins: [daemon.origin],
        auth
      });
    const fromFile = await resolveLiveConfig({
      target: { kind: "live-project" },
      project: null,
      env: { KOSMO_TUI_CONTEXT: context({ kind: "token-file", path: tokenPath }), KOSMO_PROJECT_DIR: tmp },
      cwd: "/somewhere/else"
    });
    expect(fromFile).toMatchObject({
      ok: true,
      token: TOKEN,
      config: { endpointSource: "context", authSource: "context-token-file" }
    });
    const fromEnv = await resolveLiveConfig({
      target: { kind: "live-project" },
      project: null,
      env: { KOSMO_TUI_CONTEXT: context({ kind: "env", variable: "KOSMO_TUI_TOKEN" }), KOSMO_TUI_TOKEN: TOKEN },
      cwd: tmp
    });
    expect(fromEnv).toMatchObject({ ok: true, token: TOKEN, config: { authSource: "context-env" } });
    if (fromEnv.ok) record(fromEnv.config);
    // An explicit endpoint on another origin does not inherit the context's credential.
    const elsewhere = await resolveLiveConfig({
      target: { kind: "live-endpoint", url: "http://127.0.0.1:9/" },
      project: null,
      env: { KOSMO_TUI_CONTEXT: context({ kind: "env", variable: "KOSMO_TUI_TOKEN" }), KOSMO_TUI_TOKEN: TOKEN },
      cwd: path.join(tmp, "empty")
    });
    expect(elsewhere).toMatchObject({ ok: true, token: undefined, config: { endpointSource: "target" } });
  });

  it("refuses a discovered non-loopback endpoint and an unreadable token file before any network read", async () => {
    const remote = await project({
      endpoints: { cli: "http://10.0.0.5:41729" },
      auth: { projectTokenFile: "project-token" }
    });
    const refused = await resolveLiveConfig({ target: { kind: "live-project" }, project: remote, env: {}, cwd: tmp });
    expect(refused).toMatchObject({ ok: false, code: "origin-not-allowed", exitCode: 2 });

    await writeFile(
      path.join(tmp, ".kosmo-callflow", "project.json"),
      JSON.stringify({ endpoints: { cli: daemon.origin }, auth: { projectTokenFile: "missing" } })
    );
    const missing = await resolveLiveConfig({ target: { kind: "live-project" }, project: remote, env: {}, cwd: tmp });
    expect(missing).toMatchObject({ ok: false, code: "auth-token-unreadable" });
    expect(daemon.requests).toHaveLength(0);
  });

  it("wires live targets through openTargetSource with the resolved credential", async () => {
    const candidate = await project({ endpoints: { cli: daemon.origin }, auth: { projectTokenFile: "project-token" } });
    const opened = await openTargetSource({
      target: { kind: "live-trace", traceId: "t_9f" },
      project: candidate,
      env: {},
      cwd: tmp
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.source.kind).toBe("live");
    await opened.source.open(new AbortController().signal);
    expect(daemon.requests[0]?.token).toBe(TOKEN);
    await opened.source.close();
  });
});

describe("live source over HTTP (4.1)", () => {
  const signal = () => new AbortController().signal;

  it("opens a paged baseline, sends the token only in its header and offers what the API serves", async () => {
    const source = createLiveSource({ config: config(daemon.origin), token: TOKEN });
    const opened = record(await source.open(signal()));
    expect(opened.firstPage.items.map((item) => item.traceId)).toEqual(["t-1", "t-2"]);
    expect(opened.firstPage.items[0]).toMatchObject({ datasetId: "live:p", projectId: "p", sessionId: "s-1" });
    expect(opened.firstPage).toMatchObject({ truncated: true, coverage: { scope: "partial" } });
    expect(opened.snapshot).toMatchObject({ datasetId: "live:p", retentionEpoch: 1, watermark: 25 });
    expect(opened.stableDataset).toBe(true);
    for (const request of daemon.requests) {
      expect(request.token).toBe(TOKEN);
      expect(request.url.toString()).not.toContain(TOKEN);
    }
    const caps = effectiveCapabilities(opened, source, POLICY);
    expect(caps).toMatchObject({
      projectionVersions: [1, 2],
      follow: { available: true },
      replay: { available: true },
      probes: { available: true },
      values: { available: true, level: "full" }
    });

    const next = record(await source.traces(opened.snapshot, { limit: 50, cursor: opened.firstPage.cursor }, signal()));
    expect(next.items.map((item) => item.traceId)).toEqual(["t-3"]);
    expect(next).toMatchObject({ cursor: null, truncated: false, coverage: { loaded: 3 } });

    // The cursor is opaque and bound: another filter or snapshot is refused locally.
    const foreign = await failure(
      source.traces(
        opened.snapshot,
        { limit: 50, cursor: opened.firstPage.cursor, filter: { errorsOnly: true } },
        signal()
      )
    );
    expect(foreign).toMatchObject({ code: "cursor-rejected" });
    const moved = await failure(
      source.traces(
        { ...opened.snapshot, snapshotId: "other" },
        { limit: 50, cursor: opened.firstPage.cursor },
        signal()
      )
    );
    expect(moved.message).toContain("snapshot-changed");
    await source.close();
  });

  it("reports a legacy daemon's missing probe/trace-event APIs as unavailable capabilities", async () => {
    const full = fullDaemon();
    daemon.handle.current = (url, request) =>
      url.pathname === "/api/v1/probes" || /^\/api\/v1\/traces\/[^/]+$/.test(url.pathname)
        ? { status: 404, body: { error: "not_found" } }
        : full(url, request);
    const source = createLiveSource({ config: config(daemon.origin), token: TOKEN });
    const opened = await source.open(signal());
    const caps = effectiveCapabilities(opened, source, POLICY);
    expect(caps.probes).toEqual({ available: false, reason: "no-probe-api" });
    expect(caps.replay).toEqual({ available: false, reason: "no-replay-api" });
    expect(caps.values).toMatchObject({ available: false, level: "none" });
  });

  it("checks the projection version of every canonical answer", async () => {
    const source = createLiveSource({ config: config(daemon.origin), token: TOKEN });
    const opened = await source.open(signal());
    const ref = opened.firstPage.items[0]!;
    const v2 = record(await source.canonical!(opened.snapshot, { kind: "trace", ref }, { version: 2 }, signal()));
    expect(v2.version).toBe(2);
    expect(v2.envelope.projectionVersion).toBe(2);
    expect(daemon.requests.at(-1)?.url.searchParams.get("projectionVersion")).toBe("2");

    // An older daemon ignores projectionVersion and answers v1: an explicit mismatch.
    const full = fullDaemon();
    daemon.handle.current = (url, request) =>
      url.pathname.endsWith("/canonical")
        ? {
            status: 200,
            body: { projectionVersion: 1, dataset: dataset(), order: "causal", items: [], truncated: false }
          }
        : full(url, request);
    const mismatch = await failure(
      source.canonical!(opened.snapshot, { kind: "trace", ref }, { version: 2 }, signal())
    );
    expect(mismatch).toMatchObject({ code: "projection-version-mismatch" });
    expect(mismatch.message).toMatch(/requested canonical projection v2, the daemon answered v1/);

    daemon.handle.current = (url, request) =>
      url.pathname.endsWith("/canonical")
        ? { status: 400, body: { error: "unsupported_projection_version", projectionVersion: "2", supported: [1] } }
        : full(url, request);
    const unsupported = await failure(
      source.canonical!(opened.snapshot, { kind: "trace", ref }, { version: 2 }, signal())
    );
    expect(unsupported).toMatchObject({ code: "projection-version-unsupported" });

    daemon.handle.current = (url, request) =>
      url.pathname.endsWith("/canonical")
        ? { status: 200, body: { projectionVersion: 2, items: "nope" } }
        : full(url, request);
    expect(
      await failure(source.canonical!(opened.snapshot, { kind: "trace", ref }, { version: 2 }, signal()))
    ).toMatchObject({
      code: "projection-invalid"
    });
  });

  it("pages records and probes with opaque cursors and reads span evidence", async () => {
    const source = createLiveSource({ config: config(daemon.origin), token: TOKEN });
    const opened = await source.open(signal());
    const ref = opened.firstPage.items[0]!;
    const selection = { kind: "trace" as const, ref };
    const first = record(await source.records!(opened.snapshot, selection, { limit: 2 }, signal()));
    expect(first.items).toHaveLength(2);
    expect(first.truncated).toBe(true);
    // Opaque: not the daemon's raw cursor, and rejected by a source bound elsewhere.
    expect(first.cursor).not.toBe("2");
    expect(first.cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const rest = [];
    let cursor = first.cursor;
    while (cursor !== null) {
      const page = record(await source.records!(opened.snapshot, selection, { limit: 2, cursor }, signal()));
      rest.push(...page.items);
      cursor = page.cursor;
    }
    expect([...first.items, ...rest].map((item) => item.seq)).toEqual([10, 12, 18, 20]);
    // A record cursor is bound to its selection.
    const other = { kind: "trace" as const, ref: { ...ref, traceId: "t-2" } };
    expect(
      await failure(source.records!(opened.snapshot, other, { limit: 2, cursor: first.cursor }, signal()))
    ).toMatchObject({
      code: "cursor-rejected"
    });

    const probes = record(await source.probes!(opened.snapshot, selection, { limit: 10 }, signal()));
    expect(probes.items.map((item) => [item.probeId, item.probeSeq, item.label, item.value.state])).toEqual([
      ["pr-1", 11, "cart.total", "recorded"],
      ["pr-2", 12, "user.email", "masked"]
    ]);
    expect(probes.items[0]!.ref).toEqual({
      datasetId: "live:p",
      projectId: "p",
      sessionId: "s-1",
      traceId: "t-1",
      spanId: "sp-1"
    });

    const evidence = record(await source.details!(opened.snapshot, { ...ref, spanId: "sp-1" }, signal()));
    expect(evidence).toMatchObject({
      nodeId: "src/cart.ts#checkout",
      status: "complete",
      args: { state: "recorded", text: '["cart-1"]' }
    });
  });

  it("applies deltas, turns 409 into an atomic reset baseline and stops on 401/403", async () => {
    const source = createLiveSource({ config: config(daemon.origin), token: TOKEN });
    const opened = await source.open(signal());
    const delta = record(await source.deltas!(opened.deltaCursor!, signal()));
    expect(delta).toMatchObject({ reset: false, gap: false, snapshot: { watermark: 30 } });
    expect(delta.traces.map((item) => item.traceId)).toEqual(["t-4"]);

    const reset = record(await source.deltas!(delta.cursor, signal()));
    expect(reset).toMatchObject({ reset: true, gap: true, snapshot: { retentionEpoch: 2 } });
    expect(reset.traces.map((item) => item.traceId)).toEqual(["t-9"]);
    // The pre-reset cursor now belongs to another epoch.
    expect(await failure(source.deltas!(delta.cursor, signal()))).toMatchObject({ code: "cursor-rejected" });

    for (const status of [401, 403]) {
      daemon.handle.current = () => ({ status, body: { status: "unauthorized" } });
      const denied = await failure(source.deltas!(reset.cursor, signal()));
      expect(denied).toMatchObject({ code: "auth-rejected", status });
      expect(denied.message).toMatch(/authentication failed/);
      expect(classifyFailure(denied)).toEqual({ kind: "auth", status });
    }
    daemon.handle.current = () => ({ status: 503, body: {} });
    expect(classifyFailure(await failure(source.deltas!(reset.cursor, signal())))).toMatchObject({
      kind: "retry",
      status: 503
    });
  });

  it("never follows a redirect and never forwards the token to another origin", async () => {
    const other = await startDaemon(() => ({ status: 200, body: {} }));
    try {
      daemon.handle.current = () => ({ status: 302, headers: { location: `${other.origin}/api/v1/live/snapshot` } });
      const source = createLiveSource({ config: config(daemon.origin), token: TOKEN });
      const refused = await failure(source.open(signal()));
      expect(refused).toMatchObject({ code: "redirect-refused" });
      expect(refused.message).toContain(`another origin (${other.origin})`);
      expect(refused.message).toContain("no credentials were forwarded");
      expect(other.requests).toHaveLength(0);
      expect(classifyFailure(refused).kind).toBe("fatal");

      daemon.handle.current = () => ({ status: 307, headers: { location: "/elsewhere" } });
      expect((await failure(source.open(signal()))).message).toMatch(/redirects are not followed/);
    } finally {
      await other.close();
    }
  });

  it("refuses to send anything to an origin outside the allowed list", async () => {
    const calls: string[] = [];
    const fetch: LiveFetch = async (url) => {
      calls.push(url);
      throw new Error("must not be called");
    };
    const source = createLiveSource({
      config: config(daemon.origin, { allowedOrigins: ["http://127.0.0.1:1"] }),
      token: TOKEN,
      fetch
    });
    expect(await failure(source.open(signal()))).toMatchObject({ code: "origin-not-allowed" });
    expect(calls).toEqual([]);
  });

  it("reports an unreachable daemon with the outcome wording and without secrets", async () => {
    const fetch: LiveFetch = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    const source = createLiveSource({ config: config(daemon.origin), token: TOKEN, fetch });
    const error = await failure(source.open(signal()));
    expect(error).toMatchObject({ code: "daemon-unavailable" });
    expect(error.message).toMatch(/could not reach the daemon.*ECONNREFUSED/);
    expect(classifyFailure(error).kind).toBe("retry");
  });

  it("uses GET with redirect:manual for every request", async () => {
    const inits: Array<{ method: string; redirect: string }> = [];
    const fetch: LiveFetch = async (url, init) => {
      inits.push(init);
      return globalThis.fetch(url, init) as never;
    };
    const source = createLiveSource({ config: config(daemon.origin), token: TOKEN, fetch });
    await source.open(signal());
    expect(inits.length).toBeGreaterThan(0);
    expect(inits.every((init) => init.method === "GET" && init.redirect === "manual")).toBe(true);
  });
});
