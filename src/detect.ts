/**
 * Target detection (design D5): one positional target, no mode flags.
 *
 * Resolution order, first match wins, and it is deterministic for a given filesystem:
 *
 *  1. absent            → live project resolved from cwd
 *  2. `-`               → NDJSON stream on stdin
 *  3. `scheme://…`      → live endpoint; only http/https, no userinfo, no token query
 *  4. explicit path     → `./`, `../`, `/`, `~`, `.\`, drive letter, any path separator,
 *                         or a known extension (.json .sqlite .sqlite3 .db). It MUST
 *                         exist; a missing explicit path is a usage error and never
 *                         becomes a traceId.
 *  5. existing file     → a bare name that exists in cwd is a file source
 *  6. anything else     → opaque live traceId; there is no minimum length (`t_9f`)
 *
 * File kind is sniffed from content, not from the extension: the 16-byte SQLite
 * header means SQLite, a leading `{` (after BOM/whitespace) means portable export.
 * Full JSON/schema validation stays with the shared importer.
 *
 * Only read-only filesystem calls (stat + reading a small header) happen here; no
 * network, review or terminal side effect.
 */

import path from "node:path";

export type ResolvedTarget =
  | { kind: "live-project" }
  | { kind: "live-trace"; traceId: string }
  | { kind: "live-endpoint"; url: string }
  | { kind: "stdin" }
  | { kind: "export"; path: string }
  | { kind: "sqlite"; path: string };

export type DetectErrorCode =
  | "empty-target"
  | "invalid-target"
  | "missing-path"
  | "not-a-file"
  | "unrecognized-file"
  | "unsupported-scheme"
  | "invalid-endpoint"
  | "endpoint-credentials";

/** Usage errors exit 1; content errors (the file exists but is not a trace source) exit 2. */
export type DetectResult =
  { ok: true; target: ResolvedTarget } | { ok: false; code: DetectErrorCode; message: string; exitCode: 1 | 2 };

export type FileStat = { isFile: boolean; isDirectory: boolean; size: number };

/** Read-only filesystem port. `stat` resolves undefined when the path does not exist. */
export type DetectFs = {
  stat(filePath: string): Promise<FileStat | undefined>;
  readHead(filePath: string, bytes: number): Promise<Uint8Array>;
};

export type DetectContext = { cwd: string; homedir: string; fs: DetectFs };

export const KNOWN_EXTENSIONS = [".json", ".sqlite", ".sqlite3", ".db"] as const;
const SQLITE_MAGIC = "SQLite format 3\u0000";

const TOKEN_PARAM =
  /^(token|access[_-]?token|auth|authorization|api[_-]?key|apikey|key|secret|password|pass|session)$/i;

export function isExplicitPath(target: string): boolean {
  if (target === "~" || target.startsWith("~/") || target.startsWith("~\\")) return true;
  if (target.startsWith("./") || target.startsWith("../") || target === "." || target === "..") return true;
  if (target.startsWith(".\\") || target.startsWith("..\\")) return true;
  if (target.startsWith("/") || target.startsWith("\\")) return true;
  if (/^[A-Za-z]:[\\/]/.test(target)) return true;
  if (target.includes("/") || target.includes("\\")) return true;
  const lower = target.toLowerCase();
  return KNOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Redact userinfo and credential-like query values so an error never echoes a secret. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "";
    }
    for (const key of [...url.searchParams.keys()]) {
      if (TOKEN_PARAM.test(key)) url.searchParams.set(key, "***");
    }
    return url.toString();
  } catch {
    return "<invalid url>";
  }
}

/** Validate an endpoint URL. Credentials in the URL are rejected, not silently stripped. */
export function validateEndpoint(raw: string): DetectResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return usage("invalid-endpoint", `kosmo-tui: ${JSON.stringify(raw)} is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return usage("unsupported-scheme", `kosmo-tui: only http(s) endpoints are supported, received ${url.protocol}//`);
  }
  if (url.username !== "" || url.password !== "") {
    return usage(
      "endpoint-credentials",
      `kosmo-tui: endpoint ${redactUrl(raw)} carries userinfo credentials; remove them — the token is read from auth.projectTokenFile`
    );
  }
  const tokenKeys = [...url.searchParams.keys()].filter((key) => TOKEN_PARAM.test(key));
  if (tokenKeys.length > 0) {
    return usage(
      "endpoint-credentials",
      `kosmo-tui: endpoint ${redactUrl(raw)} carries a credential query parameter (${tokenKeys.join(", ")}); remove it — the token is read from auth.projectTokenFile`
    );
  }
  if (url.hash !== "") url.hash = "";
  return { ok: true, target: { kind: "live-endpoint", url: url.toString() } };
}

function usage(code: DetectErrorCode, message: string): DetectResult {
  return { ok: false, code, message, exitCode: 1 };
}

