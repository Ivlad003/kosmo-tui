/**
 * Cross-source parity through kosmo-tui's own sources (task 4.5, KT half; tui-debugger
 * "Узгоджений offline snapshot", design D4/D14).
 *
 * test/fixtures/cross-source/ is the file kosmo-callflow's
 * tests/integration/cross-source/cross-source-parity.test.ts generates from ONE real
 * recording (an Express app under the register preload, against a real daemon): the
 * daemon's events.sqlite, two `kosmo-callflow export` files, the `connect
 * --stream-version 2` and v1 NDJSON streams, the manifest and the normalized golden facts.
 *
 * Here the same dataset is opened through the four kosmo-tui sources — live (a real
 * kosmo-callflow daemon re-serving that SQLite store), sqlite, export and stdin stream v2 —
 * and after an explicit identity mapping every source must state the facts of the golden.
 * Byte parity is claimed only for the identical envelope (live vs sqlite: same shared
 * projector, version and options). The v1 stream is summary-only and cannot claim parity.
 */
import { copyFileSync, createReadStream, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CanonicalPageEnvelopeV2 } from "@kosmo-callflow/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectionLine } from "../src/render.js";
import { createSession } from "../src/session.js";
import { createExportSource } from "../src/source-export.js";
import { createLiveSource } from "../src/source-live.js";
import { createSqliteSource } from "../src/source-sqlite.js";
import { createStreamSource } from "../src/source-stream.js";
import type { SourceOpenResult, TraceSource } from "../src/source.js";
import {
  compareSourceFacts,
  normalizeFacts,
  sourceMeta,
  spanFacts,
  type IdentityMapping,
  type SourceMeta,
  type SpanFact
} from "./cross-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "cross-source");
const KC_FIXTURE = path.resolve(here, "../../kosmo-callflow/tests/fixtures/cross-source");
const KC_DAEMON = path.resolve(here, "../../kosmo-callflow/packages/daemon/dist/index.js");
const kcDaemon = existsSync(KC_DAEMON) && kcDaemonLoadable(path.resolve(here, "../../kosmo-callflow"));

type Manifest = {
  projectId: string;
  sessionId: string;
  traces: { ok: string; errored: string };
  order: string[];
  files: Record<"sqlite" | "exportErrored" | "exportOk" | "streamV2" | "streamV1", string>;
  live: { canonical: Record<string, CanonicalPageEnvelopeV2> };
};
const manifest = JSON.parse(readFileSync(path.join(FIXTURE, "manifest.json"), "utf8")) as Manifest;
const golden = JSON.parse(readFileSync(path.join(FIXTURE, "facts.golden.json"), "utf8")) as unknown;
const file = (name: keyof Manifest["files"]) => path.join(FIXTURE, manifest.files[name]);
const never = new AbortController().signal;

async function canonicalPages(source: TraceSource, opened: SourceOpenResult) {
  const pages: Record<string, CanonicalPageEnvelopeV2> = {};
  for (const traceId of manifest.order) {
    const row = opened.firstPage.items.find((item) => item.traceId === traceId);
    if (row === undefined) continue;
    const page = await source.canonical!(opened.snapshot, { kind: "trace", ref: row }, { version: 2 }, never);
    if (page.version !== 2) throw new Error("expected projection v2");
    pages[traceId] = page.envelope;
  }
  return pages;
}

type Opened = { source: TraceSource; opened: SourceOpenResult; pages: Record<string, CanonicalPageEnvelopeV2> };

async function openAll(source: TraceSource): Promise<Opened> {
  const opened = await source.open(never);
  return { source, opened, pages: await canonicalPages(source, opened) };
}

function exportSource(name: "exportErrored" | "exportOk") {
  return createExportSource({ path: file(name) });
}

function streamSource(name: "streamV2" | "streamV1") {
  return createStreamSource({ input: createReadStream(file(name)) });
}

let live: { url: string; token: string; close(): Promise<void>; dir: string } | null = null;

