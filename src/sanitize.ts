/**
 * Terminal safety for every string that comes from data (spec 8.1).
 *
 * `escapeTerminalControls` turns each control character into visible `\uXXXX` text (lowercase hex):
 * C0 (U+0000–U+001F), DEL (U+007F), C1 (U+0080–U+009F, including CSI U+009B) and the bidi controls
 * U+202A–U+202E and U+2066–U+2069. With `multiline: true` only `\n` survives, for multi-line blocks (code
 * window, expanded values). `\t` is always escaped: the code window expands tabs to spaces before calling
 * this, every other place shows a tab as `\u0009`. The output contains no control character, so escaping
 * twice gives the same result.
 *
 * `isSafeOsc8Uri` is the only gate for OSC 8 hyperlinks (spec 6.4, 8.2): a `file:///` URI made of RFC 3986
 * path characters only (so `?`, `#`, spaces and raw non-ASCII must be percent-encoded, see `toFileUri`),
 * whose decoded path has no control/bidi character, no `.`/`..`/empty segment, and lies inside `root`.
 */

const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const CONTROLS_KEEP_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const HAS_CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const FILE_URI = /^file:\/\/\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/;

function hex4(char: string): string {
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

/** Replace C0 (except `\n` when `multiline`), DEL, C1 and bidi controls with visible `\uXXXX` text. */
export function escapeTerminalControls(text: string, options: { multiline?: boolean } = {}): string {
  return text.replace(options.multiline === true ? CONTROLS_KEEP_NEWLINE : CONTROLS, hex4);
}

/** `file://` URI of an absolute POSIX path: every byte outside RFC 3986 unreserved characters and `/` is %-encoded. */
export function toFileUri(absolutePath: string): string {
  let out = "file://";
  for (const byte of new TextEncoder().encode(absolutePath)) {
    const char = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-._~/]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** True only for a `file:///` URI whose decoded path is a clean absolute path inside `root`. */
export function isSafeOsc8Uri(uri: string, root: string): boolean {
  if (!FILE_URI.test(uri)) return false;
  if (!root.startsWith("/") || HAS_CONTROL.test(root)) return false;
  let path: string;
  try {
    path = decodeURIComponent(uri.slice("file://".length));
  } catch {
    return false;
  }
  if (HAS_CONTROL.test(path) || path.includes("\\")) return false;
  const segments = path.split("/").slice(1);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  const base = root.replace(/\/+$/, "");
  if (base === "") return true;
  return path === base || path.startsWith(`${base}/`);
}
