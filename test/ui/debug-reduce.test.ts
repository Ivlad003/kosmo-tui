/**
 * Stage 2–3 view logic after review: header truth on detach, leaving the Paused view, the confirm
 * screen for every attach path, `:tp`/`:bp` parsing, and keys that keep working in debug panes.
 */
import { describe, expect, it } from "vitest";
import type { ConfirmRequest } from "../../src/debug/port.js";
import { parseCommandLine } from "../../src/ui/commands.js";
import { decodeKey } from "../../src/ui/keys.js";
import { initialState, update, type Action, type Effect, type ViewState } from "../../src/ui/state.js";
import { model, span } from "./model-fixtures.js";

function traceState(location?: { file: string; line: number }): ViewState {
  let state = initialState({ root: "/work", readOnly: false });
  [state] = update(state, {
    type: "datasetOpened",
    dataset: {
      info: { id: "ds" },
      kind: "json",
      origin: { path: "/work/a.kosmo-trace.json" },
      traces: [{ id: "t1", name: null, spans: 2, status: "complete", requests: null }],
      hasMore: false,
      notices: [],
      reloadable: true
    }
  });
  [state] = update(state, {
    type: "traceLoaded",
    model: model([
      span({ id: "r", order: 0, ...(location === undefined ? {} : { location }) }),
      span({ id: "c", parent: "r", order: 1 })
    ])
  });
  return state;
}

function run(state: ViewState, ...actions: Action[]): [ViewState, Effect[]] {
  let effects: Effect[] = [];
  for (const action of actions) {
    const [next, produced] = update(state, action);
    state = next;
    effects = [...effects, ...produced];
  }
  return [state, effects];
}

const attached = (node: string | null, browser: string | null): Action => ({
  type: "debug",
  action: { type: "event", event: { type: "attached", node, browser } }
});

