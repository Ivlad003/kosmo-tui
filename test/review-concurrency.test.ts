import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  lockPathFor,
  openReviewSession,
  parseReview,
  resolveReviewCapability,
  type ReviewCapability,
  type ReviewResult,
  type ReviewSessionOptions
} from "../src/review.js";
import { SOURCE_REF, fakeEnv, faultyFs, findingInput, removeDir, snapshotTree, tempDir } from "./review-helpers.js";

const WRITER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "review-writer.mjs");

let root: string;
let reviews: string;
let capability: ReviewCapability;

beforeEach(async () => {
  root = await tempDir();
  reviews = path.join(root, ".kosmo-callflow", "reviews");
  capability = await resolveReviewCapability({ readOnly: false, oneShot: false, projectRoot: root, cwd: root });
});
afterEach(async () => removeDir(root));

function options(overrides: Partial<ReviewSessionOptions> = {}): ReviewSessionOptions {
  return {
    capability,
    sourceRef: SOURCE_REF,
    sourceLabel: "export ./trace-export.json",
    dialect: "lisp",
    traceTextVersion: 2,
    env: fakeEnv(),
    ...overrides
  };
}

type Child = { process: ChildProcessWithoutNullStreams; lines: Promise<ReviewResult[]>; first: Promise<ReviewResult> };

function writer(args: string[]): Child {
  const child = spawn(process.execPath, [WRITER, root, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  let resolveFirst: (value: ReviewResult) => void;
  const first = new Promise<ReviewResult>((resolve) => (resolveFirst = resolve));
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString();
    const line = out.split("\n")[0];
    if (out.includes("\n") && line) resolveFirst(JSON.parse(line) as ReviewResult);
  });
  child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
  const lines = new Promise<ReviewResult[]>((resolve, reject) =>
    child.on("close", (code) =>
      code === 0
        ? resolve(
            out
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as ReviewResult)
          )
        : reject(new Error(`writer exited ${code}: ${err}`))
    )
  );
  return { process: child, lines, first };
}

async function reviewFiles(): Promise<string[]> {
  return (await readdir(reviews)).filter((name) => /^\d{4}-\d{2}-\d{2}-\d{2,}\.md$/.test(name)).sort();
}

async function allTodos(): Promise<string[]> {
  const notes: string[] = [];
  for (const name of await reviewFiles()) {
    const parsed = parseReview(await readFile(path.join(reviews, name), "utf8"));
    expect(parsed.ok, name).toBe(true);
    if (parsed.ok) notes.push(...parsed.value.todos.map((todo) => todo.note));
  }
  return notes.sort();
}

describe("6.3 exclusive numbering with concurrent sessions", () => {
  it("scenario: two in-process sessions and a child process create reviews at once; no number is overwritten", async () => {
    const child = writer(["new", "child", "6"]);
    const inProcess = async (label: string) => {
      const results: ReviewResult[] = [];
      for (let index = 0; index < 6; index += 1) {
        const session = await openReviewSession(options({ noResume: true }));
        results.push(await session.addTodo(`${label}-${index}`));
        await session.close();
      }
      return results;
    };
    const [a, b, c] = await Promise.all([inProcess("a"), inProcess("b"), child.lines]);
    const results = [...a, ...b, ...c];
    expect(results.every((result) => result.ok)).toBe(true);
    const paths = results.map((result) => (result.ok ? result.path : ""));
    expect(new Set(paths).size).toBe(18);
    expect(await reviewFiles()).toHaveLength(18);
    const expected = ["a", "b", "child"].flatMap((label) => Array.from({ length: 6 }, (_, i) => `${label}-${i}`));
    expect(await allTodos()).toEqual(expected.sort());
    // No lock or temp leftovers once every session closed.
    expect((await readdir(reviews)).filter((name) => !name.endsWith(".md"))).toEqual([]);
  }, 30_000);

  it("scenario: sessions racing to resume one editing review; the locked file is not edited twice, no draft lost", async () => {
    const seed = await openReviewSession(options());
    await seed.addTodo("seed");
    await seed.close();
    const [seedName] = await reviewFiles();

    const child = writer(["resume", "child"]);
    const a = await openReviewSession(options());
    const b = await openReviewSession(options());
    expect(a.resumedFrom).toBe(path.join(reviews, seedName!));
    expect(b.resumedFrom).toBe(path.join(reviews, seedName!));
    const [ra, rb, rc] = await Promise.all([a.addTodo("a"), b.addTodo("b"), child.first]);
    const results = [ra, rb, rc];
    expect(results.every((result) => result.ok)).toBe(true);
    const onSeed = results.filter((result) => result.ok && result.path === path.join(reviews, seedName!));
    expect(onSeed).toHaveLength(1);
    // The in-process loser saw the candidate locked and started a new review with its draft.
    for (const result of [ra, rb])
      if (result.ok && result.path !== path.join(reviews, seedName!)) expect(result.notice).toContain("locked");
    expect(new Set(results.map((result) => result.ok && result.path)).size).toBe(3);
    child.process.stdin.end();
    await child.lines;
    await a.close();
    await b.close();
    expect(await allTodos()).toEqual(["a", "b", "child", "seed"]);
    expect(await reviewFiles()).toHaveLength(3);
  }, 30_000);
});

