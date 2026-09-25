import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveRoot, type RootFs } from "../../src/code/root.js";
import { nodeRootFs } from "../../src/ui/node-ports.js";

/**
 * Directories and files by absolute path; everything else does not exist. `links` maps a path to
 * its real path; `realpath` of anything else is the path itself.
 */
function fakeRootFs(
  dirs: string[],
  files: string[] = [],
  links: Record<string, string> = {}
): RootFs & { probes: string[] } {
  const probes: string[] = [];
  return {
    probes,
    async isDirectory(p) {
      probes.push(`dir ${p}`);
      return dirs.includes(p);
    },
    async exists(p) {
      probes.push(`exists ${p}`);
      return dirs.includes(p) || files.includes(p);
    },
    async realpath(p) {
      return links[p] ?? p;
    }
  };
}

const HOME = "/home/me";
const root = async (input: Parameters<typeof resolveRoot>[0], fs: RootFs) => (await resolveRoot(input, fs)).root;

describe("resolveRoot (spec 4.8)", () => {
  it("1. the flag wins over everything, relative to cwd", async () => {
    const fs = fakeRootFs(["/data/root", "/work/.git"]);
    const input = {
      home: HOME,
      flag: "../other",
      datasetRoot: "/data/root",
      traceFile: "/work/t.kosmo-trace.json",
      cwd: "/work/app"
    };
    expect(await root(input, fs)).toBe("/work/other");
    expect(await root({ ...input, flag: "/abs/root" }, fs)).toBe("/abs/root");
    expect(fs.probes).toEqual([]);
  });

  it("2. dataset.root when it exists and contains the trace file's directory", async () => {
    const fs = fakeRootFs(["/data/root"], ["/data/root/traces/package.json"]);
    const input = { datasetRoot: "/data/root", traceFile: "/data/root/traces/t.json", cwd: "/cwd", home: HOME };
    expect(await resolveRoot(input, fs)).toEqual({ root: "/data/root" });
  });

  it("2. dataset.root when it contains cwd, or is cwd itself", async () => {
    const fs = fakeRootFs(["/repo", "/repo/app"], ["/elsewhere/package.json"]);
    const traceFile = "/elsewhere/t.json";
    expect(await resolveRoot({ datasetRoot: "/repo", traceFile, cwd: "/repo/app/src", home: HOME }, fs)).toEqual({
      root: "/repo"
    });
    expect(await resolveRoot({ datasetRoot: "/repo/app", traceFile, cwd: "/repo/app", home: HOME }, fs)).toEqual({
      root: "/repo/app"
    });
    // A relative dataset.root resolves against cwd: "." is cwd.
    expect(await resolveRoot({ datasetRoot: ".", traceFile, cwd: "/repo/app", home: HOME }, fs)).toEqual({
      root: "/repo/app"
    });
  });

  it("2. an existing dataset.root unrelated to cwd and the trace falls through to rule 3 and is reported", async () => {
    const fs = fakeRootFs(["/data/root"], ["/work/package.json"]);
    expect(
      await resolveRoot({ datasetRoot: "/data/root", traceFile: "/work/t.json", cwd: "/cwd", home: HOME }, fs)
    ).toEqual({ root: "/work", ignored: { datasetRoot: "/data/root", reason: "unrelated" } });
    // A sibling whose name is a prefix does not contain the trace directory.
    const prefix = fakeRootFs(["/work/app"], ["/work/application/package.json"]);
    const traceFile = "/work/application/t.json";
    expect(await resolveRoot({ datasetRoot: "/work/app", traceFile, cwd: "/cwd", home: HOME }, prefix)).toEqual({
      root: "/work/application",
      ignored: { datasetRoot: "/work/app", reason: "unrelated" }
    });
  });

  it("2. the filesystem root is rejected, even though it contains everything", async () => {
    const fs = fakeRootFs(["/"], ["/work/package.json"]);
    const input = { datasetRoot: "/", traceFile: "/work/t.json", cwd: "/work", home: HOME };
    expect(await resolveRoot(input, fs)).toEqual({
      root: "/work",
      ignored: { datasetRoot: "/", reason: "filesystem-root" }
    });
    // Also when it is spelled differently or reached through a symlink.
    const link = fakeRootFs(["/work/up"], ["/work/package.json"], { "/work/up": "/" });
    expect((await resolveRoot({ ...input, datasetRoot: "/work/up" }, link)).ignored?.reason).toBe("filesystem-root");
  });

  it("2. the home directory (or anything above it) is rejected; a project inside home is fine", async () => {
    const fs = fakeRootFs(["/home/me", "/home", "/home/me/repo"], ["/home/me/repo/package.json"]);
    const base = { traceFile: "/home/me/repo/traces/t.json", cwd: "/home/me/repo", home: HOME };
    expect(await resolveRoot({ ...base, datasetRoot: "/home/me" }, fs)).toEqual({
      root: "/home/me/repo",
      ignored: { datasetRoot: "/home/me", reason: "home" }
    });
    expect((await resolveRoot({ ...base, datasetRoot: "/home" }, fs)).ignored?.reason).toBe("home");
    expect(await resolveRoot({ ...base, datasetRoot: "/home/me/repo" }, fs)).toEqual({ root: "/home/me/repo" });
    // home compares by real path too.
    const linked = fakeRootFs(["/Users/me"], ["/Users/me/repo/package.json"], { "/home/me": "/Users/me" });
    const viaLink = { traceFile: "/Users/me/repo/t.json", cwd: "/Users/me/repo", home: "/home/me" };
    expect((await resolveRoot({ ...viaLink, datasetRoot: "/Users/me" }, linked)).ignored?.reason).toBe("home");
  });

  it("2. home: null means no home check, the containment rule still holds", async () => {
    const fs = fakeRootFs(["/home/me"], ["/home/me/repo/package.json"]);
    const input = { datasetRoot: "/home/me", traceFile: "/home/me/repo/t.json", cwd: "/home/me/repo", home: null };
    expect(await resolveRoot(input, fs)).toEqual({ root: "/home/me" });
    expect(await resolveRoot({ ...input, datasetRoot: "/" }, fakeRootFs(["/"]))).toMatchObject({
      ignored: { reason: "filesystem-root" }
    });
  });

  it("2. a dataset.root that is a symlink pointing outside is judged by its real path", async () => {
    const fs = fakeRootFs(["/work/link"], ["/work/package.json"], { "/work/link": "/etc" });
    const input = { datasetRoot: "/work/link", traceFile: "/work/t.json", cwd: "/work", home: HOME };
    expect(await resolveRoot(input, fs)).toEqual({
      root: "/work",
      ignored: { datasetRoot: "/work/link", reason: "unrelated" }
    });
    // A symlinked cwd counts by its real path as well.
    const cwdLink = fakeRootFs(["/real/repo"], [], { "/tmp/repo": "/real/repo" });
    expect(await resolveRoot({ datasetRoot: "/real/repo", cwd: "/tmp/repo", home: HOME }, cwdLink)).toEqual({
      root: "/real/repo"
    });
  });

  it("2. stdin has no trace directory: only cwd counts", async () => {
    const fs = fakeRootFs(["/repo", "/data"]);
    expect(await resolveRoot({ datasetRoot: "/repo", cwd: "/repo/app", home: HOME }, fs)).toEqual({ root: "/repo" });
    expect(await resolveRoot({ datasetRoot: "/data", cwd: "/repo/app", home: HOME }, fs)).toEqual({
      root: "/repo/app",
      ignored: { datasetRoot: "/data", reason: "unrelated" }
    });
  });

  it("2. a dataset.root that is missing (or whose realpath fails) falls through without a report", async () => {
    const fs: RootFs = {
      isDirectory: async () => true,
      exists: async () => false,
      realpath: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
    };
    expect(await resolveRoot({ datasetRoot: "/repo", cwd: "/repo", home: HOME }, fs)).toEqual({ root: "/repo" });
    expect(await resolveRoot({ datasetRoot: "/gone", cwd: "/w", home: HOME }, fakeRootFs([]))).toEqual({ root: "/w" });
  });

  it("3. a missing dataset.root falls through to the nearest ancestor with .git or package.json", async () => {
    const fs = fakeRootFs(["/repo/.git"], ["/repo/packages/app/package.json"]);
    const traceFile = "/repo/packages/app/traces/deep/t.kosmo-trace.json";
    expect(await root({ datasetRoot: "/gone", traceFile, cwd: "/cwd", home: HOME }, fs)).toBe("/repo/packages/app");
    expect(await root({ traceFile: "/repo/src/t.kosmo-trace.json", cwd: "/cwd", home: HOME }, fs)).toBe("/repo");
  });

  it("3. the trace file's own directory counts, and a relative trace path resolves against cwd", async () => {
    const fs = fakeRootFs([], ["/work/app/traces/package.json"]);
    expect(await root({ traceFile: "traces/t.kosmo-trace.json", cwd: "/work/app", home: HOME }, fs)).toBe(
      "/work/app/traces"
    );
  });

  it("4. cwd when nothing else applies (stdin has no trace file)", async () => {
    const fs = fakeRootFs([]);
    expect(await root({ cwd: "/work/app", home: HOME }, fs)).toBe("/work/app");
    expect(await root({ traceFile: "/a/b/c/t.json", cwd: "/work/app", home: HOME }, fs)).toBe("/work/app");
    expect(fs.probes).toContain("exists /.git");
  });

  it("a probe that throws counts as absent", async () => {
    const fs: RootFs = {
      isDirectory: async () => {
        throw new Error("EACCES");
      },
      exists: async () => {
        throw new Error("EACCES");
      },
      realpath: async () => {
        throw new Error("EACCES");
      }
    };
    expect(await root({ datasetRoot: "/x", traceFile: "/a/t.json", cwd: "/w", home: HOME }, fs)).toBe("/w");
  });

  it("walks a very deep path without recursion", async () => {
    const deep = "/" + Array.from({ length: 500 }, (_, i) => `d${i}`).join("/");
    const fs = fakeRootFs([], ["/package.json"]);
    expect(await root({ traceFile: `${deep}/t.json`, cwd: "/w", home: HOME }, fs)).toBe("/");
  });

  it("real disk: a symlink inside the project that points outside it is rejected (rule 2)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kosmo-root-"));
    try {
      await mkdir(path.join(dir, "project"));
      await mkdir(path.join(dir, "outside"));
      await writeFile(path.join(dir, "project", "package.json"), "{}");
      await symlink(path.join(dir, "outside"), path.join(dir, "project", "escape"));
      const traceFile = path.join(dir, "project", "t.kosmo-trace.json");
      const input = { datasetRoot: path.join(dir, "project", "escape"), traceFile, cwd: "/", home: null };
      const result = await resolveRoot(input, nodeRootFs);
      expect(result.ignored?.reason).toBe("unrelated");
      expect(result.root).toBe(path.join(dir, "project"));
      // The project itself is accepted, by its real path (macOS: /var → /private/var).
      const own = await resolveRoot({ ...input, datasetRoot: path.join(dir, "project") }, nodeRootFs);
      expect(own).toEqual({ root: await realpath(path.join(dir, "project")) });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("finds test/fixtures/project on the real disk (rule 3)", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const project = path.resolve(here, "../fixtures/project");
    const exists = async (p: string) => (await stat(p).catch(() => undefined)) !== undefined;
    const fs: RootFs = {
      exists,
      isDirectory: async (p) => (await stat(p).catch(() => undefined))?.isDirectory() ?? false,
      realpath: (p) => realpath(p)
    };
    const traceFile = path.join(project, "traces", "x.kosmo-trace.json");
    expect(await root({ traceFile, cwd: "/", home: null }, fs)).toBe(project);
  });
});
