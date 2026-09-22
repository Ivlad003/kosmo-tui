/**
 * Session bookmarks (`m` marks, `'` opens the jump list; design D6).
 *
 * Keyed by the full span ref, so a bookmark in one session never resolves to the span
 * with the same traceId/spanId in another. Bookmarks outlive the rows they point at:
 * after retention or cache eviction they stay in the list as placeholders with the
 * reason, and jumping to one pins the selection on that ref rather than on a neighbour.
 * The list is bounded; marking past the cap drops the oldest bookmark.
 */

import { spanKey, spanRefOf, traceKey, type SpanRef, type SpanRow, type TraceRow } from "./view-state.js";

export const BOOKMARK_CAP = 64;

export type Bookmark = {
  ref: SpanRef;
  /** Node id at the time of marking, so a placeholder can still say what it was. */
  nodeId: string;
};

export type ResolvedBookmark =
  | { bookmark: Bookmark; state: "loaded"; row: SpanRow }
  | { bookmark: Bookmark; state: "placeholder"; reason: "retention" | "evicted" };

export function isBookmarked(bookmarks: readonly Bookmark[], ref: SpanRef): boolean {
  const key = spanKey(ref);
  return bookmarks.some((bookmark) => spanKey(bookmark.ref) === key);
}

/** `m`: mark the span, or unmark it when it is already marked. */
export function toggleBookmark(bookmarks: readonly Bookmark[], row: SpanRow, cap = BOOKMARK_CAP): Bookmark[] {
  const key = spanKey(row);
  if (bookmarks.some((bookmark) => spanKey(bookmark.ref) === key)) {
    return bookmarks.filter((bookmark) => spanKey(bookmark.ref) !== key);
  }
  const next = [...bookmarks, { ref: spanRefOf(row), nodeId: row.nodeId }];
  return next.slice(Math.max(0, next.length - Math.max(1, cap)));
}

/**
 * Resolve every bookmark against what is loaded now. A span whose trace is gone aged
 * out of retention; a span whose trace is still loaded but whose row is not was evicted.
 */
export function resolveBookmarks(
  bookmarks: readonly Bookmark[],
  spans: readonly SpanRow[],
  traces: readonly TraceRow[]
): ResolvedBookmark[] {
  const rows = new Map(spans.map((row) => [spanKey(row), row]));
  const loadedTraces = new Set(traces.map(traceKey));
  return bookmarks.map((bookmark) => {
    const row = rows.get(spanKey(bookmark.ref));
    if (row) return { bookmark, state: "loaded", row };
    return {
      bookmark,
      state: "placeholder",
      reason: loadedTraces.has(traceKey(bookmark.ref)) ? "evicted" : "retention"
    };
  });
}
