/**
 * The vim-style `:` command line: tokenizer, ref syntax and prompt editing (design D12).
 *
 * This is a command parser, not a language. There is no evaluation step anywhere in
 * here: a line is split into tokens and the first one names a domain command, so
 * `(eval ...)` is simply an unknown command.
 *
 * Tokens:
 *  - bare words end at unquoted whitespace; `\x` takes the next character literally;
 *  - `'...'` is literal (no escapes inside), `"..."` understands `\"`, `\\`, `\n`, `\t`;
 *  - a token that starts with `/` is a regex literal `/source/flags`: it runs to the
 *    next unescaped `/`, so it may contain spaces and quotes;
 *  - an unquoted `--name` is a flag.
 *
 * Qualified refs (consistent with the viewer's full span identity) are colon-separated
 * parts of one token. Only UNQUOTED colons separate, so an id that contains a colon is
 * written quoted: `"sess:1":t-1:s-2`.
 *
 *   span ref:  `.` (the selection) | `span` | `trace:span` | `session:trace:span`
 *              | `dataset:project:session:trace:span`
 *   trace ref: `trace` | `session:trace` | `dataset:project:session:trace`
 *
 * Missing leading parts come from the current context (the selected span, or a field
 * every loaded row shares). A short id resolves only when that makes it unambiguous;
 * otherwise the command asks for a longer ref instead of guessing.
 */

export type Token = {
  /** The token's value with quotes and escapes removed. */
  text: string;
  /** `text` split on unquoted colons. */
  parts: string[];
  /** True when any part of the token was quoted or escaped. */
  quoted: boolean;
  regex?: { source: string; flags: string };
};

export type TokenizeResult = { ok: true; tokens: Token[] } | { ok: false; error: string };

function isSpace(char: string): boolean {
  return char === " " || char === "\t";
}

export function tokenize(line: string): TokenizeResult {
  const tokens: Token[] = [];
  let index = 0;
  while (index < line.length) {
    while (index < line.length && isSpace(line[index]!)) index += 1;
    if (index >= line.length) break;

    if (line[index] === "/") {
      let source = "";
      let cursor = index + 1;
      let closed = false;
      while (cursor < line.length) {
        const char = line[cursor]!;
        if (char === "\\" && cursor + 1 < line.length) {
          source += char + line[cursor + 1]!;
          cursor += 2;
          continue;
        }
        if (char === "/") {
          closed = true;
          cursor += 1;
          break;
        }
        source += char;
        cursor += 1;
      }
      if (!closed) return { ok: false, error: "unterminated regex literal (expected /pattern/flags)" };
      let flags = "";
      while (cursor < line.length && /[a-z]/.test(line[cursor]!)) {
        flags += line[cursor]!;
        cursor += 1;
      }
      if (cursor < line.length && !isSpace(line[cursor]!)) {
        return { ok: false, error: `unexpected character after regex literal: ${line[cursor]}` };
      }
      const text = `/${source}/${flags}`;
      tokens.push({ text, parts: [text], quoted: true, regex: { source, flags } });
      index = cursor;
      continue;
    }

    const parts: string[] = [""];
    let text = "";
    let quoted = false;
    const append = (value: string): void => {
      parts[parts.length - 1] += value;
      text += value;
    };
    while (index < line.length && !isSpace(line[index]!)) {
      const char = line[index]!;
      if (char === "'") {
        const end = line.indexOf("'", index + 1);
        if (end === -1) return { ok: false, error: "unterminated single quote" };
        append(line.slice(index + 1, end));
        quoted = true;
        index = end + 1;
      } else if (char === '"') {
        let cursor = index + 1;
        let value = "";
        let closed = false;
        while (cursor < line.length) {
          const inner = line[cursor]!;
          if (inner === "\\" && cursor + 1 < line.length) {
            const next = line[cursor + 1]!;
            value += next === "n" ? "\n" : next === "t" ? "\t" : next;
            cursor += 2;
            continue;
          }
          if (inner === '"') {
            closed = true;
            break;
          }
          value += inner;
          cursor += 1;
        }
        if (!closed) return { ok: false, error: "unterminated double quote" };
        append(value);
        quoted = true;
        index = cursor + 1;
      } else if (char === "\\") {
        if (index + 1 >= line.length) return { ok: false, error: "trailing backslash" };
        append(line[index + 1]!);
        quoted = true;
        index += 2;
      } else if (char === ":") {
        parts.push("");
        text += ":";
        index += 1;
      } else {
        append(char);
        index += 1;
      }
    }
    tokens.push({ text, parts, quoted });
  }
  return { ok: true, tokens };
}

export type ParsedCommand = {
  name: string;
  args: Token[];
  flags: Set<string>;
};

export type ParseResult = { ok: true; command: ParsedCommand } | { ok: false; error: string } | { ok: "empty" };

