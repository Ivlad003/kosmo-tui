import path from "node:path";
import { BrowserDebugSession } from "./browser-session.js";
import { NodeDebugSession, type HitEvent, type PauseEvent } from "./node-session.js";
import type { LogicalPoint } from "./points.js";
import { findInspectorOfPid, probeBrowser, probeInspector, scanTargets, type TargetRow } from "./scan.js";
import { parseHostPort, toLoopbackIp } from "./loopback.js";

/** A screen the user answers with `y`/`n`; `y` dispatches `command`, `n` dispatches `declined` if any. */
export type ConfirmRequest = {
  readonly title: string;
  readonly lines: readonly string[];
  readonly command: DebugCommand;
  readonly declined?: DebugCommand;
};

export type PointRuntime = "node" | "edge" | "browser" | "other" | null;

export type DebugEvent =
  | { readonly type: "targets"; readonly rows: readonly TargetRow[] }
  | { readonly type: "status"; readonly text: string }
  | { readonly type: "banner"; readonly level: "info" | "error"; readonly text: string }
  | { readonly type: "hit"; readonly text: string }
  | {
      readonly type: "paused";
      readonly text: string | null;
      readonly frames: readonly string[];
      readonly scopes: readonly string[];
    }
  /** Full truth about both sessions; `null` means "not attached". */
  | { readonly type: "attached"; readonly node: string | null; readonly browser: string | null }
  | { readonly type: "confirm"; readonly request: ConfirmRequest }
  | { readonly type: "pointState"; readonly id: number; readonly state: string };

export type ArmCommand = {
  readonly type: "arm";
  readonly id: number;
  readonly kind: "tp" | "bp";
  readonly file: string;
  readonly root: string | null;
  readonly line: number;
  readonly endLine?: number;
  /** The span's recorded text of `line` (spec 9.5 step 0, maps without `sourcesContent`). */
  readonly snippet?: string;
  readonly names: readonly string[];
  readonly sameCase: boolean;
  readonly cap: number;
  /** From the span (spec 9.3 routing); `null` for `:tp`/`:bp` without a span → every attached target. */
  readonly runtime: PointRuntime;
};

export type DebugCommand =
  | { readonly type: "scan"; readonly root: string | null; readonly wildcard: boolean }
  | { readonly type: "attach"; readonly targetId: string; readonly confirmed?: boolean; readonly enable?: boolean }
  | { readonly type: "attachAddress"; readonly host: string; readonly port: number; readonly confirmed?: boolean }
  | { readonly type: "detach"; readonly which: "node" | "browser" | "both"; readonly closePort?: boolean }
  | ArmCommand
  | { readonly type: "disarm"; readonly id: number }
  | { readonly type: "step"; readonly command: "resume" | "over" | "out" | "into" }
  | { readonly type: "maxPause"; readonly seconds: number | null }
  | { readonly type: "launchBrowser"; readonly url: string; readonly confirmed?: boolean }
  | { readonly type: "attachBrowser"; readonly host: string; readonly port: number; readonly confirmed?: boolean }
  | { readonly type: "reloadArmed"; readonly confirmed?: boolean }
  | { readonly type: "close" };

const ATTACH_WARNINGS = [
  "kosmo-tui can pause this process and run code in it",
  "another debugger may already be attached; masking of live values is incomplete"
];

const RESTART_POLL_MS = 1000;
const RESTART_WINDOW_MS = 10000;

export class DebugController {
  private node: NodeDebugSession | null = null;
  private browser: BrowserDebugSession | null = null;
  private rows: TargetRow[] = [];
  private listeners = new Set<(event: DebugEvent) => void>();
  /** Points as the user set them; they outlive targets and are re-armed on (re)attach (spec 9.5 p.8). */
  private readonly logical = new Map<number, LogicalPoint>();
  /** Pids whose inspector kosmo-tui itself enabled with SIGUSR1 (spec 9.9). */
  private readonly enabledPids = new Set<number>();
  private lastNode: TargetRow | null = null;
  private restartPoll: ReturnType<typeof setTimeout> | null = null;
  private maxPauseMs: number | null = null;
  private closed = false;

