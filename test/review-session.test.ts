import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openReviewSession,
  parseFrontmatter,
  parseReview,
  reparseEvidence,
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

describe("6.1 review location, frontmatter and lazy creation", () => {
  it("capability points at <projectRoot>/.kosmo-callflow/reviews, or --review-dir", async () => {
    expect(capability).toEqual({ enabled: true, dir: reviews, projectRoot: root });
    const explicit = await resolveReviewCapability({ readOnly: false, oneShot: false, reviewDir: "out/r", cwd: root });
    expect(explicit).toEqual({ enabled: true, dir: path.join(root, "out/r"), projectRoot: null });
    const standalone = await resolveReviewCapability({ readOnly: false, oneShot: false, cwd: root });
    expect(standalone).toEqual({ enabled: false, reason: expect.stringContaining("--review-dir") });
  });

  it("viewing and quitting without f/t leaves no file or directory", async () => {
    const before = await snapshotTree(root);
    const session = await openReviewSession(options());
    expect(session.path).toBeNull();
    await session.close();
    const fresh = await openReviewSession(options({ noResume: true }));
    await fresh.close();
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("creates YYYY-MM-DD-NN.md (UTC) with the full frontmatter on the first todo", async () => {
    const env = fakeEnv();
    env.clock.now = new Date("2026-09-22T23:59:30.000-02:00"); // already 2026-09-23 in UTC
    const session = await openReviewSession(options({ env }));
    const result = await session.addTodo("look at the retry loop");
    expect(result).toMatchObject({ ok: true, revision: 1, status: "editing" });
    expect(session.path).toBe(path.join(reviews, "2026-09-23-01.md"));
    const text = await readFile(session.path!, "utf8");
    const frontmatter = parseFrontmatter(text);
    expect(frontmatter).toEqual({
      ok: true,
      value: {
        reviewVersion: 1,
        revision: 1,
        status: "editing",
        source: "export ./trace-export.json",
        sourceRef: SOURCE_REF,
        created: "2026-09-23T01:59:30.000Z",
        updated: "2026-09-23T01:59:30.000Z",
        dialect: "lisp",
        traceTextVersion: 2
      }
    });
    await session.close();
  });

  it("resumes only the latest unlocked editing review of the same sourceRef; watermark may change", async () => {
    const first = await openReviewSession(options());
    await first.addTodo("first");
    await first.close();

    // Different export (dataset) and different revision of the same dataset: never joined.
    for (const sourceRef of [
      { ...SOURCE_REF, datasetId: "imported:other" },
      { ...SOURCE_REF, sourceRevision: "rev-43" }
    ]) {
      const other = await openReviewSession(options({ sourceRef }));
      expect(other.resumedFrom).toBeNull();
      const before = await snapshotTree(root);
      await other.close();
      expect(await snapshotTree(root)).toEqual(before); // new review only on first write
    }

    const again = await openReviewSession(options());
    expect(again.resumedFrom).toBe(path.join(reviews, "2026-09-22-01.md"));
    const later = findingInput({
      snapshot: { snapshotId: "snap-9", watermark: 9000, retentionEpoch: 8, seq: 41 },
      evidence: v2Document([v2Span()], 9000)
    });
    expect(await again.addFinding(later)).toMatchObject({ ok: true, revision: 2 });
    await again.close();
    const parsed = parseReview(await readFile(path.join(reviews, "2026-09-22-01.md"), "utf8"));
    expect(parsed.ok && parsed.value.todos.map((todo) => todo.note)).toEqual(["first"]);
    expect(parsed.ok && parsed.value.findings[0]!.snapshot.watermark).toBe(9000);
  });

  it("a different export gets a new number on its first write and never touches the other review", async () => {
    const first = await openReviewSession(options());
    await first.addTodo("shop review");
    await first.close();
    const firstText = await readFile(path.join(reviews, "2026-09-22-01.md"), "utf8");
    const other = await openReviewSession(options({ sourceRef: { ...SOURCE_REF, datasetId: "imported:other" } }));
    const result = await other.addTodo("other review");
    expect(result).toMatchObject({ ok: true, path: path.join(reviews, "2026-09-22-02.md") });
    await other.close();
    expect(await readFile(path.join(reviews, "2026-09-22-01.md"), "utf8")).toBe(firstText);
  });

  it("-n never resumes and does not overwrite the previous review", async () => {
    const first = await openReviewSession(options());
    await first.addTodo("keep me");
    await first.close();
    const firstText = await readFile(path.join(reviews, "2026-09-22-01.md"), "utf8");
    const before = await snapshotTree(root);

    const fresh = await openReviewSession(options({ noResume: true }));
    expect(fresh.resumedFrom).toBeNull();
    await fresh.close();
    expect(await snapshotTree(root)).toEqual(before);

    const writer = await openReviewSession(options({ noResume: true }));
    expect(await writer.addTodo("new")).toMatchObject({ ok: true, path: path.join(reviews, "2026-09-22-02.md") });
    await writer.close();
    expect(await readFile(path.join(reviews, "2026-09-22-01.md"), "utf8")).toBe(firstText);
  });

  it("a source without stable identity never auto-resumes and writes sourceRef nulls", async () => {
    const first = await openReviewSession(options({ sourceRef: null }));
    await first.addTodo("unstable");
    await first.close();
    const second = await openReviewSession(options({ sourceRef: null }));
    expect(second.resumedFrom).toBeNull();
    const result = await second.addTodo("again");
    expect(result).toMatchObject({ ok: true, path: path.join(reviews, "2026-09-22-02.md") });
    await second.close();
    const frontmatter = parseFrontmatter(await readFile(path.join(reviews, "2026-09-22-01.md"), "utf8"));
    expect(frontmatter.ok && frontmatter.value.sourceRef).toBeNull();
  });

  it("unknown reviewVersion is an explicit diagnostic, never resumed and never overwritten", async () => {
    await mkdir(reviews, { recursive: true });
    const future = [
      "---",
      "reviewVersion: 2",
      "revision: 1",
      "status: editing",
      'source: "export ./trace-export.json"',
      "sourceRef:",
      '  projectId: "shop"',
      '  datasetId: "imported:shop"',
      '  sourceRevision: "rev-42"',
      "created: 2026-09-22T10:00:00.000Z",
      "updated: 2026-09-22T10:00:00.000Z",
      "dialect: lisp",
      "traceTextVersion: 2",
      "futureField: yes",
      "---",
      "",
      "whatever a newer kosmo-tui writes",
      ""
    ].join("\n");
    const broken = "---\nreviewVersion: 1\nstatus: editing\n---\n";
    await writeFile(path.join(reviews, "2026-09-22-01.md"), future);
    await writeFile(path.join(reviews, "2026-09-22-02.md"), broken);

    expect(parseFrontmatter(future)).toMatchObject({ ok: false, code: "unsupported-review-version" });
    const session = await openReviewSession(options());
    expect(session.resumedFrom).toBeNull();
    expect(session.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "2026-09-22-01.md", code: "unsupported-review-version" }),
        expect.objectContaining({ file: "2026-09-22-02.md", code: "invalid-frontmatter" })
      ])
    );
    expect(await session.addTodo("new work")).toMatchObject({ ok: true, path: path.join(reviews, "2026-09-22-03.md") });
    await session.close();
    expect(await readFile(path.join(reviews, "2026-09-22-01.md"), "utf8")).toBe(future);
    expect(await readFile(path.join(reviews, "2026-09-22-02.md"), "utf8")).toBe(broken);
  });

  it("a review edited outside kosmo-tui (non-canonical body) is not resumed or rewritten", async () => {
    const first = await openReviewSession(options());
    await first.addTodo("original");
    await first.close();
    const file = path.join(reviews, "2026-09-22-01.md");
    const edited = `${await readFile(file, "utf8")}\nA free-form paragraph from a human.\n`;
    await writeFile(file, edited);
    const again = await openReviewSession(options());
    expect(again.resumedFrom).toBeNull();
    expect(again.diagnostics.map((d) => d.code)).toContain("invalid-body");
    await again.addTodo("next");
    await again.close();
    expect(await readFile(file, "utf8")).toBe(edited);
  });
});

