#!/usr/bin/env node
/**
 * Install the @kosmo-callflow/* dependencies from freshly packed kosmo-callflow tarballs
 * (KC task 1.11, KT task 2.1).
 *
 *   npm run deps:tarballs              pack in ../kosmo-callflow, then install
 *   npm run deps:tarballs -- --no-pack  install tarballs already in ../kosmo-callflow/artifacts/tarballs
 *                                       (CI downloads them from the job that packed them)
 *
 * 1. Runs `npm run pack:public -- <the five packages>` in the sibling ../kosmo-callflow checkout
 *    (build it first: `npm run build` there). The tarballs land in
 *    ../kosmo-callflow/artifacts/tarballs/<name>.tgz under version-free names.
 * 2. Installs exactly those tarballs by path. `npm install` without arguments keeps a stale copy
 *    when a tarball changed under the same path (npm trusts the lockfile integrity and its cache),
 *    so the explicit install is what refreshes node_modules and the lockfile integrity.
 * 3. Fails when any @kosmo-callflow/* entry in package-lock.json is not a file: tarball — nothing
 *    may come from the public registry, where stale 0.0.0 copies of some names exist.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kc = path.resolve(root, "../kosmo-callflow");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const names = Object.keys(pkg.dependencies).filter((name) => name.startsWith("@kosmo-callflow/"));
const shell = process.platform === "win32";

function run(args, cwd) {
  const result = spawnSync("npm", args, { cwd, stdio: "inherit", shell });
  if (result.status !== 0) {
    console.error(`deps:tarballs: npm ${args.join(" ")} failed in ${cwd}`);
    process.exit(result.status ?? 1);
  }
}

if (!process.argv.includes("--no-pack")) {
  if (!existsSync(path.join(kc, "scripts/pack-public.mjs"))) {
    console.error(`deps:tarballs: no kosmo-callflow checkout with scripts/pack-public.mjs at ${kc}`);
    process.exit(1);
  }
  run(["run", "pack:public", "--", ...names], kc);
}

const specs = names.map((name) => {
  const spec = pkg.dependencies[name];
  if (!spec.startsWith("file:") || !spec.endsWith(".tgz")) {
    console.error(`deps:tarballs: ${name} must be pinned to a file: tarball, found ${spec}`);
    process.exit(1);
  }
  const file = spec.slice("file:".length);
  if (!existsSync(path.resolve(root, file))) {
    console.error(`deps:tarballs: ${file} does not exist; pack kosmo-callflow first`);
    process.exit(1);
  }
  return file;
});
run(["install", "--prefer-offline", "--no-audit", "--no-fund", ...specs], root);

const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const stray = Object.entries(lock.packages)
  .filter(([key]) => key.includes("@kosmo-callflow/"))
  .filter(([, entry]) => !(entry.resolved ?? "").startsWith("file:") || !(entry.resolved ?? "").endsWith(".tgz"));
if (stray.length > 0) {
  console.error(
    `deps:tarballs: not installed from a tarball: ${stray.map(([key, entry]) => `${key} (${entry.resolved})`).join(", ")}`
  );
  process.exit(1);
}
console.log(
  `deps:tarballs: ${names.length} @kosmo-callflow packages installed from ${path.relative(root, path.join(kc, "artifacts/tarballs"))}`
);
