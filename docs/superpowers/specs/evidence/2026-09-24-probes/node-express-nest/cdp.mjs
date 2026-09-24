// Throwaway CDP probe client (Node >= 22, global WebSocket). Not production code.
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const req = createRequire("/Users/kosmodev/Documents/pet_project/kosmo-callflow/package.json");
const TM = req("@jridgewell/trace-mapping");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function launch({ node = process.execPath, args, cwd, env = {}, label = "target" }) {
  const child = spawn(node, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const out = { stdout: "", stderr: "" };
  let wsResolve;
  const ws = new Promise((r) => (wsResolve = r));
  child.stdout.on("data", (d) => (out.stdout += d));
  child.stderr.on("data", (d) => {
    out.stderr += d;
    const m = /Debugger listening on (ws:\/\/\S+)/.exec(out.stderr);
    if (m) wsResolve(m[1]);
  });
  child.on("exit", (code, sig) => (out.exit = { code, sig }));
  return { child, out, ws, label };
}

export async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  let id = 0;
  const pending = new Map();
  const handlers = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(Object.assign(new Error(msg.error.message), msg.error)) : res(msg.result); return; }
    for (const h of handlers.get(msg.method) || []) h(msg.params);
    for (const h of handlers.get("*") || []) h(msg.method, msg.params);
  });
  return {
    send(method, params = {}) { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res, rej) => pending.set(i, { res, rej })); },
    on(method, cb) { if (!handlers.has(method)) handlers.set(method, []); handlers.get(method).push(cb); },
    close() { ws.close(); }
  };
}

// ---------- in-process helper (what kosmo-tui would install) ----------
export const HELPER_SRC = String.raw`(() => {
  const KEY = Symbol.for("kosmo-tui");
  if (globalThis[KEY]) return "already";
  const MASK = /password|passwd|token|secret|authorization|cookie|api[-_]?key|session/i;
  const MAXD = 2, MAXN = 50, MAXS = 1000;
  function ser(v, d, seen) {
    const t = typeof v;
    if (v === null || t === "boolean" || t === "number") return Number.isFinite(v) || t !== "number" ? v : { $type: "number", value: String(v) };
    if (t === "undefined") return { $type: "undefined" };
    if (t === "string") return v.length > MAXS ? { $type: "truncated", preview: v.slice(0, MAXS), length: v.length } : v;
    if (t === "bigint") return { $type: "bigint", value: String(v) };
    if (t === "symbol") return { $type: "symbol", value: String(v) };
    if (t === "function") return { $type: "function", name: v.name || "(anonymous)" };
    if (seen.has(v)) return { $type: "circular" };
    let ctor = "Object"; try { ctor = (Object.getPrototypeOf(v)?.constructor?.name) || "Object"; } catch {}
    if (v instanceof Error) return { $type: "error", name: v.name, message: String(v.message).slice(0, MAXS) };
    if (d >= MAXD) return { $type: "depth", ctor };
    seen.add(v);
    if (Array.isArray(v)) { const a = v.slice(0, MAXN).map((x) => ser(x, d + 1, seen)); if (v.length > MAXN) a.push({ $type: "more", count: v.length - MAXN }); return a; }
    const o = ctor !== "Object" ? { $ctor: ctor } : {};
    let n = 0, total = 0;
    for (const k of Reflect.ownKeys(v)) {
      if (typeof k === "symbol") continue;
      const desc = Object.getOwnPropertyDescriptor(v, k);
      if (!desc || !desc.enumerable) continue;
      total++;
      if (n >= MAXN) continue;
      n++;
      if (MASK.test(k)) { o[k] = { $type: "masked" }; continue; }
      if (desc.get || desc.set) { o[k] = { $type: "accessor" }; continue; }
      o[k] = ser(desc.value, d + 1, seen);
    }
    if (total > n) o.$more = total - n;
    return o;
  }
  function summarizeHttp(name, v) {
    // Framework-aware summaries: IncomingMessage (Express req) / ServerResponse (Express res)
    try {
      if (v && typeof v === "object" && typeof v.method === "string" && v.headers && typeof v.httpVersion === "string") {
        const h = {};
        for (const [k, val] of Object.entries(v.headers)) h[k] = MASK.test(k) || /^x-api-key$|^proxy-authorization$/i.test(k) ? { $type: "masked" } : ser(val, 1, new Set());
        const s = { $type: "http.request", method: v.method, url: String(v.originalUrl ?? v.url).slice(0, MAXS), headers: h };
        for (const k of ["baseUrl", "path", "route"]) { const d = Object.getOwnPropertyDescriptor(v, k); if (d && !d.get && d.value !== undefined) s[k] = k === "route" ? String(d.value?.path) : d.value; }
        for (const k of ["params", "query", "body"]) { const d = Object.getOwnPropertyDescriptor(v, k) ; if (d && "value" in d && d.value !== undefined) s[k] = ser(d.value, 1, new Set()); else if (d && d.get) s[k] = { $type: "accessor" }; }
        return s;
      }
      if (v && typeof v === "object" && typeof v.statusCode === "number" && typeof v.getHeaders === "function" && "headersSent" in v) {
        return { $type: "http.response", statusCode: v.statusCode, headersSent: v.headersSent, finished: v.writableEnded };
      }
    } catch (e) { return { $type: "unavailable", reason: String(e) }; }
    return undefined;
  }
  let hits = 0;
  Object.defineProperty(globalThis, KEY, { configurable: true, enumerable: false, value: function (tpId, getters) {
    try {
      if (++hits > 10000) return false;
      const out = {};
      for (const [name, get] of getters) {
        let v; try { v = get(); } catch (e) { out[name] = { $type: "unavailable", reason: e && e.name }; continue; }
        out[name] = (String(tpId).startsWith("raw") ? undefined : summarizeHttp(name, v)) ?? ser(v, 0, new Set());
      }
      console.context("kosmo-tui").trace("KOSMO_TP", tpId, JSON.stringify(out));
    } catch (e) { /* never throw into debuggee */ }
    return false;
  }});
  return "installed";
})()`;