describe("debug view", () => {
  it("clears labels and header status when the controller reports nothing attached", () => {
    const [mid] = run(traceState(), attached("debug: node pid 7", null));
    expect(mid.debug.status).toBe("debug: node pid 7");
    const [after] = run(mid, attached(null, null));
    expect(after.debug.nodeLabel).toBeNull();
    expect(after.debug.status).toBeNull();
    const [browserOnly] = run(mid, attached(null, "browser (temp profile)"));
    expect(browserOnly.debug.status).toBe("browser (temp profile)");
    expect(browserOnly.debug.nodeLabel).toBeNull();
  });

  it("enters the Paused view on our pause and leaves it on resume", () => {
    const paused: Action = {
      type: "debug",
      action: { type: "event", event: { type: "paused", text: "PAUSED breakpoint", frames: ["f a.ts:1"], scopes: [] } }
    };
    const resumed: Action = {
      type: "debug",
      action: { type: "event", event: { type: "paused", text: null, frames: [], scopes: [] } }
    };
    const [onPause] = run(traceState(), paused);
    expect(onPause.pane).toBe("paused");
    const [onResume] = run(onPause, resumed);
    expect(onResume.pane).toBe("tree");
    expect(onResume.debug.pausedText).toBeNull();
    // A pause while the capture prompt is open does not steal the screen.
    const prompting = {
      ...traceState(),
      debug: {
        ...traceState().debug,
        capture: { kind: "tp" as const, file: "a", line: 1, text: "", sameCase: false, spanKey: null, runtime: null }
      }
    };
    const [kept] = run(prompting, paused);
    expect(kept.pane).toBe("tree");
  });

  it("dispatches the confirmed command on y and drops it on n", () => {
    const request: ConfirmRequest = {
      title: "Attach?",
      lines: ["pid 7"],
      command: { type: "attach", targetId: "pid:7", confirmed: true }
    };
    const [asked] = run(traceState(), {
      type: "debug",
      action: { type: "event", event: { type: "confirm", request } }
    });
    expect(asked.debug.confirm).toEqual(request);
    expect(decodeKey(asked, "y")).toEqual({ type: "debug", action: { type: "confirm", answer: "yes" } });
    expect(decodeKey(asked, "q")).toBeUndefined();
    const [, effects] = run(asked, { type: "debug", action: { type: "confirm", answer: "yes" } });
    expect(effects).toEqual([{ kind: "debug", command: request.command }]);
    const [declined, none] = run(asked, { type: "debug", action: { type: "confirm", answer: "no" } });
    expect(declined.debug.confirm).toBeNull();
    expect(none).toEqual([]);
    // A request with a `declined` command: `n` runs it, Esc only drops the screen.
    const twoWay: ConfirmRequest = {
      ...request,
      title: "Close the debug port too?",
      declined: { type: "detach", which: "node", closePort: false }
    };
    const [asked2] = run(traceState(), {
      type: "debug",
      action: { type: "event", event: { type: "confirm", request: twoWay } }
    });
    expect(decodeKey(asked2, "\u001b")).toEqual({ type: "debug", action: { type: "confirm", answer: "cancel" } });
    const [, no] = run(asked2, { type: "debug", action: { type: "confirm", answer: "no" } });
    expect(no).toEqual([{ kind: "debug", command: twoWay.declined }]);
    const [, cancelled] = run(asked2, { type: "debug", action: { type: "confirm", answer: "cancel" } });
    expect(cancelled).toEqual([]);
  });

  it("selecting a target asks the controller, which owns the confirmation", () => {
    const rows = [
      {
        id: "pid:7",
        kind: "node" as const,
        pid: 7,
        ppid: 1,
        label: "app",
        command: "node app.js",
        cwd: "/work",
        host: "127.0.0.1",
        port: 9229,
        inspector: "on" as const,
        sameProject: true,
        depth: 0,
        webSocketUrl: "ws://127.0.0.1:9229/x"
      }
    ];
    const [withRows] = run(
      traceState(),
      { type: "debug", action: { type: "openTargets" } },
      { type: "debug", action: { type: "event", event: { type: "targets", rows } } }
    );
    const [, effects] = run(withRows, { type: "debug", action: { type: "activateTarget" } });
    expect(effects).toEqual([{ kind: "debug", command: { type: "attach", targetId: "pid:7" } }]);
  });

  it("asks before reload-armed and refuses without a browser", () => {
    const [noBrowser] = run(traceState(), {
      type: "debug",
      action: { type: "command", command: { type: "reloadArmed" } }
    });
    expect(noBrowser.banner?.text).toBe("no browser attached");
    const [withBrowser] = run(traceState(), attached(null, "browser (temp profile)"), {
      type: "debug",
      action: { type: "command", command: { type: "reloadArmed" } }
    });
    expect(withBrowser.debug.confirm?.command).toEqual({ type: "reloadArmed", confirmed: true });
  });

  it("keeps an error banner when a controller event follows it", () => {
    const [withBanner] = run(traceState(), { type: "showBanner", level: "error", text: "not-attached" });
    const [after] = run(withBanner, {
      type: "debug",
      action: { type: "event", event: { type: "hit", text: "12:00  node  f  {}" } }
    });
    expect(after.banner?.text).toBe("not-attached");
  });

  it("routes a span without runtime to Node only", () => {
    const state = {
      ...traceState({ file: "src/cart.ts", line: 3 }),
      debug: { ...traceState().debug, nodeLabel: "debug: node pid 1" }
    };
    const [prompt] = run(state, { type: "debug", action: { type: "togglePoint", kind: "tp" } });
    expect(prompt.debug.capture?.runtime).toBe("node");
    const [, effects] = run(prompt, { type: "debug", action: { type: "captureSubmit" } });
    expect(effects[0]).toMatchObject({ kind: "debug", command: { type: "arm", runtime: "node", root: "/work" } });
  });

  it("refuses b/B without an attached target", () => {
    const state = traceState({ file: "src/cart.ts", line: 3 });
    expect(state.selected).not.toBeNull();
    const [refused, effects] = run(state, { type: "debug", action: { type: "togglePoint", kind: "tp" } });
    expect(refused.banner?.text).toContain("not-attached");
    expect(effects).toEqual([]);
  });

  it("keeps the Hits cursor on the newest hit and caps the list", () => {
    let state = traceState();
    [state] = run(state, { type: "debug", action: { type: "openHits" } });
    for (let index = 0; index < 1205; index += 1) {
      [state] = run(state, { type: "debug", action: { type: "event", event: { type: "hit", text: `hit ${index}` } } });
    }
    expect(state.debug.hits.length).toBe(1000);
    expect(state.paneCursor).toBe(999);
    expect(state.debug.hits[999]).toBe("hit 1204");
  });
});

