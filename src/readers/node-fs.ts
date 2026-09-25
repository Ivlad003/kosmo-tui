/**
 * The production ReaderFs over node:fs/promises. This is the only module of the reader
 * layer that touches the file system; everything else receives a ReaderFs port.
 * Files are only ever opened for reading ("r").
 */
import { open, stat } from "node:fs/promises";
import { FileTooLargeError, concatBytes } from "./common.js";
import type { ReaderFs } from "./types.js";

const CHUNK_BYTES = 64 * 1024;

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function* readChunks(path: string): AsyncGenerator<Uint8Array> {
  const handle = await open(path, "r");
  try {
    for (;;) {
      const buffer = new Uint8Array(CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) return;
      yield bytesRead === CHUNK_BYTES ? buffer : buffer.slice(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}

export const nodeReaderFs: ReaderFs = {
  async stat(path) {
    try {
      const info = await stat(path);
      return { size: info.size, isFile: info.isFile(), isDirectory: info.isDirectory() };
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  },

  async readHead(path, bytes) {
    const handle = await open(path, "r");
    try {
      const buffer = new Uint8Array(bytes);
      let filled = 0;
      while (filled < bytes) {
        const { bytesRead } = await handle.read(buffer, filled, bytes - filled, null);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return filled === bytes ? buffer : buffer.slice(0, filled);
    } finally {
      await handle.close();
    }
  },

  async readFile(path, maxBytes) {
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of readChunks(path)) {
      total += chunk.length;
      if (total > maxBytes) throw new FileTooLargeError(path, maxBytes);
      parts.push(chunk);
    }
    return concatBytes(parts, total);
  },

  createReadStream(path) {
    return readChunks(path);
  }
};
