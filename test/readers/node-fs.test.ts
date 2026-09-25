/**
 * The production ReaderFs: read-only access through node:fs/promises, missing paths as
 * undefined, a hard cap in readFile, chunked streaming that yields every byte once.
 * It is the only module of src/readers that imports a Node built-in: every other reader
 * gets its I/O through the ReaderFs port (plan, global constraints).
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FileTooLargeError, concatBytes } from "../../src/readers/common.js";
import { nodeReaderFs } from "../../src/readers/node-fs.js";
import { cleanupTempDirs, tempDir } from "../trace-writers.js";

afterEach(cleanupTempDirs);

describe("src/readers imports", () => {
  it("only node-fs.ts imports a Node built-in module", () => {
    const dir = fileURLToPath(new URL("../../src/readers/", import.meta.url));
    const builtin = /^\s*(import|export)\b[^;]*?\bfrom\s*["'](node:[^"']+|fs|fs\/promises|process|child_process)["']/m;
    const offenders = readdirSync(dir)
      .filter((name) => name.endsWith(".ts") && name !== "node-fs.ts")
      .filter((name) => builtin.test(readFileSync(path.join(dir, name), "utf8")));
    expect(offenders).toEqual([]);
    expect(builtin.test(readFileSync(path.join(dir, "node-fs.ts"), "utf8"))).toBe(true);
  });
});

describe("nodeReaderFs", () => {
  it("stat: file, directory, missing, and a path through a file", async () => {
    const dir = tempDir();
    const file = path.join(dir, "a.json");
    writeFileSync(file, "12345");
    mkdirSync(path.join(dir, "sub"));
    expect(await nodeReaderFs.stat(file)).toEqual({ size: 5, isFile: true, isDirectory: false });
    expect(await nodeReaderFs.stat(path.join(dir, "sub"))).toEqual({
      size: expect.any(Number),
      isFile: false,
      isDirectory: true
    });
    expect(await nodeReaderFs.stat(path.join(dir, "missing"))).toBeUndefined();
    expect(await nodeReaderFs.stat(path.join(file, "below"))).toBeUndefined();
  });

  it("readHead returns at most the requested bytes", async () => {
    const file = path.join(tempDir(), "a.txt");
    writeFileSync(file, "abcdef");
    expect(new TextDecoder().decode(await nodeReaderFs.readHead(file, 4))).toBe("abcd");
    expect(new TextDecoder().decode(await nodeReaderFs.readHead(file, 100))).toBe("abcdef");
  });

  it("readFile returns the bytes and throws FileTooLargeError over the cap", async () => {
    const file = path.join(tempDir(), "a.bin");
    const data = new Uint8Array(200_000).map((_, index) => index % 251);
    writeFileSync(file, data);
    expect(await nodeReaderFs.readFile(file, 200_000)).toEqual(data);
    await expect(nodeReaderFs.readFile(file, 199_999)).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it("createReadStream yields every byte once, in order", async () => {
    const file = path.join(tempDir(), "a.bin");
    const data = new Uint8Array(150_001).map((_, index) => index % 253);
    writeFileSync(file, data);
    const parts: Uint8Array[] = [];
    for await (const chunk of nodeReaderFs.createReadStream(file)) parts.push(chunk);
    expect(parts.length).toBeGreaterThan(1);
    expect(concatBytes(parts)).toEqual(data);
  });
});