describe("debug commands", () => {
  it("parses :bp flags and names and rejects bad names", () => {
    const state = traceState();
    expect(parseCommandLine(state, "bp src/cart.ts:12 item qty --same-case")).toEqual({
      type: "debug",
      action: {
        type: "command",
        command: {
          type: "arm",
          id: 1,
          kind: "bp",
          file: "src/cart.ts",
          root: "/work",
          line: 12,
          names: ["item", "qty"],
          sameCase: true,
          cap: 100,
          runtime: null
        }
      }
    });
    expect(parseCommandLine(state, "tp src/cart.ts:12 --same-case")).toEqual({
      error: "usage: :tp <file>:<line> [name…]"
    });
    expect(parseCommandLine(state, "tp src/cart.ts:12 item;")).toEqual({ error: "tp: not a capture name: item;" });
    expect(parseCommandLine(state, "tp src/cart.ts")).toEqual({ error: "usage: :tp <file>:<line> [name…]" });
  });

  it("validates :detach, :tp-cap and :untp arguments", () => {
    const state = traceState();
    expect(parseCommandLine(state, "detach foo")).toEqual({ error: "usage: :detach [node|browser]" });
    expect(parseCommandLine(state, "detach node")).toEqual({
      type: "debug",
      action: { type: "command", command: { type: "detach", which: "node" } }
    });
    expect(parseCommandLine(state, "tp-cap 50")).toEqual({ type: "debug", action: { type: "setCap", cap: 50 } });
    expect(parseCommandLine(state, "tp-cap many")).toEqual({ error: "usage: :tp-cap <n>" });
    expect(parseCommandLine(state, "untp 3")).toEqual({
      type: "debug",
      action: { type: "removePoint", id: 3, kind: "tp" }
    });
    const [capped] = run(state, { type: "debug", action: { type: "setCap", cap: 50 } });
    expect(capped.debug.cap).toBe(50);
    const [rejected] = run(state, { type: "debug", action: { type: "setCap", cap: 0 } });
    expect(rejected.debug.cap).toBe(100);
    expect(rejected.banner?.level).toBe("error");
  });

  it("remembers :tp points so :untp can disarm them", () => {
    const state = traceState();
    const [armed] = run(state, parseCommandLine(state, "tp src/cart.ts:12 item") as Action);
    expect(armed.debug.points).toEqual([
      { id: 1, kind: "tp", spanKey: null, file: "src/cart.ts", line: 12, runtime: null, state: "pending" }
    ]);
    expect(armed.debug.nextId).toBe(2);
    const [removed, effects] = run(armed, { type: "debug", action: { type: "removePoint", id: 1, kind: "tp" } });
    expect(removed.debug.points).toEqual([]);
    expect(effects).toEqual([{ kind: "debug", command: { type: "disarm", id: 1 } }]);
  });
});

describe("debug pane keys", () => {
  it("keeps q, : and the debug globals inside the debug panes", () => {
    const [targets] = run(traceState(), { type: "debug", action: { type: "openTargets" } });
    expect(decodeKey(targets, "q")).toEqual({ type: "quit" });
    expect(decodeKey(targets, ":")).toEqual({ type: "openPrompt", kind: "command" });
    expect(decodeKey(targets, "H")).toEqual({ type: "debug", action: { type: "openHits" } });
    expect(decodeKey(targets, "r")).toEqual({ type: "debug", action: { type: "rescan", wildcard: false } });
    const [hits] = run(traceState(), { type: "debug", action: { type: "openHits" } });
    expect(decodeKey(hits, "A")).toEqual({ type: "debug", action: { type: "openTargets" } });
  });

  it("binds Ctrl+Z to suspend", () => {
    expect(decodeKey(traceState(), "\u001a")).toEqual({ type: "debug", action: { type: "suspend" } });
  });
});
