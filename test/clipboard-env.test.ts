/** S-L3: clipboard adapters get an allowlisted env and are found on absolute PATH entries only. */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clipboardEnv, resolveClipboardCommand, spawnClipboard } from "../src/clipboard.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "kt-clip-"));
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

describe("clipboard adapter environment", () => {
  it("passes no token or credential variable to the adapter", async () => {
    const out = path.join(dir, "env.json");
    const bin = path.join(dir, "fake-clip");
    await writeFile(
      bin,
      `#!${process.execPath}\nlet input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>{require("node:fs").writeFileSync(${JSON.stringify(out)},JSON.stringify({env:process.env,input}))});\n`
    );
    await chmod(bin, 0o755);
    await spawnClipboard({ command: "fake-clip", args: [] }, "doc-text", {
      PATH: `.${path.delimiter}relative/bin${path.delimiter}${dir}`,
      HOME: "/home/dev",
      KOSMO_TUI_TOKEN: "tui-secret",
      GITHUB_TOKEN: "gh-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret"
    });
    const seen = JSON.parse(await readFile(out, "utf8")) as { env: Record<string, string>; input: string };
    expect(seen.input).toBe("doc-text");
    expect(seen.env.HOME).toBe("/home/dev");
    expect(seen.env.PATH).toBe(dir);
    expect(JSON.stringify(seen.env)).not.toMatch(/secret/);
  });

  it("never resolves a command through a relative PATH entry", () => {
    // node_modules/.bin exists relative to the test cwd and holds `vitest`.
    expect(resolveClipboardCommand("vitest", { PATH: "node_modules/.bin" })).toBeUndefined();
    expect(resolveClipboardCommand("vitest", { PATH: path.resolve("node_modules/.bin") })).toBe(
      path.resolve("node_modules/.bin/vitest")
    );
    expect(clipboardEnv({ PATH: `.${path.delimiter}/usr/bin`, KOSMO_TUI_TOKEN: "x" })).toEqual({ PATH: "/usr/bin" });
  });
});
