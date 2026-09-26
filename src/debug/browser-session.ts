import { CdpClient } from "./cdp.js";
import { browserHelperSource, randomNonce } from "./helper.js";
import { cleanupStaleProfiles, launchBrowser, type LaunchedBrowser } from "./browser.js";
import { probeBrowser } from "./scan.js";
import { openWebSocket } from "./transport.js";
import { isLocalHostname, isLoopbackHost } from "./loopback.js";
import {
  CASE_INSENSITIVE_FS,
  MapCache,
  SiteRegistry,
  fileText,
  pickBreakable,
  registrationOf,
  resolveSite,
  scriptInfoFrom,
  type CdpSend,
  type LogicalPoint,
  type ScriptInfo
} from "./points.js";
import { HITS_MAX, stateWithNotes, type HitEvent, type PauseEvent } from "./node-session.js";
import { fetchScopes, type CallFrameScopes } from "./scopes.js";

const BLACKBOX = [
  "/node_modules/",
  "/@vite/client",
  "/@react-refresh",
  "/@id/__x00__",
  "^webpack-internal:///.*/node_modules/",
  "/_next/static/chunks/.*next_dist"
];

const SCRIPTS_MAX = 20000;

type PageSession = { readonly sessionId: string; readonly targetId: string; url: string; readonly type: string };

type ArmedPoint = {
  readonly point: LogicalPoint;
  readonly text: string | null;
  hits: number;
  removed: boolean;
  readonly notes: Set<string>;
};

export class BrowserDebugSession {
  readonly nonce = randomNonce();
  private launched: LaunchedBrowser | null = null;
  private client: CdpClient | null = null;
  private readonly pages = new Map<string, PageSession>();
  private pageWaiters: ((sessionId: string | null) => void)[] = [];
  private readonly scripts = new Map<string, ScriptInfo>();
  private readonly maps = new MapCache();
  private readonly sites: SiteRegistry;
  private readonly points = new Map<number, ArmedPoint>();
  private seq = 0;
  private pausedSession: string | null = null;
  private stepEpoch = false;
  private resumeEpoch = false;
  private maxPauseMs: number | null = null;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  readonly hits: HitEvent[] = [];
  pause: PauseEvent | null = null;
  label = "browser (temp profile)";
  onHit: ((hit: HitEvent) => void) | null = null;
  onPause: ((pause: PauseEvent | null) => void) | null = null;
  onBanner: ((text: string) => void) | null = null;
  onPointState: ((id: number, state: string) => void) | null = null;
  /** Reports the end of the connection (browser quit, pipe EOF) so the header can drop the label. */
  onClosed: ((reason: string) => void) | null = null;

  constructor() {
    this.sites = new SiteRegistry(this.nonce, {
      set: async (selector, line, column, condition, sessionId) => {
        const result = await this.need().send<{ breakpointId: string }>(
          "Debugger.setBreakpointByUrl",
          { ...selector, lineNumber: line, columnNumber: column, condition },
          sessionId
        );
        return result.breakpointId;
      },
      remove: async (breakpointId, sessionId) => {
        await this.client?.send("Debugger.removeBreakpoint", { breakpointId }, sessionId);
      }
    });
  }

  async launch(
    env: Readonly<Record<string, string | undefined>>,
    url: string,
    options?: { headless?: boolean; noSandbox?: boolean }
  ): Promise<void> {
    cleanupStaleProfiles();
    this.launched = launchBrowser({ env, headless: options?.headless, noSandbox: options?.noSandbox });
    const client = new CdpClient(this.launched.transport);
    this.client = client;
    this.launched.transport.onClose((reason) => this.ended(reason));
    this.wire(client);
    await client.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await client.send("Target.setDiscoverTargets", { discover: true }).catch(() => undefined);
    await this.navigate(url);
  }