export function conditionFor(tpId, names) {
  const getters = names.map((n) => `[${JSON.stringify(n)}, () => ${n}]`).join(", ");
  return `(globalThis[Symbol.for("kosmo-tui")](${JSON.stringify(tpId)}, [${getters}]), false)`;
}

// ---------- script registry + source maps ----------
export class Registry {
  constructor() { this.scripts = new Map(); this.maps = new Map(); }
  add(p) { this.scripts.set(p.scriptId, p); }
  mapFor(s) {
    if (!s.sourceMapURL) return null;
    if (this.maps.has(s.scriptId)) return this.maps.get(s.scriptId);
    let raw = null, mapUrl = s.sourceMapURL;
    try {
      if (mapUrl.startsWith("data:")) { const b = mapUrl.slice(mapUrl.indexOf(",") + 1); raw = mapUrl.includes(";base64,") ? Buffer.from(b, "base64").toString("utf8") : decodeURIComponent(b); }
      else {
        const base = s.url.startsWith("file://") ? fileURLToPath(s.url) : s.url;
        const p = mapUrl.startsWith("file://") ? fileURLToPath(mapUrl) : path.resolve(path.dirname(base), mapUrl);
        if (existsSync(p)) raw = readFileSync(p, "utf8");
        mapUrl = p;
      }
    } catch (e) { raw = null; }
    const m = raw ? new TM.TraceMap(raw, s.url) : null;
    this.maps.set(s.scriptId, m);
    return m;
  }
  original(scriptId, line0, col0) {
    const s = this.scripts.get(scriptId); if (!s) return null;
    const m = this.mapFor(s); if (!m) return null;
    const o = TM.originalPositionFor(m, { line: line0 + 1, column: col0 });
    return o.source ? `${o.source}:${o.line}:${o.column + 1}${o.name ? " (" + o.name + ")" : ""}` : null;
  }
}

export function shortUrl(u, root) {
  if (!u) return "(no url)";
  let x = u.replace(/^file:\/\//, "");
  if (root && x.startsWith(root)) x = "<root>" + x.slice(root.length);
  x = x.replace(/.*\/node_modules\//, "nm:/");
  return x;
}

export function fmtFrames(reg, st, root, { maxAsync = 12 } = {}) {
  const lines = [];
  let cur = st, depth = 0;
  while (cur && depth <= maxAsync) {
    if (depth > 0) lines.push(`   -- async: ${cur.description || "(parent)"} --`);
    for (const f of cur.callFrames) {
      const orig = reg.original(f.scriptId, f.lineNumber, f.columnNumber);
      lines.push(`   ${(f.functionName || "(anonymous)").padEnd(34)} ${shortUrl(f.url, root)}:${f.lineNumber + 1}:${f.columnNumber + 1}${orig ? "  => " + orig : ""}`);
    }
    if (cur.parentId) lines.push(`   -- parentId (external): ${JSON.stringify(cur.parentId).slice(0, 80)}`);
    cur = cur.parent; depth++;
  }
  return lines.join("\n");
}

export async function waitHttp(url, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await fetch(url); await r.text(); return true; } catch { await sleep(150); } }
  return false;
}

export function killTree(child) { try { process.kill(child.pid, "SIGKILL"); } catch {} }
