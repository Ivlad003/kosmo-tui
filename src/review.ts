/**
 * Debug review session (spec debug-review, design D3/D4/D7).
 *
 * Capability first: `resolveReviewCapability` decides — without creating anything —
 * whether this session may write reviews at all (`-r`, `--print`/one-shot, no project
 * root without `--review-dir`, or an unwritable directory disable it). A disabled
 * session still opens; every write answers `review disabled: <reason>` and the source
 * view is unaffected.
 *
 * Lazy: `openReviewSession` only reads. The directory, the review file and its lock
 * appear on the first successful `f`/`t` save; viewing and quitting leaves nothing.
 *
 * Resume: the newest `editing` review with the same `sourceRef` (project, dataset,
 * source revision — the watermark may differ), same dialect/trace-text version, a
 * free or stale lock and a byte-exact strict parse. `-n` (`noResume`) skips resume;
 * a source without stable identity (`sourceRef: null`) never resumes. Files with an
 * unknown `reviewVersion` or invalid frontmatter are reported and never rewritten.
 *
 * Writes: new numbers are reserved by exclusive create of `YYYY-MM-DD-NN.md` (UTC,
 * retry on collision), the session takes the `.lock` advisory lock, checks the lock
 * token and the file's sha256 before every save, and commits through a same-directory
 * temp file + rename. A lock conflict, an external edit, EACCES/ENOSPC or any I/O
 * failure keeps the previous file and the in-memory draft, and returns the reason.
 * This is cooperative locking plus optimistic detection, not a CAS against an
 * arbitrary editor.
 */

import path from "node:path";
import {
  REVIEW_FILE_PATTERN,
  REVIEW_NOTE_MAX_BYTES,
  REVIEW_VERSION,
  buildEvidence,
  byteLength,
  evidenceVersionOf,
  normalizeNote,
  parseFrontmatter,
  parseReview,
  renderReview,
  sanitizeLine,
  sanitizeSourceLabel,
  sha256,
  type EvidenceDocument,
  type FullSpanRef,
  type ReviewDocument,
  type ReviewFinding,
  type ReviewItem,
  type ReviewSourceRef,
  type ReviewStatus,
  type ReviewTodo,
  type SanitizeContext,
  type SnapshotAnchor,
  type SourceAnchor,
  type TraceTextVersion
} from "./review-format.js";
import { errorCode, nodeReviewEnv, nodeReviewFs, type ReviewEnv, type ReviewFs } from "./review-fs.js";
import {
  DEFAULT_STALE_LOCK_MS,
  acquireLock,
  inspectLock,
  lockPathFor,
  releaseLock,
  stillHeld,
  type HeldLock
} from "./review-lock.js";
import { canFinalize, countCheckboxes, diagnoseStatus } from "./review-status.js";
import type { TraceTextDialect } from "@kosmo-callflow/protocol";

export * from "./review-format.js";
export * from "./review-fs.js";
export * from "./review-lock.js";
export * from "./review-status.js";

export const REVIEW_DIR_SEGMENTS = [".kosmo-callflow", "reviews"] as const;

// ---------------------------------------------------------------------------------------
// Capability (design D3)
// ---------------------------------------------------------------------------------------

export type ReviewCapability =
  { enabled: true; dir: string; projectRoot: string | null } | { enabled: false; reason: string };

export type ReviewCapabilityInput = {
  /** `-r`: read-only session, no review and no eval. */
  readOnly: boolean;
  /** `--print`, SQL/eval one-shot: never writes reviews. */
  oneShot: boolean;
  /** Explicitly selected or unambiguously discovered project root. */
  projectRoot?: string;
  /** `--review-dir <dir>`, resolved against cwd. */
  reviewDir?: string;
  cwd: string;
  fs?: ReviewFs;
};

/**
 * Decide whether review writes are possible. Pure apart from read-only `stat`/`access`
 * calls: nothing is created, even when the answer is "enabled".
 */
