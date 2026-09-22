/**
 * Target kind → source constructor (tasks 4.1–4.3). The only place that decides which
 * concrete `TraceSource` a resolved target opens:
 *
 *  - live-project / live-trace / live-endpoint → live daemon source (config and auth
 *    resolved first; a config/auth problem is an error before any network read);
 *  - export file → portable export source;
 *  - `-` (stdin) → NDJSON stream source, which gets NO fetch: stdin data never makes
 *    kosmo-tui contact a daemon;
 *  - sqlite → the static SQLite snapshot source (4.4); a missing driver is an explicit
 *    `unavailable(sqlite-driver)` when the source opens.
 */

import type { ProjectCandidate, ResolvedTarget } from "./detect.js";
import { createExportSource, type ExportFs } from "./source-export.js";
import { createLiveSource, resolveLiveConfig, type LiveFetch } from "./source-live.js";
import { createSqliteSource } from "./source-sqlite.js";
import type { SqliteDriverSelection } from "./sqlite-driver.js";
import { createStreamSource, type StreamInput } from "./source-stream.js";
import type { TraceSource } from "./source.js";

export type OpenTargetInput = {
  target: ResolvedTarget;
  project: ProjectCandidate | null;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  projectId?: string;
};

export type OpenTargetDeps = {
  fetch?: LiveFetch;
  readFile?: (filePath: string) => Promise<string>;
  exportFs?: ExportFs;
  /** The data stdin for `-`; defaults to `process.stdin`. */
  stdinData?: StreamInput;
  /** SQLite driver selection; defaults to feature detection. */
  sqliteDriver?: SqliteDriverSelection;
};

export type OpenTargetResult =
  { ok: true; source: TraceSource } | { ok: false; code: string; message: string; exitCode: 1 | 2 };

export async function openTargetSource(input: OpenTargetInput, deps: OpenTargetDeps = {}): Promise<OpenTargetResult> {
  const { target } = input;
  switch (target.kind) {
    case "live-project":
    case "live-trace":
    case "live-endpoint": {
      const resolved = await resolveLiveConfig({
        target,
        project: input.project,
        env: input.env,
        cwd: input.cwd,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(deps.readFile === undefined ? {} : { readFile: deps.readFile })
      });
      if (!resolved.ok) return resolved;
      return {
        ok: true,
        source: createLiveSource({
          config: resolved.config,
          ...(resolved.token === undefined ? {} : { token: resolved.token }),
          ...(deps.fetch === undefined ? {} : { fetch: deps.fetch })
        })
      };
    }
    case "export":
      return {
        ok: true,
        source: createExportSource({ path: target.path, ...(deps.exportFs ? { fs: deps.exportFs } : {}) })
      };
    case "stdin":
      return {
        ok: true,
        source: createStreamSource({ input: deps.stdinData ?? (process.stdin as unknown as StreamInput) })
      };
    case "sqlite":
      return {
        ok: true,
        source: createSqliteSource({
          path: target.path,
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          ...(deps.sqliteDriver ? { driver: deps.sqliteDriver } : {})
        })
      };
  }
}
