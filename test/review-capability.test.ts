import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openReviewSession, resolveReviewCapability, type ReviewSessionOptions } from "../src/review.js";
import { SOURCE_REF, fakeEnv, faultyFs, findingInput, removeDir, snapshotTree, tempDir } from "./review-helpers.js";

let root: string;
let exportPath: string;
const EXPORT = '{"format":"kosmo-callflow.export","traces":[]}\n';

beforeEach(async () => {
  root = await tempDir();
  exportPath = path.join(root, "export.json");
  await writeFile(exportPath, EXPORT);
});
afterEach(async () => {
  await chmod(root, 0o755).catch(() => undefined);
  await removeDir(root);
});

function options(
  capability: ReviewSessionOptions["capability"],
  fs?: ReviewSessionOptions["fs"]
): ReviewSessionOptions {
  return {
    capability,
    sourceRef: SOURCE_REF,
    sourceLabel: "export ./export.json",
    dialect: "lisp",
    traceTextVersion: 2,
    env: fakeEnv(),
    ...(fs === undefined ? {} : { fs })
  };
}

/** Exercise every review action of a disabled session and assert nothing was written. */
async function exerciseDisabled(capability: ReviewSessionOptions["capability"], reason: RegExp): Promise<void> {
  expect(capability).toEqual({ enabled: false, reason: expect.stringMatching(reason) });
  const calls: string[] = [];
  const fs = faultyFs([], calls);
  const before = await snapshotTree(root);
  const session = await openReviewSession(options(capability, fs));
  for (const result of [
    await session.addFinding(findingInput()),
    await session.addTodo("todo"),
    await session.finalize(),
    await session.save()
  ])
    expect(result).toEqual({
      ok: false,
      code: "review-disabled",
      message: expect.stringMatching(/^review disabled: /)
    });
  await session.close();
  expect(session.path).toBeNull();
  expect(session.items).toEqual([]);
  expect(calls).toEqual([]); // not even a directory listing
  expect(await snapshotTree(root)).toEqual(before);
  // The source view stays usable: the source is untouched and still readable.
  expect(await readFile(exportPath, "utf8")).toBe(EXPORT);
}

describe("6.5 sessions that must not write reviews", () => {
  it("scenario: -r read-only export creates no review directories or files", async () => {
    const capability = await resolveReviewCapability({ readOnly: true, oneShot: false, projectRoot: root, cwd: root });
    await exerciseDisabled(capability, /read-only/);
  });

  it("scenario: --print one-shot never writes a review, even with an existing editing review to resume", async () => {
    const writable = await resolveReviewCapability({ readOnly: false, oneShot: false, projectRoot: root, cwd: root });
    const seed = await openReviewSession(options(writable));
    await seed.addTodo("existing");
    await seed.close();
    const capability = await resolveReviewCapability({ readOnly: false, oneShot: true, projectRoot: root, cwd: root });
    await exerciseDisabled(capability, /one-shot/);
  });

  it("-r also wins over an existing resumable review: it is neither resumed nor rewritten", async () => {
    const writable = await resolveReviewCapability({ readOnly: false, oneShot: false, projectRoot: root, cwd: root });
    const seed = await openReviewSession(options(writable));
    await seed.addTodo("existing");
    await seed.close();
    const capability = await resolveReviewCapability({ readOnly: true, oneShot: false, projectRoot: root, cwd: root });
    const session = await openReviewSession(options(capability));
    expect(session.resumedFrom).toBeNull();
    await exerciseDisabled(capability, /read-only/);
  });

  it("standalone export without a project root needs --review-dir", async () => {
    const capability = await resolveReviewCapability({ readOnly: false, oneShot: false, cwd: root });
    await exerciseDisabled(capability, /--review-dir/);
  });

  it.skipIf(process.getuid?.() === 0)(
    "an unwritable review directory disables review without creating anything",
    async () => {
      await mkdir(path.join(root, ".kosmo-callflow"));
      await chmod(path.join(root, ".kosmo-callflow"), 0o555);
      try {
        const capability = await resolveReviewCapability({
          readOnly: false,
          oneShot: false,
          projectRoot: root,
          cwd: root
        });
        await exerciseDisabled(capability, /not writable: \.kosmo-callflow\/reviews$/);
      } finally {
        await chmod(path.join(root, ".kosmo-callflow"), 0o755);
      }
    }
  );

  it("an injected unwritable ancestor and a file in place of the directory are reported with a reason", async () => {
    const readOnlyFs = { ...faultyFs(), canWrite: async () => false };
    const denied = await resolveReviewCapability({
      readOnly: false,
      oneShot: false,
      projectRoot: root,
      cwd: root,
      fs: readOnlyFs
    });
    await exerciseDisabled(denied, /not writable/);

    await writeFile(path.join(root, ".kosmo-callflow"), "not a directory");
    const blocked = await resolveReviewCapability({ readOnly: false, oneShot: false, projectRoot: root, cwd: root });
    await exerciseDisabled(blocked, /not a directory/);
  });

  it("an enabled capability is decided without creating anything", async () => {
    const before = await snapshotTree(root);
    const capability = await resolveReviewCapability({
      readOnly: false,
      oneShot: false,
      reviewDir: "deep/nested/reviews",
      cwd: root
    });
    expect(capability).toEqual({ enabled: true, dir: path.join(root, "deep/nested/reviews"), projectRoot: null });
    expect(await snapshotTree(root)).toEqual(before);
  });
});