export async function resolveReviewCapability(input: ReviewCapabilityInput): Promise<ReviewCapability> {
  const fs = input.fs ?? nodeReviewFs;
  if (input.readOnly) return { enabled: false, reason: "read-only session (-r)" };
  if (input.oneShot) return { enabled: false, reason: "one-shot output (--print) never writes reviews" };
  const projectRoot = input.projectRoot === undefined ? null : path.resolve(input.cwd, input.projectRoot);
  const dir =
    input.reviewDir !== undefined
      ? path.resolve(input.cwd, input.reviewDir)
      : projectRoot !== null
        ? path.join(projectRoot, ...REVIEW_DIR_SEGMENTS)
        : null;
  if (dir === null) return { enabled: false, reason: "no project root; pass --review-dir <dir> to write reviews" };
  const label = displayPath(dir, projectRoot ?? input.cwd);
  // Nearest existing ancestor decides: it must be a writable directory.
  let probe = dir;
  for (;;) {
    let info: { isDirectory: boolean } | undefined;
    try {
      info = await fs.stat(probe);
    } catch {
      return { enabled: false, reason: `review directory is not accessible: ${label}` };
    }
    if (info !== undefined) {
      if (!info.isDirectory) return { enabled: false, reason: `review path is not a directory: ${label}` };
      if (!(await fs.canWrite(probe))) return { enabled: false, reason: `review directory is not writable: ${label}` };
      return { enabled: true, dir, projectRoot };
    }
    const parent = path.dirname(probe);
    if (parent === probe) return { enabled: false, reason: `review directory is not accessible: ${label}` };
    probe = parent;
  }
}

function displayPath(target: string, root: string): string {
  const relative = path.relative(root, target);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : "[external-path]";
}

// ---------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------

export type ReviewErrorCode =
  | "review-disabled"
  | "invalid-input"
  | "note-too-long"
  | "finding-requires-evidence"
  | "evidence-version-mismatch"
  | "evidence-invalid"
  | "conflict"
  | "locked"
  | "lock-lost"
  | "not-editing"
  | "permission"
  | "disk-full"
  | "io"
  | "empty-review"
  | "unsaved-draft";

export type ReviewResult =
  | { ok: true; path: string; revision: number; status: ReviewStatus; itemId?: string; notice?: string }
  | { ok: false; code: ReviewErrorCode; message: string };

export type ReviewDiagnostic = {
  file: string;
  code: "unsupported-review-version" | "invalid-frontmatter" | "invalid-body" | "status-mismatch" | "unreadable";
  message: string;
};

export type FindingInput = {
  note: string;
  ref: FullSpanRef;
  node: string | null;
  snapshot: SnapshotAnchor;
  /** Relative anchor when known; `null` records `unavailable`. */
  source: { file: string; line: number | null; column: number | null } | null;
  /** Full codec document captured from the snapshot; `null` for summary-only sources. */
  evidence: EvidenceDocument | null;
};

export type ReviewSessionOptions = {
  capability: ReviewCapability;
  /** Stable dataset identity; `null` disables auto-resume. */
  sourceRef: ReviewSourceRef | null;
  /** Human display label of the source (sanitized before it is written). */
  sourceLabel: string;
  dialect: TraceTextDialect;
  traceTextVersion: TraceTextVersion;
  /** `-n`: never resume; reserve a new review on the first write. */
  noResume?: boolean;
  fs?: ReviewFs;
  env?: ReviewEnv;
  staleLockMs?: number;
};

type Candidate = { path: string; text: string; hash: string; document: ReviewDocument };
type Attached = { path: string; lock: HeldLock; document: ReviewDocument | null; hash: string };

const MAX_NUMBER_ATTEMPTS = 1_000;

function sameRef(a: ReviewSourceRef | null, b: ReviewSourceRef | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.projectId === b.projectId &&
    a.datasetId === b.datasetId &&
    a.sourceRevision === b.sourceRevision
  );
}

function ioError(error: unknown, action: string, label: string): { ok: false; code: ReviewErrorCode; message: string } {
  const code = errorCode(error);
  if (code === "EACCES" || code === "EPERM" || code === "EROFS")
    return { ok: false, code: "permission", message: `review not saved: permission denied while ${action} ${label}` };
  if (code === "ENOSPC" || code === "EDQUOT")
    return { ok: false, code: "disk-full", message: `review not saved: no space left while ${action} ${label}` };
  return { ok: false, code: "io", message: `review not saved: ${code ?? "I/O error"} while ${action} ${label}` };
}

