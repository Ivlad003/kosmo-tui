/**
 * Logical points shared by the Node and browser sessions (spec 9.4–9.5, 10.5).
 *
 *  - `ScriptInfo`: the light per-script record of the registry.
 *  - `MapCache`: source maps by `sourceMapURL`/`hash`; `data:` decoded, files read only inside the
 *    project root, http only same-origin loopback (browser).
 *  - `resolveSite`: `(file, line)` of a logical point → one generated position in a script, anchored
 *    after the body opener so the header line is never the site.
 *  - `SiteRegistry`: one CDP breakpoint per generated location; registrations of that location share
 *    its condition, and any change re-sets the breakpoint (V8 refuses a second one at the same place).
 */
import { readFileSync, realpathSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isFunctionHeaderLine } from "../code/params.js";
import { isLoopbackHost, MAP_HTTP_MAX } from "./loopback.js";
import { normalizeSource, sourcesMatch } from "./normalize.js";
import { bodyAnchor, classifyScript, siteCondition, type Registration, type ScriptKind } from "./sites.js";
import { SourceMapConsumer, decodeDataUrl, parseSourceMap } from "./sourcemap.js";

export type ScriptInfo = {
  readonly scriptId: string;
  readonly url: string;
  readonly hash?: string;
  readonly sourceMapURL?: string;
  readonly kind: ScriptKind;
  readonly sessionId?: string;
  readonly contextId?: number;
  readonly startLine: number;
  readonly startColumn: number;
};

export function scriptInfoFrom(params: unknown, sessionId?: string): ScriptInfo | null {
  const script = params as {
    scriptId?: string;
    url?: string;
    sourceMapURL?: string;
    hash?: string;
    executionContextId?: number;
    startLine?: number;
    startColumn?: number;
  };
  if (script.scriptId === undefined) return null;
  const kind = classifyScript(script.url ?? "", script.sourceMapURL);
  if (kind === "drop") return null;
  return {
    scriptId: script.scriptId,
    url: script.url ?? "",
    ...(script.hash === undefined ? {} : { hash: script.hash }),
    ...(script.sourceMapURL === undefined || script.sourceMapURL === "" ? {} : { sourceMapURL: script.sourceMapURL }),
    kind,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(script.executionContextId === undefined ? {} : { contextId: script.executionContextId }),
    startLine: script.startLine ?? 0,
    startColumn: script.startColumn ?? 0
  };
}

/** A point as the user asked for it; it outlives any target (spec 9.5 p.8). */
export type LogicalPoint = {
  readonly id: number;
  readonly kind: "tp" | "bp";
  /** Absolute path when a root is known, else the path as typed. */
  readonly absolute: string;
  /** Root-relative form for suffix matching against bundler sources; null when unknown. */
  readonly relative: string | null;
  readonly root: string | null;
  readonly line: number;
  readonly endLine?: number;
  /** The trace's text of `line`; the witness for maps without `sourcesContent` (spec 9.5 step 0). */
  readonly snippet?: string;
  readonly names: readonly string[];
  readonly sameCase: boolean;
  readonly cap: number;
  readonly runtime: "node" | "browser" | "all";
};

