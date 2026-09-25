/**
 * Project root for reading code files (spec 4.8).
 *
 * Rules, first match wins:
 *  1. `--root <dir>` or `:root <dir>` (the flag), resolved against cwd;
 *  2. `dataset.root`, if that directory exists AND passes the trust check below;
 *  3. the nearest ancestor of the trace file that holds `.git` or `package.json`;
 *  4. the current directory.
 *
 * Trust check of rule 2 (the trace file is untrusted input, changed after the stage-1 review):
 * with every path compared by its real path (symlinks resolved), `dataset.root` must be equal to
 * or contain cwd or the trace file's directory (stdin has no trace directory: only cwd counts).
 * It is never the filesystem root `/`, and never the home directory or one of its ancestors
 * (`home: null` skips that check). A rejected root falls through to rule 3 and is reported in
 * `ignored`, so the caller can tell the user; a missing one falls through silently.
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

export type DatasetRootRejection = "filesystem-root" | "home" | "unrelated";

export type RootResolution = {
  readonly root: string;
  /** Set when `dataset.root` exists but failed the trust check of rule 2. */
  readonly ignored?: { readonly datasetRoot: string; readonly reason: DatasetRootRejection };
};

const MARKERS = [".git", "package.json"] as const;

export async function resolveRoot(input: RootInput, fs: RootFs): Promise<RootResolution> {
  const cwd = path.resolve(input.cwd);
  if (input.flag !== undefined && input.flag !== "") return { root: path.resolve(cwd, input.flag) };
  const traceFile =
    input.traceFile !== undefined && input.traceFile !== "" ? path.resolve(cwd, input.traceFile) : undefined;
  let ignored: RootResolution["ignored"];
  if (input.datasetRoot !== undefined && input.datasetRoot !== "") {
    const candidate = path.resolve(cwd, input.datasetRoot);
    if (await safe(() => fs.isDirectory(candidate))) {
      const verdict = await checkDatasetRoot(candidate, { cwd, traceFile, home: input.home }, fs);
      if (verdict.ok) return { root: verdict.real };
      if (verdict.reason !== null) ignored = { datasetRoot: input.datasetRoot, reason: verdict.reason };
    }
  }
  const withIgnored = (root: string): RootResolution => (ignored === undefined ? { root } : { root, ignored });
  if (traceFile !== undefined) {
    let dir = path.dirname(traceFile);
    for (;;) {
      for (const marker of MARKERS) {
        if (await safe(() => fs.exists(path.join(dir, marker)))) return withIgnored(dir);
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return withIgnored(cwd);
}

/** `reason: null`: the root could not be resolved at all (it vanished), which is not worth a notice. */
async function checkDatasetRoot(
  candidate: string,
  context: { cwd: string; traceFile: string | undefined; home: string | null },
  fs: RootFs
): Promise<{ ok: true; real: string } | { ok: false; reason: DatasetRootRejection | null }> {
  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch {
    return { ok: false, reason: null };
  }
  if (!path.isAbsolute(real)) return { ok: false, reason: null };
  if (path.dirname(real) === real) return { ok: false, reason: "filesystem-root" };
  if (context.home !== null && context.home !== "" && path.isAbsolute(context.home)) {
    const home = await realOrResolved(context.home, fs);
    if (contains(real, home)) return { ok: false, reason: "home" };
  }
  const anchors = [await realOrResolved(context.cwd, fs)];
  if (context.traceFile !== undefined) anchors.push(await realOrResolved(path.dirname(context.traceFile), fs));
  return anchors.some((anchor) => contains(real, anchor)) ? { ok: true, real } : { ok: false, reason: "unrelated" };
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