beforeAll(async () => {
  if (!kcDaemon) return;
  // A real kosmo-callflow daemon re-serving the recorded store: the live daemon API over
  // exactly the dataset the other sources hold.
  const dir = mkdtempSync(path.join(os.tmpdir(), "kosmo-tui-cross-source-"));
  copyFileSync(file("sqlite"), path.join(dir, "events.sqlite"));
  const { startDaemon } = (await import(pathToFileURL(KC_DAEMON).href)) as {
    startDaemon(options: Record<string, unknown>): Promise<{ url: string; close(): Promise<void> }>;
  };
  const token = "cross-source-project-token-0123456789";
  const daemon = await startDaemon({
    dataDir: dir,
    host: "127.0.0.1",
    port: 0,
    projectId: manifest.projectId,
    projectToken: token,
    ingestToken: "cross-source-ingest-token-0123456789",
    webToken: "cross-source-web-token-0123456789"
  });
  live = { url: daemon.url, token, close: () => daemon.close(), dir };
}, 30_000);

afterAll(async () => {
  if (live) {
    await live.close();
    rmSync(live.dir, { recursive: true, force: true });
  }
});

function liveSource(): TraceSource {
  const origin = new URL(live!.url).origin;
  return createLiveSource({
    config: {
      baseUrl: live!.url,
      allowedOrigins: [origin],
      projectId: manifest.projectId,
      traceId: null,
      endpointSource: "target",
      authSource: "token-file"
    },
    token: live!.token
  });
}

describe("4.5 the shared generated fixture", () => {
  it.skipIf(!existsSync(KC_FIXTURE))("is byte-identical to the one kosmo-callflow generated", () => {
    for (const name of [...Object.values(manifest.files), "manifest.json", "facts.golden.json"]) {
      expect(readFileSync(path.join(FIXTURE, name)).equals(readFileSync(path.join(KC_FIXTURE, name))), name).toBe(true);
    }
  });

  it("the golden facts are what the recording's own live pages state", () => {
    const facts = Object.fromEntries(manifest.order.map((id) => [id, spanFacts(manifest.live.canonical[id]!)]));
    expect(normalizeFacts(facts, manifest.order)).toEqual(golden);
  });
});

describe("4.5 cross-source semantic parity through kosmo-tui sources", () => {
  it.skipIf(!kcDaemon)(
    "live, sqlite, export and stream v2 state the golden facts after an explicit identity mapping",
    async () => {
      const liveOpened = await openAll(liveSource());
      const sqlite = await openAll(createSqliteSource({ path: file("sqlite") }));
      const exported = await openAll(exportSource("exportErrored"));
      const exportedOk = await openAll(exportSource("exportOk"));
      const stream = await openAll(streamSource("streamV2"));
      try {
        const { ok, errored } = manifest.traces;
        const sources: Array<{ meta: SourceMeta; pages: Record<string, CanonicalPageEnvelopeV2> }> = [
          { meta: sourceMeta("live", liveOpened.pages[errored]!), pages: liveOpened.pages },
          { meta: sourceMeta("sqlite", sqlite.pages[errored]!), pages: sqlite.pages },
          { meta: sourceMeta("export", exported.pages[errored]!), pages: { ...exportedOk.pages, ...exported.pages } },
          { meta: sourceMeta("stream-v2", stream.pages[errored]!), pages: stream.pages }
        ];
        // Namespaces/provenance are what each source says — nothing is erased for the golden.
        expect(sources.map((source) => [source.meta.source, source.meta.provenance])).toEqual([
          ["live", "live"],
          ["sqlite", "live"],
          ["export", "imported"],
          ["stream-v2", "live"]
        ]);
        expect(sources[0]!.meta.datasetId).toBe(`live:${manifest.projectId}`);
        expect(sources[2]!.meta.datasetId).not.toBe(sources[0]!.meta.datasetId);
        // kosmo-tui's own snapshot identities differ per source (no shared fake namespace);
        // cursors of one source are never accepted by another.
        const snapshots = [liveOpened, sqlite, exported, stream].map((entry) => entry.opened.snapshot.snapshotId);
        expect(new Set(snapshots).size).toBe(snapshots.length);
        expect(exported.opened.stableDataset).toBe(true);
        expect(stream.opened.stableDataset).toBe(false);

        const mapping: IdentityMapping = {
          projectId: manifest.projectId,
          datasets: Object.fromEntries(sources.map((source) => [source.meta.source, source.meta.datasetId]))
        };
        for (const traceId of [ok, errored]) {
          const reference = { meta: sources[0]!.meta, facts: spanFacts(sources[0]!.pages[traceId]!) };
          for (const other of sources.slice(1)) {
            const page = other.pages[traceId]!;
            const meta = sourceMeta(other.meta.source, page);
            const perTrace = { ...mapping, datasets: { ...mapping.datasets, [meta.source]: meta.datasetId } };
            const verdict = compareSourceFacts(perTrace, reference, { meta, facts: spanFacts(page) });
            expect(verdict.verdict, `${meta.source} ${traceId}: ${JSON.stringify(verdict)}`).toBe("equal");
            if (verdict.verdict !== "equal") continue;
            if (meta.source === "export") {
              expect(verdict.exportRedacted.length).toBeGreaterThan(0);
              expect(verdict.exportRedacted.every((entry) => entry.endsWith(".framework.route"))).toBe(true);
            } else expect(verdict.exportRedacted).toEqual([]);
          }
        }
        // Every source states the golden: each one normalized on its own.
        for (const source of sources.filter((entry) => entry.meta.provenance === "live")) {
          const facts = Object.fromEntries(manifest.order.map((id) => [id, spanFacts(source.pages[id]!)]));
          expect(normalizeFacts(facts, manifest.order), source.meta.source).toEqual(golden);
        }
      } finally {
        for (const entry of [liveOpened, sqlite, exported, exportedOk, stream]) await entry.source.close();
      }
    },
    30_000
  );

  it("a changed fact or an unmapped namespace is not reported as parity", async () => {
    const sqlite = await openAll(createSqliteSource({ path: file("sqlite") }));
    const exported = await openAll(exportSource("exportErrored"));
    try {
      const traceId = manifest.traces.errored;
      const left = { meta: sourceMeta("sqlite", sqlite.pages[traceId]!), facts: spanFacts(sqlite.pages[traceId]!) };
      const rightMeta = sourceMeta("export", exported.pages[traceId]!);
      const facts = spanFacts(exported.pages[traceId]!);
      const mapping = {
        projectId: manifest.projectId,
        datasets: { sqlite: left.meta.datasetId, export: rightMeta.datasetId }
      };
      expect(compareSourceFacts(mapping, left, { meta: rightMeta, facts }).verdict).toBe("equal");
      const tampered: SpanFact[] = facts.map((fact) =>
        fact.nodeId === "lib/cart.cjs#checkout"
          ? { ...fact, error: { state: "not-recorded", reason: "no-error-event" } }
          : fact
      );
      expect(compareSourceFacts(mapping, left, { meta: rightMeta, facts: tampered }).verdict).toBe("different");
      const unmapped = { projectId: manifest.projectId, datasets: { sqlite: left.meta.datasetId } };
      expect(compareSourceFacts(unmapped, left, { meta: rightMeta, facts }).verdict).toBe("not-comparable");
    } finally {
      await sqlite.source.close();
      await exported.source.close();
    }
  });
});

