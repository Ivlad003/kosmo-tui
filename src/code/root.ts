/**
 * Project root for reading code files (spec 4.8).
 *
 * Rules, first match wins:
 *  1. `--root <dir>` or `:root <dir>` (the flag), resolved against cwd;
 *  2. `dataset.root`, if that directory exists;
 *  3. the nearest ancestor of the trace file that holds `.git` or `package.json`;
 *  4. the current directory.
 *
 * Pure: the filesystem is the RootFs port. The walk up is a loop, never recursion.
 */
import path from "node:path";

export type RootFs = {
  isDirectory(path: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
};

const MARKERS = [".git", "package.json"] as const;

export async function resolveRoot(
  input: { flag?: string; datasetRoot?: string; traceFile?: string; cwd: string },
  fs: RootFs
): Promise<string> {
  const cwd = path.resolve(input.cwd);
  if (input.flag !== undefined && input.flag !== "") return path.resolve(cwd, input.flag);
  if (input.datasetRoot !== undefined && input.datasetRoot !== "") {
    const candidate = path.resolve(cwd, input.datasetRoot);
    if (await safe(() => fs.isDirectory(candidate))) return candidate;
  }
  if (input.traceFile !== undefined && input.traceFile !== "") {
    let dir = path.dirname(path.resolve(cwd, input.traceFile));
    for (;;) {
      for (const marker of MARKERS) {
        if (await safe(() => fs.exists(path.join(dir, marker)))) return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return cwd;
}

/** A failing probe counts as "no": the root falls through to the next rule. */
async function safe(probe: () => Promise<boolean>): Promise<boolean> {
  try {
    return await probe();
  } catch {
    return false;
  }
}