export class ReviewSession {
  readonly capability: ReviewCapability;
  readonly diagnostics: ReviewDiagnostic[] = [];
  private readonly options: ReviewSessionOptions;
  private readonly fs: ReviewFs;
  private readonly env: ReviewEnv;
  private readonly sanitize: SanitizeContext;
  private candidate: Candidate | null = null;
  private attached: Attached | null = null;
  private pending: ReviewItem[] = [];
  private finalizedPaths: string[] = [];
  private lastCommitted: string | null = null;

  /** Use `openReviewSession`. */
  constructor(options: ReviewSessionOptions) {
    this.options = options;
    this.capability = options.capability;
    this.fs = options.fs ?? nodeReviewFs;
    this.env = options.env ?? nodeReviewEnv;
    const root = options.capability.enabled ? options.capability.projectRoot : null;
    this.sanitize = root === null ? {} : { projectRoot: root };
  }

  /**
   * The review this session writes to, would resume, or last committed (the footer
   * keeps showing it after `R`/close); null before the first write of a new review.
   */
  get path(): string | null {
    return this.attached?.path ?? this.candidate?.path ?? this.lastCommitted;
  }

  get resumedFrom(): string | null {
    return this.candidate?.path ?? null;
  }

  get finalized(): readonly string[] {
    return this.finalizedPaths;
  }

  /** Saved items of the current review followed by unsaved draft items. */
  get items(): readonly ReviewItem[] {
    const document = this.attached?.document ?? this.candidate?.document ?? null;
    return [...(document?.findings ?? []), ...(document?.todos ?? []), ...this.pending];
  }

  get unsaved(): readonly ReviewItem[] {
    return this.pending;
  }

  /** Scan the review directory (read-only) for diagnostics and a resume candidate. */
  async scan(): Promise<void> {
    if (!this.capability.enabled) return;
    const dir = this.capability.dir;
    let names: string[];
    try {
      names = await this.fs.readdir(dir);
    } catch {
      return;
    }
    const reviews = names
      .map((name) => ({ name, match: REVIEW_FILE_PATTERN.exec(name) }))
      .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
      .sort((a, b) =>
        a.match[1] === b.match[1] ? Number(b.match[2]) - Number(a.match[2]) : a.match[1]! < b.match[1]! ? 1 : -1
      );
    const wantResume = this.options.noResume !== true && this.options.sourceRef !== null;
    for (const { name } of reviews) {
      const file = path.join(dir, name);
      let text: string;
      try {
        text = await this.fs.readFile(file);
      } catch {
        this.diagnostics.push({ file: name, code: "unreadable", message: `${name}: cannot be read` });
        continue;
      }
      // An empty file is a number reservation (possibly a crash leftover), not a review.
      if (text.length === 0) continue;
      const header = parseFrontmatter(text);
      if (!header.ok) {
        this.diagnostics.push({ file: name, code: header.code, message: `${name}: ${header.message}` });
        continue;
      }
      const frontmatter = header.value;
      if (frontmatter.status !== "editing") {
        const mismatch = diagnoseStatus(frontmatter.status, countCheckboxes(text));
        if (mismatch !== null)
          this.diagnostics.push({ file: name, code: "status-mismatch", message: `${name}: ${mismatch.message}` });
        continue;
      }
      if (!wantResume || this.candidate !== null) continue;
      if (
        !sameRef(frontmatter.sourceRef, this.sanitizedRef()) ||
        frontmatter.dialect !== this.options.dialect ||
        frontmatter.traceTextVersion !== this.options.traceTextVersion
      )
        continue;
      const parsed = parseReview(text);
      if (!parsed.ok) {
        this.diagnostics.push({ file: name, code: parsed.code, message: `${name}: ${parsed.message}` });
        continue;
      }
      // Byte-exact roundtrip: resuming must never drop content a human or agent added.
      if (renderReview(parsed.value) !== text) {
        this.diagnostics.push({
          file: name,
          code: "invalid-body",
          message: `${name}: edited outside kosmo-tui; not resumed`
        });
        continue;
      }
      let lock: Awaited<ReturnType<typeof inspectLock>>;
      try {
        lock = await inspectLock(this.fs, this.env, lockPathFor(file), this.staleMs);
      } catch {
        continue;
      }
      if (lock.state === "held") continue;
      this.candidate = { path: file, text, hash: sha256(text), document: parsed.value };
    }
  }

