import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
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
  overrides: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
  publishConfig?: { access?: string };
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
    expect(pkg.name).toBe("@ivlad003/kosmo-tui");
    expect(pkg.type).toBe("module");
    expect(pkg.publishConfig?.access).toBe("public");
    expect(pkg.bin).toEqual({ "kosmo-tui": "bin/kosmo-tui.js" });
    expect(pkg.engines.node).toBe(">=18.19.0");
    expect(pkg.files).toEqual(["dist", "bin"]);
  });

  it("limits runtime dependencies to the five @kosmo-callflow packages", () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual(ALLOWED);
  });

  it("pins every @kosmo-callflow dependency to a kosmo-callflow tarball (1.11), overrides included", () => {
    for (const name of ALLOWED) {
      expect(pkg.dependencies[name]).toBe(
        `file:../kosmo-callflow/artifacts/tarballs/${name.slice(1).replace("/", "-")}.tgz`
      );
      // Transitive @kosmo-callflow edges (query -> protocol/replay/trace-artifacts) follow the same pin,
      // so none can resolve to a stale registry copy.
      expect(pkg.overrides[name]).toBe(`$${name}`);
    }
  });

  it("the lockfile installs each @kosmo-callflow package once, from its tarball, never from a registry or link", () => {
    const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8")) as {
      packages: Record<string, { resolved?: string; integrity?: string; link?: boolean }>;
    };
    const entries = Object.entries(lock.packages).filter(([key]) => key.includes("@kosmo-callflow/"));
    expect(entries.map(([key]) => key).sort()).toEqual(ALLOWED.map((name) => `node_modules/${name}`));
    for (const [key, entry] of entries) {
      expect(entry.link, key).toBeUndefined();
      expect(entry.resolved, key).toBe(pkg.dependencies[key.slice("node_modules/".length)]);
      expect(entry.integrity, key).toMatch(/^sha512-/);
    }
  });

  it("resolves the installed tarball contents, not kosmo-callflow workspace sources", () => {
    const require = createRequire(path.join(root, "package.json"));
    for (const name of ALLOWED) {
      const dir = path.join(root, "node_modules", name);
      expect(lstatSync(dir).isSymbolicLink(), `${name} is a workspace link`).toBe(false);
      expect(existsSync(path.join(dir, "src")), `${name} ships src/`).toBe(false);
      const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
        exports: Record<string, unknown>;
      };
      for (const subpath of Object.keys(manifest.exports)) {
        if (subpath.includes("*") || subpath === "./package.json") continue;
        const specifier = subpath === "." ? name : `${name}/${subpath.slice(2)}`;
        const resolved = realpathSync(require.resolve(specifier, { paths: [root] }));
        expect(resolved.startsWith(realpathSync(dir) + path.sep), `${specifier} -> ${resolved}`).toBe(true);
      }
    }
    const fixtures = require.resolve("@kosmo-callflow/protocol/fixtures/manifest.json");
    expect(realpathSync(fixtures)).toBe(
      realpathSync(path.join(root, "node_modules/@kosmo-callflow/protocol/fixtures/manifest.json"))
    );
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

// Cross-repo CI (8.3): each matrix cell declares its SQLite driver situation and the built bin must
// follow it on the real runtime — no injected probe. Unset outside the CI/local matrix.
const SQLITE_CELL = process.env.KOSMO_TUI_SQLITE_CELL as "none" | "builtin" | "native" | undefined;
const bin = (args: string[], input?: string) =>
  spawnSync(process.execPath, [path.join(root, "bin", "kosmo-tui.js"), ...args], {
    cwd: root,
    encoding: "utf8",
    ...(input === undefined ? {} : { input })
  });

describe("installed runtime boundary (8.3)", () => {
  it("an unsupported connect stream major is an explicit version error with empty stdout", () => {
    const result = bin(["-", "--print"], '{"type":"connect","v":3}\n');
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/unsupported connect stream version 3; supported: 1, 2/);
  });

  it.skipIf(!SQLITE_CELL)(`SQLite driver cell "${SQLITE_CELL}": peer, sql and --print follow the cell`, () => {
    const require = createRequire(path.join(root, "package.json"));
    const peer = (() => {
      try {
        return require.resolve("better-sqlite3");
      } catch {
        return undefined;
      }
    })();
    expect(peer !== undefined, "better-sqlite3 installed").toBe(SQLITE_CELL === "native");
    const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
    const builtIn = major >= 24 || (major === 23 && minor >= 4) || (major === 22 && minor >= 13);
    if (SQLITE_CELL === "none") expect(major === 18 || (major === 22 && minor < 5), process.version).toBe(true);
    if (SQLITE_CELL === "builtin") expect(builtIn, process.version).toBe(true);

    const store = path.join(root, "test/fixtures/sqlite/store.sqlite");
    const sql = bin(["sql", "SELECT count(*) AS n FROM events", "--source", store]);
    const print = bin([store, "--print", "json"]);
    if (SQLITE_CELL === "none") {
      for (const result of [sql, print]) {
        expect(result.status).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).toMatch(/unavailable\(sqlite-driver\).*better-sqlite3/);
      }
      return;
    }
    expect(sql.status, sql.stderr).toBe(0);
    const table = JSON.parse(sql.stdout) as { schema: string; rows: number[][] };
    expect(table.schema).toBe("kosmo.trace-sql/v1");
    expect(table.rows[0]![0]).toBeGreaterThan(0);
    expect(print.status, print.stderr).toBe(0);
    expect((JSON.parse(print.stdout) as { schema: string }).schema).toBe("kosmo.trace-list/v1");
  });
});
