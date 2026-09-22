/**
 * Review artifact encoding (spec debug-review, design D7): pure, no I/O.
 *
 * Layout of `.kosmo-callflow/reviews/YYYY-MM-DD-NN.md`:
 *
 *   ---                                  frontmatter: a fixed YAML subset, strings
 *   reviewVersion: 1                     JSON-quoted so any YAML reader agrees
 *   ...
 *   ---
 *
 *   # Debug review
 *
 *   ## Findings
 *
 *   - [ ] f-1a2b3c4d: note line          top-level checkbox = one item
 *     more note                          continuation, escaped
 *     - ref: {...}                       metadata, JSON then inline-escaped
 *     - evidence: {...}
 *
 *     ````kosmo-trace-text               fence longer than any backtick run inside
 *     (kosmo.trace-text/v2 ...           full codec document, indented two spaces
 *     ````
 *
 *   ## Todos
 *
 *   - [ ] t-9f8e7d6c: todo note
 *
 * Every user/trace-derived string passes the shared sanitizer (`@kosmo-callflow/
 * trace-artifacts`) before it is encoded: secrets masked, absolute paths relativised
 * or `[external-path]`, terminal controls escaped as visible text. Markdown structure
 * in notes/metadata is escaped reversibly (`\` before the active character), so a
 * note can never open a fence, a heading or a checkbox. Evidence is never altered
 * after encoding: it sits indented inside a fence (so no evidence line can be a
 * top-level checkbox) and carries its byte length and sha256.
 */

import { createHash } from "node:crypto";
import {
  TRACE_TEXT_DIALECT,
  TRACE_TEXT_DIALECT_V2,
  TRACE_TEXT_MAX_BYTES,
  parseTraceText,
  parseTraceTextV2,
  renderTraceText,
  renderTraceTextV2,
  type TraceTextDialect,
  type TraceTextDocumentV1,
  type TraceTextDocumentV2
} from "@kosmo-callflow/protocol";
import { sanitizeEvidenceText, sanitizeStructuredEvidence } from "@kosmo-callflow/trace-artifacts";

export const REVIEW_VERSION = 1 as const;
export const REVIEW_NOTE_MAX_BYTES = 2_000;
export const REVIEW_EVIDENCE_MAX_BYTES = TRACE_TEXT_MAX_BYTES;
export const REVIEW_STATUSES = ["editing", "ready", "partial", "done"] as const;
export const REVIEW_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})-(\d{2,})\.md$/;
const EVIDENCE_INFO = "kosmo-trace-text";

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export type TraceTextVersion = 1 | 2;
export type ReviewSourceRef = { projectId: string; datasetId: string; sourceRevision: string };

export type ReviewFrontmatter = {
  reviewVersion: typeof REVIEW_VERSION;
  revision: number;
  status: ReviewStatus;
  /** Sanitized display label; never a host path or URL credential. */
  source: string;
  /** null when the source has no stable identity (such a review is never resumed). */
  sourceRef: ReviewSourceRef | null;
  created: string;
  updated: string;
  dialect: TraceTextDialect;
  traceTextVersion: TraceTextVersion;
};

export type FullSpanRef = { datasetId: string; projectId: string; sessionId: string; traceId: string; spanId: string };
export type SnapshotAnchor = {
  snapshotId: string;
  watermark: number;
  retentionEpoch: number | null;
  seq: number | null;
};
/** A missing line/column is `"unavailable"`, never a made-up `:1`. */
export type SourceAnchor =
  | { state: "available"; file: string; line: number | "unavailable"; column: number | "unavailable" }
  | { state: "unavailable"; reason: string };

export type ReviewEvidence = {
  version: TraceTextVersion;
  format: TraceTextDialect;
  bytes: number;
  sha256: string;
  truncated: boolean;
  coverage: string;
  text: string;
};

export type ReviewFinding = {
  kind: "finding";
  id: string;
  checked: boolean;
  note: string;
  ref: FullSpanRef;
  node: string | null;
  snapshot: SnapshotAnchor;
  source: SourceAnchor;
  evidence: ReviewEvidence;
};
export type ReviewTodo = { kind: "todo"; id: string; checked: boolean; note: string };
export type ReviewItem = ReviewFinding | ReviewTodo;

export type ReviewDocument = { frontmatter: ReviewFrontmatter; findings: ReviewFinding[]; todos: ReviewTodo[] };

