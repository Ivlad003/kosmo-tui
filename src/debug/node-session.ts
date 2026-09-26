import { CdpClient } from "./cdp.js";
import { deleteHelperExpression, nodeHelperSource, randomNonce } from "./helper.js";
import { openWebSocket } from "./transport.js";
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
import { fetchScopes, type CallFrameScopes } from "./scopes.js";
import type { TargetRow } from "./scan.js";

export type HitEvent = {
  readonly seq: number;
  readonly tpId: number;
  readonly at: string;
  readonly values: string;
  readonly path: string;
  readonly runtime: "node" | "edge" | "browser";
};

export type PauseEvent = {
  readonly reason: string;
  readonly ours: boolean;
  readonly frames: readonly string[];
  /** `local:`/`closure:` sections of the top frame; filled in a moment after the frames (spec 9.7). */
  readonly scopes: readonly string[];
  readonly since: number;
  readonly runtime: "node" | "browser";
};

/** Per-registration notes (`map-untrusted`, `re-anchored`) folded into the state text. */
export function stateWithNotes(count: number, notes: ReadonlySet<string>): string {
  return `resolved (${count} scripts)${notes.size > 0 ? ` · ${[...notes].join(" · ")}` : ""}`;
}

type ArmedPoint = {
  readonly point: LogicalPoint;
  readonly text: string | null;
  hits: number;
  removed: boolean;
  readonly notes: Set<string>;
};

const SCRIPTS_MAX = 20000;
export const HITS_MAX = 1000;

export class NodeDebugSession {
  readonly nonce = randomNonce();
  private client: CdpClient | null = null;
  private readonly scripts = new Map<string, ScriptInfo>();
  private readonly maps = new MapCache();
  private readonly sites: SiteRegistry;
  private readonly points = new Map<number, ArmedPoint>();
  private seq = 0;
  private runtimeReady = false;
  private closing = false;
  /** Step epoch (spec 9.8): the first pause after our step is ours unless a foreign resume came first. */
  private stepEpoch = false;
  /** Our own resume is in flight: the next `Debugger.resumed` is not "another client". */
  private resumeEpoch = false;
  private maxPauseMs: number | null = null;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  readonly hits: HitEvent[] = [];
  pause: PauseEvent | null = null;
  label = "";
  pid: number | null = null;
  onHit: ((hit: HitEvent) => void) | null = null;
  onPause: ((pause: PauseEvent | null) => void) | null = null;
  onBanner: ((text: string) => void) | null = null;
  /** State text of a logical point changed (`resolved (N scripts)`, `removed: cap N reached`, …). */
  onPointState: ((id: number, state: string) => void) | null = null;
  /** The connection ended (process exit, socket close, `waitingForDisconnect`). Called at most once. */
  onClosed: ((reason: string) => void) | null = null;

  constructor() {
    this.sites = new SiteRegistry(this.nonce, {
      set: async (selector, line, column, condition) => {
        const result = await this.need().send<{ breakpointId: string }>("Debugger.setBreakpointByUrl", {
          ...selector,
          lineNumber: line,
          columnNumber: column,
          condition
        });
        return result.breakpointId;
      },
      remove: async (breakpointId) => {
        await this.client?.send("Debugger.removeBreakpoint", { breakpointId });
      }
    });
  }