describe("4.5 byte parity of the identical canonical envelope", () => {
  it.skipIf(!kcDaemon)(
    "live daemon and SQLite projector serve byte-identical v2 envelopes for the same scope",
    async () => {
      const liveOpened = await openAll(liveSource());
      const whole = await openAll(createSqliteSource({ path: file("sqlite") }));
      try {
        for (const traceId of manifest.order) {
          // The daemon projects one trace's records: the same trace-scoped SQLite read is the
          // identical envelope (same projector, version and options), byte for byte.
          const scoped = await openAll(createSqliteSource({ path: file("sqlite"), traceId }));
          try {
            expect(JSON.stringify(scoped.pages[traceId]), traceId).toBe(JSON.stringify(liveOpened.pages[traceId]));
          } finally {
            await scoped.source.close();
          }
          // A whole-store read is a different scope: only its dataset watermark (and the
          // revision derived from it) differ; that is source metadata, not a fact.
          const wholePage = whole.pages[traceId]!;
          const livePage = liveOpened.pages[traceId]!;
          expect(wholePage.dataset.watermarkSeq).toBeGreaterThanOrEqual(livePage.dataset.watermarkSeq);
          const revision = (page: CanonicalPageEnvelopeV2) =>
            JSON.stringify(page)
              .split(page.dataset.graphRevision)
              .join("<revision>")
              .replace(`"watermarkSeq":${page.dataset.watermarkSeq}`, '"watermarkSeq":"<w>"');
          expect(revision(wholePage)).toBe(revision(livePage));
        }
      } finally {
        await liveOpened.source.close();
        await whole.source.close();
      }
    }
  );

  it("the stream v2 chunks carry the recorded live envelope unchanged", async () => {
    const stream = await openAll(streamSource("streamV2"));
    try {
      for (const traceId of manifest.order) {
        expect(JSON.stringify(stream.pages[traceId]), traceId).toBe(JSON.stringify(manifest.live.canonical[traceId]));
      }
    } finally {
      await stream.source.close();
    }
  });

  it("an export is a different envelope (namespace, provenance): byte parity is not claimed", async () => {
    const exported = await openAll(exportSource("exportErrored"));
    try {
      const traceId = manifest.traces.errored;
      expect(JSON.stringify(exported.pages[traceId])).not.toBe(JSON.stringify(manifest.live.canonical[traceId]));
      expect(exported.pages[traceId]!.dataset.source).toBe("imported");
    } finally {
      await exported.source.close();
    }
  });
});