describe("6.3 revision/hash check, stale locks and failures", () => {
  it("scenario: an agent changed the file after load → conflict; file not reverted, draft kept", async () => {
    const session = await openReviewSession(options());
    await session.addFinding(findingInput());
    const file = session.path!;
    const edited = (await readFile(file, "utf8")).replace("- [ ] f-", "- [x] f-");
    await writeFile(file, edited);
    const result = await session.addTodo("after the edit");
    expect(result).toMatchObject({ ok: false, code: "conflict", message: expect.stringContaining("changed outside") });
    expect(await readFile(file, "utf8")).toBe(edited);
    expect(session.unsaved.map((item) => item.note)).toEqual(["after the edit"]);
    // Retry keeps the edited file and saves the draft into a new review.
    const retry = await session.save();
    expect(retry).toMatchObject({ ok: true });
    expect(retry.ok && retry.path).not.toBe(file);
    expect(await readFile(file, "utf8")).toBe(edited);
    await session.close();
  });

  it("a live lock of another process blocks resume; the owner's lock is left alone", async () => {
    const seed = await openReviewSession(options());
    await seed.addTodo("seed");
    await seed.close();
    const file = path.join(reviews, "2026-09-22-01.md");
    const foreign = JSON.stringify({ pid: 424242, hostname: os.hostname(), token: "other", createdAt: "x" });
    await writeFile(lockPathFor(file), foreign);
    const session = await openReviewSession(options({ env: fakeEnv({ isPidAlive: () => true }) }));
    expect(session.resumedFrom).toBeNull();
    await session.addTodo("elsewhere");
    await session.close();
    expect(await readFile(lockPathFor(file), "utf8")).toBe(foreign);
    const parsed = parseReview(await readFile(file, "utf8"));
    expect(parsed.ok && parsed.value.todos.map((t) => t.note)).toEqual(["seed"]);
  });

  it("a stale lock (dead pid on this host, or an old foreign-host lock) is taken over", async () => {
    const seed = await openReviewSession(options());
    await seed.addTodo("seed");
    await seed.close();
    const file = path.join(reviews, "2026-09-22-01.md");

    await writeFile(
      lockPathFor(file),
      JSON.stringify({ pid: 424242, hostname: os.hostname(), token: "dead", createdAt: "x" })
    );
    const dead = await openReviewSession(options({ env: fakeEnv({ isPidAlive: () => false }) }));
    expect(dead.resumedFrom).toBe(file);
    expect(await dead.addTodo("after dead owner")).toMatchObject({ ok: true, path: file });
    await dead.close();

    const foreign = JSON.stringify({ pid: 1, hostname: "other-host", token: "far", createdAt: "x" });
    await writeFile(lockPathFor(file), foreign);
    const young = await openReviewSession(options({ staleLockMs: 60_000 }));
    expect(young.resumedFrom).toBeNull(); // cannot probe another host: held until old enough
    await young.close();
    const env = fakeEnv();
    env.clock.now = new Date(Date.now() + 120_000);
    const old = await openReviewSession(options({ env, staleLockMs: 60_000 }));
    expect(old.resumedFrom).toBe(file);
    expect(await old.addTodo("after old foreign lock")).toMatchObject({ ok: true, path: file });
    await old.close();
    const parsed = parseReview(await readFile(file, "utf8"));
    expect(parsed.ok && parsed.value.todos.map((t) => t.note)).toEqual([
      "seed",
      "after dead owner",
      "after old foreign lock"
    ]);
  });

  it("a lock taken over while the session holds it → lock-lost, nothing written", async () => {
    const session = await openReviewSession(options());
    await session.addTodo("first");
    const file = session.path!;
    const before = await readFile(file, "utf8");
    await writeFile(lockPathFor(file), JSON.stringify({ pid: 1, hostname: "h", token: "thief", createdAt: "x" }));
    expect(await session.addTodo("second")).toMatchObject({ ok: false, code: "lock-lost" });
    expect(await readFile(file, "utf8")).toBe(before);
    expect(session.unsaved).toHaveLength(1);
    await session.close();
  });

  it("disk full and permission failures keep the previous file and the draft; retry succeeds", async () => {
    const calls: string[] = [];
    const fs = faultyFs([], calls);
    const session = await openReviewSession(options({ fs }));
    await session.addTodo("saved");
    const file = session.path!;
    const before = await readFile(file, "utf8");

    fs.faults.push({ op: "writeTemp", code: "ENOSPC" });
    expect(await session.addTodo("disk full")).toMatchObject({ ok: false, code: "disk-full" });
    fs.faults.push({ op: "rename", code: "EACCES" });
    expect(await session.addTodo("no permission")).toMatchObject({ ok: false, code: "permission" });
    expect(await readFile(file, "utf8")).toBe(before);
    expect(session.unsaved.map((item) => item.note)).toEqual(["disk full", "no permission"]);
    expect((await readdir(reviews)).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    const retry = await session.save();
    expect(retry).toMatchObject({ ok: true, path: file, revision: 2 });
    await session.close();
    const parsed = parseReview(await readFile(file, "utf8"));
    expect(parsed.ok && parsed.value.todos.map((t) => t.note)).toEqual(["saved", "disk full", "no permission"]);
    // Commit is temp-in-same-directory then rename.
    expect(calls.filter((call) => call.startsWith("writeTemp") || call.startsWith("rename")).at(-2)).toMatch(
      /^writeTemp \.2026-09-22-01\.md\.\d+\.[0-9a-f]+\.tmp$/
    );
  });

  it("failures on the very first write leave no directory, reservation or lock behind", async () => {
    const before = await snapshotTree(root);
    const fs = faultyFs([{ op: "mkdir", code: "EACCES" }]);
    const session = await openReviewSession(options({ fs }));
    expect(await session.addTodo("x")).toMatchObject({ ok: false, code: "permission" });
    expect(await snapshotTree(root)).toEqual(before);
    fs.faults.push({ op: "writeTemp", code: "ENOSPC" });
    expect(await session.addTodo("y")).toMatchObject({ ok: false, code: "disk-full" });
    expect(await snapshotTree(root)).toEqual({ ".kosmo-callflow/": "", ".kosmo-callflow/reviews/": "" });
    expect(session.unsaved.map((item) => item.note)).toEqual(["x", "y"]);
    const retry = await session.save();
    expect(retry).toMatchObject({ ok: true, path: path.join(reviews, "2026-09-22-01.md") });
    await session.close();
  });

  it("crash leftovers (empty reservation, temp file) are ignored, not deleted, and not reused", async () => {
    await mkdir(reviews, { recursive: true });
    await writeFile(path.join(reviews, "2026-09-22-01.md"), "");
    await writeFile(path.join(reviews, ".2026-09-22-01.md.999.dead.tmp"), "partial");
    const session = await openReviewSession(options());
    expect(session.resumedFrom).toBeNull();
    expect(await session.addTodo("new")).toMatchObject({ ok: true, path: path.join(reviews, "2026-09-22-02.md") });
    await session.close();
    expect(await readFile(path.join(reviews, "2026-09-22-01.md"), "utf8")).toBe("");
    expect(await readFile(path.join(reviews, ".2026-09-22-01.md.999.dead.tmp"), "utf8")).toBe("partial");
  });
});