  constructor(
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  on(listener: (event: DebugEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async handle(command: DebugCommand): Promise<void> {
    switch (command.type) {
      case "scan":
        await this.scan(command.root, command.wildcard);
        return;
      case "attach":
        await this.attachRow(command.targetId, command.confirmed === true, command.enable === true);
        return;
      case "attachAddress":
        await this.attachAddress(command.host, command.port, command.confirmed === true);
        return;
      case "detach":
        await this.detachAsked(command.which, command.closePort);
        return;
      case "arm":
        await this.arm(command);
        return;
      case "disarm":
        this.logical.delete(command.id);
        await this.node?.disarm(command.id);
        await this.browser?.disarm(command.id);
        return;
      case "step":
        await this.step(command.command);
        return;
      case "maxPause":
        this.maxPauseMs = command.seconds === null ? null : command.seconds * 1000;
        this.node?.setMaxPause(this.maxPauseMs);
        this.browser?.setMaxPause(this.maxPauseMs);
        this.emit({
          type: "banner",
          level: "info",
          text: command.seconds === null ? "max-pause off" : `max-pause ${command.seconds}s`
        });
        return;
      case "launchBrowser":
        await this.launch(command.url, command.confirmed === true);
        return;
      case "attachBrowser":
        await this.attachBrowser(command.host, command.port, command.confirmed === true);
        return;
      case "reloadArmed":
        await this.reloadArmed();
        return;
      case "close":
        await this.close();
        return;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopRestartPoll();
    await this.detach("both");
  }

  /** Ctrl+Z (spec 9.9): our pauses end, breakpoints go inactive while kosmo-tui is stopped. */
  async suspend(): Promise<void> {
    await Promise.all([this.node?.suspend(), this.browser?.suspend()]);
  }

  async resume(): Promise<void> {
    await Promise.all([this.node?.resume(), this.browser?.resume()]);
  }

  private emit(event: DebugEvent): void {
    if (this.closed && event.type !== "attached") return;
    for (const listener of this.listeners) listener(event);
  }

  private emitAttached(): void {
    this.emit({ type: "attached", node: this.node?.label ?? null, browser: this.browser?.label ?? null });
  }

  private confirm(title: string, lines: readonly string[], command: DebugCommand, declined?: DebugCommand): void {
    this.emit({ type: "confirm", request: { title, lines, command, ...(declined === undefined ? {} : { declined }) } });
  }

  private async scan(root: string | null, wildcard: boolean): Promise<void> {
    const uid = process.getuid?.() ?? 0;
    this.rows = await scanTargets({ uid, selfPid: process.pid, root, wildcard });
    this.emit({ type: "targets", rows: this.rows });
  }

  private async attachRow(id: string, confirmed: boolean, enable: boolean): Promise<void> {
    const row = this.rows.find((item) => item.id === id);
    if (row === undefined) {
      this.emit({ type: "banner", level: "error", text: "target gone; rescan" });
      return;
    }
    if (row.kind === "browser-launch" && row.port !== null) {
      await this.launch(`http://localhost:${row.port}`, confirmed);
      return;
    }
    if (row.inspector !== "on" || row.host === null || row.port === null || row.webSocketUrl === undefined) {
      await this.enableInspector(row, confirmed && enable);
      return;
    }
    if (!confirmed) {
      this.confirm("Attach?", this.describeRow(row), { type: "attach", targetId: id, confirmed: true });
      return;
    }
    await this.attachNode(row);
  }

  /** Enter on ○ (spec 9.2 p.7): SIGUSR1 to a verified node process, never to a supervisor. */
  private async enableInspector(row: TargetRow, confirmed: boolean): Promise<void> {
    if (this.platform === "win32") {
      this.emit({ type: "banner", level: "error", text: "inspector off; start the process with --inspect" });
      return;
    }
    if (row.kind !== "node" || row.pid === null) {
      this.emit({
        type: "banner",
        level: "error",
        text:
          row.kind === "supervisor"
            ? "inspector off; a supervisor ignores SIGUSR1 or opens the inspector in itself · inspect its child"
            : "inspector off; start the process with --inspect"
      });
      return;
    }
    if (!confirmed) {
      this.confirm(
        "Enable inspector with SIGUSR1?",
        [
          `pid ${row.pid}  ${row.command}`,
          `cwd ${row.cwd ?? "-"}`,
          "the process opens a debug port on loopback and keeps it open until it exits",
          ...ATTACH_WARNINGS
        ],
        { type: "attach", targetId: row.id, confirmed: true, enable: true }
      );
      return;
    }
    try {
      process.kill(row.pid, "SIGUSR1");
    } catch (error) {
      this.emit({
        type: "banner",
        level: "error",
        text: `SIGUSR1 failed: ${error instanceof Error ? error.message : error}`
      });
      return;
    }
    const found = await findInspectorOfPid(row.pid, 3000, this.platform);
    if (found === null) {
      this.emit({ type: "banner", level: "error", text: "inspector-enable-timeout" });
      return;
    }
    this.enabledPids.add(row.pid);
    const updated: TargetRow = {
      ...row,
      inspector: "on",
      host: found.host,
      port: found.port,
      webSocketUrl: found.webSocketUrl,
      browser: found.browser
    };
    this.rows = this.rows.map((item) => (item.id === row.id ? updated : item));
    this.emit({ type: "targets", rows: this.rows });
    await this.attachNode(updated);
  }

  private describeRow(row: TargetRow): string[] {
    const lines = [
      `pid ${row.pid ?? "-"}  ${row.command}`,
      `cwd ${row.cwd ?? "-"}`,
      `${row.host ?? "-"}:${row.port ?? "-"}  ${row.browser ?? ""}`.trimEnd(),
      ...(row.title !== undefined ? [`title ${row.title}`] : []),
      ...(row.url !== undefined ? [`url ${row.url}`] : []),
      ...(row.warning !== undefined ? [`warning: ${row.warning}`] : []),
      ...(row.kind === "unverified" ? ["warning: process identity not verified (address given by hand)"] : []),
      ...ATTACH_WARNINGS
    ];
    if (this.node !== null) lines.push(`replaces the current node session (${this.node.label})`);
    return lines;
  }

  private async attachAddress(hostInput: string, port: number, confirmed: boolean): Promise<void> {
    const host = toLoopbackIp(hostInput);
    if (host === null) {
      this.emit({ type: "banner", level: "error", text: "attach refused: not loopback" });
      return;
    }
    const probe = await probeInspector(host, port);
    if (probe === null) {
      this.emit({ type: "banner", level: "error", text: "not a node inspector" });
      return;
    }
    const row: TargetRow = {
      id: `addr:${host}:${port}`,
      kind: "unverified",
      pid: null,
      ppid: null,
      label: `${host}:${port}`,
      command: "",
      cwd: null,
      host,
      port,
      inspector: "on",
      sameProject: false,
      depth: 0,
      webSocketUrl: probe.webSocketDebuggerUrl,
      browser: probe.browser,
      ...(probe.title !== undefined ? { title: probe.title } : {}),
      ...(probe.url !== undefined ? { url: probe.url } : {})
    };
    if (!confirmed) {
      this.confirm("Attach?", this.describeRow(row), { type: "attachAddress", host, port, confirmed: true });
      return;
    }
    await this.attachNode(row);
  }

  private async attachNode(row: TargetRow): Promise<void> {
    this.stopRestartPoll();
    if (this.node !== null) {
      const previous = this.node;
      this.node = null;
      await previous.detach();
      this.emitAttached();
    }
    const session = new NodeDebugSession();
    session.setMaxPause(this.maxPauseMs);
    session.onHit = (hit) => this.emit({ type: "hit", text: hitText(hit) });
    session.onPause = (pause) => this.emit(pausedEvent(pause));
    session.onBanner = (text) => this.emit({ type: "banner", level: "info", text });
    session.onPointState = (id, state) => this.emit({ type: "pointState", id, state: `node: ${state}` });
    session.onClosed = (reason) => {
      if (this.node !== session) return;
      this.node = null;
      this.emit({ type: "paused", text: null, frames: [], scopes: [] });
      this.emitAttached();
      this.emit({ type: "banner", level: "info", text: reason === "exited" ? "target exited" : `target ${reason}` });
      void session.detach();
      this.watchRestart(row);
    };
    try {
      const attached = await this.attachWithRetry(session, row);
      session.label = `debug: node pid ${attached.pid}${row.label ? ` (${row.label})` : ""}`;
      this.node = session;
      this.lastNode = { ...row, pid: attached.pid };
      this.emitAttached();
      this.emit({ type: "status", text: session.label });
      if (attached.waiting) this.emit({ type: "banner", level: "info", text: "waiting-for-debugger; continued" });
      await this.rearm("node");
    } catch (error) {
      session.onClosed = null;
      await session.detach();
      this.emit({ type: "banner", level: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }

  /** A fresh child may not answer at its first UUID yet: `/json/list` is asked again for up to 2 s. */
  private async attachWithRetry(session: NodeDebugSession, row: TargetRow): Promise<{ pid: number; waiting: boolean }> {
    const deadline = Date.now() + 2000;
    let current = row;
    for (;;) {
      try {
        return await session.attach(current);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/websocket/.test(message) || Date.now() >= deadline || current.host === null || current.port === null) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
        const probe = await probeInspector(current.host, current.port);
        if (probe !== null) current = { ...current, webSocketUrl: probe.webSocketDebuggerUrl };
      }
    }
  }

  /** Spec 9.3: after the child of a supervisor exits, its replacement is looked for up to 10 s. */
  private watchRestart(previous: TargetRow): void {
    if (this.closed || previous.ppid === null || previous.pid === null) return;
    const supervisor = previous.ppid;
    const oldPid = previous.pid;
    const deadline = Date.now() + RESTART_WINDOW_MS;
    const tick = async (): Promise<void> => {
      this.restartPoll = null;
      if (this.closed || this.node !== null) return;
      try {
        const uid = process.getuid?.() ?? 0;
        this.rows = await scanTargets({ uid, selfPid: process.pid, root: previous.cwd, wildcard: false });
      } catch {
        this.rows = [];
      }
      const replacement = this.rows.find(
        (row) => row.kind === "node" && row.ppid === supervisor && row.pid !== oldPid && row.pid !== null
      );
      if (replacement !== undefined) {
        this.emit({ type: "targets", rows: this.rows });
        const text = `target restarted (pid ${oldPid} → ${replacement.pid}) · Enter reattach`;
        this.emit({ type: "status", text });
        if (replacement.inspector === "on") {
          this.confirm("Target restarted. Reattach?", [text, ...this.describeRow(replacement)], {
            type: "attach",
            targetId: replacement.id,
            confirmed: true
          });
        } else {
          this.emit({ type: "banner", level: "info", text: `${text} (inspector off: Enter offers SIGUSR1)` });
        }
        return;
      }
      if (Date.now() < deadline) {
        this.restartPoll = setTimeout(() => void tick(), RESTART_POLL_MS);
        this.restartPoll.unref?.();
      }
    };
    this.restartPoll = setTimeout(() => void tick(), RESTART_POLL_MS);
    this.restartPoll.unref?.();
  }

  private stopRestartPoll(): void {
    if (this.restartPoll !== null) {
      clearTimeout(this.restartPoll);
      this.restartPoll = null;
    }
  }

  private async arm(command: ArmCommand): Promise<void> {
    const absolute =
      command.root !== null && !path.isAbsolute(command.file) ? path.join(command.root, command.file) : command.file;
    const relative =
      command.root !== null && absolute.startsWith(`${command.root}${path.sep}`)
        ? path.relative(command.root, absolute)
        : path.isAbsolute(command.file)
          ? null
          : command.file;
    const runtime: LogicalPoint["runtime"] =
      command.runtime === "browser" ? "browser" : command.runtime === null ? "all" : "node";
    if (command.runtime === "other") {
      this.refuse(command.id, "runtime-not-attached");
      return;
    }
    const point: LogicalPoint = {
      id: command.id,
      kind: command.kind,
      absolute,
      relative,
      root: command.root,
      line: command.line,
      ...(command.endLine === undefined ? {} : { endLine: command.endLine }),
      ...(command.snippet === undefined ? {} : { snippet: command.snippet }),
      names: command.names,
      sameCase: command.sameCase,
      cap: command.cap,
      runtime
    };
    const targets: ("node" | "browser")[] = runtime === "all" ? ["node", "browser"] : [runtime];
    const wantNode = targets.includes("node");
    const wantBrowser = targets.includes("browser");
    if ((wantNode && this.node === null && !wantBrowser) || (wantBrowser && this.browser === null && !wantNode)) {
      this.refuse(command.id, wantBrowser ? "runtime-not-attached (browser)" : "not-attached");
      return;
    }
    if (this.node === null && this.browser === null) {
      this.refuse(command.id, "not-attached");
      return;
    }
    this.logical.set(point.id, point);
    const states: string[] = [];
    try {
      if (wantNode && this.node !== null) states.push(`node: ${await this.node.arm(point)}`);
      if (wantBrowser && this.browser !== null) states.push(`browser: ${await this.browser.arm(point)}`);
      this.emit({ type: "pointState", id: point.id, state: states.join(" · ") });
      this.emit({
        type: "banner",
        level: "info",
        text: `${command.kind} ${command.file}:${command.line} ${states.join(" · ")}`
      });
    } catch (error) {
      this.emit({ type: "banner", level: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }

  /** The UI already lists the point as `pending`: it learns the refusal and the user sees a banner. */
  private refuse(id: number, reason: string): void {
    this.emit({ type: "pointState", id, state: `failed(${reason})` });
    this.emit({ type: "banner", level: "error", text: reason });
  }

  /** Every logical point routed to `which` is armed again on a fresh session. */
  private async rearm(which: "node" | "browser"): Promise<void> {
    for (const point of this.logical.values()) {
      if (point.runtime !== "all" && point.runtime !== which) continue;
      try {
        const state = which === "node" ? await this.node?.arm(point) : await this.browser?.arm(point);
        if (state !== undefined) this.emit({ type: "pointState", id: point.id, state: `${which}: ${state}` });
      } catch (error) {
        this.emit({
          type: "pointState",
          id: point.id,
          state: `${which}: failed(${error instanceof Error ? error.message : String(error)})`
        });
      }
    }
  }

  private async step(command: "resume" | "over" | "out" | "into"): Promise<void> {
    // `c`/`n`/`o`/`s` act on the target whose pause is shown (spec 9.3 D18).
    const target =
      this.node?.pause !== null && this.node !== null ? this.node : this.browser?.pause ? this.browser : null;
    if (target === null) {
      this.emit({
        type: "banner",
        level: "error",
        text: this.node === null && this.browser === null ? "not-attached" : "not paused"
      });
      return;
    }
    await target.step(command);
  }

  private browserLines(extra: readonly string[]): string[] {
    const lines = [...extra, "temporary profile; deleted on detach", "only http(s) pages on loopback are instrumented"];
    if (this.browser !== null) lines.push(`replaces the current browser session (${this.browser.label})`);
    return lines;
  }

  private wireBrowser(session: BrowserDebugSession): void {
    session.setMaxPause(this.maxPauseMs);
    session.onHit = (hit) => this.emit({ type: "hit", text: hitText(hit) });
    session.onPause = (pause) => this.emit(pausedEvent(pause));
    session.onBanner = (text) => this.emit({ type: "banner", level: "info", text });
    session.onPointState = (id, state) => this.emit({ type: "pointState", id, state: `browser: ${state}` });
    session.onClosed = (reason) => {
      if (this.browser !== session) return;
      this.browser = null;
      this.emitAttached();
      this.emit({ type: "banner", level: "info", text: `browser ${reason === "eof" ? "exited" : reason}` });
      void session.close();
    };
  }

  private async launch(url: string, confirmed: boolean): Promise<void> {
    if (!confirmed) {
      this.confirm("Launch browser?", this.browserLines([`open ${url}`]), {
        type: "launchBrowser",
        url,
        confirmed: true
      });
      return;
    }
    await this.replaceBrowser();
    const session = new BrowserDebugSession();
    this.wireBrowser(session);
    try {
      await session.launch(this.env, url);
      this.browser = session;
      this.emitAttached();
      this.emit({ type: "banner", level: "info", text: `browser launched → ${url}` });
      await this.rearm("browser");
    } catch (error) {
      session.onClosed = null;
      await session.close();
      this.emit({ type: "banner", level: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }

  private async attachBrowser(hostInput: string, port: number, confirmed: boolean): Promise<void> {
    const host = toLoopbackIp(hostInput);
    if (host === null) {
      this.emit({ type: "banner", level: "error", text: "attach-browser refused: not loopback" });
      return;
    }
    const probe = await probeBrowser(host, port);
    if (probe === null) {
      this.emit({ type: "banner", level: "error", text: "not a Chrome/Edge inspector" });
      return;
    }
    if (!confirmed) {
      this.confirm(
        "Attach to browser?",
        this.browserLines([
          `${host}:${port}  ${probe.browser}`,
          "warning: this is a browser you use; every loopback page it opens will be instrumented"
        ]),
        { type: "attachBrowser", host, port, confirmed: true }
      );
      return;
    }
    await this.replaceBrowser();
    const session = new BrowserDebugSession();
    this.wireBrowser(session);
    try {
      await session.attach(host, port, probe.webSocketDebuggerUrl);
      this.browser = session;
      this.emitAttached();
      await this.rearm("browser");
    } catch (error) {
      session.onClosed = null;
      await session.close();
      this.emit({ type: "banner", level: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }

  private async replaceBrowser(): Promise<void> {
    if (this.browser === null) return;
    const previous = this.browser;
    this.browser = null;
    await previous.close();
    this.emitAttached();
  }

  private async reloadArmed(): Promise<void> {
    if (this.browser === null) {
      this.emit({ type: "banner", level: "error", text: "no browser attached" });
      return;
    }
    try {
      await this.browser.reload();
      this.emit({ type: "banner", level: "info", text: "reload-armed" });
    } catch (error) {
      this.emit({ type: "banner", level: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }

  /** `:detach` of an inspector kosmo-tui enabled asks whether to close the port first (spec 9.9). */
  private async detachAsked(which: "node" | "browser" | "both", closePort: boolean | undefined): Promise<void> {
    const pid = this.node?.pid ?? null;
    if (which !== "browser" && pid !== null && this.enabledPids.has(pid) && closePort === undefined) {
      this.confirm(
        "Close the debug port too?",
        [
          `pid ${pid}: kosmo-tui enabled its inspector with SIGUSR1`,
          "y closes the port (this detaches every other debugger of the process)",
          "n leaves it open until the process exits"
        ],
        { type: "detach", which, closePort: true },
        { type: "detach", which, closePort: false }
      );
      return;
    }
    if (which !== "browser" && pid !== null && closePort === true) {
      await this.node?.closeInspectorPort();
      this.enabledPids.delete(pid);
    } else if (which !== "browser" && pid !== null && this.enabledPids.has(pid)) {
      this.emit({ type: "banner", level: "info", text: "debug port stays open until the process exits" });
    }
    this.stopRestartPoll();
    await this.detach(which);
  }

  private async detach(which: "node" | "browser" | "both"): Promise<void> {
    if (which !== "browser" && this.node !== null) {
      const node = this.node;
      this.node = null;
      await node.detach();
    }
    if (which !== "node" && this.browser !== null) {
      const browser = this.browser;
      this.browser = null;
      await browser.close();
    }
    this.emit({ type: "paused", text: null, frames: [], scopes: [] });
    this.emitAttached();
  }
}

function hitText(hit: HitEvent): string {
  return `${hit.at}  ${hit.runtime}  ${hit.path}  ${hit.values}`;
}

function pausedEvent(pause: PauseEvent | null): DebugEvent {
  if (pause === null) return { type: "paused", text: null, frames: [], scopes: [] };
  return {
    type: "paused",
    text: `PAUSED ${pause.runtime} ${pause.reason}${pause.ours ? "" : " (another client)"}`,
    frames: pause.frames,
    scopes: pause.scopes
  };
}

export function parseAttach(token: string): { host: string; port: number } | null {
  return parseHostPort(token);
}
