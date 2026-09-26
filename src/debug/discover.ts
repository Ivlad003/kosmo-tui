export type ProcessInfo = {
  readonly pid: number;
  readonly ppid: number;
  readonly uid: number;
  readonly command: string;
  readonly argv: readonly string[];
  readonly ucomm: string | null;
  readonly exeBase: string | null;
};

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "npx", "bunx"]);
const SCRIPT_WRAPPERS = ["npm-cli.js", "pnpm.cjs", "pnpm.mjs", "pnpm.js", "yarn.js", "yarn.cjs"];

export function isNodeProcess(proc: ProcessInfo): boolean {
  const ucomm = proc.ucomm ?? "";
  if (ucomm === "node" || ucomm === "nodejs") return true;
  const exe = proc.exeBase ?? "";
  return exe === "node" || exe === "nodejs";
}

export function supervisorReason(proc: ProcessInfo): string | null {
  const tokens = proc.argv;
  if (tokens.some((token) => token === "--watch" || token.startsWith("--watch-path"))) return "node --watch";
  const joined = tokens.join(" ");
  if (tokens.some((token) => token.endsWith("/tsx/dist/cli.mjs") || token.endsWith(".bin/tsx") || token === "tsx"))
    return "tsx";
  if (tokens.some((token) => token.includes("/@nestjs/cli/bin/nest.js"))) return "nest";
  if (tokens.some((token) => token.endsWith("/next/dist/bin/next"))) return "next";
  if (tokens.some((token) => /(^|\/)nodemon$/.test(token) || token.endsWith("ts-node-dev"))) return "watch-tool";
  const argv0 = baseName(tokens[0] ?? "");
  if (PACKAGE_MANAGERS.has(argv0)) return argv0;
  if (tokens.some((token) => SCRIPT_WRAPPERS.some((name) => token.endsWith(name) || token.includes(`/bin/${name}`))))
    return "package-manager";
  if (tokens.some((token) => token.includes("/cross-env/dist/bin/cross-env.js") || token.includes("/bin/cross-env.js")))
    return "cross-env";
  void joined;
  return null;
}

export function frameworkLabel(proc: ProcessInfo): string {
  const title = proc.command;
  const nextServer = /^next-server \(v([^)]+)\)$/.exec(title);
  if (nextServer !== null)
    return `next-server v${nextServer[1]} · app code (RSC · SSR · route handlers · actions · middleware)`;
  if (proc.argv.some((token) => token.includes("vite/bin/vite.js"))) return "vite";
  if (proc.argv.includes("react-router") && proc.argv.includes("dev")) return "react-router dev";
  if (proc.argv.some((token) => baseName(token) === "sfnext") && proc.argv.includes("dev")) return "sfnext dev";
  if (proc.argv.includes("nest") && proc.argv.includes("start")) return "nest app";
  const script = proc.argv.find(
    (token) => token.endsWith(".js") || token.endsWith(".mjs") || token.endsWith(".cjs") || token.endsWith(".ts")
  );
  return script === undefined ? "node" : `node ${baseName(script)}`;
}

export function inspectPortsFromArgv(argv: readonly string[]): number[] {
  const ports: number[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    const eq = /^(?:--inspect|--inspect-brk|--inspect-port|--inspect-wait)(?:=(.+))?$/.exec(token);
    if (eq === null) continue;
    const raw = eq[1] ?? argv[index + 1] ?? "";
    const port = /:(\d+)$/.exec(raw)?.[1] ?? (/^\d+$/.test(raw) ? raw : "");
    const value = Number(port);
    if (Number.isInteger(value) && value > 0) ports.push(value);
  }
  return ports;
}

export function probeOrder(listenPorts: readonly number[], argvPorts: readonly number[]): number[] {
  const inspector = listenPorts.filter((port) => port >= 9229 && port <= 9239);
  const fromArgv = argvPorts.filter((port) => listenPorts.includes(port) && !inspector.includes(port));
  const rest = listenPorts.filter((port) => !inspector.includes(port) && !fromArgv.includes(port));
  return [...inspector, ...fromArgv, ...rest];
}

export function parseLsof(text: string): Map<number, { host: string; port: number }[]> {
  const out = new Map<number, { host: string; port: number }[]>();
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1)) || 0;
    if (!line.startsWith("n") || pid === 0) continue;
    const addr = line.slice(1);
    const parsed = parseListen(addr);
    if (parsed === null) continue;
    const list = out.get(pid) ?? [];
    list.push(parsed);
    out.set(pid, list);
  }
  return out;
}

export function parseListen(addr: string): { host: string; port: number } | null {
  const v6 = /^\[([^\]]+)\]:(\d+)$/.exec(addr);
  const plain = /^(.+):(\d+)$/.exec(addr);
  const match = v6 ?? plain;
  if (match === null) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port)) return null;
  return { host: match[1]!, port };
}

function baseName(token: string): string {
  const slash = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
  return slash >= 0 ? token.slice(slash + 1) : token;
}