describe("4.5 the legacy v1 summary stream cannot claim full parity", () => {
  it("offers no canonical projection and compares as not-comparable", async () => {
    const source = streamSource("streamV1");
    const opened = await source.open(never);
    try {
      expect(opened.offers.projectionVersions).toEqual([]);
      expect(opened.offers.projectionReason).toBe("summary-only-stream");
      // The same traces, as summaries only.
      expect(opened.firstPage.items.map((row) => row.traceId).sort()).toEqual([...manifest.order].sort());
      const row = opened.firstPage.items[0]!;
      await expect(
        source.canonical!(opened.snapshot, { kind: "trace", ref: row }, { version: 2 }, never)
      ).rejects.toThrow(/summary-only-stream/);
      const meta: SourceMeta = {
        source: "stream-v1",
        datasetId: opened.snapshot.datasetId,
        projectId: opened.snapshot.projectId,
        provenance: "live",
        watermarkSeq: opened.snapshot.watermark ?? 0,
        retentionEpoch: opened.snapshot.retentionEpoch,
        capabilities: opened.offers.projectionVersions.length === 0 ? "summary-only" : "canonical"
      };
      const reference = manifest.live.canonical[manifest.traces.errored]!;
      const verdict = compareSourceFacts(
        { projectId: manifest.projectId, datasets: { live: reference.dataset.datasetId, "stream-v1": meta.datasetId } },
        { meta: sourceMeta("live", reference), facts: spanFacts(reference) },
        { meta, facts: null }
      );
      expect(verdict).toEqual({
        verdict: "not-comparable",
        reason: "stream-v1 is summary-only: it carries trace summaries, not spans"
      });
    } finally {
      await source.close();
    }
  });
});

describe("source-accurate header", () => {
  async function headerFor(source: TraceSource): Promise<string> {
    const session = createSession({ source });
    await session.start();
    try {
      return connectionLine(session.state());
    } finally {
      await session.close();
    }
  }

  it("names the export, the static SQLite snapshot and how a stream ended", async () => {
    expect(await headerFor(exportSource("exportErrored"))).toMatch(/^export snapshot \| /);
    expect(await headerFor(createSqliteSource({ path: file("sqlite") }))).toMatch(/^sqlite snapshot \(static\) \| /);
    expect(await headerFor(streamSource("streamV2"))).toMatch(/^stream v2 \(ended\) \| /);
    expect(await headerFor(streamSource("streamV1"))).toMatch(/^stream v1 \(ended\) \| /);
    // EOF before `end`: the stream says it is incomplete, never live or complete.
    const lines = readFileSync(file("streamV2"), "utf8").split("\n").filter(Boolean);
    const truncated = new PassThrough();
    truncated.end(`${lines.filter((line) => !line.startsWith('{"type":"end"')).join("\n")}\n`);
    const header = await headerFor(createStreamSource({ input: truncated }));
    expect(header).toMatch(/^stream v2 \(incomplete\) \| /);
    expect(header).not.toContain("connected; live");
  });

  it.skipIf(!kcDaemon)("a live daemon keeps connected; live", async () => {
    expect(await headerFor(liveSource())).toMatch(/^connected; live \| /);
  });
});

/**
 * The kosmo-callflow daemon runs in this process and loads kosmo-callflow's own native
 * better-sqlite3; built for another Node ABI it cannot load here (a cross-version matrix
 * run), which is an environment limit of this gate, not a kosmo-tui failure.
 */
function kcDaemonLoadable(kcRoot: string): boolean {
  try {
    const Database = createRequire(path.join(kcRoot, "packages/daemon/package.json"))("better-sqlite3") as new (
      file: string
    ) => { close(): void };
    new Database(":memory:").close();
    return true;
  } catch {
    return false;
  }
}
