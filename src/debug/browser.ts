import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeTransport } from "./transport.js";
import type { CdpTransport } from "./cdp.js";

const FLAGS = [
  "--remote-debugging-pipe",
  "--no-first-run",
  "--no-default-browser-check",
  "--use-mock-keychain",
  "--password-store=basic",
  "--disable-extensions",
  "--disable-background-networking"
];

export type LaunchedBrowser = {
  readonly profile: string;
  readonly transport: CdpTransport;
  readonly pid: number;
  close(): Promise<void>;
};

export function findBrowser(
  env: Readonly<Record<string, string | undefined>>,
  platform = process.platform
): string | null {
  if (env.KOSMO_TUI_BROWSER) return env.KOSMO_TUI_BROWSER;
  const candidates =
    platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Chromium.app/Contents/MacOS/Chromium"
        ]
      : platform === "win32"
        ? []
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/microsoft-edge",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser"
          ];
  return (
    candidates.find((file) => {
      try {
        return readdirSync(path.dirname(file)).includes(path.basename(file));
      } catch {
        return false;
      }
    }) ?? null
  );
}

export function launchBrowser(input: {
  env: Readonly<Record<string, string | undefined>>;
  headless?: boolean;
  noSandbox?: boolean;
}): LaunchedBrowser {
  const bin = findBrowser(input.env);
  if (bin === null) throw new Error("browser-not-found");
  const profile = mkdtempSync(path.join(tmpdir(), `kosmo-tui-profile-${process.pid}-`));
  const args = [`--user-data-dir=${profile}`, ...FLAGS, "about:blank"];
  if (input.headless === true) args.push("--headless=new");
  if (input.noSandbox === true) args.push("--no-sandbox");
  // stderr is never read by us: a "pipe" would fill its OS buffer and block Chrome (spec 10.1).
  const child = spawn(bin, args, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], detached: true });
  child.on("error", () => undefined);
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
  });
  const write = child.stdio[3];
  const read = child.stdio[4];
  if (write == null || read == null || !("write" in write) || !("on" in read)) {
    child.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true });
    throw new Error("browser pipe missing");
  }
  write.on("error", () => undefined);
  const transport = pipeTransport(read as NodeJS.ReadableStream, write as NodeJS.WritableStream);
  const signal = (name: NodeJS.Signals): void => {
    if (exited || child.pid === undefined) return;
    try {
      process.kill(-child.pid, name);
    } catch {
      try {
        child.kill(name);
      } catch {
        // already gone
      }
    }
  };
  const exitedWithin = (ms: number): Promise<boolean> =>
    Promise.race([exit.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
  return {
    profile,
    transport,
    pid: child.pid ?? 0,
    async close() {
      // Browser.close was already asked for by the session; then SIGTERM ≤ 1 s, then SIGKILL (10.8).
      if (!(await exitedWithin(1000))) {
        signal("SIGTERM");
        if (!(await exitedWithin(1000))) {
          signal("SIGKILL");
          await exitedWithin(500);
        }
      }
      rmSync(profile, { recursive: true, force: true });
    }
  };
}

export function cleanupStaleProfiles(dir = tmpdir()): void {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const match = /^kosmo-tui-profile-(\d+)-/.exec(name);
    if (match === null) continue;
    const pid = Number(match[1]);
    try {
      process.kill(pid, 0);
    } catch {
      rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }
}
