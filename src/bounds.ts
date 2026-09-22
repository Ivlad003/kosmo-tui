/**
 * Finite caps for everything the interactive session keeps (design D9, task 7.6).
 *
 * Two containers, both bounded by count or bytes, and both reporting what they dropped
 * so the view can show an explicit gap/truncated marker instead of silently losing data:
 *
 *  - `BoundedQueue`: the live frame queue (deltas parked while paused or replaying),
 *    at most 1,000 frames and 8 MiB. A frame that does not fit is refused, never
 *    squeezed in by dropping an older one: a queue with a hole in the middle cannot be
 *    replayed, so overflow means "reload a baseline", which the caller does.
 *  - `ByteLru`: cache/staging (rows, details, replay records), 64 MiB in total by
 *    default, evicting least recently used entries and naming every evicted key.
 *
 * Byte sizes are the UTF-8 length of the JSON encoding: a stable, cheap upper-bound
 * proxy for what a value costs, not a heap measurement.
 */

export const FRAME_QUEUE_MAX_FRAMES = 1_000;
export const FRAME_QUEUE_MAX_BYTES = 8 * 1024 * 1024;
export const CACHE_MAX_BYTES = 64 * 1024 * 1024;

/** UTF-8 bytes of the JSON encoding; unserialisable values count as their String(). */
export function jsonBytes(value: unknown): number {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    text = undefined;
  }
  return Buffer.byteLength(text ?? String(value), "utf8");
}

export type QueueLimits = { maxItems: number; maxBytes: number };

export class BoundedQueue<T> {
  private items: Array<{ value: T; bytes: number }> = [];
  private used = 0;
  private refused = 0;

  constructor(readonly limits: QueueLimits = { maxItems: FRAME_QUEUE_MAX_FRAMES, maxBytes: FRAME_QUEUE_MAX_BYTES }) {}

  /** False when the item would exceed either bound; the item is then not stored. */
  push(value: T, bytes = jsonBytes(value)): boolean {
    if (this.items.length + 1 > this.limits.maxItems || this.used + bytes > this.limits.maxBytes) {
      this.refused += 1;
      return false;
    }
    this.items.push({ value, bytes });
    this.used += bytes;
    return true;
  }

  /** Remove and return everything, oldest first. Overflow state is kept until `reset`. */
  drain(): T[] {
    const values = this.items.map((item) => item.value);
    this.items = [];
    this.used = 0;
    return values;
  }

  /** Forget contents and overflow alike (a new baseline replaced them). */
  reset(): void {
    this.drain();
    this.refused = 0;
  }

  get size(): number {
    return this.items.length;
  }

  get bytes(): number {
    return this.used;
  }

  /** Frames refused since the last reset; > 0 means the queue has a gap. */
  get overflowed(): number {
    return this.refused;
  }
}

/**
 * Least-recently-used map with a byte budget. `set` returns the keys it evicted (the
 * new entry itself when it alone is larger than the budget), so callers can turn every
 * eviction into a visible marker.
 */
export class ByteLru<K, V> {
  private entries = new Map<K, { value: V; bytes: number }>();
  private used = 0;

  constructor(readonly maxBytes: number = CACHE_MAX_BYTES) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    // Refresh recency: Map iteration order is insertion order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  set(key: K, value: V, bytes = jsonBytes(value)): K[] {
    this.delete(key);
    if (bytes > this.maxBytes) return [key];
    this.entries.set(key, { value, bytes });
    this.used += bytes;
    const evicted: K[] = [];
    for (const [oldest, entry] of this.entries) {
      if (this.used <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.used -= entry.bytes;
      evicted.push(oldest);
    }
    return evicted;
  }

  delete(key: K): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    this.entries.delete(key);
    this.used -= entry.bytes;
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.used = 0;
  }

  keys(): K[] {
    return [...this.entries.keys()];
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.used;
  }
}
