import { describe, expect, it } from "vitest";
import {
  RECENT_MAX,
  isTraceFileName,
  loadStartRows,
  readRecent,
  recentPath,
  recentRows,
  recordRecent,
  scanTraces,
  type StartDirent,
  type StartFs
} from "../../src/start.js";

type Node =
  | { kind: "file"; text: string; mtimeMs: number }
  | { kind: "dir" }
  | { kind: "symlink"; to: string }
  | { kind: "denied" };

/**
 * In-memory StartFs over absolute POSIX paths. Directories are implied by their children
 * or listed explicitly; every call is logged so tests can prove what was (not) touched.
 */
function memoryFs(initial: Record<string, Node>, options: { failWrite?: boolean; failRename?: boolean } = {}) {
  const nodes = new Map<string, Node>(Object.entries(initial));
  const calls: string[] = [];
  const resolve = (p: string): Node | undefined => {
    const node = nodes.get(p);
    return node?.kind === "symlink" ? nodes.get(node.to) : node;
  };
  const isDir = (p: string) =>
    nodes.get(p)?.kind === "dir" || [...nodes.keys()].some((key) => key.startsWith(p.endsWith("/") ? p : `${p}/`));
  const error = (code: string) => Object.assign(new Error(code), { code });
  const fs: StartFs = {
    async readdir(dir) {
      calls.push(`readdir ${dir}`);
      if (nodes.get(dir)?.kind === "denied") throw error("EACCES");
      if (!isDir(dir)) throw error("ENOENT");
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const names = new Set<string>();
      for (const key of nodes.keys()) if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0]!);
      return [...names].map((name): StartDirent => {
        const full = prefix + name;
        const node = nodes.get(full);
        if (node === undefined || node.kind === "dir" || node.kind === "denied") return { name, kind: "dir" };
        return { name, kind: node.kind };
      });
    },
    async stat(p) {
      calls.push(`stat ${p}`);
      const node = resolve(p);
      if (node === undefined) return isDir(p) ? { size: 0, mtimeMs: 0, isFile: false } : undefined;
      if (node.kind === "file")
        return { size: new TextEncoder().encode(node.text).length, mtimeMs: node.mtimeMs, isFile: true };
      return { size: 0, mtimeMs: 0, isFile: false };
    },
    async readFile(p, maxBytes) {
      calls.push(`readFile ${p}`);
      const node = resolve(p);
      if (node?.kind !== "file") throw error("ENOENT");
      if (new TextEncoder().encode(node.text).length > maxBytes) throw error("E2BIG");
      return node.text;
    },
    async writeFile(p, text) {
      calls.push(`writeFile ${p}`);
      if (options.failWrite) throw error("ENOSPC");
      nodes.set(p, { kind: "file", text, mtimeMs: 1 });
    },
    async rename(from, to) {
      calls.push(`rename ${from} -> ${to}`);
      if (options.failRename) throw error("EXDEV");
      const node = nodes.get(from);
      if (node === undefined) throw error("ENOENT");
      nodes.delete(from);
      nodes.set(to, node);
    },
    async mkdir(dir) {
      calls.push(`mkdir ${dir}`);
      if (!isDir(dir)) nodes.set(dir, { kind: "dir" });
    },
    async rm(p) {
      calls.push(`rm ${p}`);
      nodes.delete(p);
    }
  };
  return { fs, calls, nodes, text: (p: string) => (nodes.get(p) as { text?: string } | undefined)?.text };
}

const file = (mtimeMs: number, text = "x"): Node => ({ kind: "file", text, mtimeMs });

