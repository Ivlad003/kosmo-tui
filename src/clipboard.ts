/**
 * `y`: copy the selection as a full versioned trace-text document (task 5.9, spec
 * "Стек, закладки, порівняння та evidence").
 *
 * The document is built by the same path review evidence uses (`buildEvidence` in
 * review-format.ts): the shared sanitizer from `@kosmo-callflow/trace-artifacts` masks
 * secrets, relativises host paths and escapes control data; the shared codec of the
 * source's projection version renders it under the 51,200-byte cap; the protocol parser
 * of that version must accept the result. A bare `(span ...)` is never offered.
 *
 * Clipboard adapters are spawned without a shell (pbcopy, wl-copy, xclip, clip). When
 * none works the document is buffered and printed to stdout only after the terminal has
 * left the alternate screen, so it never interleaves with frames and survives the exit.
 */

import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import path from "node:path";
import type { TraceTextDialect } from "@kosmo-callflow/protocol";
import { buildEvidence, type EvidenceDocument, type SanitizeContext, type TraceTextVersion } from "./review-format.js";
import type { Terminal } from "./terminal.js";

export type CopyDocument = {
  text: string;
  version: TraceTextVersion;
  format: TraceTextDialect;
  bytes: number;
  truncated: boolean;
  /** True when some item has no recorded source line; the document says so (`nil`), never invents one. */
  sourceLineUnavailable: boolean;
};

export type CopyDocumentResult = { ok: true; document: CopyDocument } | { ok: false; reason: string };

/** Sanitize, encode and prove the document parses. */
export function buildCopyDocument(
  document: EvidenceDocument,
  format: TraceTextDialect,
  context: SanitizeContext = {}
): CopyDocumentResult {
  const built = buildEvidence(document, format, context);
  if (!built.ok) return { ok: false, reason: built.message };
  return {
    ok: true,
    document: {
      text: built.evidence.text,
      version: built.evidence.version,
      format,
      bytes: built.evidence.bytes,
      truncated: built.evidence.truncated,
      sourceLineUnavailable: document.items.some((item) => {
        const source = (item as { source?: { state?: string; line?: number | null } }).source;
        return item.kind === "span" && (source === undefined || source.state !== "available" || source.line === null);
      })
    }
  };
}

export type ClipboardCommand = { command: string; args: string[] };

/** Spawn one adapter with the document on stdin; resolves on exit code 0, rejects otherwise. */
export type ClipboardSpawn = (
  command: ClipboardCommand,
  input: string,
  env?: Record<string, string | undefined>
) => Promise<void>;

/**
 * Variables a clipboard adapter may see (S-L3): the display/session it talks to, the
 * locale and text encoding, the home and temp directories. Nothing else of the TUI's
 * environment reaches it: no token (`KOSMO_TUI_TOKEN`), no credential variable.
 */
export const CLIPBOARD_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "__CF_USER_TEXT_ENCODING",
  "SystemRoot",
  "SYSTEMROOT"
];

/** The adapter environment: allowlisted variables, PATH reduced to absolute entries. */
export function clipboardEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of CLIPBOARD_ENV_ALLOWLIST) {
    const value = env[name];
    if (typeof value === "string") out[name] = value;
  }
  if (out.PATH !== undefined) out.PATH = absolutePathEntries(out.PATH).join(path.delimiter);
  return out;
}

function absolutePathEntries(value: string): string[] {
  // Relative entries ("", ".", "bin") resolve against the cwd: a checked-out repository
  // could plant a `pbcopy` there. Only absolute directories are searched.
  return value.split(path.delimiter).filter((entry) => entry.length > 0 && path.isAbsolute(entry));
}

/** The adapter's absolute executable path on the absolute PATH entries, or undefined. */
export function resolveClipboardCommand(command: string, env: Record<string, string | undefined>): string | undefined {
  if (path.isAbsolute(command)) return command;
  if (command.includes("/") || command.includes("\\")) return undefined;
  const extensions = process.platform === "win32" ? ["", ".exe", ".com"] : [""];
  for (const directory of absolutePathEntries(env.PATH ?? "")) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (process.platform !== "win32") accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Not here; next entry.
      }
    }
  }
  return undefined;
}

