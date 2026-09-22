/**
 * The live daemon source (task 4.1, design D3/D4/D9).
 *
 * Config/auth resolution follows the kosmo-callflow CLI rules instead of inventing new
 * ones: the endpoint comes from the positional target, the `connect` launcher context,
 * `KOSMO_CALLFLOW_ENDPOINT`, the project's `endpoints.cli` or the default
 * `KOSMO_CALLFLOW_HOST:KOSMO_CALLFLOW_PORT`, in that order; the token from
 * `KOSMO_CALLFLOW_PROJECT_TOKEN_FILE`/`KOSMO_CALLFLOW_TOKEN_FILE`, the launcher context
 * or the project's `auth.projectTokenFile` — never a hardcoded `project.token`. The
 * origin policy is the CLI's: a discovered non-loopback endpoint is not an allowed
 * collector, and a request to an origin outside the allowed list is refused before any
 * byte leaves the process.
 *
 * The HTTP client is read-only (GET only) and takes an injected `fetch`. Redirects are
 * never followed (`redirect: "manual"`): a redirect is a source error, so the token is
 * never forwarded to another origin. 401/403 stop with the auth outcome, 409 on the
 * delta read is an epoch reset whose body becomes the new baseline, and every
 * canonical answer is checked for the projection version that was requested. Errors
 * are built from codes, statuses and origins only; the token never appears in a
 * message, a cursor, a URL or a page.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalPageEnvelopeSchema,
  canonicalPageEnvelopeV2Schema,
  connectOutcomeMessage,
  type TraceEventView
} from "@kosmo-callflow/protocol";
import type { ReplayRecord } from "@kosmo-callflow/replay";
import { contextToken, readLaunchContext, type TuiLaunchContext } from "./context.js";
import { spanDetailFromEvents, valueOf } from "./detail.js";
import type { ProjectCandidate, ResolvedTarget } from "./detect.js";
import { redactUrl, validateEndpoint } from "./detect.js";
import { SourceError, canonicalPageMeta } from "./source-common.js";
import {
  decodeCursor,
  encodeCursor,
  type CursorBinding,
  type LiveDeltaBody,
  type PageFilter,
  type PageOptions,
  type ProbePage,
  type ProbeRecord,
  type ProjectionOptions,
  type QualifiedTraceRef,
  type ReplayPage,
  type SnapshotRef,
  type SourceOffers,
  type SourceOpenResult,
  type SpanEvidence,
  type TracePage,
  type TraceSelection,
  type TraceSource,
  type VersionedCanonicalPage
} from "./source.js";
import type { DetailValue, TraceRow } from "./view-state.js";

type Env = Readonly<Record<string, string | undefined>>;

// ---------------------------------------------------------------------------
// Config / auth resolution
// ---------------------------------------------------------------------------

export type LiveEndpointSource = "target" | "context" | "env" | "discovery" | "default";
export type LiveAuthSource = "token-file" | "context-token-file" | "context-env" | "none";

/** Everything about the connection except the credential itself; safe to print. */
export type LiveConfig = {
  baseUrl: string;
  allowedOrigins: string[];
  projectId: string | null;
  traceId: string | null;
  endpointSource: LiveEndpointSource;
  authSource: LiveAuthSource;
  /** Where the token was read from (a path, never the token). */
  tokenFile?: string;
};

export type LiveResolution =
  | { ok: true; config: LiveConfig; token: string | undefined }
  | { ok: false; code: string; message: string; exitCode: 1 | 2 };

