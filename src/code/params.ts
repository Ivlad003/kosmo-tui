const RESERVED = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield"
]);

/** Names that are followed by `(...) {` without being a function header. */
const CONTROL = new Set(["if", "for", "while", "switch", "catch", "with", "return", "await", "typeof", "yield", "new"]);

/** TS parameter-property modifiers: `constructor(private readonly repo: Repo)` binds `repo`. */
const MODIFIERS = new Set(["public", "private", "protected", "readonly", "override"]);

const IDENT = /^[A-Za-z_$][\w$]*$/;
const IDENT_CHAR = /[\w$]/;
const IDENT_START = /[A-Za-z_$]/;
const WINDOW_ABOVE = 8;
const WINDOW_BELOW = 40;
const TEXT_MAX = 64 * 1024;
/** Longest parameter list or return type the scanner follows; keeps the scan linear on odd input. */
const SPAN_MAX = 4096;

export function isCaptureName(name: string): boolean {
  if (name === "this") return true;
  if (name === "__proto__") return false;
  return IDENT.test(name) && !RESERVED.has(name);
}

type Header = {
  readonly start: number;
  readonly open: number;
  readonly close: number;
  readonly bodyAt: number;
  readonly params: string;
};

/**
 * Parameter names of the function whose header covers `line` (1-based) in `source`. Bounded linear
 * scan over a window around the line; no regex over unbounded text. Empty when no header is found.
 */
export function parameterNames(source: string, line: number): string[] {
  const lines = source.split(/\r?\n/);
  const index = Math.min(Math.max(line, 1), lines.length) - 1;
  const from = Math.max(0, index - WINDOW_ABOVE);
  const to = Math.min(lines.length, index + WINDOW_BELOW + 1);
  const text = lines.slice(from, to).join("\n").slice(0, TEXT_MAX);
  let targetStart = 0;
  for (let at = from; at < index; at += 1) targetStart += lines[at]!.length + 1;
  const targetEnd = targetStart + (lines[index]?.length ?? 0);
  const header = pickHeader(findHeaders(text), targetStart, targetEnd);
  if (header === null) return [];
  const names: string[] = [];
  collectLeaves(header.params, names, 0);
  return names.filter((name, at) => isCaptureName(name) && names.indexOf(name) === at);
}

/**
 * True when a function header starts on `line` (1-based): only then is "after the body opener" a
 * meaningful anchor; a plain statement keeps its own line (spec 9.5 step 2).
 */
export function isFunctionHeaderLine(source: string, line: number): boolean {
  const lines = source.split(/\r?\n/);
  const index = Math.min(Math.max(line, 1), lines.length) - 1;
  const to = Math.min(lines.length, index + WINDOW_BELOW + 1);
  const text = lines.slice(index, to).join("\n").slice(0, TEXT_MAX);
  const targetEnd = lines[index]?.length ?? 0;
  return findHeaders(text).some((header) => header.start <= targetEnd && header.bodyAt >= header.start);
}

function pickHeader(all: readonly Header[], targetStart: number, targetEnd: number): Header | null {
  // A header whose start lies inside another header's parameter list is a callback type or default
  // value (`cb: (v: T) => void`), not the function at this line.
  const headers = all.filter((header) => !all.some((outer) => header.start > outer.open && header.start < outer.close));
  let best: Header | null = null;
  for (const header of headers) {
    if (header.start <= targetEnd && header.bodyAt >= targetStart) {
      if (best === null || header.start > best.start) best = header;
    }
  }
  if (best !== null) return best;
  for (const header of headers) {
    const distance = Math.abs(header.start - targetStart);
    if (best === null || distance < Math.abs(best.start - targetStart)) best = header;
  }
  return best;
}

function findHeaders(text: string): Header[] {
  const out: Header[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "(") {
      const header = parenHeader(text, i);
      if (header !== null) out.push(header);
    } else if (ch === "=" && text[i + 1] === ">") {
      const header = bareArrowHeader(text, i);
      if (header !== null) out.push(header);
    }
  }
  return out;
}

function parenHeader(text: string, open: number): Header | null {
  const close = matchForward(text, open, "(", ")");
  if (close < 0) return null;
  let after = skipWs(text, close + 1);
  if (text[after] === ":") after = skipWs(text, skipTypeAnnotation(text, after + 1));
  const isArrow = text[after] === "=" && text[after + 1] === ">";
  const isBlock = text[after] === "{";
  if (!isArrow && !isBlock) return null;
  let before = skipWsBack(text, open - 1);
  if (text[before] === ">") {
    const lt = matchBackward(text, before, "<", ">");
    if (lt < 0) return null;
    before = skipWsBack(text, lt - 1);
  }
  const ident = identBack(text, before);
  const params = text.slice(open + 1, close);
  const header = (start: number): Header => ({ start, open, close, bodyAt: after, params });
  if (isArrow) return header(ident?.name === "async" ? ident.start : open);
  if (ident === null || CONTROL.has(ident.name)) return null;
  if (ident.name === "function") return header(ident.start);
  const prev = skipWsBack(text, ident.start - 1);
  const keyword = identBack(text, prev);
  if (keyword?.name === "function") return header(keyword.start);
  if (text[prev] === "." || text[prev] === "=") return null;
  return header(ident.start);
}

