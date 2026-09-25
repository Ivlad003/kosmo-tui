/** Task 24: the composition root `run(proc, deps)` on the new code (spec 6.8). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as cli from "../../src/cli.js";
import { EXIT_OK, EXIT_SIGHUP, EXIT_SIGINT, EXIT_SIGTERM, EXIT_SOURCE, EXIT_USAGE, USAGE, run } from "../../src/cli.js";
import type { PrintInput } from "../../src/output/print.js";
import type { OpenTuiInput } from "../../src/ui/open.js";
import { fixtureFile } from "../fixture-recipes.js";
import { fakeProc } from "./proc-fakes.js";

describe("run(proc, deps)", () => {
  it("keeps the exit codes of spec 6.8 and exports no other", () => {
    expect([EXIT_OK, EXIT_USAGE, EXIT_SOURCE, EXIT_SIGHUP, EXIT_SIGINT, EXIT_SIGTERM]).toEqual([
      0, 1, 2, 129, 130, 143
    ]);
    const exported = Object.keys(cli).filter((name) => name.startsWith("EXIT_"));
    expect(exported.sort()).toEqual([
      "EXIT_OK",
      "EXIT_SIGHUP",
      "EXIT_SIGINT",
      "EXIT_SIGTERM",
      "EXIT_SOURCE",
      "EXIT_USAGE"
    ]);
  });

  it("--help, --version and usage errors need no terminal and touch nothing", async () => {
    const help = fakeProc(["--help"], { stdoutTty: false });
    expect(await run(help)).toBe(EXIT_OK);
    expect(help.out).toBe(USAGE);
    const version = fakeProc(["--version"]);
    expect(await run(version, { readVersion: () => "9.9.9" })).toBe(EXIT_OK);
    expect(version.out).toBe("9.9.9\n");
    const bad = fakeProc(["--bogus\u001b[2J"]);
    const never = async () => {
      throw new Error("must not run");
    };
    expect(await run(bad, { openTui: never, runPrint: never })).toBe(EXIT_USAGE);
    expect(bad.err).toBe("kosmo-tui: unknown option --bogus\\u001b[2J\nRun kosmo-tui --help for usage.\n");
  });

  it("routes --print to runPrint and everything else to openTui", async () => {
    const seen: string[] = [];
    const deps = {
      openTui: async (input: OpenTuiInput) => {
        seen.push(`tui ${input.args.target ?? "(start)"} ${input.args.readOnly}`);
        return EXIT_OK;
      },
      runPrint: async (input: PrintInput) => {
        seen.push(`print ${input.args.target} ${input.args.format}`);
        return EXIT_OK;
      }
    };
    await run(fakeProc([]), deps);
    await run(fakeProc(["-", "-r"]), deps);
    await run(fakeProc(["x.json", "--print", "tab"]), deps);
    expect(seen).toEqual(["tui (start) false", "tui - true", "print x.json tab"]);
  });

  it("SIGINT, SIGTERM and SIGHUP abort the command and give 130, 143, 129; listeners are removed", async () => {
    for (const [signal, code] of [
      ["SIGINT", EXIT_SIGINT],
      ["SIGTERM", EXIT_SIGTERM],
      ["SIGHUP", EXIT_SIGHUP]
    ] as const) {
      const proc = fakeProc([]);
      let started: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => (started = resolve));
      const pending = run(proc, {
        openTui: (input) =>
          new Promise<number>((resolve) => {
            input.signal.addEventListener("abort", () => resolve(EXIT_OK));
            started();
          })
      });
      await ready;
      proc.emit(signal);
      expect(await pending, signal).toBe(code);
      for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) expect(proc.listeners.get(name)?.size ?? 0).toBe(0);
    }
  });

  it("a throw that escapes a command is exit 2 with one escaped line", async () => {
    const proc = fakeProc([]);
    const code = await run(proc, {
      openTui: async () => {
        throw new Error("boom\u001b]0;x\u0007\nsecond");
      }
    });
    expect(code).toBe(EXIT_SOURCE);
    expect(proc.err).toBe("kosmo-tui: boom\\u001b]0;x\\u0007 second\n");
  });

  it("the default runPrint prints a real fixture file", async () => {
    const proc = fakeProc([fixtureFile("kosmo-trace/basic"), "--print", "--trace", "t_cart"], { stdoutTty: false });
    expect(await run(proc)).toBe(EXIT_OK);
    expect(proc.out).toBe(readFileSync(new URL("../golden/basic.t_cart.kosmo-text", import.meta.url), "utf8"));
  });
});
