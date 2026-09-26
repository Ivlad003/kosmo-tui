import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import { isLoopbackHost, isWildcardHost } from "./loopback.js";
import {
  frameworkLabel,
  inspectPortsFromArgv,
  isNodeProcess,
  parseLsof,
  probeOrder,
  supervisorReason,
  type ProcessInfo
} from "./discover.js";

const exec = promisify(execFile);

export type TargetRow = {
  readonly id: string;
  readonly kind: "node" | "supervisor" | "unverified" | "browser-launch";
  readonly pid: number | null;
  readonly ppid: number | null;
  readonly label: string;
  readonly command: string;
  readonly cwd: string | null;
  readonly host: string | null;
  readonly port: number | null;
  readonly inspector: "on" | "off" | "unverified";
  readonly sameProject: boolean;
  readonly depth: number;
  readonly webSocketUrl?: string;
  readonly browser?: string;
  readonly title?: string;
  readonly url?: string;
  readonly warning?: string;
};

let proxyReady = false;

export function ensureLoopbackNoProxy(): void {
  if (proxyReady) return;
  proxyReady = true;
  for (const key of ["NO_PROXY", "no_proxy"] as const) {
    const current = process.env[key] ?? "";
    const parts = new Set(
      current
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== "")
    );
    for (const host of ["127.0.0.1", "::1", "[::1]", "localhost"]) parts.add(host);
    process.env[key] = [...parts].join(",");
  }
}

export async function scanTargets(input: {
  uid: number;
  selfPid: number;
  root: string | null;
  wildcard: boolean;
  platform?: NodeJS.Platform;
}): Promise<TargetRow[]> {
  ensureLoopbackNoProxy();
  const platform = input.platform ?? process.platform;
  const processes = platform === "linux" ? await linuxProcesses(input.uid) : await darwinProcesses(input.uid);
  const nodes = processes.filter((proc) => proc.pid !== input.selfPid && isNodeProcess(proc));
  const listeners = await listenPorts(
    nodes.map((proc) => proc.pid),
    platform
  );
  const rows: TargetRow[] = [];
  for (const proc of nodes) {
    const supervisor = supervisorReason(proc);
    const ports = listeners.get(proc.pid) ?? [];
    const loopback = ports.filter((item) => isLoopbackHost(item.host));
    const order = probeOrder(
      loopback.map((item) => item.port),
      inspectPortsFromArgv(proc.argv)
    );
    let inspector: TargetRow["inspector"] = "off";
    let host: string | null = null;
    let port: number | null = null;
    let webSocketUrl: string | undefined;
    let browser: string | undefined;
    let title: string | undefined;
    let url: string | undefined;
    for (const candidate of order) {
      const bind = loopback.find((item) => item.port === candidate);
      if (bind === undefined) continue;
      const probe = await probeInspector(bind.host, candidate);
      if (probe !== null) {
        inspector = "on";
        host = bind.host;
        port = candidate;
        webSocketUrl = probe.webSocketDebuggerUrl;
        browser = probe.browser;
        title = probe.title;
        url = probe.url;
        break;
      }
    }
    if (input.wildcard && inspector === "off") {
      const wild = ports.find((item) => isWildcardHost(item.host) && item.port >= 9229 && item.port <= 9239);
      if (wild !== undefined) {
        const probe = await probeInspector("127.0.0.1", wild.port);
        if (probe !== null) {
          inspector = "on";
          host = "127.0.0.1";
          port = wild.port;
          webSocketUrl = probe.webSocketDebuggerUrl;
          browser = probe.browser;
        }
      }
    }
    const cwd = await processCwd(proc.pid, platform);
    const same = input.root !== null && cwd !== null && (cwd === input.root || cwd.startsWith(`${input.root}/`));
    const label =
      supervisor !== null
        ? `${supervisor} · supervisor${inspector === "on" && supervisor === "next" ? " (no app code)" : inspector === "on" ? " · tool process, not your app" : ""}`
        : frameworkLabel(proc);
    rows.push({
      id: `pid:${proc.pid}`,
      kind: supervisor !== null ? "supervisor" : "node",
      pid: proc.pid,
      ppid: proc.ppid,
      label,
      command: proc.command,
      cwd,
      host,
      port,
      inspector,
      sameProject: same,
      depth: 0,
      ...(webSocketUrl === undefined ? {} : { webSocketUrl }),
      ...(browser === undefined ? {} : { browser }),
      ...(title === undefined ? {} : { title }),
      ...(url === undefined ? {} : { url }),
      ...(supervisor !== null && inspector === "on" ? { warning: "supervisor confirmation required" } : {})
    });
    if (inspector === "on" && port !== null) {
      for (const item of ports) {
        if (item.port === port) continue;
        if (!isLoopbackHost(item.host) && !isWildcardHost(item.host)) continue;
        rows.push({
          id: `launch:${proc.pid}:${item.port}`,
          kind: "browser-launch",
          pid: proc.pid,
          ppid: proc.ppid,
          label: `launch browser → http://localhost:${item.port}`,
          command: proc.command,
          cwd,
          host: "localhost",
          port: item.port,
          inspector: "off",
          sameProject: same,
          depth: 1
        });
      }
    }
  }
  rows.sort((left, right) => Number(right.sameProject) - Number(left.sameProject));
  return rows;
}

