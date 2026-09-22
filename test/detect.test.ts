import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectTarget,
  discoverProjectCandidates,
  isExplicitPath,
  redactUrl,
  selectProject,
  sniffFileKind,
  type DetectContext
} from "../src/detect.js";
import { SQLITE_HEADER, fakeFs } from "./helpers.js";

const cwd = "/work/app";
function ctx(files: Record<string, string | null> = {}, calls: string[] = []): DetectContext {
  return { cwd, homedir: "/home/me", fs: fakeFs(files, calls) };
}

describe("detectTarget", () => {
  it("absent target is the cwd live project, '-' is stdin", async () => {
    expect(await detectTarget(undefined, ctx())).toEqual({ ok: true, target: { kind: "live-project" } });
    expect(await detectTarget("-", ctx())).toEqual({ ok: true, target: { kind: "stdin" } });
  });

  it("scenario: short opaque id t_9f is a valid traceId; ./missing.json is a usage error", async () => {
    expect(await detectTarget("t_9f", ctx())).toEqual({ ok: true, target: { kind: "live-trace", traceId: "t_9f" } });
    expect(await detectTarget("a", ctx())).toEqual({ ok: true, target: { kind: "live-trace", traceId: "a" } });
    const missing = await detectTarget("./missing.json", ctx());
    expect(missing).toMatchObject({ ok: false, code: "missing-path", exitCode: 1 });
  });

  it("never turns a missing explicit path into a traceId", async () => {
    for (const target of [
      "./x",
      "../x",
      "/abs/x",
      "~/x.json",
      "missing.json",
      "store.sqlite",
      "db.sqlite3",
      "a.db",
      "dir/file",
      ".\\win.json",
      "C:\\x\\y"
    ]) {
      const result = await detectTarget(target, ctx());
      expect(result, target).toMatchObject({ ok: false, code: "missing-path", exitCode: 1 });
    }
  });

  it("sniffs file content rather than trusting the extension", async () => {
    const files = {
      "/work/app/export.json": '  {"formatVersion":1}',
      "/work/app/store.sqlite": `${SQLITE_HEADER}rest`,
      "/work/app/actually-sqlite.json": `${SQLITE_HEADER}rest`,
      "/work/app/dump": "\ufeff{\n}",
      "/work/app/bad.json": "not json at all",
      "/work/app/array.json": "[1,2]",
      "/work/app/folder": null,
      "/home/me/traces/e.json": "{}"
    };
    expect(await detectTarget("./export.json", ctx(files))).toEqual({
      ok: true,
      target: { kind: "export", path: "/work/app/export.json" }
    });
    expect(await detectTarget("store.sqlite", ctx(files))).toEqual({
      ok: true,
      target: { kind: "sqlite", path: "/work/app/store.sqlite" }
    });
    expect(await detectTarget("./actually-sqlite.json", ctx(files))).toMatchObject({
      ok: true,
      target: { kind: "sqlite" }
    });
    expect(await detectTarget("dump", ctx(files))).toEqual({
      ok: true,
      target: { kind: "export", path: "/work/app/dump" }
    });
    expect(await detectTarget("~/traces/e.json", ctx(files))).toEqual({
      ok: true,
      target: { kind: "export", path: "/home/me/traces/e.json" }
    });
    expect(await detectTarget("./bad.json", ctx(files))).toMatchObject({
      ok: false,
      code: "unrecognized-file",
      exitCode: 2
    });
    expect(await detectTarget("./array.json", ctx(files))).toMatchObject({
      ok: false,
      code: "unrecognized-file",
      exitCode: 2
    });
    expect(await detectTarget("./folder", ctx(files))).toMatchObject({ ok: false, code: "not-a-file", exitCode: 1 });
    expect(await detectTarget("folder", ctx(files))).toMatchObject({ ok: false, code: "not-a-file" });
  });

  it("an existing bare file name wins over a traceId of the same text", async () => {
    const files = { "/work/app/t_9f": "{}" };
    expect(await detectTarget("t_9f", ctx(files))).toMatchObject({ ok: true, target: { kind: "export" } });
  });

  it("accepts http(s) endpoints and rejects credentials without echoing them", async () => {
    expect(await detectTarget("http://127.0.0.1:4318/", ctx())).toEqual({
      ok: true,
      target: { kind: "live-endpoint", url: "http://127.0.0.1:4318/" }
    });
    expect(await detectTarget("https://daemon.local/base#frag", ctx())).toEqual({
      ok: true,
      target: { kind: "live-endpoint", url: "https://daemon.local/base" }
    });

    const userinfo = await detectTarget("http://alice:s3cr3t@127.0.0.1:4318", ctx());
    expect(userinfo).toMatchObject({ ok: false, code: "endpoint-credentials", exitCode: 1 });
    if (!userinfo.ok) expect(userinfo.message).not.toMatch(/s3cr3t|alice/);

    const query = await detectTarget("http://127.0.0.1:4318/?token=abc123&x=1", ctx());
    expect(query).toMatchObject({ ok: false, code: "endpoint-credentials" });
    if (!query.ok) expect(query.message).not.toContain("abc123");

    expect(await detectTarget("http://h/?access_token=zz", ctx())).toMatchObject({
      ok: false,
      code: "endpoint-credentials"
    });
    expect(await detectTarget("ftp://h/x", ctx())).toMatchObject({
      ok: false,
      code: "unsupported-scheme",
      exitCode: 1
    });
    expect(await detectTarget("http://", ctx())).toMatchObject({ ok: false, code: "invalid-endpoint" });
  });

  it("does not touch the filesystem for stdin, URLs or absent targets", async () => {
    const calls: string[] = [];
    await detectTarget("-", ctx({}, calls));
    await detectTarget(undefined, ctx({}, calls));
    await detectTarget("http://127.0.0.1:1/", ctx({}, calls));
    expect(calls).toEqual([]);
  });

  it("rejects empty, whitespace and control-character targets", async () => {
    expect(await detectTarget("", ctx())).toMatchObject({ ok: false, code: "empty-target" });
    expect(await detectTarget("two words", ctx())).toMatchObject({ ok: false, code: "invalid-target" });
    expect(await detectTarget("t\u001b[2J", ctx())).toMatchObject({ ok: false, code: "invalid-target" });
  });

  it("is deterministic for the same inputs", async () => {
    const files = { "/work/app/export.json": "{}", "/work/app/s.sqlite": SQLITE_HEADER };
    for (const target of ["t_9f", "./export.json", "s.sqlite", "./missing.json", "http://a:b@h/", "-"]) {
      const a = await detectTarget(target, ctx(files));
      const b = await detectTarget(target, ctx(files));
      expect(b).toEqual(a);
    }
  });
});

