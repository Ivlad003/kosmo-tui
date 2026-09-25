/**
 * Project root for reading code files (spec 4.8).
 *
 * Rules, first match wins:
 *  1. `--root <dir>` or `:root <dir>` (the flag), resolved against cwd;
 *  2. `dataset.root`, if it is absolute, that directory exists AND it passes the trust check below;
 *  3. the nearest ancestor of the trace file that holds `.git` or `package.json`;
 *  4. the current directory.
 *
 * The flag is the user's choice and is taken as given. Rules 2–4 are automatic, and the trace file is
 * untrusted input, so every automatic candidate is compared by its real path (symlinks resolved) and
 * rejected when it is the filesystem root `/`, the home directory or one of its ancestors (`home:
 * null` skips the home part). An automatic rule always returns the real path.
 *
 * Rule 2 also has to be equal to or contain cwd or the trace file's directory (stdin has no trace
 * directory: only cwd counts). A rejected `dataset.root` falls through to rule 3 and is reported in
 * `ignored`, so the caller can tell the user; a missing one falls through silently. Rule 3 stops at the
 * nearest marker: when that directory is rejected, so is every ancestor of it, and rule 4 decides.
 * When rule 4 is rejected as well there is no root (`root: null`, the reason in `unset`): no snippets,
 * no OSC 8 links, until the user picks one with `:root` or `--root`.
 *
 * Pure: the filesystem is the RootFs port, the home directory an input. The walk up is a loop,
 * never recursion.
 */
import path from "node:path";

export type RootFs = {
  isDirectory(path: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  /** Symlinks resolved; rejects when the path does not exist. */
  realpath(path: string): Promise<string>;
};

export type RootInput = {
  readonly flag?: string;
  readonly datasetRoot?: string;
  /** Absent for stdin. */
  readonly traceFile?: string;
  readonly cwd: string;
  /** The user's home directory; null when it is unknown (then there is no home check). */
  readonly home: string | null;
};

/** Why an automatic candidate is too wide to be a code root. */
export type WideRootRejection = "filesystem-root" | "home";
export type DatasetRootRejection = WideRootRejection | "unrelated" | "not-absolute";

export type RootResolution = {
  /** The code root; null when no automatic rule survived (then `unset` says why). */
  readonly root: string | null;
  /** Set when `dataset.root` exists (or is relative) but failed the checks of rule 2. */
  readonly ignored?: { readonly datasetRoot: string; readonly reason: DatasetRootRejection };
  /** Set when `root` is null: why rule 4, the current directory, was rejected. */
  readonly unset?: { readonly reason: WideRootRejection };
};

const MARKERS = [".git", "package.json"] as const;

export async function resolveRoot(input: RootInput, fs: RootFs): Promise<RootResolution> {
  const cwd = path.resolve(input.cwd);
  if (input.flag !== undefined && input.flag !== "") return { root: path.resolve(cwd, input.flag) };
  const traceFile =
    input.traceFile !== undefined && input.traceFile !== "" ? path.resolve(cwd, input.traceFile) : undefined;
  const home =
    input.home !== null && input.home !== "" && path.isAbsolute(input.home)
      ? await realOrResolved(input.home, fs)
      : null;
  const wide = (real: string): WideRootRejection | null => {
    if (path.dirname(real) === real) return "filesystem-root";
    return home !== null && contains(real, home) ? "home" : null;
  };

  let ignored: { datasetRoot: string; reason: DatasetRootRejection; real: string | null } | undefined;
  if (input.datasetRoot !== undefined && input.datasetRoot !== "") {
    if (!path.isAbsolute(input.datasetRoot)) {
      ignored = { datasetRoot: input.datasetRoot, reason: "not-absolute", real: null };
    } else if (await safe(() => fs.isDirectory(input.datasetRoot!))) {
      const verdict = await checkDatasetRoot(input.datasetRoot, { cwd, traceFile, wide }, fs);
      if (verdict.ok) return { root: verdict.real };
      if (verdict.reason !== null)
        ignored = { datasetRoot: input.datasetRoot, reason: verdict.reason, real: verdict.real };
    }
  }
  const done = (root: string | null, unset?: WideRootRejection): RootResolution => {
    const result: { -readonly [K in keyof RootResolution]: RootResolution[K] } = { root };
    // "ignored" only when the root really ended up elsewhere.
    if (ignored !== undefined && (ignored.real === null || ignored.real !== root)) {
      result.ignored = { datasetRoot: ignored.datasetRoot, reason: ignored.reason };
    }
    if (unset !== undefined) result.unset = { reason: unset };
    return result;
  };

  if (traceFile !== undefined) {
    const marked = await nearestMarked(path.dirname(traceFile), fs);
    if (marked !== null) {
      const real = await realOrResolved(marked, fs);
      if (wide(real) === null) return done(real);
    }
  }
  const realCwd = await realOrResolved(cwd, fs);
  const rejected = wide(realCwd);
  return rejected === null ? done(realCwd) : done(null, rejected);
}

async function nearestMarked(start: string, fs: RootFs): Promise<string | null> {
  let dir = start;
  for (;;) {
    for (const marker of MARKERS) {
      if (await safe(() => fs.exists(path.join(dir, marker)))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** `reason: null`: the root could not be resolved at all (it vanished), which is not worth a notice. */
async function checkDatasetRoot(
  candidate: string,
  context: { cwd: string; traceFile: string | undefined; wide: (real: string) => WideRootRejection | null },
  fs: RootFs
): Promise<{ ok: true; real: string } | { ok: false; reason: DatasetRootRejection | null; real: string | null }> {
  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch {
    return { ok: false, reason: null, real: null };
  }
  if (!path.isAbsolute(real)) return { ok: false, reason: null, real: null };
  real = path.resolve(real);
  const wide = context.wide(real);
  if (wide !== null) return { ok: false, reason: wide, real };
  const anchors = [await realOrResolved(context.cwd, fs)];
  if (context.traceFile !== undefined) anchors.push(await realOrResolved(path.dirname(context.traceFile), fs));
  return anchors.some((anchor) => contains(real, anchor))
    ? { ok: true, real }
    : { ok: false, reason: "unrelated", real };
}

/** True when `inner` is `outer` or lies below it (both absolute and normalized). */
function contains(outer: string, inner: string): boolean {
  if (inner === outer) return true;
  const prefix = outer.endsWith(path.sep) ? outer : outer + path.sep;
  return inner.startsWith(prefix);
}

async function realOrResolved(dir: string, fs: RootFs): Promise<string> {
  try {
    const real = await fs.realpath(dir);
    return path.isAbsolute(real) ? path.resolve(real) : path.resolve(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** A failing probe counts as "no": the root falls through to the next rule. */
async function safe(probe: () => Promise<boolean>): Promise<boolean> {
  try {
    return await probe();
  } catch {
    return false;
  }
}
