// Tiny CDP helpers shared by the Next.js probes (global WebSocket, Node >= 22).
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(pred, ms = 10000, step = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return true;
    await sleep(step);
  }
  return false;
}

export async function getJson(url, ms = 800) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal });
    return await r.json();
  } catch (e) {
    return { error: String(e.name || e) };
  } finally {
    clearTimeout(t);
  }
}

export function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (!p) return;
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else for (const l of listeners) l(m);
  };
  const opened = new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  return {
    ws,
    opened,
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify(sessionId ? { id: mid, method, params, sessionId } : { id: mid, method, params }));
      }),
    on: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    close: () => ws.close(),
  };
}

// Process tree + listening ports, the way spec 9.2 discovery does it.
export function processTree(rootPid) {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  const rows = out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      return { pid: +m[1], ppid: +m[2], command: m[3] };
    });
  const keep = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) if (!keep.has(r.pid) && keep.has(r.ppid)) (keep.add(r.pid), (grew = true));
  }
  return rows.filter((r) => keep.has(r.pid));
}

export function listeningPorts(pids) {
  if (!pids.length) return {};
  let out = "";
  try {
    out = execFileSync("lsof", ["-a", "-p", pids.join(","), "-iTCP", "-sTCP:LISTEN", "-P", "-n", "-Fpn"], {
      encoding: "utf8",
    });
  } catch (e) {
    out = e.stdout?.toString() ?? "";
  }
  const res = {};
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) cur = +line.slice(1);
    else if (line.startsWith("n") && cur) (res[cur] ??= []).push(line.slice(1));
  }
  return res;
}

// --- source maps -------------------------------------------------------------------------------
export function loadMapFor(script, { allowHttp = false } = {}) {
  const smu = script.sourceMapURL;
  if (!smu) return { kind: "none" };
  if (smu.startsWith("data:")) {
    const comma = smu.indexOf(",");
    const meta = smu.slice(5, comma);
    const body = smu.slice(comma + 1);
    const text = meta.includes(";base64") ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body);
    return { kind: "data", map: JSON.parse(text) };
  }
  // relative or file: resolve against script url
  let base = script.url;
  let resolved;
  try {
    if (/^https?:/.test(smu)) resolved = smu;
    else if (/^file:/.test(smu)) resolved = smu;
    else if (base.startsWith("file://") || /^https?:/.test(base)) resolved = new URL(smu, base).href;
    else if (base.startsWith("/")) resolved = "file://" + path.resolve(path.dirname(base), smu);
    else resolved = null;
  } catch {
    resolved = null;
  }
  if (!resolved) return { kind: "unresolvable", smu };
  if (resolved.startsWith("file://")) {
    const p = fileURLToPath(resolved);
    if (!existsSync(p)) return { kind: "file-missing", path: p };
    return { kind: "file", path: p, map: JSON.parse(readFileSync(p, "utf8")) };
  }
  return { kind: "http", url: resolved, allowHttp };
}

// Spec 9.4 normalizer, verbatim rules: sourceRoot + source, decodeURI, strip file://, webpack://…/,
// /@fs/, query/hash; then endsWith("/" + file) (case-insensitive on macOS).
export function specNormalize(sourceRoot, source) {
  let s = (sourceRoot ? sourceRoot.replace(/\/?$/, "/") : "") + source;
  try {
    s = decodeURI(s);
  } catch {}
  s = s.replace(/^file:\/\//, "");
  s = s.replace(/^webpack:\/\/[^/]*\//, "/");
  s = s.replace(/^\/@fs\//, "/");
  s = s.replace(/[?#].*$/, "");
  return s;
}
export const specMatches = (sourceRoot, source, file) =>
  specNormalize(sourceRoot, source).toLowerCase().endsWith(("/" + file).toLowerCase());

// Flatten an index map (sections) into [{offsetLine, offsetColumn, map}] so each part can be fed to
// trace-mapping individually and we can report which formats appeared.
export function mapSections(map) {
  if (!map.sections) return [{ offset: { line: 0, column: 0 }, map }];
  return map.sections.map((s) => ({ offset: s.offset, map: s.map }));
}
