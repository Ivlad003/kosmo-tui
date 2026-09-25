/**
 * loadSnippet against the real filesystem (spec 13.1 test/fixtures/project): symlinks out
 * of the root, CRLF, tabs and a file over 2 MiB are created at test time in a temp dir,
 * because git, prettier and Windows checkouts do not keep them reliably.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SNIPPET_MAX_FILE_BYTES, loadSnippet, type SnippetFs } from "../../src/code/snippet.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, "../fixtures/project/src/cart.ts");
const HEADER = "export async function calculateLineTotal(item, qty) {";

const diskFs: SnippetFs = {
  realpath: (p) => realpath(p),
  async stat(p) {
    try {
      const info = await stat(p);
      return { size: info.size, isFile: info.isFile() };
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return undefined;
      throw error;
    }
  },
  readFile: async (p) => new Uint8Array(await readFile(p))
};

let tmp = "";
let root = "";
const symlinksWork = process.platform !== "win32";

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "kosmo-snippet-"));
  root = path.join(tmp, "project");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(tmp, "outside"), { recursive: true });
  const cart = await readFile(FIXTURE, "utf8");
  await writeFile(path.join(root, "src/cart.ts"), cart);
  await writeFile(path.join(root, "src/crlf.ts"), cart.replace(/\n/g, "\r\n"));
  await writeFile(path.join(root, "src/tabs.ts"), "function f() {\n\treturn 1;\n}\n");
  await writeFile(path.join(root, "src/big.ts"), Buffer.alloc(SNIPPET_MAX_FILE_BYTES + 1, 0x61));
  await writeFile(path.join(tmp, "outside/secret.ts"), "secret\n");
  if (symlinksWork) {
    await symlink(path.join(tmp, "outside/secret.ts"), path.join(root, "src/escape.ts"));
    await symlink(path.join(tmp, "outside"), path.join(root, "vendor"));
    await symlink(path.join(root, "src/cart.ts"), path.join(root, "src/alias.ts"));
    await symlink(path.join(root, "src/nowhere.ts"), path.join(root, "src/dangling.ts"));
    await symlink(root, path.join(tmp, "root-link"));
  }
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("loadSnippet on disk", () => {
  it("reads the committed fixture (ok)", async () => {
    const snippet = await loadSnippet(root, { file: "src/cart.ts", line: 12, endLine: 20, snippet: HEADER }, diskFs);
    expect(snippet.state).toBe("ok");
    expect(snippet.lines.map((l) => l.n)).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(snippet.lines[0]!.text).toBe(HEADER);
  });

  it("CRLF and tabs", async () => {
    const crlf = await loadSnippet(root, { file: "src/crlf.ts", line: 12, snippet: HEADER }, diskFs);
    expect(crlf.state).toBe("ok");
    expect(crlf.lines.some((l) => l.text.includes("\r"))).toBe(false);
    const tabs = await loadSnippet(root, { file: "src/tabs.ts", line: 2, snippet: "return 1;" }, diskFs);
    expect(tabs.state).toBe("ok");
    expect(tabs.lines[1]).toEqual({ n: 2, text: "    return 1;" });
  });

  it("too-large for a file over 2 MiB", async () => {
    expect((await loadSnippet(root, { file: "src/big.ts", line: 1 }, diskFs)).state).toBe("too-large");
  });

  it("file-missing, and a directory is unreadable", async () => {
    expect((await loadSnippet(root, { file: "src/none.ts", line: 1 }, diskFs)).state).toBe("file-missing");
    expect((await loadSnippet(root, { file: "src", line: 1 }, diskFs)).state).toBe("unreadable");
  });

  it.runIf(symlinksWork)("outside-root through a file symlink and a directory symlink", async () => {
    expect((await loadSnippet(root, { file: "src/escape.ts", line: 1 }, diskFs)).state).toBe("outside-root");
    expect((await loadSnippet(root, { file: "vendor/secret.ts", line: 1 }, diskFs)).state).toBe("outside-root");
  });

  it.runIf(symlinksWork)("a symlink inside the root and a root reached through a symlink are fine", async () => {
    expect((await loadSnippet(root, { file: "src/alias.ts", line: 12, snippet: HEADER }, diskFs)).state).toBe("ok");
    const viaLink = path.join(tmp, "root-link");
    expect((await loadSnippet(viaLink, { file: "src/cart.ts", line: 12, snippet: HEADER }, diskFs)).state).toBe("ok");
  });

  it.runIf(symlinksWork)("a dangling symlink is file-missing", async () => {
    expect((await loadSnippet(root, { file: "src/dangling.ts", line: 1 }, diskFs)).state).toBe("file-missing");
  });
});