  async attach(host: string, port: number, webSocketUrl: string): Promise<void> {
    if (!isLoopbackHost(host)) throw new Error("non-loopback");
    const probe = await probeBrowser(host, port);
    if (probe === null) throw new Error("not a chrome/edge inspector");
    const transport = await openWebSocket(host, port, webSocketUrl);
    const client = new CdpClient(transport);
    this.client = client;
    transport.onClose((reason) => this.ended(reason));
    this.wire(client);
    this.label = "browser (attached)";
    await client.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }

  private wire(client: CdpClient): void {
    client.on("Target.attachedToTarget", (params) => {
      void this.onAttached(params);
    });
    client.on("Target.detachedFromTarget", (params) => {
      const sessionId = (params as { sessionId?: string }).sessionId;
      if (sessionId !== undefined) this.dropSession(sessionId);
    });
    client.on("Target.targetInfoChanged", (params) => {
      const info = (params as { targetInfo?: { targetId?: string; url?: string } }).targetInfo;
      if (info?.url === undefined || info.targetId === undefined) return;
      for (const page of this.pages.values()) if (page.targetId === info.targetId) page.url = info.url;
    });
    client.on("Debugger.scriptParsed", (params, sessionId) => this.onScript(params, sessionId));
    client.on("Runtime.consoleAPICalled", (params, sessionId) => this.onConsole(params, sessionId));
    client.on("Debugger.paused", (params, sessionId) => this.onPaused(params, sessionId));
    client.on("Debugger.resumed", (_params, sessionId) => {
      if (sessionId !== this.pausedSession) return;
      this.sites.forgetRetired();
      const ours = this.resumeEpoch;
      this.resumeEpoch = false;
      if (!ours) this.stepEpoch = false;
      this.clearPause();
    });
    client.on("Page.frameNavigated", (params, sessionId) => {
      const frame = (params as { frame?: { parentId?: string; url?: string } }).frame;
      if (frame === undefined || frame.parentId !== undefined || sessionId === undefined) return;
      const page = this.pages.get(sessionId);
      if (page !== undefined) page.url = frame.url ?? page.url;
      // A new document: the old scripts of this page are gone with it.
      for (const key of [...this.scripts.keys()]) if (key.startsWith(`${sessionId}|`)) this.scripts.delete(key);
      // Chrome resets skipAllPauses on every navigation: the wanted value goes again (spec 10.4 p.4).
      void this.client
        ?.send("Debugger.setSkipAllPauses", { skip: !this.sites.hasBreakpoints() }, sessionId)
        .catch(() => undefined);
    });
  }

  /** Arms a logical point in every matching script of every initialised page (spec 10.5). */
  async arm(point: LogicalPoint): Promise<string> {
    this.need();
    const previous = this.points.get(point.id);
    if (previous !== undefined) previous.removed = true;
    const armed: ArmedPoint = { point, text: fileText(point.absolute), hits: 0, removed: false, notes: new Set() };
    this.points.set(point.id, armed);
    let failure: string | null = null;
    for (const script of [...this.scripts.values()]) {
      const outcome = await this.armInScript(armed, script);
      if (outcome !== null && outcome !== "armed" && failure === null) failure = outcome;
    }
    const count = this.sites.countFor(point.id);
    await this.syncSkip();
    const state =
      count > 0
        ? `${stateWithNotes(count, armed.notes)} · armed after first run`
        : failure !== null
          ? `failed(${failure})`
          : "pending";
    this.onPointState?.(point.id, state);
    return state;
  }

  async disarm(id: number): Promise<void> {
    const armed = this.points.get(id);
    if (armed !== undefined) armed.removed = true;
    this.points.delete(id);
    await this.sites.remove(id);
    await this.syncSkip();
  }

  armedIds(): number[] {
    return [...this.points.keys()];
  }

  async step(command: "resume" | "over" | "out" | "into"): Promise<void> {
    const client = this.need();
    const sessionId = this.pausedSession;
    if (this.pause === null || sessionId === null) return;
    this.stepEpoch = command !== "resume";
    this.resumeEpoch = true;
    const method =
      command === "resume"
        ? "Debugger.resume"
        : command === "over"
          ? "Debugger.stepOver"
          : command === "out"
            ? "Debugger.stepOut"
            : "Debugger.stepInto";
    try {
      await client.send(method, {}, sessionId);
    } catch {
      this.stepEpoch = false;
      this.resumeEpoch = false;
    }
  }

