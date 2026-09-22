#!/usr/bin/env node
/**
 * SQLite store fixture generator (tasks 4.4 / 5b.3).
 *
 * Writes test/fixtures/sqlite/store.sqlite with the REAL kosmo-callflow daemon store
 * (`openSqliteEventStore` from `packages/daemon/dist/store` of a built kosmo-callflow
 * checkout), so the SQLite source and the SQL recipes are tested against the schema,
 * tables and seq domains the daemon actually writes — not a hand-made imitation. The
 * file is checkpointed and switched to rollback-journal mode before it is copied, so it
 * is self-contained (no -wal/-shm companions).
 *
 *   node scripts/sqlite-fixture-kc.mjs [--kc <path-to-kosmo-callflow>]
 *
 * Default kosmo-callflow path: ../kosmo-callflow next to this repo. Run `npm run build`
 * there first. The fixture is only ever produced by this script.
 */

import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const KT_ROOT = path.resolve(here, "..");
export const FIXTURE_FILE = path.join(KT_ROOT, "test/fixtures/sqlite/store.sqlite");
export const FIXTURE_PROJECT = "fixture-project";

function event(sessionId, localSeq, fields) {
  return {
    v: 1,
    projectId: FIXTURE_PROJECT,
    sessionId,
    localSeq,
    idempotencyKey: `${sessionId}:${localSeq}`,
    parentSpanId: null,
    type: "enter",
    kind: "function",
    runtime: sessionId === "s-web" ? "browser" : "node",
    serviceName: sessionId === "s-web" ? "web" : "api",
    level: "shallow",
    payload: {},
    flags: {},
    ...fields
  };
}

/** Deterministic content: two sessions, a cross-session parent, errors of two kinds, a recorded cycle. */
export function fixtureBatches() {
  const web = [
    event("s-web", 1, {
      traceId: "t-checkout",
      spanId: "req",
      nodeId: "src/web/checkout.ts#submit",
      ts: 1000,
      payload: { args: [{ cart: "c-1" }] }
    }),
    event("s-web", 2, {
      traceId: "t-checkout",
      spanId: "validate",
      parentSpanId: "req",
      nodeId: "src/web/validate.ts#validate",
      ts: 1010
    }),
    event("s-web", 3, {
      traceId: "t-checkout",
      spanId: "validate",
      parentSpanId: "req",
      nodeId: "src/web/validate.ts#validate",
      type: "exit",
      ts: 1030,
      payload: { ret: "order-7" }
    }),
    event("s-web", 4, {
      traceId: "t-checkout",
      spanId: "req",
      nodeId: "src/web/checkout.ts#submit",
      type: "exit",
      ts: 1250,
      payload: { ret: { ok: false } }
    }),
    event("s-web", 5, { traceId: "t-login", spanId: "login", nodeId: "src/web/login.ts#login", ts: 2000 }),
    event("s-web", 6, {
      traceId: "t-login",
      spanId: "audit",
      parentSpanId: "login",
      nodeId: "src/web/audit.ts#audit",
      ts: 2010,
      payload: { args: ["order-7"] }
    }),
    event("s-web", 7, {
      traceId: "t-login",
      spanId: "audit",
      parentSpanId: "login",
      nodeId: "src/web/audit.ts#audit",
      type: "exit",
      ts: 2020
    }),
    event("s-web", 8, {
      traceId: "t-login",
      spanId: "login",
      nodeId: "src/web/login.ts#login",
      type: "error",
      ts: 2050,
      payload: { error: { name: "ValidationError", message: "bad email" } }
    })
  ];
  const api = [
    // Cross-session parent: the api span's parent is the web request span.
    event("s-api", 1, {
      traceId: "t-checkout",
      spanId: "handle",
      parentSpanId: "req",
      nodeId: "src/api/orders.ts#handle",
      ts: 1100,
      payload: { args: ["order-7"] }
    }),
    event("s-api", 2, {
      traceId: "t-checkout",
      spanId: "query",
      parentSpanId: "handle",
      nodeId: "src/api/db.ts#query",
      ts: 1110
    }),
    event("s-api", 3, {
      traceId: "t-checkout",
      spanId: "query",
      parentSpanId: "handle",
      nodeId: "src/api/db.ts#query",
      type: "error",
      ts: 1190,
      payload: { error: { name: "TimeoutError", message: "db timeout" } }
    }),
    event("s-api", 4, {
      traceId: "t-checkout",
      spanId: "handle",
      parentSpanId: "req",
      nodeId: "src/api/orders.ts#handle",
      type: "error",
      ts: 1200,
      payload: { error: { name: "TimeoutError", message: "db timeout" } }
    }),
    // A recorded parent cycle (corrupt producer data): every walk must stop on it.
    event("s-api", 5, { traceId: "t-cycle", spanId: "a", parentSpanId: "b", nodeId: "src/api/loop.ts#a", ts: 3000 }),
    event("s-api", 6, { traceId: "t-cycle", spanId: "b", parentSpanId: "a", nodeId: "src/api/loop.ts#b", ts: 3001 })
  ];
  return [web, api];
}

export async function writeFixture(kcRoot = path.resolve(KT_ROOT, "../kosmo-callflow"), target = FIXTURE_FILE) {
  const store = await import(pathToFileURL(path.join(kcRoot, "packages/daemon/dist/store/index.js")).href);
  const dir = mkdtempSync(path.join(tmpdir(), "kosmo-tui-sqlite-fixture-"));
  try {
    const events = store.openSqliteEventStore({ dataDir: dir, projectId: FIXTURE_PROJECT });
    for (const batch of fixtureBatches()) {
      const result = events.appendBatch(batch);
      if ((result.rejected ?? []).length > 0) throw new Error(`rejected: ${JSON.stringify(result.rejected)}`);
    }
    events.close?.();
    const Database = createRequire(path.join(kcRoot, "package.json"))("better-sqlite3");
    const db = new Database(path.join(dir, "events.sqlite"));
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.pragma("journal_mode = DELETE");
    db.close();
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(dir, "events.sqlite"), target);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--kc");
  const kc = index === -1 ? undefined : process.argv[index + 1];
  const written = await writeFixture(kc === undefined ? undefined : path.resolve(kc));
  process.stdout.write(`wrote ${path.relative(KT_ROOT, written)}\n`);
}