function expandHome(target: string, homedir: string): string {
  if (target === "~") return homedir;
  if (target.startsWith("~/") || target.startsWith("~\\")) return path.join(homedir, target.slice(2));
  return target;
}

/** Classify a file by its first bytes. */
export function sniffFileKind(head: Uint8Array): "sqlite" | "export" | undefined {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(head);
  if (text.startsWith(SQLITE_MAGIC)) return "sqlite";
  const trimmed = text.replace(/^\ufeff/, "").trimStart();
  if (trimmed.startsWith("{")) return "export";
  return undefined;
}

export async function detectTarget(target: string | undefined, context: DetectContext): Promise<DetectResult> {
  if (target === undefined) return { ok: true, target: { kind: "live-project" } };
  if (target === "") return usage("empty-target", "kosmo-tui: the target is an empty string");
  if (target === "-") return { ok: true, target: { kind: "stdin" } };
  if (/[\u0000-\u001f\u007f]/.test(target)) {
    return usage("invalid-target", "kosmo-tui: the target contains control characters");
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(target)) return validateEndpoint(target);

  const explicit = isExplicitPath(target);
  const resolved = path.resolve(context.cwd, expandHome(target, context.homedir));
  const stat = await context.fs.stat(resolved);
  if (stat === undefined) {
    if (explicit) {
      return usage(
        "missing-path",
        `kosmo-tui: ${target} does not exist. A path is never treated as a trace id; use --trace <id> for a literal id.`
      );
    }
    if (/\s/.test(target))
      return usage("invalid-target", `kosmo-tui: ${JSON.stringify(target)} is not a valid trace id`);
    return { ok: true, target: { kind: "live-trace", traceId: target } };
  }
  if (!stat.isFile) {
    return usage("not-a-file", `kosmo-tui: ${target} is not a regular file`);
  }
  const kind = sniffFileKind(await context.fs.readHead(resolved, 64));
  if (kind === undefined) {
    return {
      ok: false,
      code: "unrecognized-file",
      message: `kosmo-tui: ${target} is neither a SQLite store nor a portable JSON export`,
      exitCode: 2
    };
  }
  return {
    ok: true,
    target: kind === "sqlite" ? { kind: "sqlite", path: resolved } : { kind: "export", path: resolved }
  };
}

// ---------------------------------------------------------------------------
// Project discovery (ported from kosmo-callflow connect/discovery.ts).
// Ambiguity is an error listing the candidates and the flag that resolves it.

export type ProjectCandidate = { projectId: string; root: string; configPath: string };
export type ProjectConfigReader = (directory: string) => Promise<{ projectId: string } | undefined>;
export type ProjectSelection =
  | { ok: true; project: ProjectCandidate | null }
  | { ok: false; code: "ambiguous-project" | "unknown-project"; message: string };

export async function discoverProjectCandidates(options: {
  cwd: string;
  readConfig: ProjectConfigReader;
  maxDepth?: number;
}): Promise<ProjectCandidate[]> {
  const maxDepth = options.maxDepth ?? 32;
  const found: ProjectCandidate[] = [];
  const seen = new Set<string>();
  let directory = path.resolve(options.cwd);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const config = await options.readConfig(directory);
    if (config) {
      const configPath = path.join(directory, ".kosmo-callflow", "project.json");
      const key = `${config.projectId}\u0000${configPath}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({ projectId: config.projectId, root: directory, configPath });
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return found;
}

function describe(candidates: ProjectCandidate[]): string {
  return candidates.map((candidate) => `${candidate.projectId} (${candidate.configPath})`).join(", ");
}

export function selectProject(candidates: ProjectCandidate[], explicitProjectId?: string): ProjectSelection {
  if (explicitProjectId !== undefined) {
    const matches = candidates.filter((candidate) => candidate.projectId === explicitProjectId);
    if (matches.length === 1) return { ok: true, project: matches[0]! };
    if (matches.length === 0) {
      return {
        ok: false,
        code: "unknown-project",
        message:
          candidates.length === 0
            ? `kosmo-tui: no project named ${explicitProjectId}: no .kosmo-callflow/project.json was found from this directory upwards. Pass an http(s) endpoint as the target.`
            : `kosmo-tui: no project named ${explicitProjectId}. Projects found from this directory upwards: ${describe(candidates)}.`
      };
    }
    return {
      ok: false,
      code: "ambiguous-project",
      message: `kosmo-tui: ${matches.length} projects are named ${explicitProjectId}: ${describe(matches)}. Pass an http(s) endpoint as the target to choose the daemon.`
    };
  }
  if (candidates.length === 0) return { ok: true, project: null };
  if (candidates.length === 1) return { ok: true, project: candidates[0]! };
  return {
    ok: false,
    code: "ambiguous-project",
    message: `kosmo-tui: found ${candidates.length} candidate projects from this directory: ${describe(candidates)}. Pass --project <projectId> to choose one, or an http(s) endpoint as the target.`
  };
}
