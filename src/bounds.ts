/**
 * Byte bounds for what the viewer keeps beyond the model. Pure: no I/O.
 *
 *  - `jsonBytes` and `CACHE_MAX_BYTES` bound the view state's caches of lazy SQLite values
 *    and code snippets (src/ui/state.ts, task 14): the oldest entries are evicted first, the
 *    selected span's never, and an evicted entry is simply loaded again when selected.
 *  - `ByteLru` is the source-map cache of stage 2 (spec 9.4): 64 MiB by default, it evicts
 *    least recently used entries and names every evicted key, so the caller can show an
 *    explicit marker instead of silently losing data.
 *
 * Byte sizes are the UTF-8 length of the JSON encoding: a stable, cheap upper-bound proxy
 * for what a value costs, not a heap measurement.
 */

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