  private get staleMs(): number {
    return this.options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  }

  private disabled(): ReviewResult | null {
    return this.capability.enabled
      ? null
      : { ok: false, code: "review-disabled", message: `review disabled: ${this.capability.reason}` };
  }

  private newId(prefix: "f" | "t"): string {
    const taken = new Set(this.items.map((item) => item.id));
    for (;;) {
      const id = `${prefix}-${this.env.randomId(4)}`;
      if (!taken.has(id)) return id;
    }
  }

  private noteOrError(
    note: string
  ): { ok: true; note: string } | { ok: false; code: ReviewErrorCode; message: string } {
    const normalized = normalizeNote(note, this.sanitize);
    if (byteLength(normalized) > REVIEW_NOTE_MAX_BYTES)
      return {
        ok: false,
        code: "note-too-long",
        message: `note is ${byteLength(normalized)} bytes; the limit is ${REVIEW_NOTE_MAX_BYTES} UTF-8 bytes`
      };
    return { ok: true, note: normalized };
  }

  /** `f`: add a finding with immutable evidence captured now, then save. */
  async addFinding(input: FindingInput): Promise<ReviewResult> {
    const disabled = this.disabled();
    if (disabled !== null) return disabled;
    const note = this.noteOrError(input.note);
    if (!note.ok) return note;
    if (input.evidence === null)
      return {
        ok: false,
        code: "finding-requires-evidence",
        message: "this source has no span evidence; add a todo (t) instead of a finding"
      };
    const refKeys = ["datasetId", "projectId", "sessionId", "traceId", "spanId"] as const;
    if (refKeys.some((key) => typeof input.ref[key] !== "string" || input.ref[key].length === 0))
      return { ok: false, code: "invalid-input", message: "a finding needs a full span ref" };
    const version = evidenceVersionOf(input.evidence);
    if (version !== this.options.traceTextVersion)
      return {
        ok: false,
        code: "evidence-version-mismatch",
        message: `evidence is trace-text v${version ?? "?"}, this review is v${this.options.traceTextVersion}`
      };
    const evidence = buildEvidence(input.evidence, this.options.dialect, this.sanitize);
    if (!evidence.ok) return { ok: false, code: "evidence-invalid", message: evidence.message };
    const line = (value: string) => sanitizeLine(value, this.sanitize);
    const source: SourceAnchor =
      input.source === null
        ? { state: "unavailable", reason: "no source location recorded" }
        : {
            state: "available",
            file: line(input.source.file),
            line: input.source.line ?? "unavailable",
            column: input.source.column ?? "unavailable"
          };
    const finding: ReviewFinding = {
      kind: "finding",
      id: this.newId("f"),
      checked: false,
      note: note.note,
      ref: {
        datasetId: line(input.ref.datasetId),
        projectId: line(input.ref.projectId),
        sessionId: line(input.ref.sessionId),
        traceId: line(input.ref.traceId),
        spanId: line(input.ref.spanId)
      },
      node: input.node === null ? null : line(input.node),
      snapshot: {
        snapshotId: line(input.snapshot.snapshotId),
        watermark: input.snapshot.watermark,
        retentionEpoch: input.snapshot.retentionEpoch,
        seq: input.snapshot.seq
      },
      source,
      evidence: evidence.evidence
    };
    this.pending.push(finding);
    return this.save(finding.id);
  }

  /** `t`: add a todo (no span needed), then save. */
  async addTodo(noteText: string): Promise<ReviewResult> {
    const disabled = this.disabled();
    if (disabled !== null) return disabled;
    const note = this.noteOrError(noteText);
    if (!note.ok) return note;
    if (note.note.length === 0) return { ok: false, code: "invalid-input", message: "a todo needs a note" };
    const todo: ReviewTodo = { kind: "todo", id: this.newId("t"), checked: false, note: note.note };
    this.pending.push(todo);
    return this.save(todo.id);
  }

