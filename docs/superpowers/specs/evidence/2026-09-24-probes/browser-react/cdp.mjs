// Minimal flat-session CDP client over global WebSocket or --remote-debugging-pipe.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

export const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const CFT = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
export const SCRATCH = path.dirname(new URL(import.meta.url).pathname);

export class Cdp {
  constructor(sendRaw) {
    this.sendRaw = sendRaw; this.id = 0; this.pending = new Map(); this.handlers = [];
  }
  onMessage(text) {
    const msg = JSON.parse(text);
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id); this.pending.delete(msg.id);
      if (!p) return;
      if (msg.error) p.reject(Object.assign(new Error(`${p.method}: ${msg.error.message}`), { cdp: msg.error })); else p.resolve(msg.result);
      return;
    }
    for (const h of this.handlers) h(msg);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params }; if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, method }); this.sendRaw(JSON.stringify(payload)); });
  }
  on(fn) { this.handlers.push(fn); }
  session(sessionId) { return { id: sessionId, send: (m, p) => this.send(m, p, sessionId) }; }
}

export function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const cdp = new Cdp((t) => ws.send(t));
    ws.onmessage = (e) => cdp.onMessage(typeof e.data === "string" ? e.data : Buffer.from(e.data).toString());
    ws.onopen = () => resolve(Object.assign(cdp, { close: () => ws.close(), ws }));
    ws.onerror = (e) => reject(new Error("ws error " + (e.message ?? "")));
  });
}

export function launch({ bin = CHROME, headless = true, pipe = false, extra = [], env = process.env, userDataDir } = {}) {
  const profile = userDataDir ?? mkdtempSync(path.join(SCRATCH, "profiles", "p-"));
  const args = [
    `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic",
    "--disable-background-networking", "--disable-component-update", "--disable-sync",
    "--disable-extensions", "--metrics-recording-only",
    ...(headless ? ["--headless"] : []),
    ...(pipe ? ["--remote-debugging-pipe"] : ["--remote-debugging-port=0"]),
    ...extra, "about:blank",
  ];
  const child = spawn(bin, args, { stdio: pipe ? ["ignore", "pipe", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"], env, detached: false });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  child.stdout.on("data", (d) => { stderr += d; });
  const out = { child, profile, args, get stderr() { return stderr; } };
  if (pipe) {
    const writer = child.stdio[3], reader = child.stdio[4];
    const cdp = new Cdp((t) => writer.write(t + "\0"));
    let buf = "";
    reader.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\0")) >= 0) { const m = buf.slice(0, i); buf = buf.slice(i + 1); cdp.onMessage(m); } });
    out.cdp = cdp;
  }
  out.kill = () => { try { child.kill("SIGKILL"); } catch {} };
  out.cleanup = () => { out.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {} };
  return out;
}

export async function waitActivePort(profile, ms = 10000) {
  const f = path.join(profile, "DevToolsActivePort"); const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (existsSync(f)) { const [port, p] = readFileSync(f, "utf8").trim().split("\n"); if (port && p) return { port: Number(port), path: p }; }
    await sleep(50);
  }
  throw new Error("no DevToolsActivePort");
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const maskWs = (u) => u.replace(/([0-9A-F-]{8,})/gi, (m) => "<…" + m.slice(-4) + ">");
