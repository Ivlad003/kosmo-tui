import { describe, expect, it } from "vitest";
import {
  contextToken,
  readLaunchContext,
  TUI_CONTEXT_ENV,
  TUI_PROJECT_DIR_ENV,
  TUI_TOKEN_ENV
} from "../src/context.js";

const SECRET = "tui-private-token-7f3a";

function contextJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    source: "kosmo-callflow connect",
    projectId: "p",
    projectDir: "/work/app",
    endpoint: "http://127.0.0.1:41729",
    endpointExplicit: false,
    allowedCollectorOrigins: ["http://127.0.0.1:41729"],
    auth: { kind: "token-file", path: "/work/app/.kosmo-callflow/project-token" },
    ...overrides
  });
}

describe("KOSMO_TUI_CONTEXT v1 (boundary §1.9)", () => {
  it("is absent when not launched by connect", () => {
    expect(readLaunchContext({})).toEqual({ ok: true, context: null, projectDir: null });
    expect(readLaunchContext({ [TUI_PROJECT_DIR_ENV]: "/work/app" })).toEqual({
      ok: true,
      context: null,
      projectDir: "/work/app"
    });
  });

  it("parses the documented schema with each auth kind", () => {
    const read = readLaunchContext({ [TUI_CONTEXT_ENV]: contextJson(), [TUI_PROJECT_DIR_ENV]: "/work/app" });
    expect(read).toMatchObject({
      ok: true,
      projectDir: "/work/app",
      context: {
        projectId: "p",
        endpoint: "http://127.0.0.1:41729/",
        allowedCollectorOrigins: ["http://127.0.0.1:41729"],
        auth: { kind: "token-file", path: "/work/app/.kosmo-callflow/project-token" }
      }
    });
    const env = readLaunchContext({
      [TUI_CONTEXT_ENV]: contextJson({ auth: { kind: "env", variable: TUI_TOKEN_ENV }, projectId: null })
    });
    expect(env).toMatchObject({ ok: true, context: { projectId: null, auth: { kind: "env" } } });
    expect(readLaunchContext({ [TUI_CONTEXT_ENV]: contextJson({ auth: { kind: "none" } }) })).toMatchObject({
      ok: true,
      context: { auth: { kind: "none" } }
    });
  });

  it.each([
    ["not JSON", "{nope", /not valid JSON/],
    ["future version", contextJson({ v: 2 }), /unsupported version 2/],
    ["extra field (a smuggled token)", contextJson({ token: SECRET }), /unknown field\(s\) token/],
    ["relative project dir", contextJson({ projectDir: "app" }), /projectDir/],
    ["endpoint with credentials", contextJson({ endpoint: `http://u:${SECRET}@127.0.0.1:41729` }), /endpoint rejected/],
    [
      "endpoint with token query",
      contextJson({ endpoint: `http://127.0.0.1:41729/?token=${SECRET}` }),
      /endpoint rejected/
    ],
    [
      "endpoint outside the allowed origins",
      contextJson({ allowedCollectorOrigins: ["http://127.0.0.1:1"] }),
      /not in allowedCollectorOrigins/
    ],
    ["relative token path", contextJson({ auth: { kind: "token-file", path: "project-token" } }), /absolute/],
    ["env auth naming another variable", contextJson({ auth: { kind: "env", variable: "HOME" } }), /KOSMO_TUI_TOKEN/]
  ])("rejects %s explicitly and never echoes a secret", (_label, raw, pattern) => {
    const read = readLaunchContext({ [TUI_CONTEXT_ENV]: raw, [TUI_TOKEN_ENV]: SECRET });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.message).toMatch(pattern);
    expect(read.message).not.toContain(SECRET);
  });

  it("rejects a project dir that disagrees with KOSMO_PROJECT_DIR", () => {
    const read = readLaunchContext({ [TUI_CONTEXT_ENV]: contextJson(), [TUI_PROJECT_DIR_ENV]: "/elsewhere" });
    expect(read).toMatchObject({ ok: false, message: expect.stringContaining(TUI_PROJECT_DIR_ENV) });
  });

  it("reads the private token only for auth.kind=env and never puts it in the context", () => {
    const env = {
      [TUI_CONTEXT_ENV]: contextJson({ auth: { kind: "env", variable: TUI_TOKEN_ENV } }),
      [TUI_TOKEN_ENV]: SECRET
    };
    const read = readLaunchContext(env);
    expect(read.ok).toBe(true);
    if (!read.ok || read.context === null) return;
    expect(JSON.stringify(read)).not.toContain(SECRET);
    expect(contextToken(read.context, env)).toEqual({ ok: true, token: SECRET });

    const missing = contextToken(read.context, { [TUI_CONTEXT_ENV]: env[TUI_CONTEXT_ENV] });
    expect(missing).toMatchObject({ ok: false });

    const fileAuth = readLaunchContext({ [TUI_CONTEXT_ENV]: contextJson() });
    if (!fileAuth.ok || fileAuth.context === null) throw new Error("expected a context");
    // A token in the environment is ignored when the context says the token is in a file.
    expect(contextToken(fileAuth.context, { [TUI_TOKEN_ENV]: SECRET })).toEqual({ ok: true, token: undefined });
  });
});

describe("the private token does not outlive the read in process.env (review)", () => {
  it("removes KOSMO_TUI_TOKEN from process.env, keeps it in memory, and later children never see it", async () => {
    const { spawnSync } = await import("node:child_process");
    const saved = { context: process.env[TUI_CONTEXT_ENV], token: process.env[TUI_TOKEN_ENV] };
    try {
      process.env[TUI_CONTEXT_ENV] = contextJson({ auth: { kind: "env", variable: TUI_TOKEN_ENV } });
      process.env[TUI_TOKEN_ENV] = SECRET;
      const read = readLaunchContext(process.env);
      if (!read.ok || read.context === null) throw new Error("expected a context");
      // Reading the context already takes the token out of the environment.
      expect(process.env[TUI_TOKEN_ENV]).toBeUndefined();
      expect(contextToken(read.context, process.env)).toEqual({ ok: true, token: SECRET });
      // Asked again (a reload), the in-memory copy still answers.
      expect(contextToken(read.context, process.env)).toEqual({ ok: true, token: SECRET });
      const child = spawnSync(
        process.execPath,
        ["-e", "process.stdout.write(process.env.KOSMO_TUI_TOKEN ?? 'absent')"],
        {
          encoding: "utf8"
        }
      );
      expect(child.stdout).toBe("absent");
    } finally {
      if (saved.context === undefined) delete process.env[TUI_CONTEXT_ENV];
      else process.env[TUI_CONTEXT_ENV] = saved.context;
      if (saved.token === undefined) delete process.env[TUI_TOKEN_ENV];
      else process.env[TUI_TOKEN_ENV] = saved.token;
    }
  });
});