export type ReviewParseErrorCode = "unsupported-review-version" | "invalid-frontmatter" | "invalid-body";
export type ReviewParseResult<T> = { ok: true; value: T } | { ok: false; code: ReviewParseErrorCode; message: string };

// ---------------------------------------------------------------------------------------
// Sanitation and escaping
// ---------------------------------------------------------------------------------------

export type SanitizeContext = { projectRoot?: string };

function sanitizeOptions(context: SanitizeContext): { projectRoot?: string } {
  return context.projectRoot === undefined ? {} : { projectRoot: context.projectRoot };
}

/** Shared sanitizer on a single-line value (newlines become visible escapes). */
export function sanitizeLine(text: string, context: SanitizeContext = {}): string {
  return sanitizeEvidenceText(text, sanitizeOptions(context)).value;
}

/** Display label for the frontmatter `source`: sanitized, URL userinfo/query dropped. */
export function sanitizeSourceLabel(label: string, context: SanitizeContext = {}): string {
  const withoutCredentials = label.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/?#\s]*@/gi, "$1").replace(/\?[^\s#]*/g, "");
  return sanitizeLine(withoutCredentials, context);
}

/**
 * Normalize a user note: CRLF → LF, shared sanitizer (newlines kept), each line trimmed,
 * blank lines dropped. The stored note is exactly what a parse returns.
 */
export function normalizeNote(note: string, context: SanitizeContext = {}): string {
  const unified = note.replace(/\r\n?/g, "\n");
  const sanitized = sanitizeEvidenceText(unified, { ...sanitizeOptions(context), preserveNewlines: true }).value;
  return sanitized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Reversible inline escaping: `\` before every character that could start markdown structure. */
export function escapeInline(text: string): string {
  const escaped = text.replace(/[\\`[\]<>*_~|]/g, (char) => `\\${char}`);
  return /^[#>+\-=0-9]/.test(escaped) ? `\\${escaped}` : escaped;
}

export function unescapeInline(text: string): string {
  return text.replace(/\\(.)/g, "$1");
}

// ---------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------

export type EvidenceDocument = TraceTextDocumentV1 | TraceTextDocumentV2;
export type EvidenceResult = { ok: true; evidence: ReviewEvidence } | { ok: false; message: string };

export function evidenceVersionOf(document: { dialect?: unknown }): TraceTextVersion | null {
  if (document.dialect === TRACE_TEXT_DIALECT) return 1;
  if (document.dialect === TRACE_TEXT_DIALECT_V2) return 2;
  return null;
}

function parseEvidenceText(text: string, version: TraceTextVersion, format: TraceTextDialect) {
  return version === 1 ? parseTraceText(text, { dialect: format }) : parseTraceTextV2(text, { dialect: format });
}

/**
 * Snapshot a codec document as immutable evidence: sanitize every string, render with
 * the shared codec under the 51,200-byte cap (which keeps coverage/truncated markers),
 * and prove the result parses with the protocol parser.
 */
export function buildEvidence(
  document: EvidenceDocument,
  format: TraceTextDialect,
  context: SanitizeContext = {}
): EvidenceResult {
  const version = evidenceVersionOf(document);
  if (version === null) return { ok: false, message: "evidence is not a kosmo.trace-text/v1 or v2 document" };
  const sanitized = sanitizeStructuredEvidence(document, sanitizeOptions(context)).value;
  let text: string;
  try {
    text =
      version === 1
        ? renderTraceText(sanitized as TraceTextDocumentV1, { dialect: format, maxBytes: REVIEW_EVIDENCE_MAX_BYTES })
        : renderTraceTextV2(sanitized as TraceTextDocumentV2, { dialect: format, maxBytes: REVIEW_EVIDENCE_MAX_BYTES });
  } catch (error) {
    const issue = (error as { issues?: Array<{ path?: unknown[]; message?: string }> }).issues?.[0];
    const detail =
      issue === undefined ? "invalid document" : `${(issue.path ?? []).join(".")}: ${issue.message ?? "invalid"}`;
    return { ok: false, message: `evidence does not encode: ${sanitizeLine(detail)}` };
  }
  const parsed = parseEvidenceText(text, version, format);
  if (!parsed.ok)
    return {
      ok: false,
      message: `encoded evidence does not re-parse: ${parsed.reason} at ${parsed.line}:${parsed.column}`
    };
  return {
    ok: true,
    evidence: {
      version,
      format,
      bytes: byteLength(text),
      sha256: sha256(text),
      truncated: parsed.data.truncated,
      coverage: parsed.data.coverage.state,
      text
    }
  };
}