export function fileText(absolute: string): string | null {
  try {
    return readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}

export type MapResult = { readonly map: SourceMapConsumer; readonly base: string } | { readonly error: string } | null;

export class MapCache {
  private readonly cache = new Map<string, MapResult>();
  private readonly inflight = new Map<string, Promise<MapResult>>();
  private bytes = 0;

  constructor(private readonly maxBytes = 64 * 1024 * 1024) {}

  /** `null`: the script has no map. `{error}`: it has one that could not be used (kept on the script). */
  load(script: ScriptInfo, options: { root: string | null; allowHttp: boolean }): Promise<MapResult> {
    if (script.sourceMapURL === undefined) return Promise.resolve(null);
    // The root and the http permission decide the outcome, so they are part of the key: an arm made
    // before a root is known must not poison the script for the session.
    const key = `${options.root ?? ""}|${options.allowHttp}|${script.hash ?? ""}|${script.sourceMapURL.slice(0, 256)}|${script.url}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const pending = this.inflight.get(key);
    if (pending !== undefined) return pending;
    const work = this.fetch(script, options)
      .catch((error: unknown): MapResult => ({
        error: `map-decode-failed(${error instanceof Error ? error.message : error})`
      }))
      .then((result) => {
        this.inflight.delete(key);
        // What is retained is the decoded segment array plus its indexes, not the VLQ text.
        const size = result !== null && "map" in result ? Math.max(4096, result.map.all().length * 96) : 64;
        if (this.bytes + size > this.maxBytes) {
          this.cache.clear();
          this.bytes = 0;
        }
        this.bytes += size;
        this.cache.set(key, result);
        return result;
      });
    this.inflight.set(key, work);
    return work;
  }

  private async fetch(script: ScriptInfo, options: { root: string | null; allowHttp: boolean }): Promise<MapResult> {
    const url = script.sourceMapURL!;
    if (url.startsWith("data:")) {
      const text = decodeDataUrl(url);
      const json = text === null ? null : parseSourceMap(text);
      return json === null ? { error: "map-decode-failed" } : { map: new SourceMapConsumer(json), base: script.url };
    }
    let resolved: string;
    try {
      resolved = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : new URL(url, script.url || "file:///").toString();
    } catch {
      return { error: "map-url-invalid" };
    }
    if (resolved.startsWith("file:")) {
      let file: string;
      try {
        file = fileURLToPath(resolved);
      } catch {
        return { error: "map-url-invalid" };
      }
      return this.fromDisk(file, options.root);
    }
    if (/^https?:/i.test(resolved)) {
      if (!options.allowHttp) return { error: "map-fetch-failed(http-not-allowed)" };
      return this.fromHttp(resolved, script.url);
    }
    // A bare relative path next to a Node script without a `file:` url.
    if (script.url === "" || script.url.startsWith("/")) {
      return this.fromDisk(path.resolve(path.dirname(script.url || "/"), url), options.root);
    }
    return { error: "map-url-unsupported" };
  }

  private fromDisk(file: string, root: string | null): MapResult {
    if (root === null) return { error: "map-fetch-failed(no-root)" };
    let real: string;
    let rootReal: string;
    try {
      real = realpathSync.native(file);
      rootReal = realpathSync.native(root);
    } catch {
      return { error: "map-fetch-failed(missing)" };
    }
    if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`))
      return { error: "map-fetch-failed(outside-root)" };
    const text = fileText(real);
    const json = text === null ? null : parseSourceMap(text);
    return json === null
      ? { error: "map-decode-failed" }
      : { map: new SourceMapConsumer(json), base: `file://${real}` };
  }

  private fromHttp(mapUrl: string, scriptUrl: string): Promise<MapResult> {
    let map: URL;
    let script: URL;
    try {
      map = new URL(mapUrl);
      script = new URL(scriptUrl);
    } catch {
      return Promise.resolve({ error: "map-url-invalid" });
    }
    if (map.protocol !== "http:") return Promise.resolve({ error: "map-fetch-failed(non-http)" });
    if (map.origin !== script.origin) return Promise.resolve({ error: "map-fetch-failed(cross-origin)" });
    if (map.pathname.startsWith("/__nextjs_source-map"))
      return Promise.resolve({ error: "map-fetch-failed(nextjs-proxy)" });
    const host = map.hostname.replace(/^\[|\]$/g, "");
    const ip = host === "localhost" ? "127.0.0.1" : host;
    if (!isLoopbackHost(ip)) return Promise.resolve({ error: "map-fetch-failed(non-loopback)" });
    return new Promise((resolve) => {
      const req = http.get(
        {
          host: ip,
          port: map.port === "" ? 80 : Number(map.port),
          path: `${map.pathname}${map.search}`,
          timeout: 5000,
          agent: new http.Agent(),
          headers: { host: map.host, accept: "application/json" }
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            resolve({ error: `map-fetch-failed(http-${res.statusCode ?? 0})` });
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAP_HTTP_MAX) {
              req.destroy();
              resolve({ error: "map-fetch-failed(too-large)" });
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            const json = parseSourceMap(Buffer.concat(chunks).toString("utf8"));
            resolve(
              json === null ? { error: "map-decode-failed" } : { map: new SourceMapConsumer(json), base: mapUrl }
            );
          });
          res.on("error", () => resolve({ error: "map-fetch-failed(error)" }));
        }
      );
      req.on("error", () => resolve({ error: "map-fetch-failed(error)" }));
      req.on("timeout", () => {
        req.destroy();
        resolve({ error: "map-fetch-failed(timeout)" });
      });
    });
  }
}