  setMaxPause(ms: number | null): void {
    this.maxPauseMs = ms;
    this.armPauseTimer();
  }

  async suspend(): Promise<void> {
    if (this.pause?.ours === true) await this.step("resume");
    for (const sessionId of this.pages.keys()) {
      await this.client?.send("Debugger.setBreakpointsActive", { active: false }, sessionId).catch(() => undefined);
    }
  }

  async resume(): Promise<void> {
    for (const sessionId of this.pages.keys()) {
      await this.client?.send("Debugger.setBreakpointsActive", { active: true }, sessionId).catch(() => undefined);
    }
  }

  /** `:reload-armed` (confirmed by the caller): every instrumented page runs again with sites armed. */
  async reload(): Promise<void> {
    const pages = [...this.pages.values()].filter((page) => page.type === "page");
    if (pages.length === 0) throw new Error("no page attached");
    for (const page of pages) {
      await this.client?.send("Page.reload", {}, page.sessionId).catch(() => undefined);
    }
  }

  async navigate(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("bad launch url");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("only http(s) launch urls");
    if (!isLocalHostname(parsed.hostname)) throw new Error("non-loopback");
    const page = await this.firstPage(3000);
    if (page === null) throw new Error("browser page did not appear");
    await this.client?.send("Page.navigate", { url }, page);
  }