describe("6.2 findings: stable ids, bounded notes, immutable evidence", () => {
  it("finding after retention: saved evidence keeps the old watermark and is never refreshed", async () => {
    const session = await openReviewSession(options());
    const live = v2Document([v2Span()], 5010);
    const added = await session.addFinding(findingInput({ evidence: live }));
    expect(added.ok).toBe(true);
    const file = session.path!;
    const savedEvidence = parseReview(await readFile(file, "utf8"));
    expect(savedEvidence.ok).toBe(true);
    if (!savedEvidence.ok) return;
    const evidenceText = savedEvidence.value.findings[0]!.evidence.text;
    const firstId = savedEvidence.value.findings[0]!.id;

    // Retention evicts the span and live updates move the watermark: the source object mutates.
    live.items = [];
    live.dataset.watermark = 9999;
    // A later lookup of the same span is unavailable; the user adds a todo about it.
    expect(await session.addTodo("span sp1 is unavailable after retention")).toMatchObject({ ok: true, revision: 2 });
    await session.close();

    const after = parseReview(await readFile(file, "utf8"));
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    const finding = after.value.findings[0]!;
    expect(finding.id).toBe(firstId);
    expect(finding.evidence.text).toBe(evidenceText);
    expect(finding.snapshot).toEqual({ snapshotId: "snap-1", watermark: 5010, retentionEpoch: 7, seq: 41 });
    const reparsed = reparseEvidence(finding.evidence);
    expect(reparsed.ok && reparsed.data.dataset.watermark).toBe(5010);
    expect(reparsed.ok && reparsed.data.items).toHaveLength(1);
  });

  it("item ids are unique and stable across saves and resumes", async () => {
    const session = await openReviewSession(options());
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const result =
        index % 2 === 0 ? await session.addTodo(`todo ${index}`) : await session.addFinding(findingInput());
      expect(result.ok).toBe(true);
      if (result.ok) ids.push(result.itemId!);
    }
    await session.close();
    expect(new Set(ids).size).toBe(5);
    expect(ids.every((id) => /^[ft]-[0-9a-f]{8}$/.test(id))).toBe(true);
    const resumed = await openReviewSession(options());
    expect(resumed.items.map((item) => item.id).sort()).toEqual([...ids].sort());
    await resumed.addTodo("one more");
    await resumed.close();
    const parsed = parseReview(await readFile(resumed.path ?? path.join(reviews, "2026-09-22-01.md"), "utf8"));
    expect(
      parsed.ok &&
        [...parsed.value.findings, ...parsed.value.todos]
          .map((i) => i.id)
          .slice(0, 5)
          .sort()
    ).toEqual([...ids].sort());
  });

  it("notes are bounded to 2,000 UTF-8 bytes; an oversize note changes nothing", async () => {
    const session = await openReviewSession(options());
    const fits = "é".repeat(1_000); // 2,000 bytes
    expect(await session.addTodo(fits)).toMatchObject({ ok: true });
    const text = await readFile(session.path!, "utf8");
    const tooLong = await session.addTodo(`${fits}x`);
    expect(tooLong).toMatchObject({ ok: false, code: "note-too-long" });
    expect(await readFile(session.path!, "utf8")).toBe(text);
    expect(session.unsaved).toHaveLength(0);
    await session.close();
  });

  it("missing source line is recorded as unavailable, never :1; missing source is explicit", async () => {
    const session = await openReviewSession(options());
    await session.addFinding(findingInput({ source: { file: "src/cart.ts", line: null, column: null } }));
    await session.addFinding(findingInput({ source: null }));
    await session.close();
    const text = await readFile(path.join(reviews, "2026-09-22-01.md"), "utf8");
    expect(text).not.toMatch(/cart\.ts:1\b/);
    const parsed = parseReview(text);
    expect(parsed.ok && parsed.value.findings.map((finding) => finding.source)).toEqual([
      { state: "available", file: "src/cart.ts", line: "unavailable", column: "unavailable" },
      { state: "unavailable", reason: "no source location recorded" }
    ]);
  });

  it("summary-only sources allow todos but refuse a finding without span evidence", async () => {
    const session = await openReviewSession(options());
    const refused = await session.addFinding(findingInput({ evidence: null }));
    expect(refused).toMatchObject({ ok: false, code: "finding-requires-evidence" });
    expect(session.path).toBeNull();
    expect(await session.addTodo("investigate from summaries")).toMatchObject({ ok: true });
    await session.close();
  });

  it("evidence version must match the review's traceTextVersion", async () => {
    const { v1Document } = await import("./review-helpers.js");
    const session = await openReviewSession(options());
    expect(await session.addFinding(findingInput({ evidence: v1Document() }))).toMatchObject({
      ok: false,
      code: "evidence-version-mismatch"
    });
    await session.close();
    const v1 = await openReviewSession(options({ traceTextVersion: 1, noResume: true }));
    const saved = await v1.addFinding(findingInput({ evidence: v1Document() }));
    expect(saved).toMatchObject({ ok: true });
    await v1.close();
    if (!saved.ok) return;
    const parsed = parseReview(await readFile(saved.path, "utf8"));
    expect(parsed.ok && parsed.value.frontmatter.traceTextVersion).toBe(1);
    expect(parsed.ok && parsed.value.findings[0]!.evidence.version).toBe(1);
    expect(parsed.ok && parsed.value.findings[0]!.evidence.text.startsWith("(kosmo.trace-text/v1")).toBe(true);
  });
});
