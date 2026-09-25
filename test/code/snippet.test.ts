import { describe, expect, it } from "vitest";
import {
  SNIPPET_MAX_FILE_BYTES,
  expandCodeTabs,
  loadSnippet,
  snippetMatches,
  windowLines,
  resolveRoot as reexportedResolveRoot,
  type Snippet,
  type SnippetFs
} from "../../src/code/snippet.js";
import { resolveRoot } from "../../src/code/root.js";
import type { Location } from "../../src/format/types.js";

/** 24 lines; 12..20 are the function from spec 6.4. Same text as test/fixtures/project/src/cart.ts. */
const CART_LINES = [
  'import { price } from "./price";',
  'import { log } from "./log";',
  "",
  "export type Item = { id: number; discount: number };",
  "",
  "/**",
  " * Line total for one cart item.",
  " * Throws when the discount is above 100%.",
  " */",
  "const ZERO = 0;",
  "",
  "export async function calculateLineTotal(item, qty) {",
  "  const p = await price(item.id);",
  "  if (item.discount > 100) {",
  '    throw new RangeError("discount > 100%");',
  "  }",
  "  const total = p * qty;",
  "  log(total);",
  "  return total;",
  "}",
  "",
  "export function emptyTotal() {",
  "  return ZERO;",
  "}"
];
const CART = CART_LINES.join("\n") + "\n";
const HEADER = "export async function calculateLineTotal(item, qty) {";

type Entry = string | Uint8Array | { dir: true } | { link: string } | { error: string };

/**
 * In-memory SnippetFs. `link` entries are resolved by realpath only (like a symlink whose
 * target is given); `error` entries make readFile reject with that errno code.
 */
function fakeFs(entries: Record<string, Entry>): SnippetFs & { reads: string[] } {
  const reads: string[] = [];
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  const isLink = (entry: Entry | undefined): entry is { link: string } =>
    typeof entry === "object" && !(entry instanceof Uint8Array) && "link" in entry;
  return {
    reads,
    async realpath(p) {
      const entry = entries[p];
      if (entry === undefined) throw enoent(p);
      if (!isLink(entry)) return p;
      const target = entries[entry.link];
      if (target === undefined || isLink(target)) throw enoent(p);
      return entry.link;
    },
    async stat(p) {
      const entry = entries[p];
      if (entry === undefined) return undefined;
      if (typeof entry === "string") return { size: new TextEncoder().encode(entry).length, isFile: true };
      if (entry instanceof Uint8Array) return { size: entry.length, isFile: true };
      if ("dir" in entry) return { size: 0, isFile: false };
      return { size: 10, isFile: true };
    },
    async readFile(p) {
      reads.push(p);
      const entry = entries[p];
      if (entry === undefined) throw enoent(p);
      if (typeof entry === "string") return new TextEncoder().encode(entry);
      if (entry instanceof Uint8Array) return entry;
      if ("error" in entry) throw Object.assign(new Error(entry.error), { code: entry.error });
      throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
    }
  };
}

const ROOT = "/proj";
const projectFs = (files: Record<string, Entry>) => fakeFs({ [ROOT]: { dir: true }, ...files });
const at = (location: Partial<Location> & { line: number }): Location => ({ file: "src/cart.ts", ...location });
const numbers = (snippet: Snippet) => snippet.lines.map((line) => line.n);

