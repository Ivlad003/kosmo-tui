// Minimal independent CDP client (pipe or WebSocket) + launcher for verification.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const DIR = path.dirname(new URL(import.meta.url).pathname);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Cdp {
  constructor(sendRaw) { this.sendRaw = sendRaw; this.n = 0; this.pending = new Map(); this.handlers = new Set(); }
  onMessage(text) {
    const m = JSON.parse(text);
    if (m.id !== undefined) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (!p) return; m.error ? p.reject(new Error(p.method + ": " + m.error.message)) : p.resolve(m.result); return; }
    for (const h of this.handlers) h(m);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.n; const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, method }); this.sendRaw(JSON.stringify(msg)); });
  }
  on(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }
  session(id) { return { id, send: (m, p) => this.send(m, p, id) }; }
}

export function launch({ pipe = true, extra = [], headless = true } = {}) {
  mkdirSync(path.join(DIR, "profiles"), { recursive: true });
  const profile = mkdtempSync(path.join(DIR, "profiles", "p-"));
  const args = [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--use-mock-keychain",
    "--password-store=basic", "--disable-background-networking", "--disable-component-update", "--disable-sync",
    "--disable-extensions", ...(headless ? ["--headless"] : []), pipe ? "--remote-debugging-pipe" : "--remote-debugging-port=0", ...extra, "about:blank"];
  const child = spawn(CHROME, args, { stdio: pipe ? ["ignore", "pipe", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"] });
  let log = ""; child.stderr.on("data", (d) => (log += d)); child.stdout.on("data", (d) => (log += d));
  const out = { child, profile, get log() { return log; } };
  if (pipe) {
    const w = child.stdio[3], r = child.stdio[4];
    out.cdp = new Cdp((t) => w.write(t + "\0"));
    let buf = ""; r.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\0")) >= 0) { const m = buf.slice(0, i); buf = buf.slice(i + 1); out.cdp.onMessage(m); } });
  }
  out.cleanup = () => { try { child.kill("SIGKILL"); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
  return out;
}

export async function activePort(profile, ms = 10000) {
  const f = path.join(profile, "DevToolsActivePort"); const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (existsSync(f)) { const [port, p] = readFileSync(f, "utf8").trim().split("\n"); if (port && p) return { port: +port, path: p }; } await sleep(50); }
  throw new Error("no DevToolsActivePort");
}

export function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); const cdp = new Cdp((t) => ws.send(t));
    ws.onmessage = (e) => cdp.onMessage(String(e.data)); ws.onopen = () => resolve(Object.assign(cdp, { close: () => ws.close() })); ws.onerror = () => reject(new Error("ws error"));
  });
}

export function startServer() {
  const s = spawn(process.execPath, [path.join(DIR, "server.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((r) => s.stdout.once("data", (d) => r({ proc: s, port: JSON.parse(d).port })));
}

// Helper mirrors the researcher's shape but keyed by a per-attach nonce.
export const helperSrc = (nonce) => String.raw`(() => {
  const KEY = Symbol.for("kosmo-tui:${nonce}");
  if (globalThis[KEY]) return "already";
  const con = console.context("kosmo-tui"); const trace = con.trace; const str = JSON.stringify;
  function hit(tp, pairs) { const out = {}; for (const [n, th] of pairs) { try { const v = th(); out[n] = /password|token/i.test(n) ? {$type:"masked"} : (typeof v === "object" && v ? Object.keys(v) : v); } catch (e) { out[n] = { $type: "unavailable" }; } } trace.call(con, "KOSMO_TP", "${nonce}", tp, str(out)); return false; }
  Object.defineProperty(globalThis, KEY, { value: Object.freeze({ hit }), enumerable: false, configurable: true, writable: false });
  return "installed";
})()`;
export const cond = (nonce, tp, names) => `(globalThis[Symbol.for("kosmo-tui:${nonce}")]?.hit(${tp}, [${names.map((n) => `[${JSON.stringify(n)}, () => ${n}]`).join(", ")}]), false)`;