async function darwinProcesses(uid: number): Promise<ProcessInfo[]> {
  const [commands, ucomms] = await Promise.all([
    exec("ps", ["-axo", "pid=,ppid=,uid=,command="]).then((result) => result.stdout),
    exec("ps", ["-axo", "pid=,ucomm="]).then((result) => result.stdout)
  ]);
  const names = new Map<number, string>();
  for (const line of ucomms.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match !== null) names.set(Number(match[1]), match[2]!.trim());
  }
  const out: ProcessInfo[] = [];
  for (const line of commands.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null || Number(match[3]) !== uid) continue;
    const pid = Number(match[1]);
    const command = match[4] ?? "";
    out.push({
      pid,
      ppid: Number(match[2]),
      uid,
      command,
      argv: command.split(/\s+/),
      ucomm: names.get(pid) ?? null,
      exeBase: null
    });
  }
  return out;
}

async function linuxProcesses(uid: number): Promise<ProcessInfo[]> {
  const { readdir, readFile, readlink } = await import("node:fs/promises");
  const pids = await readdir("/proc");
  const out: ProcessInfo[] = [];
  for (const name of pids) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = await readFile(`/proc/${name}/status`, "utf8");
      const uidLine = /^Uid:\s+(\d+)/m.exec(status);
      if (uidLine === null || Number(uidLine[1]) !== uid) continue;
      const ppid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0);
      const cmdline = await readFile(`/proc/${name}/cmdline`);
      const argv = cmdline
        .toString("utf8")
        .split("\0")
        .filter((part) => part !== "");
      const exe = await readlink(`/proc/${name}/exe`).catch(() => "");
      out.push({
        pid: Number(name),
        ppid,
        uid,
        command: argv.join(" "),
        argv,
        ucomm: null,
        exeBase: exe.split("/").pop() ?? null
      });
    } catch {
      // process exited
    }
  }
  return out;
}

async function listenPorts(
  pids: number[],
  platform: NodeJS.Platform
): Promise<Map<number, { host: string; port: number }[]>> {
  if (pids.length === 0) return new Map();
  try {
    const result = await exec("lsof", ["-a", "-p", pids.join(","), "-iTCP", "-sTCP:LISTEN", "-P", "-n", "-Fpn"]);
    return parseLsof(result.stdout);
  } catch (error) {
    const err = error as { code?: string; stdout?: string };
    if (err.stdout) return parseLsof(err.stdout);
    if (err.code !== "ENOENT") return new Map();
  }
  if (platform === "linux") {
    try {
      const result = await exec("ss", ["-ltnpH"]);
      return parseSs(result.stdout);
    } catch {
      return fallbackPorts();
    }
  }
  return new Map();
}