describe("loadSnippet: window (spec 6.4)", () => {
  it("with endLine shows line..endLine and marks the header line", async () => {
    const fs = projectFs({ "/proj/src/cart.ts": CART });
    const snippet = await loadSnippet(ROOT, at({ line: 12, endLine: 20, snippet: HEADER }), fs);
    expect(snippet).toEqual({
      state: "ok",
      file: "src/cart.ts",
      target: 12,
      lines: CART_LINES.slice(11, 20).map((text, i) => ({ n: 12 + i, text }))
    });
  });

  it("without endLine shows 8 lines on each side, clipped at the file edges", async () => {
    const fs = projectFs({ "/proj/src/cart.ts": CART });
    expect(numbers(await loadSnippet(ROOT, at({ line: 12 }), fs))).toEqual(range(4, 20));
    expect(numbers(await loadSnippet(ROOT, at({ line: 2 }), fs))).toEqual(range(1, 10));
    expect(numbers(await loadSnippet(ROOT, at({ line: 23 }), fs))).toEqual(range(15, 24));
  });

  it("caps line..endLine at 40 lines and flags the rest with more", async () => {
    const text = range(1, 60)
      .map((n) => `line ${n}`)
      .join("\n");
    const fs = projectFs({ "/proj/src/cart.ts": text });
    const long = await loadSnippet(ROOT, at({ line: 5, endLine: 55, snippet: "line 5" }), fs);
    expect(numbers(long)).toEqual(range(5, 44));
    expect(long.more).toBe(true);
    const exact = await loadSnippet(ROOT, at({ line: 5, endLine: 44, snippet: "line 5" }), fs);
    expect(numbers(exact)).toEqual(range(5, 44));
    expect(exact.more).toBeUndefined();
    // endLine past the end of a shorter file: up to EOF, nothing more to show.
    const pastEof = await loadSnippet(ROOT, at({ line: 50, endLine: 90, snippet: "line 50" }), fs);
    expect(numbers(pastEof)).toEqual(range(50, 60));
    expect(pastEof.more).toBeUndefined();
  });

  it("reads the last line of a file without a trailing newline", async () => {
    const fs = projectFs({ "/proj/src/cart.ts": "a\nb\nlast" });
    const snippet = await loadSnippet(ROOT, at({ line: 3, snippet: "last" }), fs);
    expect(snippet.state).toBe("ok");
    expect(snippet.lines.at(-1)).toEqual({ n: 3, text: "last" });
  });
});

describe("loadSnippet: text normalisation", () => {
  it("strips CR of CRLF files, and compares the snippet with CR removed on both sides", async () => {
    const fs = projectFs({ "/proj/src/cart.ts": CART.replace(/\n/g, "\r\n") });
    const snippet = await loadSnippet(ROOT, at({ line: 12, endLine: 20, snippet: `${HEADER}\r` }), fs);
    expect(snippet.state).toBe("ok");
    for (const line of snippet.lines) expect(line.text).not.toContain("\r");
  });

  it("expands tabs with a stop of 4 before any escaping (the text keeps raw ESC for the renderer)", async () => {
    const fs = projectFs({ "/proj/src/cart.ts": "\tif (x) {\n\t\treturn 1;\na\tb\n中\tb\n\t\u001b[31mred\n" });
    const snippet = await loadSnippet(ROOT, at({ line: 1, snippet: "\tif (x) {" }), fs);
    expect(snippet.state).toBe("ok");
    expect(snippet.lines.map((line) => line.text)).toEqual([
      "    if (x) {",
      "        return 1;",
      "a   b",
      "中  b",
      "    \u001b[31mred"
    ]);
  });

  it("drops a UTF-8 BOM before comparing line 1", async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("first\nsecond\n")]);
    const snippet = await loadSnippet(ROOT, at({ line: 1, snippet: "first" }), projectFs({ "/proj/src/cart.ts": bom }));
    expect(snippet.state).toBe("ok");
    expect(snippet.lines[0]).toEqual({ n: 1, text: "first" });
  });

  it("returns a 200 KB minified line whole; truncation is the renderer's job", async () => {
    const minified = "var a=1;".repeat(25_000);
    const fs = projectFs({ "/proj/src/cart.ts": `${minified}\n` });
    const snippet = await loadSnippet(ROOT, at({ line: 1, snippet: minified.slice(0, 500), snippetCut: true }), fs);
    expect(snippet.state).toBe("ok");
    expect(snippet.lines).toHaveLength(1);
    expect(snippet.lines[0]!.text).toHaveLength(200_000);
    expect(windowLines(snippet, 3)).toEqual([{ n: 1, text: minified, target: true }]);
  });
});