  async attach(target: TargetRow): Promise<{ pid: number; waiting: boolean }> {
    if (target.host === null || target.port === null || target.webSocketUrl === undefined) {
      throw new Error("target has no inspector");
    }
    const transport = await openWebSocket(target.host, target.port, target.webSocketUrl);
    const client = new CdpClient(transport);
    this.client = client;
    transport.onClose((reason) => this.ended(reason));
    client.on("Debugger.scriptParsed", (params) => this.onScript(params));
    client.on("Runtime.executionContextDestroyed", (params) => {
      const id = (params as { executionContextId?: number }).executionContextId;
      if (id !== undefined) this.dropContext(id);
    });
    client.on("Runtime.consoleAPICalled", (params) => this.onConsole(params));
    client.on("Debugger.paused", (params) => this.onPaused(params));
    client.on("Debugger.resumed", () => {
      this.sites.forgetRetired();
      const ours = this.resumeEpoch;
      this.resumeEpoch = false;
      if (!ours) {
        this.stepEpoch = false;
        if (this.pause !== null) this.onBanner?.("resumed by another client");
      }
      this.clearPause();
    });
    client.on("NodeRuntime.waitingForDisconnect", () => {
      this.ended("exited");
      void this.detach();
    });
    const readPid = async (): Promise<number | undefined> => {
      const value = await client.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
        expression: "process.pid",
        throwOnSideEffect: true,
        returnByValue: true
      });
      return typeof value.result?.value === "number" ? value.result.value : undefined;
    };
    let pid = await readPid();
    const waiting = pid === undefined;
    if (!waiting && target.pid !== null && pid !== target.pid) {
      await this.detach();
      throw new Error("pid-mismatch");
    }
    if (pid === process.pid) {
      await this.detach();
      throw new Error("pid-mismatch");
    }
    await client.send("NodeRuntime.notifyWhenWaitingForDisconnect", { enabled: true }).catch(() => undefined);
    await client.send("Runtime.enable");
    this.runtimeReady = true;
    await client.send("Debugger.enable");
    await client.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
    await client.send("Debugger.setBlackboxPatterns", { patterns: ["/node_modules/"] }).catch(() => undefined);
    await client.send("Debugger.setPauseOnExceptions", { state: "none" });
    await client.send("Debugger.setSkipAllPauses", { skip: true });
    await client.send("Runtime.evaluate", { expression: nodeHelperSource(this.nonce) });
    await client.send("Runtime.runIfWaitingForDebugger").catch(() => undefined);
    if (waiting) {
      // The listener's pid was the identity so far; the process itself must agree now (spec 9.3 p.6).
      pid = await readPid().catch(() => undefined);
      if (pid !== undefined && target.pid !== null && pid !== target.pid) {
        await this.detach();
        throw new Error("pid-mismatch");
      }
    }
    this.pid = typeof pid === "number" ? pid : (target.pid ?? 0);
    return { pid: this.pid, waiting };
  }

  /** Arms a logical point in every matching script; returns its state text (spec 9.5 p.8). */
  async arm(point: LogicalPoint): Promise<string> {
    this.need();
    const text = fileText(point.absolute);
    const previous = this.points.get(point.id);
    if (previous !== undefined) previous.removed = true;
    const armed: ArmedPoint = { point, text, hits: 0, removed: false, notes: new Set() };
    this.points.set(point.id, armed);
    let failure: string | null = null;
    for (const script of [...this.scripts.values()]) {
      const outcome = await this.armInScript(armed, script);
      if (outcome !== null && outcome !== "armed" && failure === null) failure = outcome;
    }
    await this.syncSkip();
    // No url/urlRegex fallback (spec 9.5 p.6): a script not loaded yet is armed when it is parsed.
    const count = this.sites.countFor(point.id);
    const state = count > 0 ? stateWithNotes(count, armed.notes) : failure !== null ? `failed(${failure})` : "pending";
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
    if (this.pause === null) return;
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
      await client.send(method);
    } catch {
      this.stepEpoch = false;
      this.resumeEpoch = false;
    }
  }

  /** `:max-pause`: our pauses resume by themselves after `ms`; `null` turns it off (spec 9.7). */
  setMaxPause(ms: number | null): void {
    this.maxPauseMs = ms;
    this.armPauseTimer();
  }

  /** Ctrl+Z (spec 9.9): let the process run while kosmo-tui is stopped. */
  async suspend(): Promise<void> {
    if (this.pause?.ours === true) await this.step("resume");
    await this.client?.send("Debugger.setBreakpointsActive", { active: false }).catch(() => undefined);
  }

  async resume(): Promise<void> {
    await this.client?.send("Debugger.setBreakpointsActive", { active: true }).catch(() => undefined);
  }

  /**
   * For an inspector kosmo-tui enabled (spec 9.9): the process closes its debug port shortly after
   * this session disconnects. Deferred, because `inspector.close()` inside the evaluate would cut
   * the connection under the reply.
   */
  async closeInspectorPort(): Promise<void> {
    await this.client
      ?.send("Runtime.evaluate", {
        expression: 'setTimeout(() => { try { process.getBuiltinModule("node:inspector").close(); } catch {} }, 200)'
      })
      .catch(() => undefined);
  }

  async detach(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.clearPause();
    const client = this.client;
    if (client === null) return;
    const deadline = new Promise((resolve) => {
      const timer = setTimeout(resolve, 1500);
      timer.unref?.();
    });
    const work = (async () => {
      await this.sites.clear();
      if (this.pause?.ours === true) {
        this.resumeEpoch = true;
        await client.send("Debugger.resume").catch(() => undefined);
      }
      await client.send("Runtime.evaluate", { expression: deleteHelperExpression(this.nonce) }).catch(() => undefined);
      await client.send("Runtime.discardConsoleEntries").catch(() => undefined);
      await client.send("Debugger.disable").catch(() => undefined);
      client.close();
    })();
    await Promise.race([work, deadline]);
    client.close();
    this.client = null;
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

  private async syncSkip(): Promise<void> {
    await this.client?.send("Debugger.setSkipAllPauses", { skip: !this.sites.hasBreakpoints() }).catch(() => undefined);
  }

  /** `"armed"`, a failure text, or `null` when the script is not about the point's file. */
  private async armInScript(armed: ArmedPoint, script: ScriptInfo): Promise<string | null> {
    if (armed.removed || script.kind !== "user") return null;
    const map = await this.maps.load(script, { root: armed.point.root, allowHttp: false });
    // The point may have been disarmed or re-armed while the map loaded.
    if (armed.removed || this.points.get(armed.point.id) !== armed) return null;
    const mapped = resolveSite(script, map, armed.point, armed.text, CASE_INSENSITIVE_FS);
    if (mapped === null) return null;
    if ("failed" in mapped) return mapped.failed;
    if (script.hash === undefined) return "no-selector";
    const site = await pickBreakable(this.send, script, map, mapped);
    if (armed.removed || this.points.get(armed.point.id) !== armed) return null;
    if ("failed" in site) return site.failed;
    try {
      await this.sites.add(undefined, { scriptHash: script.hash }, site.line, site.column, registrationOf(armed.point));
      for (const note of site.notes) armed.notes.add(note);
      return "armed";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private readonly send: CdpSend = (method, params, sessionId) => this.need().send(method, params, sessionId);

  private onScript(params: unknown): void {
    const script = scriptInfoFrom(params);
    if (script === null) return;
    if (this.scripts.size >= SCRIPTS_MAX) {
      const oldest = this.scripts.keys().next();
      if (!oldest.done) this.scripts.delete(oldest.value);
    }
    this.scripts.set(script.scriptId, script);
    if (script.kind !== "user" || this.points.size === 0) return;
    // New hash (HMR, lazy load): every logical point is re-resolved against it (spec 9.5 p.7).
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

  private dropContext(contextId: number): void {
    for (const [id, script] of this.scripts) {
      if (script.contextId === contextId) this.scripts.delete(id);
    }
  }

  private onConsole(params: unknown): void {
    if (!this.runtimeReady) return;
    const event = params as {
      type?: string;
      context?: string;
      args?: { value?: unknown }[];
      stackTrace?: { callFrames?: { functionName?: string; url?: string }[] };
    };
    if (event.context === undefined || !event.context.startsWith("kosmo-tui")) return;
    const args = event.args ?? [];
    if (args[0]?.value !== "KOSMO_TP" || args[1]?.value !== this.nonce) return;
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
      runtime: "node"
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

  private onPaused(params: unknown): void {
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
    const frames = (event.callFrames ?? []).map((frame) => {
      const line = frame.location?.lineNumber;
      const url = frame.url || this.scripts.get(frame.location?.scriptId ?? "")?.url || "";
      return `${frame.functionName || "(anonymous)"} ${url}${line === undefined ? "" : `:${line + 1}`}`;
    });
    // A foreign pause is shown, never resumed by us (spec 9.8).
    const pause: PauseEvent = {
      reason: event.reason ?? "other",
      ours,
      frames,
      scopes: [],
      since: Date.now(),
      runtime: "node"
    };
    this.pause = pause;
    this.onPause?.(pause);
    this.armPauseTimer();
    const top = event.callFrames?.[0];
    if (top !== undefined && ours) {
      // Scope values of our own pause only; the predicate of 9.7 never runs on a foreign pause.
      void fetchScopes(this.send, top, undefined, () => this.pause === pause)
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
    if (this.pause !== null) {
      this.pause = null;
      this.onPause?.(null);
    }
  }
}
