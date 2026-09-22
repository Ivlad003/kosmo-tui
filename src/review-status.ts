/**
 * Review status machine (spec debug-review "Однозначний lifecycle статусів").
 *
 *   editing ──R (saved, non-empty, no unsaved draft)──▶ ready
 *   ready/partial/done: owned by the external writer, never rewritten by kosmo-tui
 *
 * Exact rule for an external writer that ticks checkboxes (counted over top-level
 * `- [ ]`/`- [x]` items of `## Findings` and `## Todos` only; lines inside fenced
 * blocks — the evidence — never count):
 *
 *   checked = 0                  → ready
 *   0 < checked < total          → partial
 *   checked = total and total > 0 → done
 *
 * A finalized file whose status disagrees with its counts gets a `status-mismatch`
 * diagnostic; kosmo-tui reports it and leaves the file alone.
 */

import { splitFrontmatter, type ReviewStatus } from "./review-format.js";

export type CheckboxCounts = { total: number; checked: number };

export type StatusDiagnostic = {
  code: "status-mismatch";
  status: ReviewStatus;
  expected: Exclude<ReviewStatus, "editing">;
  counts: CheckboxCounts;
  message: string;
};

const TOP_LEVEL_CHECKBOX = /^[-*+] \[( |x|X)\]/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Count top-level checkbox items of the Findings/Todos sections, outside fences. */
export function countCheckboxes(text: string): CheckboxCounts {
  const lines = splitFrontmatter(text)?.body ?? text.replace(/\r\n/g, "\n").split("\n");
  let fence: { char: string; length: number } | null = null;
  let inItems = false;
  let total = 0;
  let checked = 0;
  for (const raw of lines) {
    const marker = FENCE.exec(raw);
    if (fence !== null) {
      const run = marker?.[1];
      if (run !== undefined && run[0] === fence.char && run.length >= fence.length && raw.trim() === run) fence = null;
      continue;
    }
    if (marker !== null) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
      continue;
    }
    if (/^#{1,6} /.test(raw)) {
      inItems = /^## (Findings|Todos)\s*$/.test(raw);
      continue;
    }
    const box = inItems ? TOP_LEVEL_CHECKBOX.exec(raw) : null;
    if (box === null) continue;
    total += 1;
    if (box[1] !== " ") checked += 1;
  }
  return { total, checked };
}

/** The status an external writer must set for these counts. */
export function expectedStatus(counts: CheckboxCounts): Exclude<ReviewStatus, "editing"> {
  if (counts.checked === 0) return "ready";
  return counts.checked >= counts.total ? "done" : "partial";
}

/** Diagnostic for a finalized review whose status disagrees with its checkboxes; null otherwise. */
export function diagnoseStatus(status: ReviewStatus, counts: CheckboxCounts): StatusDiagnostic | null {
  if (status === "editing") return null;
  const expected = expectedStatus(counts);
  if (expected === status) return null;
  return {
    code: "status-mismatch",
    status,
    expected,
    counts,
    message: `status ${status} does not match ${counts.checked}/${counts.total} checked items (expected ${expected}); kosmo-tui does not change finalized reviews`
  };
}

export type FinalizeCheck =
  { ok: true } | { ok: false; code: "not-editing" | "empty-review" | "unsaved-draft"; message: string };

/** Whether `R` may move this review to ready. It never finalizes an empty or unsaved draft. */
export function canFinalize(input: {
  status: ReviewStatus | null;
  savedItems: number;
  pendingItems: number;
}): FinalizeCheck {
  if (input.status !== null && input.status !== "editing")
    return {
      ok: false,
      code: "not-editing",
      message: `review is ${input.status}; only an editing review can be finalized`
    };
  if (input.pendingItems > 0)
    return {
      ok: false,
      code: "unsaved-draft",
      message: `${input.pendingItems} unsaved item(s); save the draft before finalizing`
    };
  if (input.savedItems === 0)
    return { ok: false, code: "empty-review", message: "nothing to finalize: add a finding (f) or todo (t) first" };
  return { ok: true };
}