describe("loadSnippet: snippet comparison and moved code", () => {
  it("trims both sides before comparing", () => {
    expect(snippetMatches("  return total;  ", "return total;", false)).toBe(true);
    expect(snippetMatches("return total;", "  return total;\r", false)).toBe(true);
    expect(snippetMatches("return total + 1;", "return total;", false)).toBe(false);
  });

  it("compares a cut snippet (snippetCut) as a prefix", async () => {
    const fs = projectFs({ "/proj/src/cart.ts": CART });
    const cut = await loadSnippet(ROOT, at({ line: 12, snippet: "export async function calc", snippetCut: true }), fs);
    expect(cut.state).toBe("ok");
    const whole = await loadSnippet(ROOT, at({ line: 12, snippet: "export async function calc" }), fs);
    expect(whole.state).toBe("changed-since-trace");
  });

  it("changed-since-trace keeps the window at line when the text is nowhere within ±40", async () => {
    const fs = projectFs({ "/proj/src/cart.ts": CART });
    const snippet = await loadSnippet(ROOT, at({ line: 12, snippet: "function removed() {" }), fs);
    expect(snippet.state).toBe("changed-since-trace");
    expect(snippet.target).toBe(12);
    expect(snippet.movedFrom).toBeUndefined();
    expect(numbers(snippet)).toEqual(range(4, 20));
  });

  it("moved: finds the text after three inserted lines and shifts the endLine range", async () => {
    const shifted = ["// a", "// b", "// c", ...CART_LINES].join("\n");
    const fs = projectFs({ "/proj/src/cart.ts": shifted });
    const snippet = await loadSnippet(ROOT, at({ line: 12, endLine: 20, snippet: HEADER }), fs);
    expect(snippet.state).toBe("moved");
    expect(snippet.target).toBe(15);
    expect(snippet.movedFrom).toBe(12);
    expect(numbers(snippet)).toEqual(range(15, 23));
    expect(snippet.lines[0]!.text).toBe(HEADER);
  });

  it("moved: the nearest match wins, a tie goes to the lower line", async () => {
    const lines = range(1, 30).map((n) => `filler ${n}`);
    lines[20 - 1] = "target();"; // 20 = 15 + 5
    lines[13 - 1] = "target();"; // 13 = 15 - 2 → nearest
    const nearest = await loadSnippet(
      ROOT,
      at({ line: 15, snippet: "target();" }),
      projectFs({ "/proj/src/cart.ts": lines.join("\n") })
    );
    expect([nearest.state, nearest.target]).toEqual(["moved", 13]);

    const tie = range(1, 30).map((n) => `filler ${n}`);
    tie[12 - 1] = "target();"; // 15 - 3
    tie[18 - 1] = "target();"; // 15 + 3
    const lower = await loadSnippet(
      ROOT,
      at({ line: 15, snippet: "target();" }),
      projectFs({ "/proj/src/cart.ts": tie.join("\n") })
    );
    expect([lower.state, lower.target, lower.movedFrom]).toEqual(["moved", 12, 15]);
  });

  it("searches exactly ±40 lines", async () => {
    const lines = range(1, 100).map((n) => `filler ${n}`);
    lines[50 - 1] = "far();"; // 10 + 40
    const within = await loadSnippet(
      ROOT,
      at({ line: 10, snippet: "far();" }),
      projectFs({ "/proj/src/cart.ts": lines.join("\n") })
    );
    expect([within.state, within.target]).toEqual(["moved", 50]);
    const beyond = await loadSnippet(
      ROOT,
      at({ line: 9, snippet: "far();" }),
      projectFs({ "/proj/src/cart.ts": lines.join("\n") })
    );
    expect(beyond.state).toBe("changed-since-trace");
  });

  it("line past the end of the file: changed-since-trace with no lines, or moved when the text is near", async () => {
    const fs = projectFs({ "/proj/src/cart.ts": CART });
    const noSnippet = await loadSnippet(ROOT, at({ line: 30 }), fs);
    expect(noSnippet).toEqual({ state: "changed-since-trace", file: "src/cart.ts", lines: [], target: 30 });
    const notFound = await loadSnippet(ROOT, at({ line: 30, snippet: "gone();" }), fs);
    expect([notFound.state, notFound.lines]).toEqual(["changed-since-trace", []]);
    const near = await loadSnippet(ROOT, at({ line: 30, snippet: "export function emptyTotal() {" }), fs);
    expect([near.state, near.target, near.movedFrom]).toEqual(["moved", 22, 30]);
    const emptyFile = await loadSnippet(ROOT, at({ line: 1 }), projectFs({ "/proj/src/cart.ts": "" }));
    expect(emptyFile.state).toBe("changed-since-trace");
  });
});

