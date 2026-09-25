/**
 * argv of kosmo-tui (spec 6.8, 7.1). Pure: no filesystem, no environment, no terminal.
 *
 *   kosmo-tui [-r] [--root <dir>]                          start screen
 *   kosmo-tui <file|-> [-r] [--root <dir>]                 open a trace file or stdin
 *   kosmo-tui <file|-> --print [--trace <id>] [--format text|json|tab] [--detail 0|1]
 *   kosmo-tui --help | --version
 *
 * Every flag combination is checked here, before any side effect; a violation is a usage
 * error (exit 1). `--print` also takes the format as its next argument (`--print json`),
 * `--flag=value` works for every flag with a value, `-` is stdin and `--` ends the options.
 */

export const FORMATS = ["text", "json", "tab"] as const;
export type OutputFormat = (typeof FORMATS)[number];

export type TuiArgs = {
  readonly command: "tui";
  /** A path or `-` (stdin); absent → the start screen. */
  readonly target?: string;
  readonly readOnly: boolean;
  readonly root?: string;
};

export type PrintArgs = {
  readonly command: "print";
  readonly target: string;
  readonly format: OutputFormat;
  readonly trace?: string;
  /** `text` only; 1 (the default) adds the args/return/error line of every span. */
  readonly detail: 0 | 1;
};

export type ParsedArgs = TuiArgs | PrintArgs | { readonly command: "help" } | { readonly command: "version" };

export type ParseResult =
  { readonly ok: true; readonly args: ParsedArgs } | { readonly ok: false; readonly message: string };

export const USAGE = `Usage:
  kosmo-tui [-r] [--root <dir>]              start screen: traces found here and recently opened
  kosmo-tui <file|-> [-r] [--root <dir>]     open a kosmo-trace/v1 file (.json, .ndjson, .sqlite) or stdin
  kosmo-tui <file|-> --print [text|json|tab] [--trace <id>] [--detail 0|1]
  kosmo-tui --help | --version

Options:
  -r, --read-only        never write recent.json
  --root <dir>           project root for code snippets (default: dataset.root, else the nearest
                         directory with .git or package.json above the trace file, else cwd)
  --print [format]       print instead of opening the viewer:
                           text  kosmo-text/v1 of one trace, needs --trace <id> (the default)
                           json  normalized kosmo-trace/v1: the dataset, or one trace with --trace
                           tab   the trace list, or one row per span with --trace
  --format <format>      the same as the argument of --print
  --trace <id>           the trace to print
  --detail 0|1           text only: 1 (default) adds args/return/error to every span
  -h, --help             show this help
  --version              print the version

Exit codes: 0 ok, 1 usage / missing path / no terminal, 2 unreadable or invalid trace,
130 SIGINT or Ctrl+C, 143 SIGTERM, 129 SIGHUP.
`;

const VALUE_FLAGS = new Set(["--root", "--trace", "--format", "--detail"]);
const SWITCHES = new Set(["-r", "--read-only", "--print"]);

function fail(message: string): ParseResult {
  return { ok: false, message };
}

function isFormat(value: string | undefined): value is OutputFormat {
  return value !== undefined && (FORMATS as readonly string[]).includes(value);
}

/** Parse argv without `node` and the script. */
export function parseArgv(argv: readonly string[]): ParseResult {
  const tokens: string[] = [];
  let endOfOptions = false;
  for (const raw of argv) {
    if (endOfOptions || raw === "--") {
      tokens.push(raw);
      endOfOptions = true;
      continue;
    }
    const eq = raw.indexOf("=");
    if (raw.startsWith("--") && eq > 2) tokens.push(raw.slice(0, eq), raw.slice(eq + 1));
    else tokens.push(raw);
  }

  // --help and --version answer even next to a wrong flag.
  const options = tokens.includes("--") ? tokens.slice(0, tokens.indexOf("--")) : tokens;
  if (options.includes("-h") || options.includes("--help")) return { ok: true, args: { command: "help" } };
  if (options.includes("--version")) return { ok: true, args: { command: "version" } };

  const positionals: string[] = [];
  const seen = new Map<string, string | true>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--") {
      positionals.push(...tokens.slice(index + 1));
      break;
    }
    if (token === "-" || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    const name = token === "--read-only" ? "-r" : token;
    if (seen.has(name)) return fail(`${token} was given more than once`);
    if (name === "--print") {
      const next = tokens[index + 1];
      if (isFormat(next)) {
        seen.set(name, next);
        index += 1;
      } else {
        seen.set(name, true);
      }
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      const value = tokens[index + 1];
      if (value === undefined || value === "" || value.startsWith("--")) return fail(`${token} requires a value`);
      seen.set(name, value);
      index += 1;
      continue;
    }
    if (SWITCHES.has(name)) {
      seen.set(name, true);
      continue;
    }
    return fail(`unknown option ${token}`);
  }

  if (positionals.length > 1) {
    return fail(`kosmo-tui accepts one trace file or -, received ${positionals.length}: ${positionals.join(" ")}`);
  }
  const target = positionals[0];
  const text = (flag: string): string | undefined => {
    const value = seen.get(flag);
    return typeof value === "string" ? value : undefined;
  };

  const formatFlag = text("--format");
  if (formatFlag !== undefined && !isFormat(formatFlag)) {
    return fail(`--format must be text, json or tab, received ${formatFlag}`);
  }
  const detailFlag = text("--detail");
  if (detailFlag !== undefined && detailFlag !== "0" && detailFlag !== "1") {
    return fail(`--detail must be 0 or 1, received ${detailFlag}`);
  }
  const trace = text("--trace");
  const root = text("--root");

  if (!seen.has("--print")) {
    if (formatFlag !== undefined) return fail("--format selects the --print output; add --print");
    if (trace !== undefined)
      return fail("--trace selects the trace to print; add --print (in the viewer use :trace <id>)");
    if (detailFlag !== undefined) return fail("--detail belongs to --print --format text; add --print");
    return {
      ok: true,
      args: {
        command: "tui",
        readOnly: seen.has("-r"),
        ...(target === undefined ? {} : { target }),
        ...(root === undefined ? {} : { root })
      }
    };
  }

  const printFormat = text("--print");
  if (printFormat !== undefined && formatFlag !== undefined && printFormat !== formatFlag) {
    return fail(`--print ${printFormat} conflicts with --format ${formatFlag}`);
  }
  const format: OutputFormat = (printFormat ?? formatFlag ?? "text") as OutputFormat;
  if (target === undefined) return fail("--print needs a trace file or - (stdin)");
  if (root !== undefined) return fail("--root sets the viewer's code root; --print does not read code");
  if (detailFlag !== undefined && format !== "text")
    return fail(`--detail applies to --format text only, not ${format}`);
  // Spec 7.1: text without --trace is a usage error, decided before anything is read.
  if (format === "text" && trace === undefined) {
    return fail("--print text shows one trace: pass --trace <id> (or --format json|tab for the whole dataset)");
  }
  return {
    ok: true,
    args: {
      command: "print",
      target,
      format,
      detail: detailFlag === "0" ? 0 : 1,
      ...(trace === undefined ? {} : { trace })
    }
  };
}