function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

// ---------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------

function yamlString(value: string | null): string {
  return value === null ? "null" : JSON.stringify(value);
}

export function renderFrontmatter(frontmatter: ReviewFrontmatter): string {
  const ref = frontmatter.sourceRef;
  return [
    "---",
    `reviewVersion: ${frontmatter.reviewVersion}`,
    `revision: ${frontmatter.revision}`,
    `status: ${frontmatter.status}`,
    `source: ${yamlString(frontmatter.source)}`,
    "sourceRef:",
    `  projectId: ${yamlString(ref?.projectId ?? null)}`,
    `  datasetId: ${yamlString(ref?.datasetId ?? null)}`,
    `  sourceRevision: ${yamlString(ref?.sourceRevision ?? null)}`,
    `created: ${frontmatter.created}`,
    `updated: ${frontmatter.updated}`,
    `dialect: ${frontmatter.dialect}`,
    `traceTextVersion: ${frontmatter.traceTextVersion}`,
    "---",
    ""
  ].join("\n");
}

function itemHead(item: ReviewItem): string[] {
  const [first = "", ...rest] = item.note.length > 0 ? item.note.split("\n") : [];
  const head = `- [${item.checked ? "x" : " "}] ${item.id}:${first.length > 0 ? ` ${escapeInline(first)}` : ""}`;
  return [head, ...rest.map((line) => `  ${escapeInline(line)}`)];
}

function meta(key: string, value: unknown): string {
  return `  - ${key}: ${escapeInline(JSON.stringify(value))}`;
}

function renderFinding(finding: ReviewFinding): string[] {
  const { text, ...evidenceMeta } = finding.evidence;
  const fence = fenceFor(text);
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return [
    ...itemHead(finding),
    meta("ref", finding.ref),
    meta("node", finding.node),
    meta("snapshot", finding.snapshot),
    meta("source", finding.source),
    meta("evidence", evidenceMeta),
    "",
    `  ${fence}${EVIDENCE_INFO}`,
    ...body.split("\n").map((line) => (line.length === 0 ? "" : `  ${line}`)),
    `  ${fence}`
  ];
}