export type ResolvedSite = {
  /** Generated, 0-based, already corrected by `startLine`/`startColumn`. */
  readonly line: number;
  readonly column: number;
  /** Original range (1-based, inclusive) the chosen location must map back into (spec 9.5 step 4). */
  readonly originalFrom: number;
  readonly originalTo: number;
  /** `map-untrusted`, `re-anchored`: shown next to the state (spec 9.5 p.8). */
  readonly notes: readonly string[];
};
export type SiteResolution = ResolvedSite | { readonly failed: string } | null;

/** Lines searched on each side when a disk line has to be found again in other text (spec 9.5 step 0). */
export const REANCHOR_WINDOW = 200;

function joinRoot(root: string, source: string): string {
  if (root === "" || /^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith("/")) return source;
  return `${root.replace(/\/?$/, "/")}${source}`;
}

function matches(point: LogicalPoint, source: string, base: string | null, caseInsensitive: boolean): boolean {
  const normalized = normalizeSource(source, base);
  if (normalized.ignored) return false;
  const root = point.root ?? "/";
  if (point.relative !== null && sourcesMatch(point.relative, normalized, root, caseInsensitive)) return true;
  return sourcesMatch(point.absolute, normalized, root, caseInsensitive);
}

/**
 * Token-normalized text of a line: identifiers, keywords and punctuation without whitespace or quote
 * characters, so formatting and quote style do not count as a change (spec 9.5 step 0).
 */