describe("helpers", () => {
  it("isExplicitPath", () => {
    expect(isExplicitPath("t_9f")).toBe(false);
    expect(isExplicitPath("sql")).toBe(false);
    expect(isExplicitPath("./t_9f")).toBe(true);
    expect(isExplicitPath("TRACE.JSON")).toBe(true);
  });
  it("sniffFileKind", () => {
    expect(sniffFileKind(new TextEncoder().encode(SQLITE_HEADER))).toBe("sqlite");
    expect(sniffFileKind(new TextEncoder().encode("SQLite format 2"))).toBeUndefined();
    expect(sniffFileKind(new TextEncoder().encode("\n\t {"))).toBe("export");
    expect(sniffFileKind(new Uint8Array())).toBeUndefined();
  });
  it("redactUrl hides userinfo and token query values", () => {
    const redacted = redactUrl("http://u:p@h/?token=abc&keep=1");
    expect(redacted).not.toMatch(/u:p|abc/);
    expect(redacted).toContain("keep=1");
  });
});

describe("project ambiguity", () => {
  const configs: Record<string, string> = { "/work/app": "shop", "/work": "monorepo" };
  const readConfig = async (dir: string) => (configs[dir] ? { projectId: configs[dir]! } : undefined);

  it("collects every candidate up the tree", async () => {
    const candidates = await discoverProjectCandidates({ cwd: "/work/app/src", readConfig });
    expect(candidates.map((c) => c.projectId)).toEqual(["shop", "monorepo"]);
    expect(candidates[0]!.configPath).toBe(path.join("/work/app", ".kosmo-callflow", "project.json"));
  });

  it("is an error without --project, resolved with it", async () => {
    const candidates = await discoverProjectCandidates({ cwd: "/work/app", readConfig });
    const ambiguous = selectProject(candidates);
    expect(ambiguous).toMatchObject({ ok: false, code: "ambiguous-project" });
    if (!ambiguous.ok) expect(ambiguous.message).toContain("--project");
    expect(selectProject(candidates, "monorepo")).toMatchObject({
      ok: true,
      project: { projectId: "monorepo", root: "/work" }
    });
    expect(selectProject(candidates, "nope")).toMatchObject({ ok: false, code: "unknown-project" });
    expect(selectProject([])).toEqual({ ok: true, project: null });
    const twins = [
      { projectId: "x", root: "/a", configPath: "/a/.kosmo-callflow/project.json" },
      { projectId: "x", root: "/b", configPath: "/b/.kosmo-callflow/project.json" }
    ];
    expect(selectProject(twins, "x")).toMatchObject({ ok: false, code: "ambiguous-project" });
  });
});
