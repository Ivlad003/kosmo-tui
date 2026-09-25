/** Task 23: argv of spec 6.8/7.1, validated before any side effect. */
import { describe, expect, it } from "vitest";
import { USAGE, parseArgv } from "../../src/args.js";

const ok = (argv: string[]) => {
  const result = parseArgv(argv);
  if (!result.ok) throw new Error(result.message);
  return result.args;
};
const error = (argv: string[]) => {
  const result = parseArgv(argv);
  if (result.ok) throw new Error(`accepted ${argv.join(" ")}`);
  return result.message;
};

describe("parseArgv: the viewer", () => {
  it("no argument is the start screen; -r and --root apply", () => {
    expect(ok([])).toEqual({ command: "tui", readOnly: false });
    expect(ok(["-r", "--root", "../app"])).toEqual({ command: "tui", readOnly: true, root: "../app" });
    expect(ok(["--read-only", "--root=src"])).toEqual({ command: "tui", readOnly: true, root: "src" });
  });

  it("a path or - opens a trace; -- ends the options", () => {
    expect(ok(["./x.kosmo-trace.json"])).toEqual({ command: "tui", readOnly: false, target: "./x.kosmo-trace.json" });
    expect(ok(["-", "-r"])).toEqual({ command: "tui", readOnly: true, target: "-" });
    expect(ok(["--", "--weird-name.json"])).toEqual({ command: "tui", readOnly: false, target: "--weird-name.json" });
  });

  it("--help and --version win over everything else", () => {
    expect(ok(["x", "--bogus", "--help"])).toEqual({ command: "help" });
    expect(ok(["-h"])).toEqual({ command: "help" });
    expect(ok(["--version"])).toEqual({ command: "version" });
    expect(USAGE).toContain("--print [text|json|tab]");
  });

  it("print-only flags without --print are usage errors", () => {
    expect(error(["x", "--trace", "t1"])).toBe(
      "--trace selects the trace to print; add --print (in the viewer use :trace <id>)"
    );
    expect(error(["x", "--format", "json"])).toBe("--format selects the --print output; add --print");
    expect(error(["x", "--detail", "0"])).toBe("--detail belongs to --print --format text; add --print");
  });

  it("refuses unknown options, a second target, repeats and missing values", () => {
    expect(error(["--depth", "app"])).toBe("unknown option --depth");
    expect(error(["a.json", "b.json"])).toBe("kosmo-tui accepts one trace file or -, received 2: a.json b.json");
    expect(error(["-r", "--read-only"])).toBe("--read-only was given more than once");
    expect(error(["--root"])).toBe("--root requires a value");
    expect(error(["--root", "--print"])).toBe("--root requires a value");
  });
});

describe("parseArgv: --print (spec 7.1)", () => {
  it("text is the default format and needs --trace; --detail defaults to 1", () => {
    expect(ok(["x", "--print", "--trace", "t1"])).toEqual({
      command: "print",
      target: "x",
      format: "text",
      trace: "t1",
      detail: 1
    });
    expect(ok(["-", "--print", "text", "--trace=t1", "--detail", "0"])).toMatchObject({ target: "-", detail: 0 });
    expect(error(["x", "--print"])).toBe(
      "--print text shows one trace: pass --trace <id> (or --format json|tab for the whole dataset)"
    );
  });

  it("json and tab work with and without --trace; --print <format> and --format agree", () => {
    expect(ok(["x", "--print", "json"])).toEqual({ command: "print", target: "x", format: "json", detail: 1 });
    expect(ok(["x", "--print", "--format", "tab", "--trace", "t"])).toMatchObject({ format: "tab", trace: "t" });
    expect(ok(["x", "--print", "tab", "--format", "tab"])).toMatchObject({ format: "tab" });
    expect(error(["x", "--print", "json", "--format", "tab"])).toBe("--print json conflicts with --format tab");
    expect(error(["x", "--print", "--format", "lisp"])).toBe("--format must be text, json or tab, received lisp");
  });

  it("--print <word> with no other positional reads the word as the trace file, not the format", () => {
    // A file may be named json/tab/text: `--print json` alone must not report a missing file.
    expect(ok(["--print", "json", "--format", "json"])).toEqual({
      command: "print",
      target: "json",
      format: "json",
      detail: 1
    });
    expect(ok(["--print", "tab", "--trace", "t"])).toEqual({
      command: "print",
      target: "tab",
      format: "text",
      trace: "t",
      detail: 1
    });
    expect(ok(["--print", "text", "--format", "tab"])).toMatchObject({ target: "text", format: "tab" });
    expect(error(["--print", "json"])).toBe(
      "--print json: json was read as the trace file, and --print text shows one trace: pass --trace <id>, " +
        "or name the file first to print json (<file> --print json)"
    );
    // With a positional the word stays the format, on either side.
    expect(ok(["--print", "json", "x"])).toMatchObject({ target: "x", format: "json" });
    expect(ok(["json", "--print", "tab"])).toMatchObject({ target: "json", format: "tab" });
    expect(ok(["--print=json", "x"])).toMatchObject({ target: "x", format: "json" });
  });

  it("--detail only with text, and only 0 or 1", () => {
    expect(error(["x", "--print", "json", "--detail", "1"])).toBe("--detail applies to --format text only, not json");
    expect(error(["x", "--print", "--trace", "t", "--detail", "2"])).toBe("--detail must be 0 or 1, received 2");
  });

  it("needs a target, has no code root, and tolerates -r", () => {
    expect(error(["--print"])).toBe("--print needs a trace file or - (stdin)");
    expect(error(["--print", "--format", "json"])).toBe("--print needs a trace file or - (stdin)");
    expect(error(["x", "--print", "json", "--root", "."])).toBe(
      "--root sets the viewer's code root; --print does not read code"
    );
    expect(ok(["x", "--print", "json", "-r"])).toMatchObject({ command: "print", format: "json" });
  });
});
