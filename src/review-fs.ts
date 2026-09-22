/**
 * Filesystem and process ports for the review artifact (design D2/D7).
 *
 * Every review side effect goes through `ReviewFs`, so tests can inject EACCES/ENOSPC
 * failures or count calls, and read-only sessions can prove they never touched disk.
 * `nodeReviewFs`/`nodeReviewEnv` are the default adapters wired by the composition root.
 */

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";

export type ReviewFs = {
  /** Recursive mkdir; succeeds when the directory already exists. */
  mkdir(dir: string): Promise<void>;
  /** Entry names; rejects with ENOENT when the directory does not exist. */
  readdir(dir: string): Promise<string[]>;
  readFile(file: string): Promise<string>;
  /** Exclusive create (`O_CREAT|O_EXCL`); rejects with EEXIST when the file exists. */
  createExclusive(file: string, data: string): Promise<void>;
  /** Plain write of a same-directory temp file (also exclusive, never clobbers). */
  writeTemp(file: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
  /** Resolves undefined when the path does not exist. */
  stat(file: string): Promise<{ mtimeMs: number; isDirectory: boolean } | undefined>;
  /** Whether the current process may create entries in an existing directory. */
  canWrite(dir: string): Promise<boolean>;
};

export type ReviewEnv = {
  pid: number;
  hostname: string;
  now(): Date;
  /** Random lowercase hex, used for item ids, lock tokens and temp names. */
  randomId(bytes?: number): string;
  /** Whether a process with this pid exists on this host. */
  isPidAlive(pid: number): boolean;
};

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

export const nodeReviewFs: ReviewFs = {
  async mkdir(dir) {
    await mkdir(dir, { recursive: true });
  },
  readdir: (dir) => readdir(dir),
  readFile: (file) => readFile(file, "utf8"),
  async createExclusive(file, data) {
    const handle = await open(file, "wx");
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async writeTemp(file, data) {
    await writeFile(file, data, { encoding: "utf8", flag: "wx" });
  },
  rename: (from, to) => rename(from, to),
  unlink: (file) => unlink(file),
  async stat(file) {
    try {
      const info = await stat(file);
      return { mtimeMs: info.mtimeMs, isDirectory: info.isDirectory() };
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return undefined;
      throw error;
    }
  },
  async canWrite(dir) {
    try {
      await access(dir, constants.W_OK | constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
};

export const nodeReviewEnv: ReviewEnv = {
  pid: process.pid,
  hostname: os.hostname(),
  now: () => new Date(),
  randomId: (bytes = 4) => randomBytes(bytes).toString("hex"),
  isPidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM: the process exists but belongs to someone else.
      return errorCode(error) === "EPERM";
    }
  }
};