function parseSs(text: string): Map<number, { host: string; port: number }[]> {
  const out = new Map<number, { host: string; port: number }[]>();
  for (const line of text.split("\n")) {
    const pid = /pid=(\d+)/.exec(line)?.[1];
    const addr = /\s(\S+):(\d+)\s/.exec(line);
    if (pid === undefined || addr === null) continue;
    const list = out.get(Number(pid)) ?? [];
    list.push({ host: addr[1]!, port: Number(addr[2]) });
    out.set(Number(pid), list);
  }
  return out;
}

function fallbackPorts(): Map<number, { host: string; port: number }[]> {
  return new Map();
}

async function processCwd(pid: number, platform: NodeJS.Platform): Promise<string | null> {
  if (platform === "linux") {
    const { readlink } = await import("node:fs/promises");
    return readlink(`/proc/${pid}/cwd`).catch(() => null);
  }
  try {
    const result = await exec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    const line = result.stdout.split("\n").find((item) => item.startsWith("n"));
    return line?.slice(1) ?? null;
  } catch {
    return null;
  }
}

/**
 * After SIGUSR1 (spec 9.2 p.7): the inspector opens on `process.debugPort`, not always 9229, so the
 * LISTEN sockets of this pid are polled for up to `timeoutMs`.
 */
export async function findInspectorOfPid(
  pid: number,
  timeoutMs = 3000,
  platform: NodeJS.Platform = process.platform
): Promise<{ host: string; port: number; webSocketUrl: string; browser: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ports = (await listenPorts([pid], platform)).get(pid) ?? [];
    for (const item of ports) {
      if (!isLoopbackHost(item.host)) continue;
      const probe = await probeInspector(item.host, item.port);
      if (probe !== null)
        return { host: item.host, port: item.port, webSocketUrl: probe.webSocketDebuggerUrl, browser: probe.browser };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

export async function probeInspector(
  host: string,
  port: number
): Promise<{ webSocketDebuggerUrl: string; browser: string; title?: string; url?: string } | null> {
  ensureLoopbackNoProxy();
  const versionRaw = await httpJson(host, port, "/json/version");
  if (versionRaw === null || typeof versionRaw !== "object" || Array.isArray(versionRaw)) return null;
  const version = versionRaw as Record<string, unknown>;
  if (typeof version.Browser !== "string" || !version.Browser.startsWith("node.js/")) return null;
  const listed = await httpJson(host, port, "/json/list");
  const firstRaw = Array.isArray(listed) ? listed[0] : listed;
  const first =
    firstRaw !== null && typeof firstRaw === "object" && !Array.isArray(firstRaw)
      ? (firstRaw as Record<string, unknown>)
      : undefined;
  const fromVersion = typeof version.webSocketDebuggerUrl === "string" ? version.webSocketDebuggerUrl : undefined;
  const fromList =
    first !== undefined && typeof first.webSocketDebuggerUrl === "string" ? first.webSocketDebuggerUrl : undefined;
  const webSocketDebuggerUrl = fromVersion ?? fromList;
  if (webSocketDebuggerUrl === undefined) return null;
  return {
    webSocketDebuggerUrl,
    browser: version.Browser,
    ...(typeof first?.title === "string" ? { title: first.title } : {}),
    ...(typeof first?.url === "string" ? { url: first.url } : {})
  };
}

export async function probeBrowser(
  host: string,
  port: number
): Promise<{ browser: string; webSocketDebuggerUrl: string } | null> {
  ensureLoopbackNoProxy();
  const body = await httpJson(host, port, "/json/version");
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const browser = String(record.Browser ?? "");
  if (!browser.startsWith("Chrome/") && !browser.startsWith("HeadlessChrome/") && !browser.startsWith("Edg/"))
    return null;
  if (typeof record.webSocketDebuggerUrl !== "string") return null;
  return { browser, webSocketDebuggerUrl: record.webSocketDebuggerUrl };
}

const PROBE_BODY_MAX = 1024 * 1024;

function httpJson(host: string, port: number, pathName: string): Promise<unknown> {
  const ip = host.replace(/^\[|\]$/g, "");
  if (!isLoopbackHost(ip)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.get({ host: ip, port, path: pathName, timeout: 300, agent: new http.Agent() }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > PROBE_BODY_MAX) {
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}
