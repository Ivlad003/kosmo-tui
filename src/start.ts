/**
 * The start screen's data (spec 6.1): trace files found near cwd and recently opened ones.
 *
 * - Scan: cwd plus two levels of subdirectories; `node_modules`, `.git` and hidden
 *   directories are skipped, symlinked directories are not followed. Names matching
 *   `*.kosmo-trace.json`, `*.kosmo-trace.ndjson`, `*.kosmo-trace.sqlite` become rows with
 *   path (relative to cwd), size and mtime. Files are only stat'ed, never opened.
 * - Recent: up to 20 absolute paths in `$XDG_CONFIG_HOME/kosmo-tui/recent.json` (or
 *   `~/.config/kosmo-tui/recent.json`; with neither — no home directory — it is disabled),
 *   each with only `path` and `openedAt`. A missing
 *   file is flagged, a corrupt recent.json reads as empty, `-r` (readOnly) never writes,
 *   and a write is atomic: a temp file in the same directory, then rename.
 *
 * Pure: every filesystem call goes through the StartFs port.
 */
import path from "node:path";
import type { StartRow } from "./ui/state.js";

export type StartDirent = { readonly name: string; readonly kind: "file" | "dir" | "symlink" | "other" };

export type StartFs = {
  /** Entries of a directory; rejects when it cannot be read. */
  readdir(dir: string): Promise<readonly StartDirent[]>;
  /** Follows symlinks; undefined when nothing is there. */
  stat(path: string): Promise<{ size: number; mtimeMs: number; isFile: boolean } | undefined>;
  /** Rejects when the file is missing, unreadable or larger than `maxBytes`. */
  readFile(path: string, maxBytes: number): Promise<string>;
  /** Creates or replaces the file (the Node adapter uses mode 0o600). */
  writeFile(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** `mkdir -p` (the Node adapter uses mode 0o700). */
  mkdir(dir: string): Promise<void>;
  /** Removes a file; used only to clean up a failed temp file. */
  rm(path: string): Promise<void>;
};

export type RecentEntry = { readonly path: string; readonly openedAt: string };
export type RecordResult = "written" | "skipped" | "failed";

export const TRACE_FILE_RE = /\.kosmo-trace\.(?:json|ndjson|sqlite)$/;
export const SCAN_DEPTH = 2;
export const RECENT_MAX = 20;
export const RECENT_FILE_MAX_BYTES = 64 * 1024;
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

export function isTraceFileName(name: string): boolean {
  return TRACE_FILE_RE.test(name);
}

/** Rows for trace files under cwd, newest first (then by path). */
export async function scanTraces(cwd: string, fs: StartFs): Promise<StartRow[]> {
  const rows: StartRow[] = [];
  const queue: Array<{ rel: string; depth: number }> = [{ rel: "", depth: 0 }];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    let entries: readonly StartDirent[];
    try {
      entries = await fs.readdir(next.rel === "" ? cwd : path.join(cwd, next.rel));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = next.rel === "" ? entry.name : `${next.rel}/${entry.name}`;
      if (entry.kind === "dir") {
        if (next.depth < SCAN_DEPTH && !SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          queue.push({ rel, depth: next.depth + 1 });
        }
        continue;
      }
      if ((entry.kind !== "file" && entry.kind !== "symlink") || !isTraceFileName(entry.name)) continue;
      const info = await fs.stat(path.join(cwd, rel)).catch(() => undefined);
      if (info === undefined || !info.isFile) continue;
      rows.push({ path: rel, size: info.size, mtimeMs: info.mtimeMs, source: "found", missing: false });
    }
  }
  return rows.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0) || compareText(a.path, b.path));
}

/**
 * `$XDG_CONFIG_HOME/kosmo-tui/recent.json`, or `~/.config/…` when it is unset, empty or relative.
 * null when neither exists (no usable home directory): recent.json is then disabled.
 */
export function recentPath(env: Readonly<Record<string, string | undefined>>, home: string | null): string | null {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg !== "" && path.isAbsolute(xdg)) return path.join(xdg, "kosmo-tui", "recent.json");
  if (home === null || home === "" || !path.isAbsolute(home)) return null;
  return path.join(home, ".config", "kosmo-tui", "recent.json");
}

/** Entries of recent.json in file order; anything unreadable or malformed reads as none. */
export async function readRecent(file: string, fs: StartFs): Promise<RecentEntry[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, RECENT_FILE_MAX_BYTES));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const entries: RecentEntry[] = [];
  for (const item of parsed) {
    if (entries.length === RECENT_MAX) break;
    if (typeof item !== "object" || item === null) continue;
    const { path: entryPath, openedAt } = item as { path?: unknown; openedAt?: unknown };
    if (typeof entryPath !== "string" || typeof openedAt !== "string") continue;
    if (!path.isAbsolute(entryPath) || seen.has(entryPath)) continue;
    seen.add(entryPath);
    entries.push({ path: entryPath, openedAt });
  }
  return entries;
}

/** One row per entry; a file that is gone keeps its row with `missing: true`. */
export async function recentRows(entries: readonly RecentEntry[], fs: StartFs): Promise<StartRow[]> {
  const rows: StartRow[] = [];
  for (const entry of entries) {
    const info = await fs.stat(entry.path).catch(() => undefined);
    rows.push(
      info === undefined || !info.isFile
        ? { path: entry.path, size: null, mtimeMs: null, source: "recent", missing: true }
        : { path: entry.path, size: info.size, mtimeMs: info.mtimeMs, source: "recent", missing: false }
    );
  }
  return rows;
}

/**
 * Put `opened` (resolved against cwd) first in recent.json, keeping at most 20 entries.
 * Never throws: recent.json is a convenience, and failing to write it must not stop a
 * trace from opening. `readOnly` (`-r`) makes it a no-op without any filesystem call.
 */
export async function recordRecent(
  input: { file: string; opened: string; cwd: string; now: Date; readOnly: boolean; tmpToken?: string },
  fs: StartFs
): Promise<RecordResult> {
  if (input.readOnly) return "skipped";
  const opened = path.resolve(input.cwd, input.opened);
  const previous = await readRecent(input.file, fs);
  const entries = [
    { path: opened, openedAt: input.now.toISOString() },
    ...previous.filter((entry) => entry.path !== opened)
  ].slice(0, RECENT_MAX);
  const text = `${JSON.stringify(
    entries.map((entry) => ({ path: entry.path, openedAt: entry.openedAt })),
    null,
    2
  )}\n`;
  const tmp = `${input.file}.${input.tmpToken ?? String(input.now.getTime())}.tmp`;
  try {
    await fs.mkdir(path.dirname(input.file));
    await fs.writeFile(tmp, text);
    await fs.rename(tmp, input.file);
    return "written";
  } catch {
    await fs.rm(tmp).catch(() => undefined);
    return "failed";
  }
}

/** Everything the start screen lists: found rows, then recent rows. */
export async function loadStartRows(
  input: { cwd: string; env: Readonly<Record<string, string | undefined>>; home: string | null },
  fs: StartFs
): Promise<StartRow[]> {
  const found = await scanTraces(input.cwd, fs);
  const file = recentPath(input.env, input.home);
  const recent = file === null ? [] : await recentRows(await readRecent(file, fs), fs);
  return [...found, ...recent];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