/** Adapters to try, in order, for this platform and display environment. */
export function clipboardCommands(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>
): ClipboardCommand[] {
  if (platform === "darwin") return [{ command: "pbcopy", args: [] }];
  if (platform === "win32") return [{ command: "clip", args: [] }];
  const commands: ClipboardCommand[] = [];
  if (env.WAYLAND_DISPLAY) commands.push({ command: "wl-copy", args: [] });
  if (env.DISPLAY) commands.push({ command: "xclip", args: ["-selection", "clipboard"] });
  return commands;
}

const SPAWN_TIMEOUT_MS = 2_000;

/**
 * Default adapter runner: no shell, argv only, an absolute executable found on absolute
 * PATH entries, the allowlisted environment only, stdout/stderr ignored, bounded wait.
 */
export const spawnClipboard: ClipboardSpawn = (command, input, parentEnv = process.env) =>
  new Promise<void>((resolve, reject) => {
    const env = clipboardEnv(parentEnv);
    const executable = resolveClipboardCommand(command.command, env);
    if (executable === undefined) {
      reject(Object.assign(new Error(`${command.command} not found on an absolute PATH entry`), { code: "ENOENT" }));
      return;
    }
    const child = spawn(executable, command.args, { shell: false, env, stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command.command} timed out`));
    }, SPAWN_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command.command} exited with ${String(code)}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input, "utf8");
  });

export type ClipboardDeps = {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  spawn?: ClipboardSpawn;
};

export type ClipboardOutcome = { copied: true; via: string } | { copied: false; reason: string };

export async function copyToClipboard(text: string, deps: ClipboardDeps): Promise<ClipboardOutcome> {
  const commands = clipboardCommands(deps.platform, deps.env);
  if (commands.length === 0) return { copied: false, reason: "no clipboard adapter for this platform/display" };
  const run = deps.spawn ?? spawnClipboard;
  const failures: string[] = [];
  for (const command of commands) {
    try {
      await run(command, text, deps.env);
      return { copied: true, via: command.command };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      failures.push(`${command.command}: ${typeof code === "string" ? code : (error as Error).message}`);
    }
  }
  return { copied: false, reason: failures.join("; ") };
}

export const FALLBACK_MAX_DOCUMENTS = 16;

/**
 * Documents that could not reach a clipboard, held until the terminal is restored. The
 * count is bounded; the oldest is dropped first and the drop is reported with the rest.
 */
export class StdoutFallback {
  private documents: string[] = [];
  private dropped = 0;
  private flushed = false;

  constructor(private readonly stdout: { write(chunk: string): unknown }) {}

  queue(text: string): void {
    if (this.flushed) return;
    this.documents.push(text);
    if (this.documents.length > FALLBACK_MAX_DOCUMENTS) {
      this.documents.shift();
      this.dropped += 1;
    }
  }

  get pending(): number {
    return this.documents.length;
  }

  /** Write everything once; later calls are no-ops. Call only after the terminal is restored. */
  flush(): void {
    if (this.flushed) return;
    this.flushed = true;
    if (this.dropped > 0) {
      this.stdout.write(
        `kosmo-tui: ${this.dropped} earlier copied document(s) dropped (fallback holds ${FALLBACK_MAX_DOCUMENTS})\n`
      );
    }
    for (const text of this.documents) this.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    this.documents = [];
  }
}

/**
 * Wrap a terminal so `after` runs once, right after the real close restored raw mode,
 * cursor and the main screen. Whoever closes the terminal (q, a signal, a failure)
 * therefore also flushes the fallback, in the right order.
 */
export function withAfterClose(terminal: Terminal, after: () => void): Terminal {
  let done = false;
  return {
    ...terminal,
    close() {
      terminal.close();
      if (done) return;
      done = true;
      after();
    }
  };
}