export type ResolveLiveInput = {
  target: ResolvedTarget;
  project: ProjectCandidate | null;
  env: Env;
  cwd: string;
  /** Explicit `--project`, used when no project config was discovered. */
  projectId?: string;
  readFile?: (filePath: string) => Promise<string>;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = "41729";

export function isLoopbackOrigin(origin: string): boolean {
  const hostname = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return hostname === "localhost" || hostname === "::1" || /^127\./.test(hostname);
}

function fail(code: string, message: string, exitCode: 1 | 2 = 2): LiveResolution {
  return { ok: false, code, message, exitCode };
}

type Discovery = { url?: string; tokenFile?: string };

async function readDiscovery(
  dataDir: string,
  read: (filePath: string) => Promise<string>
): Promise<Discovery | undefined | { error: string }> {
  const configPath = path.join(dataDir, "project.json");
  let raw: string;
  try {
    raw = await read(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return { error: `kosmo-tui: cannot read ${configPath} (${(error as NodeJS.ErrnoException).code ?? "read error"})` };
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return { error: `kosmo-tui: ${configPath} is not valid JSON` };
  }
  const config = document as { endpoints?: { cli?: unknown }; auth?: { projectTokenFile?: unknown } } | null;
  const url = typeof config?.endpoints?.cli === "string" ? config.endpoints.cli : undefined;
  const ref = config?.auth?.projectTokenFile;
  const tokenFile =
    typeof ref === "string" && ref.length > 0 && !ref.includes("\0")
      ? path.isAbsolute(ref)
        ? ref
        : path.join(dataDir, ref)
      : undefined;
  return { ...(url === undefined ? {} : { url }), ...(tokenFile === undefined ? {} : { tokenFile }) };
}

async function readToken(
  tokenFile: string,
  read: (filePath: string) => Promise<string>
): Promise<{ ok: true; token: string | undefined } | { ok: false; message: string }> {
  try {
    const token = (await read(tokenFile)).trim();
    return { ok: true, token: token.length > 0 ? token : undefined };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "read error";
    return { ok: false, message: `kosmo-tui: cannot read the project token file ${tokenFile} (${code})` };
  }
}

function checkedEndpoint(raw: string, what: string): { ok: true; url: string } | { ok: false; message: string } {
  const result = validateEndpoint(raw);
  if (!result.ok || result.target.kind !== "live-endpoint") {
    return { ok: false, message: `kosmo-tui: ${what} ${redactUrl(raw)} is not a usable http(s) endpoint` };
  }
  return { ok: true, url: result.target.url };
}

/**
 * Resolve where to connect and with which credential. Pure except for reading the
 * project config and the token file; no network. The result's `config` is secret-free.
 */
export async function resolveLiveConfig(input: ResolveLiveInput): Promise<LiveResolution> {
  const read = input.readFile ?? ((filePath: string) => readFile(filePath, "utf8"));
  const { env, target } = input;
  if (target.kind !== "live-project" && target.kind !== "live-trace" && target.kind !== "live-endpoint") {
    return fail("not-live", `kosmo-tui: target ${target.kind} is not a live daemon`, 1);
  }
  const launched = readLaunchContext(env);
  if (!launched.ok) return fail(launched.code, launched.message);
  const context: TuiLaunchContext | null = launched.context;
  const projectDir = input.project?.root ?? launched.projectDir ?? input.cwd;
  const dataDir = env.KOSMO_CALLFLOW_DATA ?? path.join(projectDir, ".kosmo-callflow");
  const defaultBase = `http://${env.KOSMO_CALLFLOW_HOST ?? DEFAULT_HOST}:${env.KOSMO_CALLFLOW_PORT ?? DEFAULT_PORT}`;

  let discovery: Discovery | undefined;
  const loadDiscovery = async (): Promise<LiveResolution | undefined> => {
    const found = await readDiscovery(dataDir, read);
    if (found !== undefined && "error" in found) return fail("invalid-project-config", found.error);
    discovery = found;
    return undefined;
  };

  let baseUrl: string;
  let allowedOrigins: string[];
  let endpointSource: LiveEndpointSource;
  if (target.kind === "live-endpoint") {
    baseUrl = target.url;
    allowedOrigins = [new URL(baseUrl).origin];
    endpointSource = "target";
  } else if (context !== null) {
    baseUrl = context.endpoint;
    allowedOrigins = [...context.allowedCollectorOrigins];
    endpointSource = "context";
  } else if (env.KOSMO_CALLFLOW_ENDPOINT !== undefined && env.KOSMO_CALLFLOW_ENDPOINT !== "") {
    const checked = checkedEndpoint(env.KOSMO_CALLFLOW_ENDPOINT, "KOSMO_CALLFLOW_ENDPOINT");
    if (!checked.ok) return fail("invalid-endpoint", checked.message, 1);
    baseUrl = checked.url;
    allowedOrigins = [new URL(baseUrl).origin];
    endpointSource = "env";
  } else {
    const failed = await loadDiscovery();
    if (failed) return failed;
    if (discovery?.url !== undefined) {
      const checked = checkedEndpoint(discovery.url, "endpoints.cli");
      if (!checked.ok) return fail("invalid-endpoint", checked.message);
      baseUrl = checked.url;
      const origin = new URL(baseUrl).origin;
      // The CLI's rule: a discovered endpoint is trusted only on loopback.
      allowedOrigins = isLoopbackOrigin(origin) ? [origin] : [new URL(defaultBase).origin];
      endpointSource = "discovery";
    } else {
      const checked = checkedEndpoint(defaultBase, "the default endpoint");
      if (!checked.ok) return fail("invalid-endpoint", checked.message, 1);
      baseUrl = checked.url;
      allowedOrigins = [new URL(baseUrl).origin];
      endpointSource = "default";
    }
  }
  const origin = new URL(baseUrl).origin;
  if (!allowedOrigins.includes(origin)) {
    return fail(
      "origin-not-allowed",
      `kosmo-tui: network target ${origin} is not an allowed collector; pass the endpoint explicitly as the target to choose it`
    );
  }

  // Token: explicit env override, then the launcher context (only for an origin it
  // allows), then the project's auth.projectTokenFile.
  let token: string | undefined;
  let authSource: LiveAuthSource = "none";
  let tokenFile: string | undefined;
  const overrideFile = env.KOSMO_CALLFLOW_PROJECT_TOKEN_FILE || env.KOSMO_CALLFLOW_TOKEN_FILE || undefined;
  const contextApplies = context !== null && context.allowedCollectorOrigins.includes(origin);
  if (overrideFile !== undefined) {
    tokenFile = path.resolve(input.cwd, overrideFile);
    authSource = "token-file";
  } else if (contextApplies && context.auth.kind === "token-file") {
    tokenFile = context.auth.path;
    authSource = "context-token-file";
  } else if (contextApplies && context.auth.kind === "env") {
    const fromEnv = contextToken(context, env);
    if (!fromEnv.ok) return fail("auth-token-missing", fromEnv.message);
    token = fromEnv.token;
    authSource = "context-env";
  } else if (!contextApplies || context.auth.kind !== "none") {
    if (discovery === undefined) {
      const failed = await loadDiscovery();
      if (failed) return failed;
    }
    if (discovery?.tokenFile !== undefined) {
      tokenFile = discovery.tokenFile;
      authSource = "token-file";
    }
  }
  if (tokenFile !== undefined) {
    const loaded = await readToken(tokenFile, read);
    if (!loaded.ok) return fail("auth-token-unreadable", loaded.message);
    token = loaded.token;
  }

  const projectId = context?.projectId ?? input.project?.projectId ?? input.projectId ?? null;
  return {
    ok: true,
    config: {
      baseUrl,
      allowedOrigins,
      projectId,
      traceId: target.kind === "live-trace" ? target.traceId : null,
      endpointSource,
      authSource,
      ...(tokenFile === undefined ? {} : { tokenFile })
    },
    token
  };
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

/** The subset of a fetch Response the client reads. */
export type LiveResponse = {
  status: number;
  type?: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
};

export type LiveFetch = (
  url: string,
  init: { method: "GET"; headers: Record<string, string>; redirect: "manual"; signal: AbortSignal }
) => Promise<LiveResponse>;

export type LiveSourceOptions = {
  config: LiveConfig;
  token?: string;
  fetch?: LiveFetch;
  /** Trace page size of the live projection. */
  pageSize?: number;
};

/** Bound on one response body; the daemon pages everything well below it. */
export const LIVE_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;
const PROBE_TRACE_ID = "kosmo-tui-capability-probe";
const EVENTS_PER_READ = 1000;

type LiveDataset = {
  projectId: string;
  datasetId: string;
  graphRevision: string;
  watermarkSeq: number;
  retentionEpoch: number;
};
type LiveRow = { traceId: string; sessionId: string; status: TraceRow["status"]; spansCount: number; firstSeq: number };
type LiveSnapshotBody = {
  dataset: LiveDataset;
  items: LiveRow[];
  markers?: { truncated?: boolean; gap?: boolean };
  pageCursor?: string;
  cursor: string;
};
type LivePageBody = { dataset: LiveDataset; items: LiveRow[]; markers?: { truncated?: boolean }; pageCursor?: string };
type LiveDeltaWire = { dataset: LiveDataset; items: LiveRow[]; cursor: string };

function isDataset(value: unknown): value is LiveDataset {
  const dataset = value as Partial<LiveDataset> | null;
  return (
    typeof dataset === "object" &&
    dataset !== null &&
    typeof dataset.projectId === "string" &&
    typeof dataset.datasetId === "string" &&
    typeof dataset.graphRevision === "string" &&
    typeof dataset.watermarkSeq === "number" &&
    typeof dataset.retentionEpoch === "number"
  );
}

function isRows(value: unknown): value is LiveRow[] {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        typeof (row as LiveRow)?.traceId === "string" &&
        typeof (row as LiveRow).sessionId === "string" &&
        typeof (row as LiveRow).spansCount === "number" &&
        typeof (row as LiveRow).firstSeq === "number"
    )
  );
}

function snapshotRefOf(dataset: LiveDataset): SnapshotRef {
  return {
    datasetId: dataset.datasetId,
    projectId: dataset.projectId,
    revision: dataset.graphRevision,
    watermark: dataset.watermarkSeq,
    retentionEpoch: dataset.retentionEpoch,
    snapshotId: `live:${dataset.datasetId}:e${dataset.retentionEpoch}:w${dataset.watermarkSeq}`
  };
}

function traceRowOf(dataset: LiveDataset, row: LiveRow): TraceRow {
  return {
    datasetId: dataset.datasetId,
    projectId: dataset.projectId,
    sessionId: row.sessionId,
    traceId: row.traceId,
    status: row.status === "errored" || row.status === "complete" ? row.status : "running",
    startedAt: row.firstSeq,
    spanCount: row.spansCount
  };
}

function selectionRefs(selection: TraceSelection): QualifiedTraceRef[] {
  if (selection.kind === "trace") return [selection.ref];
  if (selection.kind === "span") return [selection.ref];
  return selection.refs;
}

function selectionKey(selection: TraceSelection): string {
  return JSON.stringify(
    selectionRefs(selection)
      .map((ref) => [ref.datasetId, ref.projectId, ref.sessionId, ref.traceId])
      .concat(selection.kind === "span" ? [[selection.ref.spanId]] : [])
  );
}

function statusError(status: number, what: string): SourceError {
  if (status === 404 || status === 501) {
    return new SourceError("api-missing", `kosmo-tui: the daemon does not serve ${what} (status ${status})`, status);
  }
  if (status >= 500) {
    return new SourceError(
      "daemon-unavailable",
      connectOutcomeMessage("daemon-unavailable", `status ${status}`),
      status
    );
  }
  return new SourceError("unexpected-status", `kosmo-tui: the daemon answered ${what} with status ${status}`, status);
}

export type LiveSource = TraceSource & { readonly sourceId: string; readonly config: LiveConfig };

/**
 * Open a read-only live source. `token` is captured here and only ever placed in the
 * `x-kosmo-token` header of requests to an allowed origin.
 */
export function createLiveSource(options: LiveSourceOptions): LiveSource {
  const config = options.config;
  const token = options.token;
  const fetchImpl: LiveFetch = options.fetch ?? (globalThis.fetch as unknown as LiveFetch);
  const pageSize = Math.max(1, Math.min(options.pageSize ?? 50, 1000));
  const origin = new URL(config.baseUrl).origin;
  const sourceId = `live:${origin}`;
  const lifetime = new AbortController();
  let currentEpoch = 0;
  let closed = false;

  /** The caller's signal plus the source lifetime (AbortSignal.any needs Node 20). */
  function linked(signal: AbortSignal): AbortSignal {
    if (signal.aborted) return signal;
    if (lifetime.signal.aborted) return lifetime.signal;
    const controller = new AbortController();
    const abort = (from: AbortSignal) => () => controller.abort(from.reason);
    signal.addEventListener("abort", abort(signal), { once: true });
    lifetime.signal.addEventListener("abort", abort(lifetime.signal), { once: true });
    return controller.signal;
  }

  async function get(
    pathname: string,
    query: Record<string, string | undefined>,
    signal: AbortSignal,
    what: string
  ): Promise<{ status: number; body: unknown }> {
    if (closed) throw new SourceError("closed", "kosmo-tui: the live source is closed");
    const url = new URL(pathname, config.baseUrl);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value);
    if (!config.allowedOrigins.includes(url.origin)) {
      throw new SourceError(
        "origin-not-allowed",
        `kosmo-tui: network target ${url.origin} is not an allowed collector`
      );
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (token !== undefined) headers["x-kosmo-token"] = token;
    const combined = linked(signal);
    let response: LiveResponse;
    try {
      response = await fetchImpl(url.toString(), { method: "GET", headers, redirect: "manual", signal: combined });
    } catch (error) {
      if (combined.aborted) throw error;
      const code = (error as { cause?: { code?: unknown } })?.cause?.code;
      throw new SourceError(
        "daemon-unavailable",
        connectOutcomeMessage("daemon-unavailable", typeof code === "string" ? `${code} at ${origin}` : origin)
      );
    }
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      const location = response.headers.get("location");
      let targetOrigin = "an unknown location";
      try {
        if (location !== null) targetOrigin = new URL(location, url).origin;
      } catch {
        // An unparseable location stays "unknown"; nothing is followed either way.
      }
      const cross = targetOrigin !== url.origin;
      throw new SourceError(
        "redirect-refused",
        cross
          ? `kosmo-tui: the daemon at ${origin} redirected ${what} to another origin (${targetOrigin}); the redirect was not followed and no credentials were forwarded`
          : `kosmo-tui: the daemon at ${origin} redirected ${what}; redirects are not followed`,
        response.status || undefined
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new SourceError("auth-rejected", connectOutcomeMessage("auth-rejected"), response.status);
    }
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > LIVE_RESPONSE_MAX_BYTES) {
      throw new SourceError("response-too-large", `kosmo-tui: ${what} exceeds ${LIVE_RESPONSE_MAX_BYTES} bytes`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > LIVE_RESPONSE_MAX_BYTES) {
      throw new SourceError("response-too-large", `kosmo-tui: ${what} exceeds ${LIVE_RESPONSE_MAX_BYTES} bytes`);
    }
    let body: unknown;
    try {
      body = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      throw new SourceError(
        "invalid-response",
        `kosmo-tui: ${what} is not valid JSON (status ${response.status})`,
        response.status
      );
    }
    return { status: response.status, body };
  }

  const pageBinding = (snapshot: SnapshotRef, filter: PageFilter): CursorBinding => ({
    sourceId,
    snapshotId: snapshot.snapshotId,
    retentionEpoch: snapshot.retentionEpoch,
    projectionVersion: null,
    filter
  });
  const deltaBinding = (): CursorBinding => ({
    sourceId,
    snapshotId: "live-deltas",
    retentionEpoch: currentEpoch,
    projectionVersion: null,
    filter: {}
  });
  const wrapDelta = (cursor: string): string => encodeCursor(deltaBinding(), cursor);

  function tracePage(
    snapshot: SnapshotRef,
    filter: PageFilter,
    body: { dataset: LiveDataset; items: LiveRow[]; markers?: { truncated?: boolean }; pageCursor?: string },
    loadedBefore: number
  ): TracePage {
    const more = typeof body.pageCursor === "string" && body.pageCursor.length > 0;
    const items = body.items.map((row) => traceRowOf(body.dataset, row));
    const loaded = loadedBefore + items.length;
    return {
      items,
      coverage: { scope: more ? "partial" : "complete", loaded, total: more ? null : loaded },
      truncated: more,
      cursor: more ? encodeCursor(pageBinding(snapshot, filter), JSON.stringify([body.pageCursor, loaded])) : null
    };
  }

  function listQuery(filter: PageFilter): Record<string, string | undefined> {
    return { limit: String(pageSize), ...(filter.errorsOnly ? { errors: "true" } : {}) };
  }

  async function readSnapshot(filter: PageFilter, signal: AbortSignal): Promise<LiveSnapshotBody> {
    const { status, body } = await get("/api/v1/live/snapshot", listQuery(filter), signal, "the live snapshot");
    if (status !== 200) throw statusError(status, "the live snapshot");
    const snapshot = body as Partial<LiveSnapshotBody> | undefined;
    if (!isDataset(snapshot?.dataset) || !isRows(snapshot?.items) || typeof snapshot?.cursor !== "string") {
      throw new SourceError(
        "invalid-response",
        "kosmo-tui: the live snapshot does not have the expected shape",
        status
      );
    }
    return snapshot as LiveSnapshotBody;
  }

  /** A read-only capability probe: 200 means the API exists, 404/501 that it does not. */
  async function probeApi(pathname: string, query: Record<string, string>, signal: AbortSignal): Promise<boolean> {
    const { status } = await get(pathname, query, signal, `the ${pathname} API`);
    if (status === 200) return true;
    if (status === 404 || status === 501 || status === 400) return false;
    throw statusError(status, `the ${pathname} API`);
  }

  function baselineOf(body: LiveSnapshotBody): { snapshot: SnapshotRef; rows: TraceRow[] } {
    return { snapshot: snapshotRefOf(body.dataset), rows: body.items.map((row) => traceRowOf(body.dataset, row)) };
  }

  async function traceEvents(
    traceId: string,
    query: Record<string, string | undefined>,
    signal: AbortSignal
  ): Promise<{ items: TraceEventView[]; cursor: string | null; truncated: boolean }> {
    const { status, body } = await get(`/api/v1/traces/${encodeURIComponent(traceId)}`, query, signal, "trace events");
    if (status !== 200) throw statusError(status, "trace events");
    const wire = body as {
      items?: unknown;
      data?: { items?: unknown; cursor?: unknown; truncated?: unknown };
      cursor?: unknown;
      truncated?: unknown;
    };
    const payload = wire?.data ?? wire;
    if (!Array.isArray(payload?.items))
      throw new SourceError("invalid-response", "kosmo-tui: trace events do not have the expected shape");
    return {
      items: payload.items as TraceEventView[],
      cursor: typeof payload.cursor === "string" && payload.cursor.length > 0 ? payload.cursor : null,
      truncated: payload.truncated === true
    };
  }

  const source: LiveSource = {
    kind: "live",
    sourceId,
    config,

    async open(signal): Promise<SourceOpenResult> {
      const body = await readSnapshot({}, signal);
      const { snapshot } = baselineOf(body);
      currentEpoch = snapshot.retentionEpoch;
      // Capability probes run only after the snapshot read proved auth and reachability.
      const eventsApi = await probeApi(`/api/v1/traces/${PROBE_TRACE_ID}`, { maxSpans: "1", maxEvents: "1" }, signal);
      const probesApi = await probeApi("/api/v1/probes", { traceId: PROBE_TRACE_ID, limit: "1" }, signal);
      const offers: SourceOffers = {
        projectionVersions: [1, 2],
        follow: { available: true },
        replay: eventsApi ? { available: true } : { available: false, reason: "no-replay-api" },
        values: eventsApi ? { level: "full" } : { level: "none", reason: "no-trace-events-api" },
        probes: probesApi ? { available: true } : { available: false, reason: "no-probe-api" },
        staticGraph: { available: false, reason: "no-static-graph-reader" },
        sql: { available: false, reason: "sql-reads-offline-snapshots" }
      };
      return {
        snapshot,
        offers,
        firstPage: tracePage(snapshot, {}, body, 0),
        stableDataset: true,
        deltaCursor: wrapDelta(body.cursor)
      };
    },

    async traces(snapshot, options: PageOptions, signal): Promise<TracePage> {
      const filter = options.filter ?? {};
      if (!options.cursor) {
        const body = await readSnapshot(filter, signal);
        if (body.dataset.retentionEpoch !== snapshot.retentionEpoch) {
          throw new SourceError("reset", "kosmo-tui: the retention epoch changed; reload the baseline", 409);
        }
        return tracePage(snapshot, filter, body, 0);
      }
      const decoded = decodeCursor(options.cursor, pageBinding(snapshot, filter));
      if (!decoded.ok)
        throw new SourceError("cursor-rejected", `kosmo-tui: trace page cursor rejected (${decoded.reason})`, 400);
      const [pageCursor, loaded] = JSON.parse(decoded.position) as [string, number];
      const { status, body } = await get(
        "/api/v1/live/page",
        { ...listQuery(filter), cursor: pageCursor },
        signal,
        "a live trace page"
      );
      if (status === 409)
        throw new SourceError("reset", "kosmo-tui: the retention epoch changed; reload the baseline", 409);
      if (status === 400)
        throw new SourceError("cursor-rejected", "kosmo-tui: the daemon rejected the page cursor", 400);
      if (status !== 200) throw statusError(status, "a live trace page");
      const page = body as Partial<LivePageBody>;
      if (!isDataset(page?.dataset) || !isRows(page?.items)) {
        throw new SourceError("invalid-response", "kosmo-tui: the live page does not have the expected shape", status);
      }
      return tracePage(snapshot, filter, page as LivePageBody, loaded);
    },

    async deltas(cursor, signal): Promise<LiveDeltaBody> {
      const decoded = decodeCursor(cursor, deltaBinding());
      if (!decoded.ok)
        throw new SourceError("cursor-rejected", `kosmo-tui: delta cursor rejected (${decoded.reason})`, 400);
      const { status, body } = await get(
        "/api/v1/live/deltas",
        { cursor: decoded.position, limit: String(pageSize) },
        signal,
        "live deltas"
      );
      if (status === 409) {
        const reset = (body as { snapshot?: Partial<LiveSnapshotBody> } | undefined)?.snapshot;
        if (!isDataset(reset?.dataset) || !isRows(reset?.items) || typeof reset?.cursor !== "string") {
          throw new SourceError("reset", "kosmo-tui: the retention epoch changed; reload the baseline", 409);
        }
        const baseline = baselineOf(reset as LiveSnapshotBody);
        currentEpoch = baseline.snapshot.retentionEpoch;
        return {
          cursor: wrapDelta(reset.cursor),
          snapshot: baseline.snapshot,
          traces: baseline.rows,
          spans: [],
          dropped: [],
          gap: true,
          reset: true
        };
      }
      if (status === 400)
        throw new SourceError("cursor-rejected", "kosmo-tui: the daemon rejected the delta cursor", 400);
      if (status !== 200) throw statusError(status, "live deltas");
      const delta = body as Partial<LiveDeltaWire>;
      if (!isDataset(delta?.dataset) || !isRows(delta?.items) || typeof delta?.cursor !== "string") {
        throw new SourceError("invalid-response", "kosmo-tui: the live delta does not have the expected shape", status);
      }
      currentEpoch = delta.dataset.retentionEpoch;
      return {
        cursor: wrapDelta(delta.cursor),
        snapshot: snapshotRefOf(delta.dataset),
        traces: delta.items.map((row) => traceRowOf(delta.dataset!, row)),
        spans: [],
        dropped: [],
        gap: false,
        reset: false
      };
    },

    async canonical(snapshot, selection, options: ProjectionOptions, signal): Promise<VersionedCanonicalPage> {
      const refs = selectionRefs(selection);
      if (refs.length !== 1) {
        throw new SourceError("unsupported-selection", "kosmo-tui: a canonical page is read for one trace at a time");
      }
      const ref = refs[0]!;
      const version = options.version;
      const depth = options.depth === "function" ? "symbol" : options.depth;
      const query: Record<string, string | undefined> =
        version === 2
          ? { projectionVersion: "2", maxSpans: "1000", depth }
          : { projectionVersion: "1", maxSpans: "1000", maxEvents: "1000", depth };
      const { status, body } = await get(
        `/api/v1/traces/${encodeURIComponent(ref.traceId)}/canonical`,
        query,
        signal,
        "the canonical projection"
      );
      if (status === 400 && (body as { error?: unknown } | undefined)?.error === "unsupported_projection_version") {
        const supported = (body as { supported?: unknown }).supported;
        throw new SourceError(
          "projection-version-unsupported",
          `kosmo-tui: the daemon does not serve canonical projection v${version}${Array.isArray(supported) ? ` (supported: ${supported.join(", ")})` : ""}`,
          400
        );
      }
      if (status !== 200) throw statusError(status, "the canonical projection");
      const envelope = ((body as { data?: unknown } | undefined)?.data ?? body) as
        { projectionVersion?: unknown } | undefined;
      if (envelope?.projectionVersion !== version) {
        throw new SourceError(
          "projection-version-mismatch",
          `kosmo-tui: requested canonical projection v${version}, the daemon answered v${String(envelope?.projectionVersion)}; an older daemon ignores projectionVersion — upgrade it or read projection v${String(envelope?.projectionVersion)}`
        );
      }
      if (version === 2) {
        const parsed = canonicalPageEnvelopeV2Schema.safeParse(envelope);
        if (!parsed.success)
          throw new SourceError("projection-invalid", "kosmo-tui: the daemon's projection v2 page is invalid");
        if (parsed.data.dataset.projectId !== snapshot.projectId) {
          throw new SourceError("foreign-dataset", "kosmo-tui: the canonical page belongs to another project");
        }
        return { version: 2, envelope: parsed.data, ...canonicalPageMeta(parsed.data) };
      }
      const parsed = canonicalPageEnvelopeSchema.safeParse(envelope);
      if (!parsed.success)
        throw new SourceError("projection-invalid", "kosmo-tui: the daemon's projection v1 page is invalid");
      if (parsed.data.dataset.projectId !== snapshot.projectId) {
        throw new SourceError("foreign-dataset", "kosmo-tui: the canonical page belongs to another project");
      }
      return { version: 1, envelope: parsed.data, ...canonicalPageMeta(parsed.data) };
    },

    async details(snapshot, ref, signal): Promise<SpanEvidence> {
      if (ref.datasetId !== snapshot.datasetId || ref.projectId !== snapshot.projectId) {
        throw new SourceError("foreign-span", "kosmo-tui: the span belongs to another dataset");
      }
      const events = await traceEvents(
        ref.traceId,
        { maxSpans: String(EVENTS_PER_READ), maxEvents: String(EVENTS_PER_READ) },
        signal
      );
      const detail = spanDetailFromEvents(events.items, ref, null);
      if (detail === null) {
        throw new SourceError(
          "span-not-found",
          "kosmo-tui: no recorded events for the selected span in this read",
          404
        );
      }
      return {
        ref: {
          datasetId: ref.datasetId,
          projectId: ref.projectId,
          sessionId: ref.sessionId,
          traceId: ref.traceId,
          spanId: ref.spanId
        },
        nodeId: detail.nodeId,
        status: detail.status,
        args: detail.args,
        ret: detail.ret,
        error: detail.error,
        duration: detail.duration,
        anchor: detail.anchor,
        snapshot
      };
    },

    async records(snapshot, selection, options, signal): Promise<ReplayPage> {
      const refs = selectionRefs(selection);
      const key = selectionKey(selection);
      const binding = pageBinding(snapshot, {});
      let index = 0;
      let daemonCursor: string | null = null;
      let loadedBefore = 0;
      if (options.cursor) {
        const decoded = decodeCursor(options.cursor, binding);
        if (!decoded.ok)
          throw new SourceError("cursor-rejected", `kosmo-tui: record cursor rejected (${decoded.reason})`, 400);
        const position = JSON.parse(decoded.position) as { sel: string; i: number; c: string | null; n: number };
        if (position.sel !== key)
          throw new SourceError("cursor-rejected", "kosmo-tui: record cursor rejected (filter-changed)", 400);
        index = position.i;
        daemonCursor = position.c;
        loadedBefore = position.n;
      }
      const ref = refs[index];
      if (ref === undefined) {
        return {
          items: [],
          coverage: { scope: "complete", loaded: loadedBefore, total: loadedBefore },
          truncated: false,
          cursor: null
        };
      }
      const limit = Math.max(1, Math.min(options.limit, EVENTS_PER_READ));
      const page = await traceEvents(
        ref.traceId,
        { maxSpans: String(EVENTS_PER_READ), maxEvents: String(limit), cursor: daemonCursor ?? undefined },
        signal
      );
      const items = page.items
        .filter(
          (event) =>
            event.sessionId === ref.sessionId && (selection.kind !== "span" || event.spanId === selection.ref.spanId)
        )
        .map((event) => ({ ...event, projectId: snapshot.projectId }) as unknown as ReplayRecord);
      const loaded = loadedBefore + items.length;
      const next =
        page.cursor !== null
          ? { sel: key, i: index, c: page.cursor, n: loaded }
          : index + 1 < refs.length
            ? { sel: key, i: index + 1, c: null, n: loaded }
            : null;
      return {
        items,
        coverage: { scope: next === null ? "complete" : "partial", loaded, total: next === null ? loaded : null },
        truncated: next !== null,
        cursor: next === null ? null : encodeCursor(binding, JSON.stringify(next))
      };
    },

    async probes(snapshot, selection, options, signal): Promise<ProbePage> {
      const refs = selectionRefs(selection);
      const key = selectionKey(selection);
      const binding = pageBinding(snapshot, {});
      let index = 0;
      let loadedBefore = 0;
      if (options.cursor) {
        const decoded = decodeCursor(options.cursor, binding);
        if (!decoded.ok)
          throw new SourceError("cursor-rejected", `kosmo-tui: probe cursor rejected (${decoded.reason})`, 400);
        const position = JSON.parse(decoded.position) as { sel: string; i: number; n: number };
        if (position.sel !== key)
          throw new SourceError("cursor-rejected", "kosmo-tui: probe cursor rejected (filter-changed)", 400);
        index = position.i;
        loadedBefore = position.n;
      }
      const ref = refs[index];
      if (ref === undefined) {
        return {
          items: [],
          coverage: { scope: "complete", loaded: loadedBefore, total: loadedBefore },
          truncated: false,
          cursor: null
        };
      }
      const limit = Math.max(1, Math.min(options.limit, 1000));
      const { status, body } = await get(
        "/api/v1/probes",
        { traceId: ref.traceId, limit: String(limit) },
        signal,
        "probe records"
      );
      if (status !== 200) throw statusError(status, "probe records");
      const wire = body as { items?: unknown; truncated?: unknown } | undefined;
      if (!Array.isArray(wire?.items))
        throw new SourceError("invalid-response", "kosmo-tui: probe records do not have the expected shape");
      const items: ProbeRecord[] = (wire.items as Array<Record<string, unknown>>)
        .filter(
          (item) =>
            item.sessionId === ref.sessionId && (selection.kind !== "span" || item.spanId === selection.ref.spanId)
        )
        .map((item) => ({
          ref: {
            datasetId: snapshot.datasetId,
            projectId: snapshot.projectId,
            sessionId: String(item.sessionId),
            traceId: String(item.traceId),
            spanId: String(item.spanId)
          },
          probeId: String(item.probeId),
          probeSeq: Number(item.seq),
          label: String(item.expression ?? item.probeId),
          value: probeValue(item)
        }));
      const loaded = loadedBefore + items.length;
      const pageTruncated = wire.truncated === true;
      const next = index + 1 < refs.length ? { sel: key, i: index + 1, n: loaded } : null;
      return {
        items,
        coverage: {
          scope: next === null && !pageTruncated ? "complete" : "partial",
          loaded,
          total: next === null && !pageTruncated ? loaded : null,
          ...(pageTruncated ? { reason: "probe-page-truncated" } : {})
        },
        truncated: next !== null || pageTruncated,
        cursor: next === null ? null : encodeCursor(binding, JSON.stringify(next))
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      lifetime.abort(new SourceError("closed", "kosmo-tui: the live source is closed"));
    }
  };
  return source;
}

function probeValue(item: Record<string, unknown>): DetailValue {
  switch (item.status) {
    case "masked":
      return { state: "masked" };
    case "unavailable":
      return { state: "unavailable", reason: typeof item.reason === "string" ? item.reason : "probe-unavailable" };
    case "truncated": {
      const value = valueOf(item.value);
      return value.state === "recorded" ? { state: "recorded", text: `${value.text}… [truncated]` } : value;
    }
    default:
      return valueOf(item.value);
  }
}
