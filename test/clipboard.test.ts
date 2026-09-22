/**
 * Task 5.9: `y` copies the full versioned trace-text document through the shared
 * sanitizer; the protocol parser of that version accepts it; a missing source line stays
 * unavailable; adapters spawn without a shell; the stdout fallback is written only after
 * the terminal left the alternate screen.
 */
import { describe, expect, it, vi } from "vitest";
import { parseTraceText, parseTraceTextV2 } from "@kosmo-callflow/protocol";
import {
  FALLBACK_MAX_DOCUMENTS,
  StdoutFallback,
  buildCopyDocument,
  clipboardCommands,
  copyToClipboard,
  spawnClipboard,
  withAfterClose,
  type ClipboardCommand
} from "../src/clipboard.js";
import { createTerminal, RESTORE_SEQUENCE } from "../src/terminal.js";
import { ESC, v1Document, v2Document, v2Span } from "./review-helpers.js";

const SECRET = "sk_live_0123456789abcdef0123456789";

function hostileV2() {
  return v2Document([
    v2Span({
      ret: {
        state: "recorded",
        reason: null,
        value: JSON.stringify(`bold${ESC}[1m ${SECRET} /Users/alice/app/src/cart.ts`)
      },
      source: { state: "available", file: "src/cart.ts", line: null, column: null }
    })
  ]);
}

describe("copy document", () => {
  it("is a full v2 document the v2 parser accepts, with control data escaped and secrets masked", () => {
    for (const format of ["lisp", "tab"] as const) {
      const built = buildCopyDocument(hostileV2(), format);
      expect(built.ok, format).toBe(true);
      if (!built.ok) continue;
      const { text } = built.document;
      expect(text.startsWith(format === "lisp" ? "(kosmo.trace-text/v2" : "kosmo.trace-text/v2")).toBe(true);
      expect(text).not.toContain(ESC);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("/Users/alice");
      const parsed = parseTraceTextV2(text, { dialect: format });
      expect(parsed.ok, format).toBe(true);
      if (!parsed.ok) continue;
      const span = parsed.data.items[0]!;
      expect(span.kind === "span" && span.source).toEqual({
        state: "available",
        file: "src/cart.ts",
        line: null,
        column: null
      });
      expect(built.document).toMatchObject({ version: 2, format, sourceLineUnavailable: true });
      expect(built.document.bytes).toBe(Buffer.byteLength(text));
    }
  });

  it("uses the v1 codec for a v1 source and round-trips through the v1 parser", () => {
    const built = buildCopyDocument(v1Document(), "lisp");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.document.version).toBe(1);
    expect(parseTraceText(built.document.text, { dialect: "lisp" }).ok).toBe(true);
    // v1 items carry no source line here: it is reported unavailable, not invented.
    expect(built.document.sourceLineUnavailable).toBe(true);
    expect(built.document.text).not.toMatch(/:line \d/);
  });

  it("reports a recorded line as available", () => {
    const built = buildCopyDocument(v2Document(), "lisp");
    expect(built.ok && built.document.sourceLineUnavailable).toBe(false);
  });

  it("refuses something that is not a versioned document", () => {
    const built = buildCopyDocument({ items: [] } as never, "lisp");
    expect(built.ok).toBe(false);
  });
});

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
    fallback.queue("(kosmo.trace-text/v2 ...)");
    expect(log.join("")).not.toContain("kosmo.trace-text");
    terminal.close();
    terminal.close();
    const text = log.join("");
    expect(text.indexOf(RESTORE_SEQUENCE)).toBeGreaterThan(-1);
    expect(text.indexOf("(kosmo.trace-text/v2 ...)")).toBeGreaterThan(text.indexOf(RESTORE_SEQUENCE));
    expect(text.split("(kosmo.trace-text/v2 ...)")).toHaveLength(2);
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
