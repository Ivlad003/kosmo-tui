/**
 * Task 24: clipboard adapters and the stdout fallback, ported from test/clipboard.test.ts
 * (spec 13.2): adapters spawn without a shell, fall through in order and say why nothing
 * copied; the fallback is printed only after the terminal left the alternate screen.
 * The environment allowlist and absolute-PATH rules (S-L3) stay in test/clipboard-env.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import {
  FALLBACK_MAX_DOCUMENTS,
  StdoutFallback,
  clipboardCommands,
  copyToClipboard,
  spawnClipboard,
  withAfterClose,
  type ClipboardCommand
} from "../../src/clipboard.js";
import { createTerminal, RESTORE_SEQUENCE } from "../../src/terminal.js";

describe("clipboard adapters", () => {
  it("picks pbcopy, clip, wl-copy and xclip by platform and display", () => {
    expect(clipboardCommands("darwin", {})).toEqual([{ command: "pbcopy", args: [] }]);
    expect(clipboardCommands("win32", {})).toEqual([{ command: "clip", args: [] }]);
    expect(clipboardCommands("linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" })).toEqual([
      { command: "wl-copy", args: [] },
      { command: "xclip", args: ["-selection", "clipboard"] }
    ]);
    expect(clipboardCommands("linux", {})).toEqual([]);
  });

  it("falls through to the next adapter and passes the document on stdin as argv-only commands", async () => {
    const calls: Array<{ command: ClipboardCommand; input: string }> = [];
    const spawn = vi.fn(async (command: ClipboardCommand, input: string) => {
      calls.push({ command, input });
      if (command.command === "wl-copy") throw Object.assign(new Error("spawn wl-copy ENOENT"), { code: "ENOENT" });
    });
    const outcome = await copyToClipboard("DOC", {
      platform: "linux",
      env: { WAYLAND_DISPLAY: "w", DISPLAY: ":0" },
      spawn
    });
    expect(outcome).toEqual({ copied: true, via: "xclip" });
    expect(calls.map((call) => [call.command.command, call.command.args, call.input])).toEqual([
      ["wl-copy", [], "DOC"],
      ["xclip", ["-selection", "clipboard"], "DOC"]
    ]);
  });

  it("reports why nothing could copy", async () => {
    expect(await copyToClipboard("DOC", { platform: "linux", env: {} })).toEqual({
      copied: false,
      reason: "no clipboard adapter for this platform/display"
    });
    const spawn = async () => {
      throw Object.assign(new Error("x"), { code: "ENOENT" });
    };
    expect(await copyToClipboard("DOC", { platform: "darwin", env: {}, spawn })).toEqual({
      copied: false,
      reason: "pbcopy: ENOENT"
    });
  });

  it("spawns without a shell: metacharacters are part of the program name, not syntax", async () => {
    await expect(spawnClipboard({ command: "kosmo-no-such-tool;echo", args: [] }, "x")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(
      spawnClipboard(
        {
          command: process.execPath,
          args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"]
        },
        "doc"
      )
    ).resolves.toBeUndefined();
    await expect(spawnClipboard({ command: process.execPath, args: ["-e", "process.exit(3)"] }, "doc")).rejects.toThrow(
      "exited with 3"
    );
  });
});

describe("stdout fallback", () => {
  it("prints after the terminal left the alternate screen, never before", () => {
    const log: string[] = [];
    const output = {
      isTTY: true,
      columns: 80,
      rows: 24,
      write: (chunk: string) => {
        log.push(chunk);
      },
      on: () => undefined,
      off: () => undefined
    };
    const input = { isTTY: true, setRawMode: () => undefined, on: () => undefined, off: () => undefined };
    const fallback = new StdoutFallback(output);
    const terminal = withAfterClose(createTerminal(input, output), () => fallback.flush());
    terminal.paint(["frame row"]);
    fallback.queue("kosmo-text/v1 trace=t_cart");
    expect(log.join("")).not.toContain("kosmo-text/v1");
    terminal.close();
    terminal.close();
    const text = log.join("");
    expect(text.indexOf(RESTORE_SEQUENCE)).toBeGreaterThan(-1);
    expect(text.indexOf("kosmo-text/v1 trace=t_cart")).toBeGreaterThan(text.indexOf(RESTORE_SEQUENCE));
    expect(text.split("kosmo-text/v1 trace=t_cart")).toHaveLength(2);
  });

  it("is bounded and says how many documents it dropped", () => {
    const out: string[] = [];
    const fallback = new StdoutFallback({ write: (chunk: string) => out.push(chunk) });
    for (let index = 0; index < FALLBACK_MAX_DOCUMENTS + 2; index += 1) fallback.queue(`doc-${index}`);
    fallback.flush();
    fallback.flush();
    expect(out[0]).toContain("2 earlier copied document(s) dropped");
    expect(out).toHaveLength(FALLBACK_MAX_DOCUMENTS + 1);
    expect(out.at(-1)).toBe(`doc-${FALLBACK_MAX_DOCUMENTS + 1}\n`);
  });
});
