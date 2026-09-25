/**
 * UTF-8 byte arithmetic without encoding (spec 4.3 «побайтово UTF-8», 4.9 byte limits).
 *
 * A lone surrogate counts and compares as U+FFFD, exactly as `TextEncoder` would encode it, so every
 * function here agrees with `Buffer.byteLength` / `Buffer.compare` on the UTF-8 encoding.
 * `validate.ts` re-exports `utf8Bytes` and `compareBytes`; `model.ts` and `value.ts` import them from here
 * so that neither depends on the validator.
 */

/** Code point at `index` and how many UTF-16 units it takes; a lone surrogate reads as U+FFFD. */
function codePointAt(text: string, index: number): [number, number] {
  const unit = text.charCodeAt(index);
  if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
    const next = text.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return [(unit - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000, 2];
  }
  if (unit >= 0xd800 && unit <= 0xdfff) return [0xfffd, 1];
  return [unit, 1];
}

function codePointBytes(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** Length of `text` in UTF-8 bytes. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length;) {
    const [codePoint, width] = codePointAt(text, index);
    bytes += codePointBytes(codePoint);
    index += width;
  }
  return bytes;
}

/** Byte-wise comparison of the UTF-8 encodings of `a` and `b` (equals code point order). */
export function compareBytes(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const [ca, wa] = codePointAt(a, i);
    const [cb, wb] = codePointAt(b, j);
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += wa;
    j += wb;
  }
  const aLeft = i < a.length;
  const bLeft = j < b.length;
  if (aLeft === bLeft) return 0;
  return aLeft ? 1 : -1;
}

/** Longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`; a surrogate pair is never split. */
export function utf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const [codePoint, width] = codePointAt(text, index);
    const size = codePointBytes(codePoint);
    if (bytes + size > maxBytes) break;
    bytes += size;
    index += width;
  }
  return text.slice(0, index);
}
