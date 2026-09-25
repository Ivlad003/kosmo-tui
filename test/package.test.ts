/**
 * The package after the cutover (spec 1 criterion 1, spec 15): zero runtime dependencies, no
 * overrides or peers, Node >= 22.13, the JSON Schema published and exported, and nothing of the
 * old sibling project left in the sources, tests, CI, manifest or lockfile.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Manifest = {
  name: string;
  version: string;
  description: string;
  type: string;
  license: string;
  publishConfig?: { access?: string };
  bin: Record<string, string>;
  exports: Record<string, unknown>;
  files: string[];
  engines: Record<string, string>;
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
  [field: string]: unknown;
};

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as Manifest;
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8")) as {
  lockfileVersion: number;
  packages: Record<string, { dev?: boolean; dependencies?: Record<string, string>; resolved?: string }>;
};

/** Spelled in two parts, so this file does not find itself. */
const OLD_PROJECT = ["kosmo", "callflow"].join("-");

/** Every file under `dir`, skipping dependencies and build output. */
function filesUnder(dir: string): string[] {
  return readdirSync(path.join(root, dir), { recursive: true, encoding: "utf8" })
    .map((file) => path.join(dir, file))
    .filter((file) => !/(^|[\\/])(node_modules|dist)([\\/]|$)/.test(file))
    .filter((file) => statSync(path.join(root, file)).isFile());
}

describe("package manifest (spec 15)", () => {
  it("declares the bin, ESM, public access and the new description", () => {
    expect(pkg.name).toBe("@ivlad003/kosmo-tui");
    expect(pkg.type).toBe("module");
    expect(pkg.publishConfig?.access).toBe("public");
    expect(pkg.bin).toEqual({ "kosmo-tui": "bin/kosmo-tui.js" });
    expect(pkg.description).toBe("Terminal viewer for kosmo-trace call traces");
  });

  it("needs Node >= 22.13.0 (node:sqlite without a flag, process.getBuiltinModule)", () => {
    expect(pkg.engines).toEqual({ node: ">=22.13.0" });
  });

  it("has zero runtime dependencies, no peers, no overrides", () => {
    for (const field of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
      "peerDependenciesMeta",
      "bundleDependencies",
      "bundledDependencies",
      "overrides"
    ]) {
      expect(pkg[field], field).toBeUndefined();
    }
  });

  it("devDependencies are the build and test tools only", () => {
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(["@types/node", "ajv", "prettier", "typescript", "vitest"]);
    expect(pkg.scripts["deps:tarballs"]).toBeUndefined();
  });

  it("publishes dist, bin and schema, and exports ./schema/*", () => {
    expect(pkg.files).toEqual(["dist", "bin", "schema"]);
    expect(pkg.exports).toEqual({
      ".": { types: "./dist/cli.d.ts", default: "./dist/cli.js" },
      "./schema/*": "./schema/*"
    });
    const require = createRequire(path.join(root, "package.json"));
    const schema = require.resolve("@ivlad003/kosmo-tui/schema/kosmo-trace-v1.schema.json");
    expect(schema).toBe(path.join(root, "schema", "kosmo-trace-v1.schema.json"));
    expect((JSON.parse(readFileSync(schema, "utf8")) as { $id?: string }).$id).toMatch(/kosmo-trace-v1\.schema\.json$/);
  });

  it("the lockfile installs development tools only", () => {
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages[""]?.dependencies).toBeUndefined();
    const runtime = Object.entries(lock.packages).filter(([key, entry]) => key !== "" && entry.dev !== true);
    expect(runtime.map(([key]) => key)).toEqual([]);
    for (const [key, entry] of Object.entries(lock.packages)) {
      expect(entry.resolved ?? "", key).not.toMatch(/^file:/);
    }
  });
});

describe("criterion 1: the old sibling project is gone", () => {
  it("src, test, .github, package.json and package-lock.json never mention it", () => {
    const files = [
      ...filesUnder("src"),
      ...filesUnder("test"),
      ...filesUnder(".github"),
      "package.json",
      "package-lock.json"
    ];
    const hits = files.filter((file) => readFileSync(path.join(root, file), "utf8").includes(OLD_PROJECT));
    expect(hits).toEqual([]);
  });

  it("scripts/ with its tarball and parity helpers is removed", () => {
    expect(existsSync(path.join(root, "scripts"))).toBe(false);
  });

  it("src imports only relative modules and node: builtins", () => {
    const specifier = /(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/g;
    for (const file of filesUnder("src").filter((name) => name.endsWith(".ts"))) {
      const text = readFileSync(path.join(root, file), "utf8");
      for (const match of text.matchAll(specifier)) {
        expect(match[1]!, `${file}: ${match[1]}`).toMatch(/^(\.\.?\/|node:)/);
      }
    }
  });
});

describe("bin launcher", () => {
  const bin = (args: string[]) =>
    spawnSync(process.execPath, [path.join(root, "bin", "kosmo-tui.js"), ...args], { encoding: "utf8", cwd: root });

  it("runs dist/cli.js through run(process, {})", () => {
    expect(existsSync(path.join(root, "dist", "cli.js")), "run `npm run build` first").toBe(true);
    const help = bin(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage:");
    expect(help.stdout).toContain("--print [text|json|tab]");
    const version = bin(["--version"]);
    expect(version.stdout.trim()).toBe(pkg.version);
  });

  it("a missing path is exit 1 with an empty stdout (spec 6.8)", () => {
    const missing = bin(["./definitely-missing.json"]);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toBe("kosmo-tui: file-not-found: ./definitely-missing.json\n");
  });

  it("a non-interactive stdout gets the --print hint", () => {
    const start = bin([]);
    expect(start.status).toBe(1);
    expect(start.stderr).toBe(
      "kosmo-tui: no-controlling-terminal: interactive terminal required: stdout is not a TTY. Use --print [text|json|tab] for non-interactive output.\n"
    );
  });
});
