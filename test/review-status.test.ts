import { readFile, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canFinalize,
  countCheckboxes,
  diagnoseStatus,
  expectedStatus,
  openReviewSession,
  parseFrontmatter,
  resolveReviewCapability,
  type ReviewCapability,
  type ReviewSessionOptions
} from "../src/review.js";
import {
  SOURCE_REF,
  fakeEnv,
  findingInput,
  removeDir,
  snapshotTree,
  tempDir,
  v2Document,
  v2Span
} from "./review-helpers.js";

let root: string;
let capability: ReviewCapability;

beforeEach(async () => {
  root = await tempDir();
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

/** What an external writer (agent) does: tick N items and set the status. */
function tick(text: string, count: number, status: string): string {
  let left = count;
  const lines = text.split("\n").map((line) => {
    if (left > 0 && /^- \[ \] [ft]-/.test(line)) {
      left -= 1;
      return line.replace("- [ ]", "- [x]");
    }
    return line;
  });
  return lines.join("\n").replace(/^status: .*$/m, `status: ${status}`);
}

async function readyReview(items: number): Promise<string> {
  const session = await openReviewSession(options());
  for (let index = 0; index < items; index += 1) {
    const result = index % 2 === 0 ? await session.addFinding(findingInput()) : await session.addTodo(`todo ${index}`);
    expect(result.ok).toBe(true);
  }
  expect(await session.finalize()).toMatchObject({ ok: true, status: "ready" });
  await session.close();
  return session.finalized[0]!;
}

describe("6.4 status rule", () => {
  it("0 checked → ready, some → partial, all of >0 → done", () => {
    expect(expectedStatus({ total: 5, checked: 0 })).toBe("ready");
    expect(expectedStatus({ total: 5, checked: 2 })).toBe("partial");
    expect(expectedStatus({ total: 5, checked: 5 })).toBe("done");
    expect(expectedStatus({ total: 0, checked: 0 })).toBe("ready");
  });

  it("checkboxes inside fenced evidence and outside the item sections never count", () => {
    const text = [
      "---",
      "status: ready",
      "---",
      "- [x] before any section",
      "## Findings",
      "- [ ] f-1: real",
      "  ````kosmo-trace-text",
      "- [x] inside a fence",
      "```",
      "- [x] still inside (shorter fence does not close)",
      "  ````",
      "  - [x] nested sub-item",
      "## Notes",
      "- [x] in another section",
      "## Todos",
      "- [x] t-1: real done",
      "~~~",
      "- [ ] tilde fence",
      "~~~"
    ].join("\n");
    expect(countCheckboxes(text)).toEqual({ total: 2, checked: 1 });
  });

  it("R on an empty or unsaved draft is an explicit no-op error", async () => {
    expect(canFinalize({ status: null, savedItems: 0, pendingItems: 0 })).toMatchObject({
      ok: false,
      code: "empty-review"
    });
    expect(canFinalize({ status: "editing", savedItems: 2, pendingItems: 1 })).toMatchObject({
      ok: false,
      code: "unsaved-draft"
    });
    expect(canFinalize({ status: "ready", savedItems: 2, pendingItems: 0 })).toMatchObject({
      ok: false,
      code: "not-editing"
    });

    const before = await snapshotTree(root);
    const session = await openReviewSession(options());
    expect(await session.finalize()).toMatchObject({ ok: false, code: "empty-review", message: expect.any(String) });
    expect(await snapshotTree(root)).toEqual(before);
    await session.close();
  });

  it("R with an unsaved draft (failed save) does not finalize", async () => {
    const session = await openReviewSession(options());
    await session.addTodo("saved");
    const file = session.path!;
    const text = await readFile(file, "utf8");
    await writeFile(file, `${text}\n`); // external edit → next save conflicts
    expect(await session.addTodo("unsaved")).toMatchObject({ ok: false, code: "conflict" });
    expect(session.unsaved).toHaveLength(1);
    expect(await session.finalize()).toMatchObject({ ok: false, code: "unsaved-draft" });
    expect(parseFrontmatter(await readFile(file, "utf8"))).toMatchObject({ ok: true, value: { status: "editing" } });
    await session.close();
  });
});

describe("6.4 lifecycle", () => {
  it("scenario: nonempty saved editing → ready via R; lock released; f/t/R no longer change it", async () => {
    const session = await openReviewSession(options());
    await session.addFinding(findingInput());
    const file = session.path!;
    const result = await session.finalize();
    expect(result).toMatchObject({ ok: true, status: "ready", path: file, revision: 2 });
    expect(session.path).toBe(file); // footer keeps showing it
    const ready = await readFile(file, "utf8");
    expect(parseFrontmatter(ready)).toMatchObject({ ok: true, value: { status: "ready", revision: 2 } });
    expect(await snapshotTree(root)).not.toHaveProperty([".kosmo-callflow/reviews/2026-09-22-01.md.lock"]);

    expect(await session.finalize()).toMatchObject({ ok: false });
    const next = await session.addTodo("after ready");
    expect(next).toMatchObject({ ok: true });
    expect(next.ok && next.path).not.toBe(file);
    await session.close();
    expect(await readFile(file, "utf8")).toBe(ready);
  });

  it("scenario: partial plan is not resumed; a new finding starts another review, done items untouched", async () => {
    const file = await readyReview(5);
    const partial = tick(await readFile(file, "utf8"), 2, "partial");
    await writeFile(file, partial);
    expect(countCheckboxes(partial)).toEqual({ total: 5, checked: 2 });

    const session = await openReviewSession(options());
    expect(session.resumedFrom).toBeNull();
    expect(session.diagnostics).toEqual([]);
    const result = await session.addFinding(findingInput());
    expect(result.ok && result.path).not.toBe(file);
    await session.close();
    expect(await readFile(file, "utf8")).toBe(partial);
  });

  it("external writer ready → partial → done matches the rule; mismatches are diagnostics, never fixed", async () => {
    const file = await readyReview(3);
    const base = await readFile(file, "utf8");
    for (const [count, status, mismatch] of [
      [0, "ready", false],
      [1, "partial", false],
      [3, "done", false],
      [3, "partial", true],
      [0, "done", true],
      [1, "ready", true]
    ] as const) {
      const text = tick(base, count, status);
      await writeFile(file, text);
      const header = parseFrontmatter(text);
      const diagnostic = header.ok ? diagnoseStatus(header.value.status, countCheckboxes(text)) : null;
      expect(diagnostic !== null).toBe(mismatch);
      const session = await openReviewSession(options());
      expect(session.diagnostics.some((d) => d.code === "status-mismatch")).toBe(mismatch);
      expect(session.resumedFrom).toBeNull();
      await session.close();
      expect(await readFile(file, "utf8")).toBe(text);
    }
  });

  it("checkbox-looking text inside evidence does not change the counts", async () => {
    const span = v2Span({
      display: "- [x] done\n- [ ] open",
      ret: { state: "recorded", reason: null, value: "- [x] y" }
    });
    const session = await openReviewSession(options());
    await session.addFinding(findingInput({ evidence: v2Document([span]) }));
    await session.addTodo("one todo");
    const text = await readFile(session.path!, "utf8");
    expect(text).toContain("- [x] done");
    expect(countCheckboxes(text)).toEqual({ total: 2, checked: 0 });
    await session.close();
  });

  it("an agent finalizing mid-session: the TUI never rewrites the finalized file", async () => {
    const session = await openReviewSession(options());
    await session.addTodo("first");
    const file = session.path!;
    const done = tick(await readFile(file, "utf8"), 1, "done");
    await writeFile(file, done);
    const result = await session.addTodo("second");
    expect(result).toMatchObject({ ok: false, code: "not-editing", message: expect.stringContaining("done") });
    expect(await readFile(file, "utf8")).toBe(done);
    expect(session.unsaved.map((item) => item.note)).toEqual(["second"]);
    // Retrying the draft starts a new review instead of touching the finalized one.
    const retry = await session.save();
    expect(retry.ok && retry.path).not.toBe(file);
    expect(await readFile(file, "utf8")).toBe(done);
    await session.close();
  });
});