describe("scanTraces (spec 6.1)", () => {
  const tree = () =>
    memoryFs({
      "/w/a.kosmo-trace.json": file(10),
      "/w/traces/checkout-bug.kosmo-trace.json": file(30, "0123456789"),
      "/w/traces/cart.kosmo-trace.sqlite": file(20),
      "/w/traces/2026/day.kosmo-trace.ndjson": file(20),
      "/w/traces/2026/deeper/too-deep.kosmo-trace.json": file(99),
      "/w/node_modules/pkg/x.kosmo-trace.json": file(99),
      "/w/.git/x.kosmo-trace.json": file(99),
      "/w/.cache/x.kosmo-trace.json": file(99),
      "/w/notes.json": file(99),
      "/w/x.kosmo-trace.txt": file(99),
      "/w/dir.kosmo-trace.json/inner.kosmo-trace.json": file(5),
      "/w/link.kosmo-trace.json": { kind: "symlink", to: "/elsewhere/real.kosmo-trace.json" },
      "/elsewhere/real.kosmo-trace.json": file(15),
      "/w/loop": { kind: "symlink", to: "/w" }
    });

  it("finds the three extensions at depth 0–2, skipping node_modules, .git and hidden directories", async () => {
    const { fs } = tree();
    const rows = await scanTraces("/w", fs);
    expect(rows.map((row) => row.path)).toEqual([
      "traces/checkout-bug.kosmo-trace.json",
      "traces/2026/day.kosmo-trace.ndjson",
      "traces/cart.kosmo-trace.sqlite",
      "link.kosmo-trace.json",
      "a.kosmo-trace.json",
      "dir.kosmo-trace.json/inner.kosmo-trace.json"
    ]);
  });

  it("rows carry size and mtime only, newest first, ties by path", async () => {
    const { fs } = tree();
    const rows = await scanTraces("/w", fs);
    expect(rows[0]).toEqual({
      path: "traces/checkout-bug.kosmo-trace.json",
      size: 10,
      mtimeMs: 30,
      source: "found",
      missing: false
    });
    expect(rows.map((row) => row.mtimeMs)).toEqual([30, 20, 20, 15, 10, 5]);
  });

  it("never opens a file: only readdir and stat", async () => {
    const { fs, calls } = tree();
    await scanTraces("/w", fs);
    expect(calls.every((call) => call.startsWith("readdir ") || call.startsWith("stat "))).toBe(true);
    expect(calls).not.toContain("readdir /w/traces/2026/deeper");
    expect(calls).not.toContain("readdir /w/loop");
    expect(calls).not.toContain("stat /w/notes.json");
  });

  it("skips unreadable directories and survives an unreadable cwd", async () => {
    const { fs } = memoryFs({ "/w/locked": { kind: "denied" }, "/w/ok.kosmo-trace.json": file(1) });
    expect((await scanTraces("/w", fs)).map((row) => row.path)).toEqual(["ok.kosmo-trace.json"]);
    const { fs: denied } = memoryFs({ "/w": { kind: "denied" } });
    expect(await scanTraces("/w", denied)).toEqual([]);
  });

  it("matches names by the full suffix", () => {
    expect(isTraceFileName("a.kosmo-trace.json")).toBe(true);
    expect(isTraceFileName("a.kosmo-trace.ndjson")).toBe(true);
    expect(isTraceFileName("a.kosmo-trace.sqlite")).toBe(true);
    expect(isTraceFileName("a.kosmo-trace.json.bak")).toBe(false);
    expect(isTraceFileName("kosmo-trace.json")).toBe(false);
    expect(isTraceFileName("a.trace.json")).toBe(false);
  });
});