export function renderReview(document: ReviewDocument): string {
  const lines = [renderFrontmatter(document.frontmatter), "# Debug review", "", "## Findings", ""];
  for (const finding of document.findings) lines.push(...renderFinding(finding), "");
  lines.push("## Todos", "");
  for (const todo of document.todos) lines.push(...itemHead(todo), "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------

function fail<T>(code: ReviewParseErrorCode, message: string): ReviewParseResult<T> {
  return { ok: false, code, message };
}

type RawScalar = string | number | null;

function yamlScalar(raw: string): RawScalar {
  const value = raw.trim();
  if (value === "null" || value === "~" || value === "") return null;
  if (value.startsWith('"')) return JSON.parse(value) as string;
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

/** Split `---\n…\n---\n` from the body; the offsets let callers count only body lines. */
export function splitFrontmatter(text: string): { yaml: string[]; body: string[] } | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end < 0) return null;
  return { yaml: lines.slice(1, end), body: lines.slice(end + 1) };
}

/**
 * Parse the frontmatter. Tolerant of external writers (plain or quoted scalars, key
 * order), strict about meaning: an unknown `reviewVersion` is reported as such before
 * any other validation, so the caller never mistakes a newer schema for garbage.
 */
export function parseFrontmatter(text: string): ReviewParseResult<ReviewFrontmatter> {
  const split = splitFrontmatter(text);
  if (split === null) return fail("invalid-frontmatter", "missing --- frontmatter");
  const top: Record<string, RawScalar> = {};
  const ref: Record<string, RawScalar> = {};
  let inRef = false;
  try {
    for (const line of split.yaml) {
      if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
      const nested = /^\s+([A-Za-z]+):(.*)$/.exec(line);
      if (nested !== null && inRef) {
        ref[nested[1]!] = yamlScalar(nested[2]!);
        continue;
      }
      const entry = /^([A-Za-z]+):(.*)$/.exec(line);
      if (entry === null) return fail("invalid-frontmatter", `unrecognized frontmatter line: ${sanitizeLine(line)}`);
      const [, key, rest] = entry as unknown as [string, string, string];
      if (key in top) return fail("invalid-frontmatter", `duplicate frontmatter key ${key}`);
      inRef = key === "sourceRef";
      top[key] = inRef ? (rest.trim() === "" ? "" : yamlScalar(rest)) : yamlScalar(rest);
    }
  } catch {
    return fail("invalid-frontmatter", "malformed quoted frontmatter value");
  }
  if (top.reviewVersion !== REVIEW_VERSION)
    return fail(
      "unsupported-review-version",
      `unsupported reviewVersion ${sanitizeLine(String(top.reviewVersion ?? "missing"))}; this kosmo-tui reads reviewVersion 1 and will not rewrite it`
    );
  const str = (value: RawScalar | undefined): string | undefined => (typeof value === "string" ? value : undefined);
  const status = str(top.status);
  const dialect = str(top.dialect);
  const revision = top.revision;
  const version = top.traceTextVersion;
  const created = top.created;
  const updated = top.updated;
  if (typeof revision !== "number" || revision < 0) return fail("invalid-frontmatter", "revision must be a number");
  if (status === undefined || !(REVIEW_STATUSES as readonly string[]).includes(status))
    return fail("invalid-frontmatter", "status must be editing|ready|partial|done");
  if (dialect !== "lisp" && dialect !== "tab") return fail("invalid-frontmatter", "dialect must be lisp|tab");
  if (version !== 1 && version !== 2) return fail("invalid-frontmatter", "traceTextVersion must be 1 or 2");
  if (typeof created !== "string" || typeof updated !== "string")
    return fail("invalid-frontmatter", "created/updated must be timestamps");
  const source = str(top.source);
  if (source === undefined) return fail("invalid-frontmatter", "source must be a string");
  let sourceRef: ReviewSourceRef | null = null;
  if (top.sourceRef !== null && top.sourceRef !== undefined) {
    const projectId = ref.projectId ?? null;
    const datasetId = ref.datasetId ?? null;
    const sourceRevision = ref.sourceRevision ?? null;
    if (projectId === null && datasetId === null && sourceRevision === null) sourceRef = null;
    else if (typeof projectId === "string" && typeof datasetId === "string" && typeof sourceRevision === "string")
      sourceRef = { projectId, datasetId, sourceRevision };
    else return fail("invalid-frontmatter", "sourceRef needs projectId, datasetId and sourceRevision strings");
  }
  return {
    ok: true,
    value: {
      reviewVersion: REVIEW_VERSION,
      revision,
      status: status as ReviewStatus,
      source,
      sourceRef,
      created,
      updated,
      dialect,
      traceTextVersion: version
    }
  };
}

const ITEM_HEAD = /^- \[( |x|X)\] ([ft]-[0-9a-z]+):(?: (.*))?$/;
const META_LINE = /^ {2}- ([a-z]+): (.*)$/;
const FENCE_OPEN = new RegExp(`^ {2}(\`{3,})${EVIDENCE_INFO}$`);

function parseMeta(raw: string): unknown {
  return JSON.parse(unescapeInline(raw)) as unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFullRef(value: unknown): value is FullSpanRef {
  return (
    isObject(value) &&
    ["datasetId", "projectId", "sessionId", "traceId", "spanId"].every((key) => typeof value[key] === "string")
  );
}

/**
 * Strict body parse: the exact layout `renderReview` writes. Anything else is
 * `invalid-body`, and a session never resumes (or rewrites) such a file.
 */
export function parseReview(text: string): ReviewParseResult<ReviewDocument> {
  const frontmatter = parseFrontmatter(text);
  if (!frontmatter.ok) return frontmatter;
  const body = splitFrontmatter(text)!.body;
  const findings: ReviewFinding[] = [];
  const todos: ReviewTodo[] = [];
  const ids = new Set<string>();
  let index = 0;
  const at = (offset = 0) => body[index + offset];
  const bodyFail = (message: string) => fail<ReviewDocument>("invalid-body", `line ${index + 1} of body: ${message}`);
  const expect = (line: string) => {
    if (at() !== line) return false;
    index += 1;
    return true;
  };
  const skipBlank = () => {
    while (at() === "") index += 1;
  };

  skipBlank();
  if (!expect("# Debug review")) return bodyFail("expected '# Debug review'");
  skipBlank();
  if (!expect("## Findings")) return bodyFail("expected '## Findings'");
  let section: "finding" | "todo" = "finding";
  skipBlank();
  while (index < body.length) {
    const line = at()!;
    if (line === "## Todos" && section === "finding") {
      section = "todo";
      index += 1;
      skipBlank();
      continue;
    }
    const head = ITEM_HEAD.exec(line);
    if (head === null) return bodyFail("expected a checkbox item");
    const id = head[2]!;
    if ((section === "finding") !== id.startsWith("f-")) return bodyFail(`item ${id} is in the wrong section`);
    if (ids.has(id)) return bodyFail(`duplicate item id ${id}`);
    ids.add(id);
    const checked = head[1] !== " ";
    const noteLines = head[3] === undefined ? [] : [unescapeInline(head[3])];
    index += 1;
    while (at() !== undefined && at()!.startsWith("  ") && !at()!.startsWith("  - ") && !FENCE_OPEN.test(at()!)) {
      noteLines.push(unescapeInline(at()!.slice(2)));
      index += 1;
    }
    const note = noteLines.join("\n");
    if (section === "todo") {
      todos.push({ kind: "todo", id, checked, note });
      skipBlank();
      continue;
    }
    const metadata: Record<string, unknown> = {};
    try {
      let match: RegExpExecArray | null;
      while (at() !== undefined && (match = META_LINE.exec(at()!)) !== null) {
        if (match[1]! in metadata) return bodyFail(`duplicate ${match[1]} metadata`);
        metadata[match[1]!] = parseMeta(match[2]!);
        index += 1;
      }
    } catch {
      return bodyFail(`malformed metadata of ${id}`);
    }
    const evidenceMeta = metadata.evidence;
    if (
      !isFullRef(metadata.ref) ||
      !isObject(metadata.snapshot) ||
      !isObject(metadata.source) ||
      !isObject(evidenceMeta) ||
      !(metadata.node === null || typeof metadata.node === "string")
    )
      return bodyFail(`finding ${id} needs ref/node/snapshot/source/evidence metadata`);
    if (!expect("")) return bodyFail(`finding ${id}: expected a blank line before evidence`);
    const open = FENCE_OPEN.exec(at() ?? "");
    if (open === null) return bodyFail(`finding ${id}: expected a ${EVIDENCE_INFO} fence`);
    const closing = `  ${open[1]}`;
    index += 1;
    const content: string[] = [];
    while (at() !== undefined && at() !== closing) {
      const evidenceLine = at()!;
      if (evidenceLine !== "" && !evidenceLine.startsWith("  ")) return bodyFail(`finding ${id}: unindented evidence`);
      content.push(evidenceLine.slice(2));
      index += 1;
    }
    if (!expect(closing)) return bodyFail(`finding ${id}: unterminated evidence fence`);
    const joined = content.join("\n");
    const digest = evidenceMeta.sha256;
    const evidenceText = [joined, `${joined}\n`].find((candidate) => sha256(candidate) === digest);
    const version = evidenceMeta.version;
    const format = evidenceMeta.format;
    if (evidenceText === undefined) return bodyFail(`finding ${id}: evidence does not match its sha256`);
    if ((version !== 1 && version !== 2) || (format !== "lisp" && format !== "tab"))
      return bodyFail(`finding ${id}: evidence version/format`);
    findings.push({
      kind: "finding",
      id,
      checked,
      note,
      ref: metadata.ref,
      node: metadata.node as string | null,
      snapshot: metadata.snapshot as SnapshotAnchor,
      source: metadata.source as SourceAnchor,
      evidence: {
        version,
        format,
        bytes: byteLength(evidenceText),
        sha256: digest as string,
        truncated: evidenceMeta.truncated === true,
        coverage: typeof evidenceMeta.coverage === "string" ? evidenceMeta.coverage : "unknown",
        text: evidenceText
      }
    });
    skipBlank();
  }
  if (section !== "todo") return bodyFail("expected '## Todos'");
  return { ok: true, value: { frontmatter: frontmatter.value, findings, todos } };
}

/** Parse evidence back with the protocol parser (the roundtrip proof). */
export function reparseEvidence(evidence: ReviewEvidence) {
  return parseEvidenceText(evidence.text, evidence.version, evidence.format);
}
