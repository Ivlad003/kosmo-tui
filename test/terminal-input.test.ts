import { describe, expect, it } from "vitest";
import { createTerminal } from "../src/terminal.js";
import {
  controllingTerminalAvailable,
  controllingTerminalPath,
  openKeyboardInput,
  type TtyStream
} from "../src/terminal-input.js";
import { fakeTerminalIo } from "./terminal-fakes.js";

function fakeTtyStream() {
  const f = fakeTerminalIo();
  let destroyed = 0;
  const stream: TtyStream = Object.assign(f.input, {
    destroy: () => {
      destroyed += 1;
    }
  });
  return { f, stream, destroyed: () => destroyed };
}

describe("keyboard port", () => {
  it("uses /dev/tty on POSIX and CONIN$ on Windows", () => {
    expect(controllingTerminalPath("linux")).toBe("/dev/tty");
    expect(controllingTerminalPath("darwin")).toBe("/dev/tty");
    expect(controllingTerminalPath("win32")).toBe("CONIN$");
  });

  it("ordinary targets read keys from a TTY stdin", () => {
    const stdin = fakeTerminalIo().input;
    const opened: string[] = [];
    const result = openKeyboardInput({
      platform: "linux",
      stdin,
      stdinCarriesData: false,
      openFd: (file) => {
        opened.push(file);
        return 9;
      }
    });
    expect(result.ok && result.port.source).toBe("stdin");
    expect(result.ok && result.port.input).toBe(stdin);
    expect(opened).toEqual([]);
  });

  it("ordinary targets refuse a non-TTY stdin with the --print hint", () => {
    const stdin = fakeTerminalIo({ isTTY: false }).input;
    const result = openKeyboardInput({ platform: "linux", stdin, stdinCarriesData: false });
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(!result.ok && result.message).toMatch(/interactive terminal required.*--print/);
  });

  it("stdin data: keys come from the controlling terminal and the data stdin is never put into raw mode", () => {
    const data = fakeTerminalIo({ isTTY: false });
    const dataRaw: boolean[] = [];
    data.input.setRawMode = (mode) => dataRaw.push(mode);
    const tty = fakeTtyStream();
    const opened: string[] = [];
    const result = openKeyboardInput({
      platform: "darwin",
      stdin: data.input,
      stdinCarriesData: true,
      openFd: (file) => {
        opened.push(file);
        return 42;
      },
      isTty: (fd) => fd === 42,
      createTtyStream: (fd) => {
        expect(fd).toBe(42);
        return tty.stream;
      }
    });
    if (!result.ok) throw new Error(result.message);
    expect(opened).toEqual(["/dev/tty"]);
    expect(result.port.source).toBe("controlling-tty");

    const out = fakeTerminalIo();
    const term = createTerminal(result.port.input, out.output);
    const keys: string[] = [];
    term.onKey((key) => keys.push(key));
    tty.f.key("j");
    // Data arriving on stdin is not a key.
    data.key('{"kind":"trace"}\n');
    expect(keys).toEqual(["j"]);
    term.close();
    result.port.close();
    result.port.close();

    expect(tty.f.rawModeCalls).toEqual([true, false]);
    expect(dataRaw).toEqual([]);
    expect(tty.destroyed()).toBe(1);
  });

  it("stdin data with a data stdin that is itself a TTY still does not touch it", () => {
    // `kosmo-tui -` typed interactively: stdin is a TTY but it is the data source.
    const data = fakeTerminalIo({ isTTY: true });
    const tty = fakeTtyStream();
    const result = openKeyboardInput({
      platform: "linux",
      stdin: data.input,
      stdinCarriesData: true,
      openFd: () => 5,
      isTty: () => true,
      createTtyStream: () => tty.stream
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.port.input).not.toBe(data.input);
    createTerminal(result.port.input, fakeTerminalIo().output).close();
    expect(data.rawModeCalls).toEqual([]);
  });

  it("no controlling terminal: explicit failure, exit 1, --print hint", () => {
    const stdin = fakeTerminalIo({ isTTY: false }).input;
    const result = openKeyboardInput({
      platform: "linux",
      stdin,
      stdinCarriesData: true,
      openFd: () => {
        throw Object.assign(new Error("ENXIO: no such device or address, open '/dev/tty'"), { code: "ENXIO" });
      }
    });
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(!result.ok && result.message).toBe(
      "kosmo-tui: interactive terminal required: stdin carries data and no controlling terminal (/dev/tty) is available for keyboard input. Use --print [lisp|tab|json] for non-interactive output."
    );
  });

  it("a descriptor that is not a terminal is closed and refused", () => {
    const closed: number[] = [];
    const result = openKeyboardInput({
      platform: "win32",
      stdin: fakeTerminalIo({ isTTY: false }).input,
      stdinCarriesData: true,
      openFd: () => 7,
      closeFd: (fd) => closed.push(fd),
      isTty: () => false
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/console input \(CONIN\$\) cannot be used.*--print/);
    expect(closed).toEqual([7]);
  });

  it("availability probe opens, checks and closes the handle", () => {
    const closed: number[] = [];
    expect(
      controllingTerminalAvailable("linux", { openFd: () => 3, isTty: () => true, closeFd: (fd) => closed.push(fd) })
    ).toBe(true);
    expect(
      controllingTerminalAvailable("linux", { openFd: () => 4, isTty: () => false, closeFd: (fd) => closed.push(fd) })
    ).toBe(false);
    expect(
      controllingTerminalAvailable("linux", {
        openFd: () => {
          throw new Error("ENXIO");
        }
      })
    ).toBe(false);
    expect(closed).toEqual([3, 4]);
  });
});
