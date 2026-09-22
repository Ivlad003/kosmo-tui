/**
 * Cooperative advisory lock for one review file (design D7).
 *
 * The lock is `<review>.md.lock`, created with `O_EXCL` and holding the owner's pid,
 * hostname, a random token and the creation time. Only cooperative writers (kosmo-tui
 * sessions, agents following the same contract) honour it; an arbitrary editor is
 * caught by the revision/hash check instead, never by this lock.
 *
 * A lock is stale when its owner provably died (same host, pid gone); a lock from
 * another host, or one whose content cannot be parsed, cannot be probed and is stale
 * only once it is older than `staleAfterMs`. Stale removal re-reads the lock and
 * removes it only when it is still the exact lock that was judged stale.
 */

import { errorCode, type ReviewEnv, type ReviewFs } from "./review-fs.js";

export const DEFAULT_STALE_LOCK_MS = 24 * 60 * 60 * 1000;

export type LockInfo = { pid: number; hostname: string; token: string; createdAt: string };
export type HeldLock = { path: string; info: LockInfo };
export type LockState =
  { state: "free" } | { state: "stale"; raw: string } | { state: "held"; holder: LockInfo | null };

export type AcquireResult =
  | { ok: true; lock: HeldLock }
  | { ok: false; code: "locked"; holder: LockInfo | null }
  | { ok: false; code: "io"; error: unknown };

export function lockPathFor(reviewPath: string): string {
  return `${reviewPath}.lock`;
}

export function parseLockInfo(raw: string): LockInfo | null {
  try {
    const value = JSON.parse(raw) as Partial<LockInfo>;
    if (
      typeof value.pid === "number" &&
      Number.isInteger(value.pid) &&
      typeof value.hostname === "string" &&
      typeof value.token === "string" &&
      typeof value.createdAt === "string"
    )
      return { pid: value.pid, hostname: value.hostname, token: value.token, createdAt: value.createdAt };
  } catch {
    // fall through
  }
  return null;
}

export function isLockStale(
  info: LockInfo | null,
  mtimeMs: number,
  env: ReviewEnv,
  staleAfterMs = DEFAULT_STALE_LOCK_MS
): boolean {
  // Same host: the pid is authoritative, however old the lock is.
  if (info !== null && info.hostname === env.hostname) return info.pid !== env.pid && !env.isPidAlive(info.pid);
  return env.now().getTime() - mtimeMs > staleAfterMs;
}

export async function inspectLock(
  fs: ReviewFs,
  env: ReviewEnv,
  lockPath: string,
  staleAfterMs = DEFAULT_STALE_LOCK_MS
): Promise<LockState> {
  let raw: string;
  let meta: { mtimeMs: number } | undefined;
  try {
    meta = await fs.stat(lockPath);
    if (meta === undefined) return { state: "free" };
    raw = await fs.readFile(lockPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { state: "free" };
    throw error;
  }
  const info = parseLockInfo(raw);
  return isLockStale(info, meta.mtimeMs, env, staleAfterMs) ? { state: "stale", raw } : { state: "held", holder: info };
}

export async function acquireLock(
  fs: ReviewFs,
  env: ReviewEnv,
  lockPath: string,
  staleAfterMs = DEFAULT_STALE_LOCK_MS
): Promise<AcquireResult> {
  const info: LockInfo = {
    pid: env.pid,
    hostname: env.hostname,
    token: env.randomId(8),
    createdAt: env.now().toISOString()
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.createExclusive(lockPath, `${JSON.stringify(info)}\n`);
      return { ok: true, lock: { path: lockPath, info } };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") return { ok: false, code: "io", error };
    }
    let state: LockState;
    try {
      state = await inspectLock(fs, env, lockPath, staleAfterMs);
    } catch (error) {
      return { ok: false, code: "io", error };
    }
    if (state.state === "held") return { ok: false, code: "locked", holder: state.holder };
    if (state.state === "stale") {
      // Owner check right before removal: only the lock that was judged stale goes.
      try {
        const again = await fs.readFile(lockPath);
        if (again !== state.raw) continue;
        await fs.unlink(lockPath);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") return { ok: false, code: "io", error };
      }
    }
  }
  return { ok: false, code: "locked", holder: null };
}

/** Whether the lock file still holds this session's token. */
export async function stillHeld(fs: ReviewFs, lock: HeldLock): Promise<boolean> {
  try {
    return parseLockInfo(await fs.readFile(lock.path))?.token === lock.info.token;
  } catch {
    return false;
  }
}

/** Remove the lock only when it is still ours; never throws. */
export async function releaseLock(fs: ReviewFs, lock: HeldLock): Promise<void> {
  try {
    if (await stillHeld(fs, lock)) await fs.unlink(lock.path);
  } catch {
    // A lock we cannot remove becomes stale once this process exits.
  }
}
