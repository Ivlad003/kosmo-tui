/**
 * Node adapters for the session's file ports: code snippets (SnippetFs, task 11), the
 * project root (RootFs, task 11) and the start screen with recent.json (StartFs, task 21).
 * Trace files go through src/readers/node-fs.ts. Everything else in src/ui receives these
 * ports and never imports node:fs itself.
 *
 * Only two writes exist in the whole TUI, both through `nodeStartFs`: recent.json (mode
 * 0600, in a directory created with mode 0700) and its temp file next to it. `-r` turns
 * them off before they reach this module (start.ts `recordRecent`).
 */
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import type { RootFs } from "../code/root.js";
import type { SnippetFs } from "../code/snippet.js";
import type { StartDirent, StartFs } from "../start.js";

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export const nodeSnippetFs: SnippetFs = {
  realpath: (file) => realpath(file),
  async stat(file) {
    try {
      const info = await stat(file);
      return { size: info.size, isFile: info.isFile() };
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  },
  readFile: async (file) => new Uint8Array(await readFile(file))
};

export const nodeRootFs: RootFs = {
  async isDirectory(dir) {
    const info = await stat(dir).catch(() => undefined);
    return info?.isDirectory() === true;
  },
  async exists(file) {
    return (await stat(file).catch(() => undefined)) !== undefined;
  }
};

function direntKind(entry: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): StartDirent["kind"] {
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  return entry.isSymbolicLink() ? "symlink" : "other";
}

export const nodeStartFs: StartFs = {
  async readdir(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, kind: direntKind(entry) }));
  },
  async stat(file) {
    const info = await stat(file).catch(() => undefined);
    return info === undefined ? undefined : { size: info.size, mtimeMs: info.mtimeMs, isFile: info.isFile() };
  },
  async readFile(file, maxBytes) {
    const info = await stat(file);
    if (info.size > maxBytes) throw Object.assign(new Error(`larger than ${maxBytes} bytes`), { code: "E2BIG" });
    return readFile(file, "utf8");
  },
  writeFile: (file, text) => writeFile(file, text, { mode: 0o600 }),
  rename: (from, to) => rename(from, to),
  async mkdir(dir) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  },
  rm: (file) => rm(file, { force: true })
};