  /** Retry saving the unsaved draft (after a conflict/permission/disk failure was fixed). */
  async save(itemId?: string): Promise<ReviewResult> {
    const disabled = this.disabled();
    if (disabled !== null) return disabled;
    const attach = await this.attach();
    if (!attach.ok) return attach;
    const result = await this.commit("editing");
    if (!result.ok) return result;
    return {
      ...result,
      ...(itemId === undefined ? {} : { itemId }),
      ...(attach.notice === undefined ? {} : { notice: attach.notice })
    };
  }

  /** `R`: move the saved, non-empty editing review to ready and release the lock. */
  async finalize(): Promise<ReviewResult> {
    const disabled = this.disabled();
    if (disabled !== null) return disabled;
    const document = this.attached?.document ?? this.candidate?.document ?? null;
    const check = canFinalize({
      status: document?.frontmatter.status ?? null,
      savedItems: (document?.findings.length ?? 0) + (document?.todos.length ?? 0),
      pendingItems: this.pending.length
    });
    if (!check.ok) return check;
    const attach = await this.attach();
    if (!attach.ok) return attach;
    const result = await this.commit("ready");
    if (!result.ok) return result;
    const attached = this.attached!;
    await releaseLock(this.fs, attached.lock);
    this.finalizedPaths.push(attached.path);
    this.attached = null;
    this.candidate = null;
    return result;
  }

  /** Release the lock; a new review reserved but never committed is removed. */
  async close(): Promise<void> {
    const attached = this.attached;
    this.attached = null;
    if (attached === null) return;
    if (attached.document === null) await this.unreserve(attached);
    else await releaseLock(this.fs, attached.lock);
  }

  private async unreserve(attached: Attached): Promise<void> {
    try {
      if ((await stillHeld(this.fs, attached.lock)) && (await this.fs.readFile(attached.path)) === "")
        await this.fs.unlink(attached.path);
    } catch {
      // Leave the empty reservation; scans ignore it.
    }
    await releaseLock(this.fs, attached.lock);
  }

  private async attach(): Promise<
    { ok: true; notice?: string } | { ok: false; code: ReviewErrorCode; message: string }
  > {
    if (this.attached !== null) return { ok: true };
    if (!this.capability.enabled) return { ok: false, code: "review-disabled", message: "review disabled" };
    const dir = this.capability.dir;
    let notice: string | undefined;
    if (this.candidate !== null) {
      const candidate = this.candidate;
      const lock = await acquireLock(this.fs, this.env, lockPathFor(candidate.path), this.staleMs);
      if (lock.ok) {
        let fresh: string | null = null;
        try {
          fresh = await this.fs.readFile(candidate.path);
        } catch {
          fresh = null;
        }
        if (fresh !== null && sha256(fresh) === candidate.hash) {
          this.attached = { path: candidate.path, lock: lock.lock, document: candidate.document, hash: candidate.hash };
          return { ok: true };
        }
        await releaseLock(this.fs, lock.lock);
        notice = `${path.basename(candidate.path)} changed since it was opened; started a new review`;
      } else if (lock.code === "locked") {
        notice = `${path.basename(candidate.path)} is locked by another session; started a new review`;
      } else {
        return ioError(lock.error, "locking", path.basename(candidate.path));
      }
      this.candidate = null;
    }
    try {
      await this.fs.mkdir(dir);
    } catch (error) {
      return ioError(error, "creating", "the review directory");
    }
    const date = this.env.now().toISOString().slice(0, 10);
    let names: string[];
    try {
      names = await this.fs.readdir(dir);
    } catch (error) {
      return ioError(error, "listing", "the review directory");
    }
    let number = 0;
    for (const name of names) {
      const match = /^(\d{4}-\d{2}-\d{2})-(\d{2,})\.md(?:\.lock)?$/.exec(name);
      if (match !== null && match[1] === date) number = Math.max(number, Number(match[2]));
    }
    for (let attempt = 0; attempt < MAX_NUMBER_ATTEMPTS; attempt += 1) {
      number += 1;
      const file = path.join(dir, `${date}-${String(number).padStart(2, "0")}.md`);
      try {
        await this.fs.createExclusive(file, "");
      } catch (error) {
        if (errorCode(error) === "EEXIST") continue;
        return ioError(error, "reserving", path.basename(file));
      }
      const lock = await acquireLock(this.fs, this.env, lockPathFor(file), this.staleMs);
      if (!lock.ok) {
        try {
          await this.fs.unlink(file);
        } catch {
          // an empty reservation is ignored by scans
        }
        if (lock.code === "locked") continue;
        return ioError(lock.error, "locking", path.basename(file));
      }
      this.attached = { path: file, lock: lock.lock, document: null, hash: sha256("") };
      return notice === undefined ? { ok: true } : { ok: true, notice };
    }
    return { ok: false, code: "io", message: "review not saved: no free review number for today" };
  }