/** Parse one command line. A leading `:` is optional, so history entries parse as typed. */
export function parseCommandLine(line: string): ParseResult {
  const body = line.startsWith(":") ? line.slice(1) : line;
  const tokenized = tokenize(body);
  if (!tokenized.ok) return tokenized;
  const [head, ...rest] = tokenized.tokens;
  if (!head) return { ok: "empty" };
  const args: Token[] = [];
  const flags = new Set<string>();
  for (const token of rest) {
    if (!token.quoted && token.text.startsWith("--") && token.text.length > 2) flags.add(token.text.slice(2));
    else args.push(token);
  }
  return { ok: true, command: { name: head.text, args, flags } };
}

/** Parts of a span ref; absent fields are filled from the current context. */
export type SpanRefSpec =
  | { kind: "selection" }
  | {
      kind: "ref";
      datasetId?: string;
      projectId?: string;
      sessionId?: string;
      traceId?: string;
      spanId: string;
    };

export type TraceRefSpec = { datasetId?: string; projectId?: string; sessionId?: string; traceId: string };

export type RefParse<T> = { ok: true; spec: T } | { ok: false; error: string };

const SPAN_REF_FORMS = "span | trace:span | session:trace:span | dataset:project:session:trace:span";
const TRACE_REF_FORMS = "trace | session:trace | dataset:project:session:trace";

export function parseSpanRef(token: Token): RefParse<SpanRefSpec> {
  if (!token.quoted && token.text === ".") return { ok: true, spec: { kind: "selection" } };
  const { parts } = token;
  if (parts.some((part) => part.length === 0)) return { ok: false, error: `empty part in ref ${token.text}` };
  switch (parts.length) {
    case 1:
      return { ok: true, spec: { kind: "ref", spanId: parts[0]! } };
    case 2:
      return { ok: true, spec: { kind: "ref", traceId: parts[0]!, spanId: parts[1]! } };
    case 3:
      return { ok: true, spec: { kind: "ref", sessionId: parts[0]!, traceId: parts[1]!, spanId: parts[2]! } };
    case 5:
      return {
        ok: true,
        spec: {
          kind: "ref",
          datasetId: parts[0]!,
          projectId: parts[1]!,
          sessionId: parts[2]!,
          traceId: parts[3]!,
          spanId: parts[4]!
        }
      };
    default:
      return { ok: false, error: `bad span ref ${token.text}; expected ${SPAN_REF_FORMS}` };
  }
}

export function parseTraceRef(token: Token): RefParse<TraceRefSpec> {
  const { parts } = token;
  if (parts.some((part) => part.length === 0)) return { ok: false, error: `empty part in ref ${token.text}` };
  switch (parts.length) {
    case 1:
      return { ok: true, spec: { traceId: parts[0]! } };
    case 2:
      return { ok: true, spec: { sessionId: parts[0]!, traceId: parts[1]! } };
    case 4:
      return {
        ok: true,
        spec: { datasetId: parts[0]!, projectId: parts[1]!, sessionId: parts[2]!, traceId: parts[3]! }
      };
    default:
      return { ok: false, error: `bad trace ref ${token.text}; expected ${TRACE_REF_FORMS}` };
  }
}

/** A non-negative safe integer argument, or null. `Number("")` is 0, so text is screened first. */
export function parseCount(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/* ---------------------------------------------------------------- prompt editing */

/** Entries kept in the session history; the oldest is dropped past this. */
export const COMMAND_HISTORY_CAP = 50;
/** Longest line the prompt accepts; typing past it is ignored rather than truncated later. */
export const COMMAND_LINE_MAX = 1_024;

export type CommandLineInput = {
  text: string;
  /** Position in the history while browsing it; null when editing a fresh line. */
  historyIndex: number | null;
  /** The fresh line put aside while browsing history, restored when stepping past the end. */
  draft: string;
};

export function openCommandLine(): CommandLineInput {
  return { text: "", historyIndex: null, draft: "" };
}

export function insertText(input: CommandLineInput, text: string): CommandLineInput {
  const room = COMMAND_LINE_MAX - input.text.length;
  if (room <= 0) return input;
  return { ...input, text: input.text + text.slice(0, room), historyIndex: null };
}

export function backspace(input: CommandLineInput): CommandLineInput {
  // Remove one code point, so a surrogate pair is not split in half.
  const chars = Array.from(input.text);
  chars.pop();
  return { ...input, text: chars.join(""), historyIndex: null };
}

export function clearLine(input: CommandLineInput): CommandLineInput {
  return { ...input, text: "", historyIndex: null };
}

/** Up (`delta` -1) walks to older entries, down walks back to the draft. */
export function stepHistory(input: CommandLineInput, history: readonly string[], delta: number): CommandLineInput {
  if (history.length === 0) return input;
  const current = input.historyIndex ?? history.length;
  const draft = input.historyIndex === null ? input.text : input.draft;
  const next = Math.min(history.length, Math.max(0, current + delta));
  if (next === history.length) return { text: draft, historyIndex: null, draft };
  return { text: history[next]!, historyIndex: next, draft };
}

/** Append a submitted line: blanks and an immediate repeat are not stored; bounded. */
export function pushHistory(history: readonly string[], line: string, cap = COMMAND_HISTORY_CAP): string[] {
  const entry = line.trim();
  if (entry.length === 0 || history[history.length - 1] === entry) return [...history];
  const next = [...history, entry];
  return next.slice(Math.max(0, next.length - Math.max(1, cap)));
}
