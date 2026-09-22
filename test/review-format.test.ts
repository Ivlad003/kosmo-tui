import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseTraceTextV2 } from "@kosmo-callflow/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REVIEW_EVIDENCE_MAX_BYTES,
  buildEvidence,
  countCheckboxes,
  escapeInline,
  openReviewSession,
  parseReview,
  renderReview,
  reparseEvidence,
  resolveReviewCapability,
  unescapeInline,
  type ReviewCapability,
  type ReviewSessionOptions
} from "../src/review.js";
import {
  ESC,
  SOURCE_REF,
  fakeEnv,
  findingInput,
  removeDir,
  tempDir,
  v1Document,
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

const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123";

describe("6.2 evidence is a full codec document", () => {
  it("v2 and v1 evidence re-parse with the protocol parser; version comes from the document", () => {
    for (const format of ["lisp", "tab"] as const) {
      const v2 = buildEvidence(v2Document(), format);
      expect(v2.ok).toBe(true);
      if (!v2.ok) continue;
      expect(v2.evidence.version).toBe(2);
      expect(v2.evidence.text.startsWith(format === "lisp" ? "(kosmo.trace-text/v2" : "kosmo.trace-text/v2\t")).toBe(
        true
      );
      expect(reparseEvidence(v2.evidence).ok).toBe(true);
      const v1 = buildEvidence(v1Document(), format);
      expect(v1.ok && v1.evidence.version).toBe(1);
      expect(v1.ok && reparseEvidence(v1.evidence).ok).toBe(true);
    }
  });

  it("keeps coverage, truncated and masked markers and caps at 51,200 bytes", () => {
    const many = Array.from({ length: 400 }, (_, index) =>
      v2Span({
        ref: { datasetId: "imported:shop", projectId: "shop", sessionId: "s1", traceId: "t1", spanId: `sp${index}` },
        ret: { state: "recorded", reason: null, value: "x".repeat(200) }
      })
    );
    const evidence = buildEvidence(v2Document(many), "lisp");
    expect(evidence.ok).toBe(true);
    if (!evidence.ok) return;
    expect(evidence.evidence.bytes).toBeLessThanOrEqual(REVIEW_EVIDENCE_MAX_BYTES);
    expect(evidence.evidence.truncated).toBe(true);
    expect(evidence.evidence.coverage).toBe("truncated");
    const parsed = reparseEvidence(evidence.evidence);
    expect(parsed.ok && parsed.data.coverage.gaps).toContain("output-byte-cap");
    expect(evidence.evidence.text).toContain(":args (evidence :state masked");
  });

  it("rejects a non-codec object instead of inventing evidence", () => {
    expect(buildEvidence({ dialect: "bogus" } as never, "lisp")).toMatchObject({ ok: false });
    const invalid = v2Document();
    (invalid as { depth: string }).depth = "planet";
    expect(buildEvidence(invalid, "lisp")).toMatchObject({ ok: false, message: expect.stringContaining("depth") });
  });
});

describe("6.2 shared sanitizer on notes, frontmatter and evidence", () => {
  it("scenario: masked data and control/markdown text in the note never reach the file raw", async () => {
    const hostile = [
      `token ${TOKEN} in ${root}/src/cart.ts and /Users/someone/secret.txt ${ESC}[31mred`,
      "```",
      "- [ ] not a real item",
      "## Findings",
      "   [x] also not"
    ].join("\n");
    const span = v2Span({
      display: `- [ ] fake item ${ESC}]52;c;evil${String.fromCharCode(7)} \`\`\`\`\`\` ${TOKEN}`,
      ret: { state: "recorded", reason: null, value: `{"path":"/Users/someone/.ssh/id","token":"${TOKEN}"}` }
    });
    const session = await openReviewSession(
      options({
        sourceLabel: `live https://user:pass@example.test/api?token=${TOKEN}`,
        sourceRef: { ...SOURCE_REF, datasetId: `imported ${root}/dump.json ${ESC}` }
      })
    );
    const result = await session.addFinding(findingInput({ note: hostile, evidence: v2Document([span]) }));
    expect(result.ok).toBe(true);
    await session.close();
    const text = await readFile(session.path!, "utf8");

    expect(text).not.toContain(ESC);
    expect(text).not.toContain(String.fromCharCode(7));
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("user:pass");
    expect(text).not.toContain(root);
    expect(text).not.toContain("/Users/someone");
    expect(text).toContain("[masked:secret]");
    expect(text).toContain("[external-path]");
    // Structure intact: one finding, zero todos, only the real checkbox counts.
    expect(countCheckboxes(text)).toEqual({ total: 1, checked: 0 });
    expect(text.split("\n").filter((line) => line.startsWith("## "))).toEqual(["## Findings", "## Todos"]);
    expect(text.split("\n").filter((line) => /^\s{0,3}```/.test(line)).length).toBe(2); // one open + one close

    const parsed = parseReview(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const finding = parsed.value.findings[0]!;
    expect(finding.note.split("\n")).toEqual([
      "token [masked:secret] in src/cart.ts and [external-path] \\u001b[31mred",
      "```",
      "- [ ] not a real item",
      "## Findings",
      "[x] also not"
    ]);
    expect(parsed.value.frontmatter.source).toBe("live https://example.test/api");
    expect(parsed.value.frontmatter.sourceRef?.datasetId).toBe("imported dump.json \\u001b");
    // Evidence: sanitized before encoding, still a valid codec document, masked value not revealed.
    const evidence = parseTraceTextV2(finding.evidence.text, { dialect: "lisp" });
    expect(evidence.ok).toBe(true);
    if (!evidence.ok) return;
    const item = evidence.data.items[0]!;
    expect(item.kind === "span" && item.args.state).toBe("masked");
    expect(item.kind === "span" && item.display).toContain("- [ ] fake item \\u001b]52;c;evil\\u0007");
    expect(item.kind === "span" && item.ret.value).not.toContain(TOKEN);
  });

  it("inline escaping is reversible and neutralises block syntax", () => {
    for (const sample of ["- [ ] x", "# h", "```js", "1. item", "> quote", "a \\ b [c] `d` <e>", "+ plus", "==="]) {
      const escaped = escapeInline(sample);
      expect(unescapeInline(escaped)).toBe(sample);
      expect(escaped).not.toMatch(/^(- \[|#|```|\d+\.|>|\+ |=)/);
    }
  });
});

describe("6.2 parser roundtrip", () => {
  it("write → parse → same items and evidence; render(parse(file)) is byte-identical", async () => {
    const session = await openReviewSession(options({ dialect: "tab" }));
    await session.addFinding(findingInput({ note: "first line\nsecond `line`" }));
    await session.addTodo("check [the] retry\n- nested looking");
    await session.addFinding(findingInput({ node: null, source: null, note: "" }));
    const expected = session.items;
    await session.close();
    const text = await readFile(path.join(root, ".kosmo-callflow", "reviews", "2026-09-22-01.md"), "utf8");
    const parsed = parseReview(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect([...parsed.value.findings, ...parsed.value.todos]).toEqual(
      [...expected].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "finding" ? -1 : 1))
    );
    expect(renderReview(parsed.value)).toBe(text);
    for (const finding of parsed.value.findings) {
      expect(finding.evidence.format).toBe("tab");
      expect(reparseEvidence(finding.evidence).ok).toBe(true);
    }
  });

  it("tampered evidence fails the sha256 check instead of being trusted", async () => {
    const session = await openReviewSession(options());
    await session.addFinding(findingInput());
    await session.close();
    const text = await readFile(session.path!, "utf8");
    const tampered = text.replace(":watermark 5010", ":watermark 5011");
    expect(tampered).not.toBe(text);
    expect(parseReview(tampered)).toMatchObject({ ok: false, code: "invalid-body" });
  });
});
