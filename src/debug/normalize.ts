import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isLocalHostname } from "./loopback.js";

export type NormalizedSource = {
  readonly absolute: string | null;
  readonly relative: string | null;
  readonly layer: string | null;
  readonly ignored: boolean;
};

const IGNORED: NormalizedSource = { absolute: null, relative: null, layer: null, ignored: true };

/** Never throws: `sources` come from untrusted maps, and one bad entry must not abort a resolve pass. */
export function normalizeSource(source: string, base: string | null): NormalizedSource {
  try {
    return normalizeUnsafe(source, base);
  } catch {
    return IGNORED;
  }
}

function normalizeUnsafe(source: string, base: string | null): NormalizedSource {
  let text = source;
  if (!hasScheme(text) && !isAbsolutePath(text) && base !== null && base !== "") {
    if (isAbsolutePath(base) && !base.includes("://")) text = path.resolve(path.dirname(base), text);
    else {
      try {
        text = new URL(text, base).toString();
      } catch {
        text = path.posix.resolve(path.posix.dirname(base), text);
      }
    }
  }
  if (text.startsWith("webpack-internal://")) {
    const body = text.slice("webpack-internal://".length);
    const layer = /^\/\(([^)]+)\)\/(?:\.\/)?(.*)$/.exec(body);
    if (layer !== null) return { absolute: null, relative: decode(layer[2]!), layer: layer[1]!, ignored: false };
    const dotted = /^\/\.\/(.*)$/.exec(body);
    if (dotted !== null) return { absolute: null, relative: decode(dotted[1]!), layer: null, ignored: false };
    const abs = /^\/([^.(].*)$/.exec(body);
    if (abs !== null) return { absolute: `/${decode(abs[1]!)}`, relative: null, layer: null, ignored: false };
    return IGNORED;
  }
  if (text.startsWith("webpack://")) {
    const body = text.slice("webpack://".length).replace(/^\//, "");
    if (body.startsWith("./")) return { absolute: null, relative: decode(body.slice(2)), layer: null, ignored: false };
    const slash = body.indexOf("/");
    const rel = slash >= 0 ? body.slice(slash + 1).replace(/^\.\//, "") : body;
    return { absolute: null, relative: decode(rel), layer: null, ignored: false };
  }
  const turbopack = /^turbopack:\/{2,3}\[(project|turbopack)\]\/(.*)$/.exec(text);
  if (turbopack !== null) {
    if (turbopack[1] === "turbopack") return IGNORED;
    return { absolute: null, relative: decode(turbopack[2]!), layer: null, ignored: false };
  }
  if (text.startsWith("file://")) {
    const abs = fileUrlToPath(stripFragment(text));
    return abs === null ? IGNORED : { absolute: abs, relative: null, layer: null, ignored: false };
  }
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      if (!isLocalHostname(url.hostname)) return IGNORED;
      if (url.pathname.startsWith("/@fs/")) {
        return { absolute: decode(url.pathname.slice(4)), relative: null, layer: null, ignored: false };
      }
      const rel = decode(url.pathname.replace(/^\//, ""));
      return { absolute: null, relative: rel, layer: null, ignored: false };
    } catch {
      return IGNORED;
    }
  }
  if (hasScheme(text)) return IGNORED;
  // Bare paths are file names: `?`/`#` are ordinary characters there and nothing is percent-encoded.
  if (isAbsolutePath(text)) return { absolute: text, relative: null, layer: null, ignored: false };
  return { absolute: null, relative: text.replace(/^\.\//, ""), layer: null, ignored: false };
}

export function sourcesMatch(
  file: string,
  normalized: NormalizedSource,
  root: string,
  caseInsensitive: boolean
): boolean {
  if (normalized.ignored) return false;
  const eq = (left: string, right: string): boolean =>
    caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right;
  if (normalized.absolute !== null) {
    const resolved = path.resolve(root, file);
    if (eq(normalized.absolute, resolved)) return true;
    // Next writes the path it was launched with, possibly through a symlink (spec 9.4 step 4).
    try {
      return eq(realpathSync.native(normalized.absolute), realpathSync.native(resolved));
    } catch {
      return false;
    }
  }
  if (normalized.relative === null) return false;
  if (eq(normalized.relative, file)) return true;
  return `/${normalized.relative}`.endsWith(`/${file}`);
}

/** A Windows drive (`C:/x`) is a path, not a `c:` scheme. */
function hasScheme(text: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[a-z]:[\\/]/i.test(text);
}

function isAbsolutePath(text: string): boolean {
  return text.startsWith("/") || /^[a-z]:[\\/]/i.test(text) || text.startsWith("\\\\");
}

function stripFragment(text: string): string {
  const q = text.search(/[?#]/);
  return q >= 0 ? text.slice(0, q) : text;
}

/** Decodes once; a malformed escape leaves the text as written. */
function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function fileUrlToPath(url: string): string | null {
  try {
    return fileURLToPath(url);
  } catch {
    return null;
  }
}