  private async commit(status: "editing" | "ready"): Promise<ReviewResult> {
    const attached = this.attached!;
    const name = path.basename(attached.path);
    if (!(await stillHeld(this.fs, attached.lock))) {
      this.attached = null;
      this.candidate = null;
      return { ok: false, code: "lock-lost", message: `review not saved: lock on ${name} was taken over; draft kept` };
    }
    let current: string;
    try {
      current = await this.fs.readFile(attached.path);
    } catch (error) {
      return ioError(error, "re-reading", name);
    }
    if (sha256(current) !== attached.hash) {
      const header = parseFrontmatter(current);
      const finalized = header.ok && header.value.status !== "editing";
      const detail = finalized ? ` (status is now ${header.value.status})` : "";
      // Detach without touching the file: a retried save starts a new review with the draft.
      await releaseLock(this.fs, attached.lock);
      this.attached = null;
      this.candidate = null;
      return {
        ok: false,
        code: finalized ? "not-editing" : "conflict",
        message: `review not saved: ${name} was changed outside this session${detail}; file and draft kept`
      };
    }
    const now = this.env.now().toISOString();
    const previous = attached.document;
    const findings = [...(previous?.findings ?? []), ...this.pending.filter((item) => item.kind === "finding")];
    const todos = [...(previous?.todos ?? []), ...this.pending.filter((item) => item.kind === "todo")];
    const next: ReviewDocument = {
      frontmatter: {
        reviewVersion: REVIEW_VERSION,
        revision: (previous?.frontmatter.revision ?? 0) + 1,
        status,
        source: previous?.frontmatter.source ?? sanitizeSourceLabel(this.options.sourceLabel, this.sanitize),
        sourceRef: previous?.frontmatter.sourceRef ?? this.sanitizedRef(),
        created: previous?.frontmatter.created ?? now,
        updated: now,
        dialect: this.options.dialect,
        traceTextVersion: this.options.traceTextVersion
      },
      findings: findings as ReviewFinding[],
      todos: todos as ReviewTodo[]
    };
    const text = renderReview(next);
    const temp = path.join(path.dirname(attached.path), `.${name}.${this.env.pid}.${this.env.randomId(4)}.tmp`);
    try {
      await this.fs.writeTemp(temp, text);
      await this.fs.rename(temp, attached.path);
    } catch (error) {
      try {
        await this.fs.unlink(temp);
      } catch {
        // temp never created
      }
      const failure = ioError(error, "writing", name);
      if (previous === null) {
        // Nothing was ever committed: give the number back, keep the draft.
        this.attached = null;
        await this.unreserve(attached);
      }
      return { ...failure, message: `${failure.message}; previous file and draft kept` };
    }
    attached.document = next;
    attached.hash = sha256(text);
    this.lastCommitted = attached.path;
    this.pending = [];
    return { ok: true, path: attached.path, revision: next.frontmatter.revision, status };
  }

  private sanitizedRef(): ReviewSourceRef | null {
    const ref = this.options.sourceRef;
    if (ref === null) return null;
    return {
      projectId: sanitizeLine(ref.projectId, this.sanitize),
      datasetId: sanitizeLine(ref.datasetId, this.sanitize),
      sourceRevision: sanitizeLine(ref.sourceRevision, this.sanitize)
    };
  }
}

/** Open a review session: read-only scan for diagnostics and the resume candidate. */
export async function openReviewSession(options: ReviewSessionOptions): Promise<ReviewSession> {
  const session = new ReviewSession(options);
  await session.scan();
  return session;
}
