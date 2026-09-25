/**
 * The tokenizer of the `:` command line (spec 6.6). The commands themselves are parsed in
 * src/ui/commands.ts, span refs in src/ui/refs.ts.
 *
 * This is a command parser, not a language. There is no evaluation step anywhere in
 * here: a line is split into tokens and the first one names a command.
 *
 * Tokens:
 *  - bare words end at unquoted whitespace; `\x` takes the next character literally;
 *  - `'...'` is literal (no escapes inside), `"..."` understands `\"`, `\\`, `\n`, `\t`;
 *  - a token that starts with `/` is a regex literal `/source/flags`: it runs to the
 *    next unescaped `/`, so it may contain spaces and quotes (ui/commands.ts turns it back
 *    into plain text outside `:find`, `:filter` and `:area`);
 *  - only UNQUOTED colons split a token into `parts`, so an id that contains a colon is
 *    written quoted: `"sess:1":sp_2`.
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
