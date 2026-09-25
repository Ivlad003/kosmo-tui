/**
 * Byte-level line splitter for NDJSON (spec 4.5).
 *
 * Lines are split on the byte 0x0A BEFORE any UTF-8 decoding. 0x0A never occurs inside a
 * multi-byte UTF-8 sequence, so a character split across two chunks is always joined
 * again before it is decoded, and each complete line is decoded once, strictly.
 *  - A UTF-8 BOM at the very start of the stream is dropped, even when it is split
 *    across chunks. A U+FEFF anywhere else is kept (and then fails JSON.parse).
 *  - "\r\n" is accepted: one trailing CR is dropped from each line.
 *  - Each line is capped at `maxLineBytes` BEFORE parsing and without buffering more
 *    than the cap: as soon as a line is longer, a "too-long" event is emitted and the
 *    rest of that line is skipped up to its "\n".
 *  - Line numbers are 1-based and count every line, blank ones included.
 *  - `end()` emits the last line when the input does not end with "\n".
 */
import { concatBytes } from "./common.js";

export type LineEvent =
  | { readonly kind: "line"; readonly n: number; readonly text: string }
  | { readonly kind: "too-long"; readonly n: number }
  | { readonly kind: "invalid-utf8"; readonly n: number };

const BOM = [0xef, 0xbb, 0xbf] as const;

export class LineSplitter {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  private parts: Uint8Array[] = [];
  private length = 0;
  private skipping = false;
  private n = 1;
  private probe: number[] | null = [];

  constructor(private readonly maxLineBytes: number) {}

  push(chunk: Uint8Array): LineEvent[] {
    const events: LineEvent[] = [];
    let data = chunk;
    if (this.probe !== null) {
      let used = 0;
      while (this.probe !== null && used < data.length) {
        const byte = data[used]!;
        if (byte === BOM[this.probe.length]) {
          this.probe.push(byte);
          used += 1;
          if (this.probe.length === BOM.length) this.probe = null;
        } else {
          const held = Uint8Array.from(this.probe);
          this.probe = null;
          this.feed(held, events);
        }
      }
      data = data.subarray(used);
    }
    this.feed(data, events);
    return events;
  }

  end(): LineEvent[] {
    const events: LineEvent[] = [];
    if (this.probe !== null && this.probe.length > 0) {
      const held = Uint8Array.from(this.probe);
      this.probe = null;
      this.feed(held, events);
    }
    this.probe = null;
    if (this.length > 0 && !this.skipping) this.finish(events);
    this.reset();
    return events;
  }

  private feed(data: Uint8Array, events: LineEvent[]): void {
    let start = 0;
    while (start < data.length) {
      const newline = data.indexOf(0x0a, start);
      const end = newline === -1 ? data.length : newline;
      this.append(data.subarray(start, end), events);
      if (newline === -1) return;
      if (this.skipping) this.reset();
      else this.finish(events);
      this.n += 1;
      start = newline + 1;
    }
  }

  private append(bytes: Uint8Array, events: LineEvent[]): void {
    if (this.skipping || bytes.length === 0) return;
    // One extra byte is allowed for a CR that "\n" may still turn into a line end.
    if (this.length + bytes.length > this.maxLineBytes + 1) {
      events.push({ kind: "too-long", n: this.n });
      this.parts = [];
      this.length = 0;
      this.skipping = true;
      return;
    }
    this.parts.push(bytes.slice());
    this.length += bytes.length;
  }

  private finish(events: LineEvent[]): void {
    let line = concatBytes(this.parts, this.length);
    this.reset();
    if (line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
    if (line.length > this.maxLineBytes) {
      events.push({ kind: "too-long", n: this.n });
      return;
    }
    let text: string;
    try {
      text = this.decoder.decode(line);
    } catch {
      events.push({ kind: "invalid-utf8", n: this.n });
      return;
    }
    events.push({ kind: "line", n: this.n, text });
  }

  private reset(): void {
    this.parts = [];
    this.length = 0;
    this.skipping = false;
  }
}