describe("loadSnippet: degraded states never throw (Фокус рецензії 4)", () => {
  it("file-missing: no file, a dangling symlink, or the wrong root", async () => {
    expect((await loadSnippet(ROOT, at({ line: 1 }), projectFs({}))).state).toBe("file-missing");
    const dangling = projectFs({ "/proj/src/cart.ts": { link: "/proj/src/gone.ts" } });
    expect((await loadSnippet(ROOT, at({ line: 1 }), dangling)).state).toBe("file-missing");
    const elsewhere = fakeFs({ "/other": { dir: true }, "/proj": { dir: true }, "/proj/src/cart.ts": CART });
    expect((await loadSnippet("/other", at({ line: 12, snippet: HEADER }), elsewhere)).state).toBe("file-missing");
    expect((await loadSnippet("/missing-root", at({ line: 1 }), elsewhere)).state).toBe("file-missing");
  });

  it("outside-root: realpath escapes the root through a symlink, and nothing is read", async () => {
    const fs = fakeFs({
      [ROOT]: { dir: true },
      "/etc/secret.ts": "secret",
      "/proj/src/cart.ts": { link: "/etc/secret.ts" },
      "/project2/src/cart.ts": "sibling",
      "/proj/vendor/x.ts": { link: "/project2/src/cart.ts" }
    });
    expect((await loadSnippet(ROOT, at({ line: 1 }), fs)).state).toBe("outside-root");
    // "/project2" starts with "/proj" but is not under it.
    expect((await loadSnippet(ROOT, at({ file: "vendor/x.ts", line: 1 }), fs)).state).toBe("outside-root");
    expect(fs.reads).toEqual([]);
  });

  it("a root reached through a symlink is compared by its realpath", async () => {
    const fs = fakeFs({
      "/link-root": { link: "/real/proj" },
      "/real/proj": { dir: true },
      "/link-root/src/cart.ts": { link: "/real/proj/src/cart.ts" },
      "/real/proj/src/cart.ts": CART
    });
    expect((await loadSnippet("/link-root", at({ line: 12, snippet: HEADER }), fs)).state).toBe("ok");
  });

  it("too-large: over 2 MiB is never read; exactly 2 MiB is", async () => {
    const big = new Uint8Array(SNIPPET_MAX_FILE_BYTES + 1).fill(0x61);
    const fs = projectFs({ "/proj/src/cart.ts": big });
    expect((await loadSnippet(ROOT, at({ line: 1 }), fs)).state).toBe("too-large");
    expect(fs.reads).toEqual([]);
    const limit = projectFs({ "/proj/src/cart.ts": new Uint8Array(SNIPPET_MAX_FILE_BYTES).fill(0x61) });
    expect((await loadSnippet(ROOT, at({ line: 1 }), limit)).state).toBe("ok");
  });

  it("unreadable: EACCES on read, or a directory at the path", async () => {
    const denied = projectFs({ "/proj/src/cart.ts": { error: "EACCES" } });
    expect((await loadSnippet(ROOT, at({ line: 1 }), denied)).state).toBe("unreadable");
    const dir = projectFs({ "/proj/src/cart.ts": { dir: true } });
    expect((await loadSnippet(ROOT, at({ line: 1 }), dir)).state).toBe("unreadable");
  });

  it("not-text: a NUL byte, invalid UTF-8, or a sequence cut at the end", async () => {
    const cases = [
      new Uint8Array([0x61, 0x00, 0x62, 0x0a]),
      new Uint8Array([0x61, 0xc3, 0x28, 0x0a]),
      new Uint8Array([0x61, 0x0a, 0xe2, 0x82])
    ];
    for (const bytes of cases) {
      const snippet = await loadSnippet(ROOT, at({ line: 1 }), projectFs({ "/proj/src/cart.ts": bytes }));
      expect(snippet).toEqual({ state: "not-text", file: "src/cart.ts", lines: [], target: 1 });
    }
  });
});