export function tokenNormalize(line: string): string {
  return line.replace(/\s+/g, "").replace(/['"`]/g, "");
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/**
 * The line of `other` that corresponds to line `line` (1-based) of `text`, looked for within
 * ±REANCHOR_WINDOW lines by token-normalized equality; neighbours break ties. `moved: false` when the
 * line is where it was, `{failed}` when no line or several equally good lines match.
 */
export function anchorInOther(
  text: string,
  other: string,
  line: number
): { line: number; moved: boolean } | { failed: "map-mismatch" } {
  const mine = splitLines(text);
  const theirs = splitLines(other);
  if (mine.length === theirs.length && mine.every((item, index) => item === theirs[index])) {
    return { line, moved: false };
  }
  const want = tokenNormalize(mine[line - 1] ?? "");
  if (want === "") return { failed: "map-mismatch" };
  const from = Math.max(0, line - 1 - REANCHOR_WINDOW);
  const to = Math.min(theirs.length, line + REANCHOR_WINDOW);
  let candidates: number[] = [];
  for (let index = from; index < to; index += 1) {
    if (tokenNormalize(theirs[index] ?? "") === want) candidates.push(index);
  }
  if (candidates.length > 1) {
    // Ties: the neighbours have to agree as well.
    const prev = tokenNormalize(mine[line - 2] ?? "");
    const next = tokenNormalize(mine[line] ?? "");
    const narrowed = candidates.filter(
      (index) => tokenNormalize(theirs[index - 1] ?? "") === prev && tokenNormalize(theirs[index + 1] ?? "") === next
    );
    if (narrowed.length > 0) candidates = narrowed;
  }
  if (candidates.length !== 1) return { failed: "map-mismatch" };
  return { line: candidates[0]! + 1, moved: candidates[0]! + 1 !== line };
}

/** Original anchor for the point: after the body opener when the file text is known (spec 9.5 step 2). */
export function originalAnchor(point: LogicalPoint, text: string | null): { line: number; column: number } {
  return anchorAt(text, point.line, point.endLine);
}

function anchorAt(text: string | null, line: number, endLine: number | undefined): { line: number; column: number } {
  if (text !== null && isFunctionHeaderLine(text, line)) {
    const anchor = bodyAnchor(text, line, endLine);
    if (anchor !== null) return anchor;
  }
  if (text !== null) {
    // A statement line: its own first token, so V8 snaps to that statement and not to the next block.
    const own = splitLines(text)[line - 1] ?? "";
    return { line, column: own.length - own.trimStart().length };
  }
  return { line, column: 0 };
}

type Trusted = { text: string | null; line: number; endLine: number | undefined; notes: string[] };

/**
 * Trust of the pair (script source ↔ file on disk), spec 9.5 step 0–1. Returns the text to anchor
 * in, the line of the point in that text, the last line of the range and the notes to show.
 */
export function trustedAnchor(
  point: LogicalPoint,
  diskText: string | null,
  content: string | null
): Trusted | { failed: string } {
  const span = point.endLine === undefined ? undefined : point.endLine - point.line;
  const shifted = (line: number): number | undefined => (span === undefined ? undefined : line + span);
  if (content !== null && diskText !== null) {
    // The map carries the source it was made from: anchor there, translating the disk line if needed.
    const found = anchorInOther(diskText, content, point.line);
    if ("failed" in found) return { failed: found.failed };
    if (!found.moved && splitLines(content).join("\n") === splitLines(diskText).join("\n")) {
      return { text: content, line: point.line, endLine: point.endLine, notes: [] };
    }
    return {
      text: content,
      line: found.line,
      endLine: shifted(found.line),
      notes: found.moved ? ["map-untrusted", "re-anchored"] : ["map-untrusted"]
    };
  }
  if (content !== null) return { text: content, line: point.line, endLine: point.endLine, notes: ["map-untrusted"] };
  if (diskText !== null && point.snippet !== undefined && point.snippet.trim() !== "") {
    // No `sourcesContent` (tsc): the trace's snippet is the only witness of what the file looked like.
    const disk = splitLines(diskText);
    if (tokenNormalize(disk[point.line - 1] ?? "") !== tokenNormalize(point.snippet)) {
      const found = anchorInOther(`${"\n".repeat(point.line - 1)}${point.snippet}`, diskText, point.line);
      if ("failed" in found) return { failed: found.failed };
      return { text: diskText, line: found.line, endLine: shifted(found.line), notes: ["re-anchored"] };
    }
  }
  return { text: diskText, line: point.line, endLine: point.endLine, notes: [] };
}

/**
 * Where in `script` the point should sit; `null` when the script is not about this file. Uses the
 * map when there is one (it has priority even if the url equals root + file, spec 9.4), else the url.
 */
export function resolveSite(
  script: ScriptInfo,
  map: MapResult,
  point: LogicalPoint,
  text: string | null,
  caseInsensitive: boolean
): SiteResolution {
  if (script.kind !== "user") return null;
  if (map !== null && "map" in map) {
    const found: number[] = [];
    map.map.sources.forEach((source, index) => {
      if (matches(point, joinRoot(map.map.sourceRoot, source), map.base, caseInsensitive)) found.push(index);
    });
    if (found.length === 0) return null;
    if (found.length > 1) return { failed: "ambiguous-source" };
    const index = found[0]!;
    const source = map.map.sources[index]!;
    const content = map.map.sourcesContent[index];
    const trusted = trustedAnchor(point, text, typeof content === "string" ? content : null);
    if ("failed" in trusted) return trusted;
    const anchor = anchorAt(trusted.text, trusted.line, trusted.endLine);
    const lastLine = trusted.endLine ?? trusted.line + 40;
    for (let line = anchor.line; line <= lastLine; line += 1) {
      const all = map.map.allGeneratedPositionsFor(source, line - 1);
      const after = line === anchor.line ? all.filter((pos) => pos.sourceColumn >= anchor.column) : all;
      const candidates = after.length > 0 ? after : line === anchor.line ? [] : all;
      if (candidates.length === 0) continue;
      const first = [...candidates].sort((a, b) => a.line - b.line || a.column - b.column)[0]!;
      return {
        line: first.line + script.startLine,
        column: first.line === 0 ? first.column + script.startColumn : first.column,
        originalFrom: trusted.line,
        originalTo: lastLine,
        notes: trusted.notes
      };
    }
    return { failed: "no-breakable-location" };
  }
  if (script.url === "" || !matches(point, script.url, null, caseInsensitive)) return null;
  const trusted = trustedAnchor(point, text, null);
  if ("failed" in trusted) return trusted;
  const anchor = anchorAt(trusted.text, trusted.line, trusted.endLine);
  return {
    line: anchor.line - 1 + script.startLine,
    column: anchor.column,
    originalFrom: trusted.line,
    originalTo: trusted.endLine ?? trusted.line + 40,
    // An unusable map is a note on the script, not a reason to refuse the url (spec 9.4).
    notes: map !== null && "error" in map ? [map.error, ...trusted.notes] : trusted.notes
  };
}

export type CdpSend = (method: string, params: unknown, sessionId: string | undefined) => Promise<unknown>;

/**
 * Spec 9.5 steps 3–4: the first breakable location of the function at `site` whose reverse mapping
 * lies inside the point's original range. Filters out module-level locations and React fakes of
 * neighbouring modules in the same chunk.
 */
export async function pickBreakable(
  send: CdpSend,
  script: ScriptInfo,
  map: MapResult,
  site: ResolvedSite
): Promise<ResolvedSite | { failed: string }> {
  let locations: { lineNumber: number; columnNumber?: number }[] = [];
  try {
    const result = (await send(
      "Debugger.getPossibleBreakpoints",
      {
        start: { scriptId: script.scriptId, lineNumber: site.line, columnNumber: site.column },
        restrictToFunction: true
      },
      script.sessionId
    )) as { locations?: { lineNumber: number; columnNumber?: number }[] };
    locations = result.locations ?? [];
  } catch {
    // An older runtime or a script gone in between: keep the mapped position.
    return site;
  }
  if (locations.length === 0) return { failed: "no-breakable-location" };
  const consumer = map !== null && "map" in map ? map.map : null;
  for (const location of locations.slice(0, 32)) {
    const column = location.columnNumber ?? 0;
    if (consumer === null) return { ...site, line: location.lineNumber, column };
    const generatedLine = location.lineNumber - script.startLine;
    const generatedColumn = generatedLine === 0 ? column - script.startColumn : column;
    const original = consumer.originalPositionFor(generatedLine, generatedColumn);
    if (original === null) continue;
    const originalLine = original.sourceLine + 1;
    if (originalLine >= site.originalFrom && originalLine <= site.originalTo) {
      return { ...site, line: location.lineNumber, column };
    }
  }
  return { failed: "no-breakable-location" };
}

export type CdpSetter = {
  set(
    selector: { scriptHash?: string; url?: string },
    line: number,
    column: number,
    condition: string,
    sessionId: string | undefined
  ): Promise<string>;
  remove(breakpointId: string, sessionId: string | undefined): Promise<void>;
};

type Site = {
  readonly key: string;
  readonly selector: { scriptHash?: string; url?: string };
  readonly line: number;
  readonly column: number;
  readonly sessionId: string | undefined;
  readonly regs: Map<number, Registration>;
  breakpointId: string | null;
  /** Operations on one site run one after another: V8 refuses two breakpoints at one location. */
  queue: Promise<void>;
};

export function siteKey(sessionId: string | undefined, selector: string, line: number, column: number): string {
  return `${sessionId ?? ""}|${selector}|${line}|${column}`;
}

/** Sites of one CDP session set (a Node connection, or one browser connection with many page sessions). */
export class SiteRegistry {
  private readonly sites = new Map<string, Site>();
  /** Ids of breakpoints being replaced: a pause for one of them in flight is still ours (spec 9.8). */
  private readonly retired = new Set<string>();
  private counter = 0;

  constructor(
    private readonly nonce: string,
    private readonly setter: CdpSetter
  ) {}

  has(key: string): boolean {
    return this.sites.has(key);
  }

  /** Every breakpoint id currently or very recently owned; pause attribution checks against it. */
  breakpointIds(): Set<string> {
    const ids = new Set<string>(this.retired);
    for (const site of this.sites.values()) if (site.breakpointId !== null) ids.add(site.breakpointId);
    return ids;
  }

  /** Called on `Debugger.resumed`: an id replaced before this pause can no longer pause anything. */
  forgetRetired(): void {
    this.retired.clear();
  }

  pointIdsAt(breakpointId: string): number[] {
    for (const site of this.sites.values()) {
      if (site.breakpointId === breakpointId) return [...site.regs.keys()];
    }
    return [];
  }

  countFor(pointId: number): number {
    let count = 0;
    for (const site of this.sites.values()) if (site.regs.has(pointId) && site.breakpointId !== null) count += 1;
    return count;
  }

  hasBreakpoints(): boolean {
    for (const site of this.sites.values()) {
      if (site.breakpointId === null) continue;
      for (const reg of site.regs.values()) if (reg.kind === "bp") return true;
    }
    return false;
  }

  /** Adds a registration to the site; rejects when V8 refuses the breakpoint (the site keeps its regs). */
  add(
    sessionId: string | undefined,
    selector: { scriptHash?: string; url?: string },
    line: number,
    column: number,
    reg: Registration
  ): Promise<void> {
    const key = siteKey(sessionId, selector.scriptHash ?? `url:${selector.url ?? ""}`, line, column);
    let site = this.sites.get(key);
    if (site === undefined) {
      site = { key, selector, line, column, sessionId, regs: new Map(), breakpointId: null, queue: Promise.resolve() };
      this.sites.set(key, site);
    }
    const target = site;
    return this.enqueue(target, async () => {
      if (target.regs.has(reg.id) && target.breakpointId !== null) return;
      target.regs.set(reg.id, reg);
      await this.reset(target);
    });
  }

  /** Drops the registration everywhere; empty sites lose their breakpoint (spec 9.5 p.6). Never rejects. */
  async remove(pointId: number): Promise<void> {
    await Promise.all([...this.sites.values()].map((site) => this.removeFrom(site.key, pointId)));
  }

  /** Drops one registration from one site. Never rejects. */
  removeFrom(key: string, pointId: number): Promise<void> {
    const site = this.sites.get(key);
    if (site === undefined || !site.regs.has(pointId)) return Promise.resolve();
    return this.enqueue(site, async () => {
      if (!site.regs.delete(pointId)) return;
      if (site.regs.size === 0) {
        this.sites.delete(site.key);
        await this.unset(site);
      } else {
        await this.reset(site);
      }
    }).catch(() => undefined);
  }

  async removeSession(sessionId: string): Promise<void> {
    for (const site of [...this.sites.values()]) {
      if (site.sessionId === sessionId) this.sites.delete(site.key);
    }
  }

  /** Removes every breakpoint; never rejects. */
  async clear(): Promise<void> {
    const sites = [...this.sites.values()];
    this.sites.clear();
    await Promise.all(sites.map((site) => this.enqueue(site, () => this.unset(site)).catch(() => undefined)));
  }

  private enqueue(site: Site, work: () => Promise<void>): Promise<void> {
    const run = site.queue.then(work);
    site.queue = run.catch(() => undefined);
    return run;
  }

  private async unset(site: Site): Promise<void> {
    if (site.breakpointId === null) return;
    const old = site.breakpointId;
    site.breakpointId = null;
    await this.setter.remove(old, site.sessionId).catch(() => undefined);
  }

  private async reset(site: Site): Promise<void> {
    if (site.breakpointId !== null) {
      const old = site.breakpointId;
      site.breakpointId = null;
      this.retired.add(old);
      await this.setter.remove(old, site.sessionId).catch(() => undefined);
    }
    this.counter += 1;
    const condition = siteCondition(this.nonce, this.counter.toString(16), [...site.regs.values()]);
    site.breakpointId = await this.setter.set(site.selector, site.line, site.column, condition, site.sessionId);
  }
}

export function registrationOf(point: LogicalPoint): Registration {
  return { id: point.id, kind: point.kind, names: point.names, sameCase: point.sameCase, capPlus50: point.cap + 50 };
}

export const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";
