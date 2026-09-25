/**
 * Fakes for reader tests: an in-memory ReaderFs that records every call, and chunk
 * streams (finite, split at chosen byte offsets, failing, or never ending).
 */
import { FileTooLargeError } from "../../src/readers/common.js";
import type { ReaderFs } from "../../src/readers/types.js";

const encoder = new TextEncoder();

export function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

export type MemoryFs = ReaderFs & {
  calls: string[];
  files: Map<string, Uint8Array | null>;
  /** Pretend a file has this size (sparse, never allocated). */
  sizes: Map<string, number>;
};

/** Paths are used as given; `null` content is a directory. */
export function memoryFs(files: Record<string, string | Uint8Array | null> = {}): MemoryFs {
  const table = new Map<string, Uint8Array | null>(
    Object.entries(files).map(([name, content]) => [name, typeof content === "string" ? bytes(content) : content])
  );
  const sizes = new Map<string, number>();
  const calls: string[] = [];
  const content = (path: string): Uint8Array => {
    const value = table.get(path);
    if (value === undefined || value === null)
      throw Object.assign(new Error(`no such file ${path}`), { code: "ENOENT" });
    return value;
  };
  return {
    calls,
    files: table,
    sizes,
    async stat(path) {
      calls.push(`stat ${path}`);
      if (!table.has(path)) return undefined;
      const value = table.get(path) ?? null;
      return { size: sizes.get(path) ?? value?.length ?? 0, isFile: value !== null, isDirectory: value === null };
    },
    async readHead(path, count) {
      calls.push(`readHead ${path} ${count}`);
      return content(path).slice(0, count);
    },
    async readFile(path, maxBytes) {
      calls.push(`readFile ${path}`);
      const value = content(path);
      if ((sizes.get(path) ?? value.length) > maxBytes) throw new FileTooLargeError(path, maxBytes);
      return value.slice();
    },
    createReadStream(path) {
      calls.push(`createReadStream ${path}`);
      return chunks([content(path)]);
    }
  };
}

/** Yield the given parts as separate chunks. */
export async function* chunks(parts: readonly (string | Uint8Array)[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield typeof part === "string" ? bytes(part) : part;
}

/** Split one byte buffer into chunks at the given offsets (e.g. inside a UTF-8 sequence). */
export function splitAt(data: Uint8Array, offsets: readonly number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = 0;
  for (const offset of [...offsets, data.length]) {
    out.push(data.slice(start, offset));
    start = offset;
  }
  return out;
}

/** Yields the parts, then throws: a source that fails mid-stream. */
export async function* failing(parts: readonly string[], message: string): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield bytes(part);
  throw Object.assign(new Error(message), { code: "EIO" });
}

/** Yields the parts and then never yields or ends, like a producer that keeps stdin open. */
export function neverEnding(parts: readonly string[]): AsyncIterable<Uint8Array> & { returned: boolean } {
  const state = { returned: false };
  const iterable = {
    get returned() {
      return state.returned;
    },
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      let index = 0;
      return {
        next() {
          const part = parts[index];
          index += 1;
          if (part !== undefined) return Promise.resolve({ done: false, value: bytes(part) });
          return new Promise<IteratorResult<Uint8Array>>(() => undefined);
        },
        return() {
          state.returned = true;
          return Promise.resolve({ done: true, value: undefined });
        }
      };
    }
  };
  return iterable;
}

export function signal(): AbortSignal {
  return new AbortController().signal;
}
