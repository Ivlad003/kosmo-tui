/** Task 22: the Node adapters behind SnippetFs, RootFs and StartFs, on a real temp directory. */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRoot } from "../../src/code/root.js";
import { loadSnippet } from "../../src/code/snippet.js";
import { readRecent, recordRecent, scanTraces } from "../../src/start.js";
import { nodeRootFs, nodeSnippetFs, nodeStartFs } from "../../src/ui/node-ports.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(here, "../fixtures/project");
let tmp = "";

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "kosmo-ports-"));
  await mkdir(path.join(tmp, "work/traces"), { recursive: true });
  await writeFile(path.join(tmp, "work/traces/a.kosmo-trace.json"), "{}");
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("node ports", () => {
  it("nodeSnippetFs reads the committed project fixture; a missing file is file-missing", async () => {
    const ok = await loadSnippet(PROJECT, { file: "src/cart.ts", line: 12 }, nodeSnippetFs);
    expect(ok.state).toBe("ok");
    expect(ok.lines.find((line) => line.n === 12)?.text).toBe("export async function calculateLineTotal(item, qty) {");
    expect((await loadSnippet(PROJECT, { file: "src/nope.ts", line: 1 }, nodeSnippetFs)).state).toBe("file-missing");
  });

  it("nodeRootFs finds the nearest package.json above a trace file (spec 4.8 rule 3)", async () => {
    const trace = path.join(PROJECT, "src", "x.kosmo-trace.json");
    expect(await resolveRoot({ traceFile: trace, cwd: tmp }, nodeRootFs)).toBe(PROJECT);
    expect(await nodeRootFs.isDirectory(PROJECT)).toBe(true);
    expect(await nodeRootFs.isDirectory(path.join(PROJECT, "package.json"))).toBe(false);
  });

  it("nodeStartFs scans and writes recent.json with private modes", async () => {
    expect((await scanTraces(path.join(tmp, "work"), nodeStartFs)).map((row) => row.path)).toEqual([
      "traces/a.kosmo-trace.json"
    ]);
    const file = path.join(tmp, "config/kosmo-tui/recent.json");
    const input = { file, opened: "traces/a.kosmo-trace.json", cwd: path.join(tmp, "work"), now: new Date(5) };
    expect(await recordRecent({ ...input, readOnly: false }, nodeStartFs)).toBe("written");
    expect((await readRecent(file, nodeStartFs)).map((entry) => entry.path)).toEqual([
      path.join(tmp, "work/traces/a.kosmo-trace.json")
    ]);
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveLength(1);
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    }
  });
});
