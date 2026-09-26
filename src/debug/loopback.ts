import { isIP } from "node:net";

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "*"]);

/**
 * True only for an IP literal of the loopback range: `127.0.0.0/8`, `::1`, or the IPv4-mapped
 * `::ffff:127.x.y.z`. Names (`localhost`, `127.evil.com`) are not accepted: CDP connects to what
 * this function approved, so a name that resolves elsewhere would leave the machine.
 */
export function isLoopbackHost(host: string): boolean {
  const bare = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family === 4) {
    const first = Number(bare.split(".")[0]);
    return first === 127;
  }
  if (family === 6) {
    if (bare === "::1" || /^(0{1,4}:){7}0{0,3}1$/.test(bare)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
    return mapped !== null && isLoopbackHost(mapped[1]!);
  }
  return false;
}

/** Loopback IP literal or the name `localhost`; for URLs the browser itself resolves. */
export function isLocalHostname(host: string): boolean {
  return host.trim().toLowerCase() === "localhost" || isLoopbackHost(host);
}

/** `localhost` becomes the IPv4 loopback literal so that every socket goes to an approved IP. */
export function toLoopbackIp(host: string): string | null {
  const bare = host.trim().toLowerCase();
  if (bare === "localhost") return "127.0.0.1";
  return isLoopbackHost(bare) ? bare.replace(/^\[|\]$/g, "") : null;
}

export function isWildcardHost(host: string): boolean {
  const bare = host.trim().toLowerCase();
  return bare === "*" || bare === "0.0.0.0" || bare === "::" || bare === "[::]";
}

export function isLoopbackName(host: string): boolean {
  return LOOPBACK_NAMES.has(host.trim().toLowerCase()) || isLoopbackHost(host);
}

export function parseHostPort(text: string): { host: string; port: number } | null {
  const raw = text.trim();
  const v6 = /^\[([^\]]+)\]:(\d+)$/.exec(raw);
  const v4 = /^([^:]+):(\d+)$/.exec(raw);
  const match = v6 ?? v4;
  if (match === null) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1]!, port };
}

export function redactWsUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.length > 4 ? parsed.pathname.slice(-4) : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}/<…${tail}>`;
  } catch {
    return "ws://<redacted>";
  }
}

export function loopbackWebSocketUrl(ip: string, port: number, reported: string): string | null {
  if (!isLoopbackHost(ip)) return null;
  let parsed: URL;
  try {
    parsed = new URL(reported);
  } catch {
    return null;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") return null;
  parsed.hostname = ip.includes(":") ? `[${ip}]` : ip;
  parsed.port = String(port);
  return parsed.toString();
}

export const WS_MESSAGE_MAX = 16 * 1024 * 1024;
export const MAP_HTTP_MAX = 32 * 1024 * 1024;
