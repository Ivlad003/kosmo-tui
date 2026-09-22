import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  name: string;
  type: string;
  bin: Record<string, string>;
  engines: { node: string };
  files: string[];
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
};

const ALLOWED = [
  "@kosmo-callflow/protocol",
  "@kosmo-callflow/query",
  "@kosmo-callflow/replay",
  "@kosmo-callflow/trace-artifacts",
  "@kosmo-callflow/trace-diff"
];

describe("package boundary (spec: Окремий проєкт і опублікована межа)", () => {
  it("declares the bin, ESM, Node >=18.19.0 and published files", () => {
    expect(pkg.name).toBe("kosmo-tui");
    expect(pkg.type).toBe("module");
    expect(pkg.bin).toEqual({ "kosmo-tui": "bin/kosmo-tui.js" });
    expect(pkg.engines.node).toBe(">=18.19.0");
    expect(pkg.files).toEqual(["dist", "bin"]);
  });

  it("limits runtime dependencies to the five @kosmo-callflow packages", () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual(ALLOWED);
  });

  it("has better-sqlite3 as the only, optional, peer", () => {
    expect(Object.keys(pkg.peerDependencies)).toEqual(["better-sqlite3"]);
    expect(pkg.peerDependenciesMeta["better-sqlite3"]?.optional).toBe(true);
  });

  it("source never imports UI/CLI/daemon packages or terminal UI frameworks", () => {
    const forbidden =
      /from\s+["'](react|ink|blessed|kosmo-callflow|@kosmo-callflow\/(cli|ui|daemon|mcp|sdk-[\w-]+))(["'/])/;
    for (const file of readdirSync(path.join(root, "src"))) {
      const text = readFileSync(path.join(root, "src", file), "utf8");
      expect(text, file).not.toMatch(forbidden);
    }
  });

  it("the declared @kosmo-callflow packages resolve and expose the APIs D11 relies on", async () => {
    const replay = await import("@kosmo-callflow/replay");
    const diff = await import("@kosmo-callflow/trace-diff");
    const artifacts = await import("@kosmo-callflow/trace-artifacts");
    const query = await import("@kosmo-callflow/query");
    const protocol = await import("@kosmo-callflow/protocol");
    expect(typeof replay.seekReplay).toBe("function");
    expect(typeof replay.replayTo).toBe("function");
    expect(typeof replay.importPortableExport).toBe("function");
    expect(typeof diff.diffTraces).toBe("function");
    expect(typeof artifacts.maskArtifactText).toBe("function");
    expect(typeof artifacts.relativeArtifactPath).toBe("function");
    expect(typeof query.parseQueryExpression).toBe("function");
    expect(Object.keys(protocol).length).toBeGreaterThan(0);
  });
});

describe("bin launcher", () => {
  it("runs dist/cli.js through run(process, {})", () => {
    expect(existsSync(path.join(root, "dist", "cli.js")), "run `npm run build` first").toBe(true);
    const help = spawnSync(process.execPath, [path.join(root, "bin", "kosmo-tui.js"), "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage:");
    const bad = spawnSync(process.execPath, [path.join(root, "bin", "kosmo-tui.js"), "./definitely-missing.json"], {
      encoding: "utf8",
      cwd: root
    });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toMatch(/does not exist/);
    const version = spawnSync(process.execPath, [path.join(root, "bin", "kosmo-tui.js"), "--version"], {
      encoding: "utf8"
    });
    expect(version.stdout.trim()).toBe((pkg as unknown as { version: string }).version);
  });
});