function bareArrowHeader(text: string, arrowAt: number): Header | null {
  const before = skipWsBack(text, arrowAt - 1);
  if (before < 0 || !IDENT_CHAR.test(text[before]!)) return null;
  const ident = identBack(text, before);
  if (ident === null || RESERVED.has(ident.name)) return null;
  const prev = skipWsBack(text, ident.start - 1);
  const keyword = identBack(text, prev);
  const start = keyword?.name === "async" ? keyword.start : ident.start;
  return { start, open: ident.start, close: ident.start, bodyAt: arrowAt, params: ident.name };
}

function skipTypeAnnotation(text: string, at: number): number {
  let depth = 0;
  let sawToken = false;
  const limit = Math.min(text.length, at + SPAN_MAX);
  for (let i = skipWs(text, at); i < limit; i += 1) {
    const c = text[i]!;
    if (depth === 0 && sawToken) {
      if (c === "{" || c === "," || c === ")" || c === ";") return i;
      if (c === "=" && text[i + 1] === ">") return i;
    }
    if (c === "<" || c === "(" || c === "[" || c === "{") {
      depth += 1;
      sawToken = true;
    } else if (c === ">" || c === ")" || c === "]" || c === "}") {
      if (depth === 0) return i;
      depth -= 1;
    } else if (!isWs(c)) {
      sawToken = true;
    }
  }
  return text.length;
}

function matchForward(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  const limit = Math.min(text.length, start + SPAN_MAX);
  for (let i = start; i < limit; i += 1) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(text, i);
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function matchBackward(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i >= 0; i -= 1) {
    const c = text[i]!;
    if (c === close) depth += 1;
    else if (c === open) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipString(text: string, at: number): number {
  const quote = text[at]!;
  for (let i = at + 1; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === quote) return i;
    if (quote !== "`" && text[i] === "\n") return i;
  }
  return text.length;
}

function isWs(c: string): boolean {
  return c === " " || c === "\n" || c === "\t" || c === "\r";
}

function skipWs(text: string, at: number): number {
  let i = at;
  while (i < text.length && isWs(text[i]!)) i += 1;
  return i;
}

function skipWsBack(text: string, at: number): number {
  let i = at;
  while (i >= 0 && isWs(text[i]!)) i -= 1;
  return i;
}

function identBack(text: string, end: number): { name: string; start: number } | null {
  if (end < 0 || !IDENT_CHAR.test(text[end]!)) return null;
  let start = end;
  while (start > 0 && IDENT_CHAR.test(text[start - 1]!)) start -= 1;
  if (!IDENT_START.test(text[start]!)) return null;
  return { name: text.slice(start, end + 1), start };
}

function collectLeaves(params: string, out: string[], depthGuard: number): void {
  if (depthGuard > 8) return;
  let i = 0;
  const skip = (): void => {
    while (i < params.length) {
      const ch = params[i]!;
      if (isWs(ch) || ch === ",") {
        i += 1;
        continue;
      }
      break;
    }
  };
  const skipType = (): void => {
    if (params[i] !== ":") return;
    i += 1;
    let depth = 0;
    while (i < params.length) {
      const c = params[i]!;
      if (c === "=" && params[i + 1] === ">") {
        i += 2;
        continue;
      }
      if (c === "(" || c === "<" || c === "[" || c === "{") depth += 1;
      else if (c === ")" || c === ">" || c === "]" || c === "}") {
        if (depth === 0) return;
        depth -= 1;
      } else if ((c === "," || c === "=") && depth === 0) return;
      i += 1;
    }
  };
  const skipValue = (): void => {
    let depth = 0;
    while (i < params.length) {
      const c = params[i]!;
      if (c === "(" || c === "[" || c === "{") depth += 1;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) return;
        depth -= 1;
      } else if (c === "," && depth === 0) return;
      i += 1;
    }
  };
  while (i < params.length) {
    const before = i;
    skip();
    if (i >= params.length) break;
    const ch = params[i]!;
    if (ch === ")" || ch === "]" || ch === "}") break;
    if (ch === "{" || ch === "[") {
      const close = ch === "{" ? "}" : "]";
      const end = matchForward(params, i, ch, close);
      const inner = params.slice(i + 1, end < 0 ? params.length : end);
      collectLeaves(inner, out, depthGuard + 1);
      i = end < 0 ? params.length : end + 1;
      skip();
      if (params[i] === ":") skipType();
      skip();
      if (params[i] === "=") {
        i += 1;
        skipValue();
      }
      continue;
    }
    if (ch === "." && params.slice(i, i + 3) === "...") {
      i += 3;
      continue;
    }
    if (ch === "@") {
      // Parameter decorator: `@Param("id") id: string`.
      i += 1;
      const decorator = /^[A-Za-z_$][\w$.]*/.exec(params.slice(i));
      if (decorator !== null) i += decorator[0].length;
      if (params[i] === "(") {
        const end = matchForward(params, i, "(", ")");
        i = end < 0 ? params.length : end + 1;
      }
      continue;
    }
    const ident = /^[A-Za-z_$][\w$]*/.exec(params.slice(i));
    if (ident === null) {
      i += 1;
      continue;
    }
    const name = ident[0];
    i += name.length;
    skip();
    if (MODIFIERS.has(name) && i < params.length && IDENT_START.test(params[i]!)) continue;
    if (params[i] === "?") i += 1;
    skip();
    if (params[i] === ":") {
      // `{ key: alias }` in a destructuring pattern binds the alias; `x: Type` in a list is a type.
      if (depthGuard > 0) {
        i += 1;
        continue;
      }
      skipType();
    }
    skip();
    if (params[i] === "=") {
      i += 1;
      skipValue();
    }
    out.push(name);
    if (i === before) i += 1;
  }
}