describe("recent.json location", () => {
  it("uses XDG_CONFIG_HOME when it is an absolute path, else ~/.config", () => {
    expect(recentPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/me")).toBe("/xdg/kosmo-tui/recent.json");
    expect(recentPath({}, "/home/me")).toBe("/home/me/.config/kosmo-tui/recent.json");
    expect(recentPath({ XDG_CONFIG_HOME: "" }, "/home/me")).toBe("/home/me/.config/kosmo-tui/recent.json");
    expect(recentPath({ XDG_CONFIG_HOME: "rel/dir" }, "/home/me")).toBe("/home/me/.config/kosmo-tui/recent.json");
    // No home: only $XDG_CONFIG_HOME keeps recent.json; without it recent.json is disabled.
    expect(recentPath({ XDG_CONFIG_HOME: "/xdg" }, null)).toBe("/xdg/kosmo-tui/recent.json");
    expect(recentPath({}, null)).toBeNull();
    expect(recentPath({ XDG_CONFIG_HOME: "rel/dir" }, null)).toBeNull();
    expect(recentPath({}, "")).toBeNull();
  });
});

describe("readRecent", () => {
  const RECENT = "/cfg/kosmo-tui/recent.json";

  it("reads path + openedAt entries in file order", async () => {
    const { fs } = memoryFs({
      [RECENT]: file(
        1,
        JSON.stringify([{ path: "/a.kosmo-trace.json", openedAt: "2026-09-24T10:00:00.000Z", extra: 1 }])
      )
    });
    expect(await readRecent(RECENT, fs)).toEqual([
      { path: "/a.kosmo-trace.json", openedAt: "2026-09-24T10:00:00.000Z" }
    ]);
  });

  it("tolerates a missing, corrupt, oversized or wrongly shaped file", async () => {
    for (const text of ["{not json", '{"path":"/a"}', "null", `[${" ".repeat(70_000)}]`]) {
      const { fs } = memoryFs({ [RECENT]: file(1, text) });
      expect(await readRecent(RECENT, fs)).toEqual([]);
    }
    expect(await readRecent(RECENT, memoryFs({}).fs)).toEqual([]);
  });

  it("drops malformed, relative and duplicate entries and keeps at most 20", async () => {
    const good = Array.from({ length: 25 }, (_, i) => ({
      path: `/t/${i}.kosmo-trace.json`,
      openedAt: "2026-01-01T00:00:00.000Z"
    }));
    const items = [
      null,
      7,
      { path: "relative.json", openedAt: "x" },
      { path: "/t/0.kosmo-trace.json" },
      good[0],
      good[0],
      ...good
    ];
    const { fs } = memoryFs({ [RECENT]: file(1, JSON.stringify(items)) });
    const entries = await readRecent(RECENT, fs);
    expect(entries).toHaveLength(RECENT_MAX);
    expect(entries.map((entry) => entry.path)).toEqual(good.slice(0, 20).map((entry) => entry.path));
  });
});

describe("recentRows", () => {
  it("flags missing files and stats the others", async () => {
    const { fs } = memoryFs({ "/t/here.kosmo-trace.json": file(42, "abc") });
    const rows = await recentRows(
      [
        { path: "/t/here.kosmo-trace.json", openedAt: "2026-09-24T10:00:00.000Z" },
        { path: "/t/gone.kosmo-trace.ndjson", openedAt: "2026-09-23T10:00:00.000Z" }
      ],
      fs
    );
    expect(rows).toEqual([
      { path: "/t/here.kosmo-trace.json", size: 3, mtimeMs: 42, source: "recent", missing: false },
      { path: "/t/gone.kosmo-trace.ndjson", size: null, mtimeMs: null, source: "recent", missing: true }
    ]);
  });
});

describe("recordRecent", () => {
  const RECENT = "/cfg/kosmo-tui/recent.json";
  const now = new Date("2026-09-25T08:00:00.000Z");

  it("writes a temp file in the same directory and renames it over recent.json", async () => {
    const { fs, calls, text } = memoryFs({});
    const result = await recordRecent(
      { file: RECENT, opened: "traces/a.kosmo-trace.json", cwd: "/w", now, readOnly: false, tmpToken: "t1" },
      fs
    );
    expect(result).toBe("written");
    expect(calls.filter((call) => !call.startsWith("readFile"))).toEqual([
      "mkdir /cfg/kosmo-tui",
      "writeFile /cfg/kosmo-tui/recent.json.t1.tmp",
      "rename /cfg/kosmo-tui/recent.json.t1.tmp -> /cfg/kosmo-tui/recent.json"
    ]);
    expect(JSON.parse(text(RECENT)!)).toEqual([
      { path: "/w/traces/a.kosmo-trace.json", openedAt: "2026-09-25T08:00:00.000Z" }
    ]);
  });

  it("moves a reopened path to the front and keeps at most 20 entries with only path and openedAt", async () => {
    const old = Array.from({ length: 20 }, (_, i) => ({
      path: `/t/${i}.kosmo-trace.json`,
      openedAt: "2026-01-01T00:00:00.000Z"
    }));
    const { fs, text } = memoryFs({ [RECENT]: file(1, JSON.stringify(old)) });
    await recordRecent({ file: RECENT, opened: "/t/5.kosmo-trace.json", cwd: "/w", now, readOnly: false }, fs);
    let written = JSON.parse(text(RECENT)!) as Array<Record<string, string>>;
    expect(written).toHaveLength(20);
    expect(written[0]).toEqual({ path: "/t/5.kosmo-trace.json", openedAt: "2026-09-25T08:00:00.000Z" });
    expect(written.filter((entry) => entry.path === "/t/5.kosmo-trace.json")).toHaveLength(1);

    await recordRecent({ file: RECENT, opened: "/t/new.kosmo-trace.json", cwd: "/w", now, readOnly: false }, fs);
    written = JSON.parse(text(RECENT)!) as Array<Record<string, string>>;
    expect(written).toHaveLength(20);
    expect(written[0]!.path).toBe("/t/new.kosmo-trace.json");
    expect(written.map((entry) => entry.path)).not.toContain("/t/19.kosmo-trace.json");
    for (const entry of written) expect(Object.keys(entry).sort()).toEqual(["openedAt", "path"]);
  });

  it("-r (readOnly) touches nothing", async () => {
    const { fs, calls } = memoryFs({});
    expect(
      await recordRecent({ file: RECENT, opened: "/a.kosmo-trace.json", cwd: "/w", now, readOnly: true }, fs)
    ).toBe("skipped");
    expect(calls).toEqual([]);
  });

  it("replaces a corrupt recent.json with a fresh list", async () => {
    const { fs, text } = memoryFs({ [RECENT]: file(1, "{garbage") });
    expect(
      await recordRecent({ file: RECENT, opened: "/a.kosmo-trace.json", cwd: "/w", now, readOnly: false }, fs)
    ).toBe("written");
    expect(JSON.parse(text(RECENT)!)).toEqual([{ path: "/a.kosmo-trace.json", openedAt: "2026-09-25T08:00:00.000Z" }]);
  });

  it("reports failure without throwing and removes the temp file; recent.json stays as it was", async () => {
    const before = JSON.stringify([{ path: "/old.kosmo-trace.json", openedAt: "2026-01-01T00:00:00.000Z" }]);
    const renameFails = memoryFs({ [RECENT]: file(1, before) }, { failRename: true });
    const input = { file: RECENT, opened: "/a.kosmo-trace.json", cwd: "/w", now, readOnly: false, tmpToken: "t2" };
    expect(await recordRecent(input, renameFails.fs)).toBe("failed");
    expect(renameFails.text(RECENT)).toBe(before);
    expect(renameFails.nodes.has(`${RECENT}.t2.tmp`)).toBe(false);
    expect(renameFails.calls).toContain(`rm ${RECENT}.t2.tmp`);

    const writeFails = memoryFs({}, { failWrite: true });
    expect(await recordRecent(input, writeFails.fs)).toBe("failed");
  });
});

describe("loadStartRows", () => {
  it("lists found rows, then recent rows", async () => {
    const { fs } = memoryFs({
      "/w/a.kosmo-trace.json": file(10),
      "/home/me/.config/kosmo-tui/recent.json": file(
        1,
        JSON.stringify([{ path: "/tmp/crash.kosmo-trace.ndjson", openedAt: "2026-09-24T10:00:00.000Z" }])
      )
    });
    const rows = await loadStartRows({ cwd: "/w", env: {}, home: "/home/me" }, fs);
    expect(rows.map((row) => [row.source, row.path, row.missing])).toEqual([
      ["found", "a.kosmo-trace.json", false],
      ["recent", "/tmp/crash.kosmo-trace.ndjson", true]
    ]);
  });
});