  async close(): Promise<void> {
    this.closing = true;
    const client = this.client;
    const timeout = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      });
    if (client !== null) {
      // Our pause ends and our breakpoints go before the connection does (spec 9.9 steps 2–3).
      if (this.pause?.ours === true && this.pausedSession !== null) {
        this.resumeEpoch = true;
        await Promise.race([
          client.send("Debugger.resume", {}, this.pausedSession).catch(() => undefined),
          timeout(500)
        ]);
      }
      await Promise.race([this.sites.clear(), timeout(1000)]);
    }
    this.clearPause();
    this.client = null;
    if (this.launched !== null) {
      if (client !== null) {
        await Promise.race([client.send("Browser.close").catch(() => undefined), timeout(1000)]);
      }
      const launched = this.launched;
      this.launched = null;
      await launched.close();
    }
    client?.close();
  }

  private ended(reason: string): void {
    const notify = this.onClosed;
    this.onClosed = null;
    if (!this.closing) notify?.(reason);
  }

  private need(): CdpClient {
    if (this.client === null) throw new Error("not-attached");
    return this.client;
  }

  private firstPage(timeoutMs: number): Promise<string | null> {
    for (const page of this.pages.values()) if (page.type === "page") return Promise.resolve(page.sessionId);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pageWaiters = this.pageWaiters.filter((waiter) => waiter !== settle);
        resolve(null);
      }, timeoutMs);
      const settle = (sessionId: string | null): void => {
        clearTimeout(timer);
        resolve(sessionId);
      };
      this.pageWaiters.push(settle);
    });
  }

  private async syncSkip(): Promise<void> {
    const skip = !this.sites.hasBreakpoints();
    for (const sessionId of this.pages.keys()) {
      await this.client?.send("Debugger.setSkipAllPauses", { skip }, sessionId).catch(() => undefined);
    }
  }

  private async armInScript(armed: ArmedPoint, script: ScriptInfo): Promise<string | null> {
    if (armed.removed || script.kind !== "user") return null;
    const map = await this.maps.load(script, { root: armed.point.root, allowHttp: true });
    if (armed.removed || this.points.get(armed.point.id) !== armed) return null;
    if (!this.scripts.has(`${script.sessionId ?? ""}|${script.scriptId}`)) return null;
    const mapped = resolveSite(script, map, armed.point, armed.text, CASE_INSENSITIVE_FS);
    if (mapped === null) return null;
    if ("failed" in mapped) return mapped.failed;
    if (script.hash === undefined) return "no-selector";
    const site = await pickBreakable(this.send, script, map, mapped);
    if (armed.removed || this.points.get(armed.point.id) !== armed) return null;
    if ("failed" in site) return site.failed;
    try {
      // Hash sites arm identical re-executions (reload, HMR of an unchanged module) before they run.
      await this.sites.add(
        script.sessionId,
        { scriptHash: script.hash },
        site.line,
        site.column,
        registrationOf(armed.point)
      );
      for (const note of site.notes) armed.notes.add(note);
      return "armed";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private readonly send: CdpSend = (method, params, sessionId) => this.need().send(method, params, sessionId);

  private onScript(params: unknown, sessionId: string | undefined): void {
    if (sessionId === undefined || !this.pages.has(sessionId)) return;
    const script = scriptInfoFrom(params, sessionId);
    if (script === null) return;
    if (this.scripts.size >= SCRIPTS_MAX) {
      const oldest = this.scripts.keys().next();
      if (!oldest.done) this.scripts.delete(oldest.value);
    }
    this.scripts.set(`${sessionId}|${script.scriptId}`, script);
    if (script.kind !== "user" || this.points.size === 0) return;
    void (async () => {
      for (const armed of [...this.points.values()]) {
        const outcome = await this.armInScript(armed, script).catch(() => null);
        if (outcome === "armed") {
          this.onPointState?.(armed.point.id, stateWithNotes(this.sites.countFor(armed.point.id), armed.notes));
        }
      }
      await this.syncSkip();
    })();
  }

  private dropSession(sessionId: string): void {
    this.pages.delete(sessionId);
    for (const key of [...this.scripts.keys()]) if (key.startsWith(`${sessionId}|`)) this.scripts.delete(key);
    void this.sites.removeSession(sessionId);
    if (this.pausedSession === sessionId) this.clearPause();
  }

  private onConsole(params: unknown, sessionId: string | undefined): void {
    if (sessionId === undefined) return;
    const page = this.pages.get(sessionId);
    if (page === undefined) return;
    const event = params as {
      context?: string;
      args?: { value?: unknown }[];
      stackTrace?: { callFrames?: { functionName?: string; url?: string }[] };
    };
    if (event.context === undefined || !event.context.startsWith("kosmo-tui")) return;
    const args = event.args ?? [];
    if (args[0]?.value !== "KOSMO_TP" || args[1]?.value !== this.nonce) return;
    let host = "";
    try {
      host = new URL(page.url).hostname;
    } catch {
      host = "";
    }
    if (page.url !== "" && page.url !== "about:blank" && !isLocalHostname(host)) {
      this.onBanner?.("non-loopback-page");
      return;
    }
    const tpId = Number(args[2]?.value);
    const armed = this.points.get(tpId);
    if (armed === undefined || armed.removed) return;
    armed.hits += 1;
    const frames = (event.stackTrace?.callFrames ?? [])
      .map((frame) => frame.functionName || frame.url || "")
      .filter((name) => name !== "" && !name.includes("kosmo-tui://"));
    const hit: HitEvent = {
      seq: (this.seq += 1),
      tpId,
      at: new Date().toISOString().slice(11, 23),
      values: String(args[3]?.value ?? ""),
      path: frames.slice(0, 8).join(" → "),
      runtime: "browser"
    };
    this.hits.push(hit);
    if (this.hits.length > HITS_MAX) this.hits.shift();
    this.onHit?.(hit);
    if (armed.hits >= armed.point.cap) {
      armed.removed = true;
      this.sites
        .remove(tpId)
        .then(() => this.syncSkip())
        .catch(() => undefined);
      const state = `removed: cap ${armed.point.cap} reached`;
      this.onPointState?.(tpId, state);
      this.onBanner?.(state);
    }
  }

  private onPaused(params: unknown, sessionId: string | undefined): void {
    if (sessionId === undefined || !this.pages.has(sessionId)) return;
    const event = params as {
      reason?: string;
      hitBreakpoints?: string[];
      callFrames?: ({
        functionName?: string;
        url?: string;
        location?: { lineNumber?: number; scriptId?: string };
      } & CallFrameScopes)[];
    };
    const ids = this.sites.breakpointIds();
    const ours = (event.hitBreakpoints ?? []).some((id) => ids.has(id)) || this.stepEpoch;
    this.stepEpoch = false;
    if (!ours && this.launched !== null && !this.sites.hasBreakpoints()) {
      // Reload gap (spec 10.4 p.4): only a `debugger;` of the page can pause here, and the only
      // clients of a pipe browser are ours.
      this.resumeEpoch = true;
      void this.client?.send("Debugger.resume", {}, sessionId).catch(() => undefined);
      this.onBanner?.("skipped pause (reload gap)");
      return;
    }
    const frames = (event.callFrames ?? []).map((frame) => {
      const line = frame.location?.lineNumber;
      const url = frame.url || this.scripts.get(`${sessionId}|${frame.location?.scriptId ?? ""}`)?.url || "";
      return `${frame.functionName || "(anonymous)"} ${url}${line === undefined ? "" : `:${line + 1}`}`;
    });
    this.pausedSession = sessionId;
    const pause: PauseEvent = {
      reason: event.reason ?? "other",
      ours,
      frames,
      scopes: [],
      since: Date.now(),
      runtime: "browser"
    };
    this.pause = pause;
    this.onPause?.(pause);
    this.armPauseTimer();
    const top = event.callFrames?.[0];
    if (top !== undefined && ours) {
      void fetchScopes(this.send, top, sessionId, () => this.pause === pause)
        .then((scopes) => {
          if (this.pause !== pause || scopes.length === 0) return;
          this.pause = { ...pause, scopes };
          this.onPause?.(this.pause);
        })
        .catch(() => undefined);
    }
  }

  private armPauseTimer(): void {
    if (this.pauseTimer !== null) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    if (this.maxPauseMs === null || this.pause === null || !this.pause.ours) return;
    const remaining = Math.max(0, this.pause.since + this.maxPauseMs - Date.now());
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      if (this.pause?.ours !== true) return;
      this.onBanner?.(`max-pause: resumed after ${Math.round((this.maxPauseMs ?? 0) / 1000)}s`);
      void this.step("resume");
    }, remaining);
    this.pauseTimer.unref?.();
  }

  private clearPause(): void {
    if (this.pauseTimer !== null) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    this.pausedSession = null;
    if (this.pause !== null) {
      this.pause = null;
      this.onPause?.(null);
    }
  }

  private async onAttached(params: unknown): Promise<void> {
    const event = params as {
      sessionId?: string;
      targetInfo?: { type?: string; url?: string; targetId?: string };
      waitingForDebugger?: boolean;
    };
    const sessionId = event.sessionId;
    const client = this.client;
    if (sessionId === undefined || client === null) return;
    const type = event.targetInfo?.type ?? "";
    const url = event.targetInfo?.url ?? "";
    const targetId = event.targetInfo?.targetId ?? sessionId;
    if (type === "page" || type === "iframe") {
      let host = "";
      try {
        host = new URL(url).hostname;
      } catch {
        host = "";
      }
      if (url === "" || url === "about:blank" || isLocalHostname(host)) {
        this.pages.set(sessionId, { sessionId, targetId, url, type });
        if (type === "page") for (const waiter of this.pageWaiters.splice(0)) waiter(sessionId);
        const send = (method: string, args: unknown = {}): Promise<unknown> =>
          client.send(method, args, sessionId).catch(() => undefined);
        await send("Page.enable");
        await send("Page.addScriptToEvaluateOnNewDocument", {
          source: browserHelperSource(this.nonce),
          runImmediately: true
        });
        await send("Runtime.enable");
        await send("Debugger.enable");
        await send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
        await send("Debugger.setBlackboxPatterns", { patterns: BLACKBOX });
        await send("Debugger.setPauseOnExceptions", { state: "none" });
        await send("Debugger.setSkipAllPauses", { skip: !this.sites.hasBreakpoints() });
      }
      await client.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
      return;
    }
    await client.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
    if (type.includes("worker")) {
      await client.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }
}
