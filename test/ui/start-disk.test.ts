/** start.ts against the real filesystem through a Node StartFs adapter (temp dir). */
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readRecent, recordRecent, scanTraces, type StartFs } from "../../src/start.js";

const nodeStartFs: StartFs = {
  async readdir(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other"
    }));
  },
  async stat(p) {
    const info = await stat(p).catch(() => undefined);
    return info === undefined ? undefined : { size: info.size, mtimeMs: info.mtimeMs, isFile: info.isFile() };
  },
  async readFile(p, maxBytes) {
    const info = await stat(p);
    if (info.size > maxBytes) throw Object.assign(new Error("too large"), { code: "E2BIG" });
    return readFile(p, "utf8");
  },
  writeFile: (p, text) => writeFile(p, text, { mode: 0o600 }),
  rename: (from, to) => rename(from, to),
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  },
  rm: (p) => rm(p, { force: true })
};

let tmp = "";

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "kosmo-start-"));
  await mkdir(path.join(tmp, "work/traces"), { recursive: true });
  await writeFile(path.join(tmp, "work/traces/a.kosmo-trace.json"), "{}");
  await writeFile(path.join(tmp, "work/b.kosmo-trace.ndjson"), "{}\n");
  await utimes(path.join(tmp, "work/b.kosmo-trace.ndjson"), new Date(1_000_000), new Date(1_000_000));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("start.ts on disk", () => {
  it("scans real directories", async () => {
    const rows = await scanTraces(path.join(tmp, "work"), nodeStartFs);
    expect(rows.map((row) => row.path)).toEqual(["traces/a.kosmo-trace.json", "b.kosmo-trace.ndjson"]);
    expect(rows[0]!.size).toBe(2);
  });

  it("records recent paths atomically and leaves no temp file behind", async () => {
    const file = path.join(tmp, "config/kosmo-tui/recent.json");
    const cwd = path.join(tmp, "work");
    await recordRecent({ file, opened: "b.kosmo-trace.ndjson", cwd, now: new Date(1), readOnly: false }, nodeStartFs);
    await recordRecent(
      { file, opened: "traces/a.kosmo-trace.json", cwd, now: new Date(2), readOnly: false },
      nodeStartFs
    );
    expect((await readRecent(file, nodeStartFs)).map((entry) => entry.path)).toEqual([
      path.join(cwd, "traces/a.kosmo-trace.json"),
      path.join(cwd, "b.kosmo-trace.ndjson")
    ]);
    expect(await readdir(path.dirname(file))).toEqual(["recent.json"]);
  });
});
