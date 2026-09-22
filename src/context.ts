/**
 * The `kosmo-callflow connect` launcher context (boundary contract §1.9).
 *
 * When `connect` launches kosmo-tui it hands over what it already resolved — project,
 * endpoint, origin policy and WHERE the credential lives — through three variables:
 *
 *  - `KOSMO_TUI_CONTEXT`: non-secret JSON, schema v1 below;
 *  - `KOSMO_PROJECT_DIR`: the absolute project directory;
 *  - `KOSMO_TUI_TOKEN`: only when the token was obtained without a file
 *    (`auth.kind = "env"`); it is private to this process.
 *
 * The token itself is never part of the parsed context: it is read on demand by
 * `contextToken`, and no message produced here ever contains it. A malformed context
 * is an explicit error rather than a silent fallback to cwd discovery, because the
 * launcher promised a specific daemon and origin.
 */

import path from "node:path";
import { validateEndpoint } from "./detect.js";

export const TUI_CONTEXT_ENV = "KOSMO_TUI_CONTEXT";
export const TUI_PROJECT_DIR_ENV = "KOSMO_PROJECT_DIR";
export const TUI_TOKEN_ENV = "KOSMO_TUI_TOKEN";

export type TuiContextAuth =
  { kind: "token-file"; path: string } | { kind: "env"; variable: typeof TUI_TOKEN_ENV } | { kind: "none" };

export type TuiLaunchContext = {
  v: 1;
  source: "kosmo-callflow connect";
  projectId: string | null;
  projectDir: string;
  endpoint: string;
  endpointExplicit: boolean;
  allowedCollectorOrigins: string[];
  auth: TuiContextAuth;
};

export type ContextRead =
  | { ok: true; context: TuiLaunchContext | null; projectDir: string | null }
  | { ok: false; code: "invalid-context"; message: string };

type Env = Readonly<Record<string, string | undefined>>;

const CONTEXT_MAX_BYTES = 16 * 1024;

function invalid(detail: string): ContextRead {
  return { ok: false, code: "invalid-context", message: `kosmo-tui: ${TUI_CONTEXT_ENV} is invalid: ${detail}` };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAuth(value: unknown): TuiContextAuth | string {
  if (!isObject(value)) return "auth must be an object";
  if (value.kind === "none") return Object.keys(value).length === 1 ? { kind: "none" } : "auth.none has extra fields";
  if (value.kind === "env") {
    if (value.variable !== TUI_TOKEN_ENV || Object.keys(value).length !== 2) {
      return `auth.env must name ${TUI_TOKEN_ENV}`;
    }
    return { kind: "env", variable: TUI_TOKEN_ENV };
  }
  if (value.kind === "token-file") {
    if (typeof value.path !== "string" || !path.isAbsolute(value.path) || value.path.includes("\0")) {
      return "auth.path must be an absolute file path";
    }
    if (Object.keys(value).length !== 2) return "auth.token-file has extra fields";
    return { kind: "token-file", path: value.path };
  }
  return "auth.kind must be token-file, env or none";
}

/**
 * Read the launcher context. Absent variables mean "not launched by connect": the
 * caller falls back to its own cwd/config discovery. Only the documented fields are
 * accepted, so a secret smuggled in as an extra field is rejected, not carried along.
 */
export function readLaunchContext(env: Env): ContextRead {
  const projectDirEnv = env[TUI_PROJECT_DIR_ENV];
  if (projectDirEnv !== undefined && (!path.isAbsolute(projectDirEnv) || projectDirEnv.includes("\0"))) {
    return {
      ok: false,
      code: "invalid-context",
      message: `kosmo-tui: ${TUI_PROJECT_DIR_ENV} must be an absolute directory`
    };
  }
  const raw = env[TUI_CONTEXT_ENV];
  if (raw === undefined || raw === "") return { ok: true, context: null, projectDir: projectDirEnv ?? null };
  if (Buffer.byteLength(raw, "utf8") > CONTEXT_MAX_BYTES) return invalid(`larger than ${CONTEXT_MAX_BYTES} bytes`);

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalid("not valid JSON");
  }
  if (!isObject(value)) return invalid("must be a JSON object");
  if (value.v !== 1) return invalid(`unsupported version ${JSON.stringify(value.v)}; supported: 1`);
  const allowed = new Set([
    "v",
    "source",
    "projectId",
    "projectDir",
    "endpoint",
    "endpointExplicit",
    "allowedCollectorOrigins",
    "auth"
  ]);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length > 0) return invalid(`unknown field(s) ${extra.join(", ")}`);
  if (value.source !== "kosmo-callflow connect") return invalid('source must be "kosmo-callflow connect"');
  if (value.projectId !== null && (typeof value.projectId !== "string" || value.projectId.length === 0)) {
    return invalid("projectId must be a non-empty string or null");
  }
  if (typeof value.projectDir !== "string" || !path.isAbsolute(value.projectDir)) {
    return invalid("projectDir must be an absolute directory");
  }
  if (projectDirEnv !== undefined && path.resolve(projectDirEnv) !== path.resolve(value.projectDir)) {
    return invalid(`projectDir disagrees with ${TUI_PROJECT_DIR_ENV}`);
  }
  if (typeof value.endpoint !== "string") return invalid("endpoint must be a string");
  const endpoint = validateEndpoint(value.endpoint);
  if (!endpoint.ok || endpoint.target.kind !== "live-endpoint") {
    return invalid(`endpoint rejected (${endpoint.ok ? "not an endpoint" : endpoint.code})`);
  }
  if (typeof value.endpointExplicit !== "boolean") return invalid("endpointExplicit must be a boolean");
  const origins = value.allowedCollectorOrigins;
  if (!Array.isArray(origins) || origins.length === 0 || origins.some((origin) => typeof origin !== "string")) {
    return invalid("allowedCollectorOrigins must be a non-empty list of origins");
  }
  for (const origin of origins as string[]) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return invalid("allowedCollectorOrigins must be a non-empty list of origins");
    }
    if (parsed.origin !== origin) return invalid("allowedCollectorOrigins must be a non-empty list of origins");
  }
  const endpointOrigin = new URL(endpoint.target.url).origin;
  if (!(origins as string[]).includes(endpointOrigin)) {
    return invalid("endpoint origin is not in allowedCollectorOrigins");
  }
  const auth = parseAuth(value.auth);
  if (typeof auth === "string") return invalid(auth);

  return {
    ok: true,
    context: {
      v: 1,
      source: "kosmo-callflow connect",
      projectId: value.projectId as string | null,
      projectDir: value.projectDir,
      endpoint: endpoint.target.url,
      endpointExplicit: value.endpointExplicit,
      allowedCollectorOrigins: [...(origins as string[])],
      auth
    },
    projectDir: value.projectDir
  };
}

/**
 * The private token for `auth.kind = "env"`. Returns undefined for other kinds; a
 * missing or empty variable is reported without echoing anything from the environment.
 */
export function contextToken(
  context: TuiLaunchContext,
  env: Env
): { ok: true; token: string | undefined } | { ok: false; message: string } {
  if (context.auth.kind !== "env") return { ok: true, token: undefined };
  const token = env[TUI_TOKEN_ENV]?.trim();
  if (token === undefined || token.length === 0) {
    return {
      ok: false,
      message: `kosmo-tui: the launcher context says the token is in ${TUI_TOKEN_ENV}, but that variable is empty or unset`
    };
  }
  return { ok: true, token };
}
