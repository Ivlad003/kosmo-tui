import path from "node:path";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveRoot, type RootFs } from "../../src/code/root.js";

/** Directories and files by absolute path; everything else does not exist. */
function fakeRootFs(dirs: string[], files: string[] = []): RootFs & { probes: string[] } {
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
    }
  };
}

describe("resolveRoot (spec 4.8)", () => {
  it("1. the flag wins over everything, relative to cwd", async () => {
    const fs = fakeRootFs(["/data/root", "/work/.git"]);
    const input = {
      flag: "../other",
      datasetRoot: "/data/root",
      traceFile: "/work/t.kosmo-trace.json",
      cwd: "/work/app"
    };
    expect(await resolveRoot(input, fs)).toBe("/work/other");
    expect(await resolveRoot({ ...input, flag: "/abs/root" }, fs)).toBe("/abs/root");
    expect(fs.probes).toEqual([]);
  });

  it("2. dataset.root when that directory exists", async () => {
    const fs = fakeRootFs(["/data/root"], ["/work/package.json"]);
    expect(await resolveRoot({ datasetRoot: "/data/root", traceFile: "/work/t.json", cwd: "/cwd" }, fs)).toBe(
      "/data/root"
    );
  });

  it("3. a missing dataset.root falls through to the nearest ancestor with .git or package.json", async () => {
    const fs = fakeRootFs(["/repo/.git"], ["/repo/packages/app/package.json"]);
    const traceFile = "/repo/packages/app/traces/deep/t.kosmo-trace.json";
    expect(await resolveRoot({ datasetRoot: "/gone", traceFile, cwd: "/cwd" }, fs)).toBe("/repo/packages/app");
    expect(await resolveRoot({ traceFile: "/repo/src/t.kosmo-trace.json", cwd: "/cwd" }, fs)).toBe("/repo");
  });

  it("3. the trace file's own directory counts, and a relative trace path resolves against cwd", async () => {
    const fs = fakeRootFs([], ["/work/app/traces/package.json"]);
    expect(await resolveRoot({ traceFile: "traces/t.kosmo-trace.json", cwd: "/work/app" }, fs)).toBe(
      "/work/app/traces"
    );
  });

  it("4. cwd when nothing else applies (stdin has no trace file)", async () => {
    const fs = fakeRootFs([]);
    expect(await resolveRoot({ cwd: "/work/app" }, fs)).toBe("/work/app");
    expect(await resolveRoot({ traceFile: "/a/b/c/t.json", cwd: "/work/app" }, fs)).toBe("/work/app");
    expect(fs.probes).toContain("exists /.git");
  });

  it("a probe that throws counts as absent", async () => {
    const fs: RootFs = {
      isDirectory: async () => {
        throw new Error("EACCES");
      },
      exists: async () => {
        throw new Error("EACCES");
      }
    };
    expect(await resolveRoot({ datasetRoot: "/x", traceFile: "/a/t.json", cwd: "/w" }, fs)).toBe("/w");
  });

  it("walks a very deep path without recursion", async () => {
    const deep = "/" + Array.from({ length: 500 }, (_, i) => `d${i}`).join("/");
    const fs = fakeRootFs([], ["/package.json"]);
    expect(await resolveRoot({ traceFile: `${deep}/t.json`, cwd: "/w" }, fs)).toBe("/");
  });

  it("finds test/fixtures/project on the real disk (rule 3)", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const project = path.resolve(here, "../fixtures/project");
    const exists = async (p: string) => (await stat(p).catch(() => undefined)) !== undefined;
    const fs: RootFs = {
      exists,
      isDirectory: async (p) => (await stat(p).catch(() => undefined))?.isDirectory() ?? false
    };
    const traceFile = path.join(project, "traces", "x.kosmo-trace.json");
    expect(await resolveRoot({ traceFile, cwd: "/" }, fs)).toBe(project);
  });
});