describe("windowLines", () => {
  const around = (target: number, first: number, last: number): Snippet => ({
    state: "ok",
    file: "src/cart.ts",
    target,
    lines: range(first, last).map((n) => ({ n, text: `line ${n}` }))
  });

  it("returns every line when they fit", () => {
    expect(windowLines(around(12, 4, 20), 17).map((l) => l.n)).toEqual(range(4, 20));
    expect(windowLines(around(12, 4, 20), 99).map((l) => l.n)).toEqual(range(4, 20));
  });

  it("shrinks the context symmetrically and always keeps the ▶ line", () => {
    expect(windowLines(around(12, 4, 20), 5).map((l) => l.n)).toEqual([10, 11, 12, 13, 14]);
    expect(windowLines(around(12, 4, 20), 4).map((l) => l.n)).toEqual([11, 12, 13, 14]);
    expect(windowLines(around(12, 4, 20), 1)).toEqual([{ n: 12, text: "line 12", target: true }]);
    expect(windowLines(around(12, 4, 20), 0)).toEqual([]);
  });

  it("gives the unused side to the other one near an edge and for an endLine window", () => {
    expect(windowLines(around(2, 1, 10), 5).map((l) => l.n)).toEqual([1, 2, 3, 4, 5]);
    expect(windowLines(around(12, 12, 20), 3).map((l) => l.n)).toEqual([12, 13, 14]);
    expect(windowLines(around(20, 12, 20), 3).map((l) => l.n)).toEqual([18, 19, 20]);
  });

  it("marks only the ▶ line, for every height", () => {
    const snippet = around(12, 4, 20);
    for (let rows = 1; rows <= 20; rows += 1) {
      const shown = windowLines(snippet, rows);
      expect(shown).toHaveLength(Math.min(rows, 17));
      expect(shown.filter((l) => l.target).map((l) => l.n)).toEqual([12]);
      expect(shown.map((l) => l.n)).toEqual(range(shown[0]!.n, shown.at(-1)!.n));
    }
  });

  it("has nothing to show for a snippet without lines", () => {
    expect(windowLines({ state: "file-missing", file: "a.ts", lines: [], target: 3 }, 10)).toEqual([]);
  });
});

describe("expandCodeTabs", () => {
  it("uses a tab stop of 4 and counts wide clusters as two columns", () => {
    expect(expandCodeTabs("\tx")).toBe("    x");
    expect(expandCodeTabs("ab\tx")).toBe("ab  x");
    expect(expandCodeTabs("abcd\tx")).toBe("abcd    x");
    expect(expandCodeTabs("中\tx")).toBe("中  x");
    expect(expandCodeTabs("no tabs")).toBe("no tabs");
  });
});

describe("snippet.ts re-exports", () => {
  it("resolveRoot from root.ts", () => {
    expect(reexportedResolveRoot).toBe(resolveRoot);
  });
});

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
