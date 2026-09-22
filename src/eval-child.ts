/**
 * Child-process entry of the trusted local eval (spec: «Локальний довірений JS eval»).
 *
 * Spawned by `runLocalEval` in eval.ts with a 64 MiB heap and an allowlisted
 * environment; the parent owns the 2 s deadline and kills this process on expiry.
 *
 * stdin: one header line `{"code": string, "valueBudget": number, "rssBudget"?: number}`, then the serialized
 * snapshot JSON. stdout: exactly one result line, written synchronously, then exit.
 *
 * `node:vm` gives the user code a separate JS context (its own builtins, no `process`,
 * `require`, timers or dynamic `import`, string/Wasm code generation off). It is NOT a
 * security boundary: eval is for the user's own trusted code only. The trace API and the
 * serializer are created inside that context, so every object the code sees belongs to
 * its realm, and user getters/toJSON run here under the parent's deadline.
 */

import { readFileSync, writeSync } from "node:fs";
import vm from "node:vm";

/**
 * Runs inside the eval context. Completion value: `{ serialize, describe }`.
 * Kept free of backslash escapes so the source survives any tooling unchanged.
 */
const PRELUDE = String.raw`"use strict";
(() => {
  const snapshot = JSON.parse(globalThis.__kosmoSnapshot);
  delete globalThis.__kosmoSnapshot;
  delete globalThis.console;
  // No Wasm memories or shared buffers: off-heap memory the RSS watchdog would only catch late.
  delete globalThis.WebAssembly;
  delete globalThis.SharedArrayBuffer;
  delete globalThis.Atomics;
  const freeze = Object.freeze;
  const MAX_WALK = 1000000;
  const FIELDS = ["args", "ret", "error"];

  const byId = new Map();
  const childrenOf = new Map();
  for (const span of snapshot.spans) byId.set(span.id, span);
  for (const span of snapshot.spans) {
    if (span.parentId === null || !byId.has(span.parentId)) continue;
    const list = childrenOf.get(span.parentId) || [];
    list.push(span);
    childrenOf.set(span.parentId, list);
  }

  const view = (span) =>
    freeze({
      id: span.id,
      ref: freeze(Object.assign({}, span.ref)),
      parentId: span.parentId,
      nodeId: span.nodeId,
      depth: span.depth,
      errored: span.errored,
      firstSeq: span.firstSeq,
      lastSeq: span.lastSeq
    });

  const resolve = (ref) => {
    const id = typeof ref === "string" ? ref : ref !== null && typeof ref === "object" ? ref.id : undefined;
    const span = typeof id === "string" ? byId.get(id) : undefined;
    if (span === undefined) throw new TypeError("unknown span ref; use the opaque id of a span from this snapshot");
    return span;
  };

  const ancestorsOf = (span) => {
    const out = [];
    const seen = new Set([span.id]);
    let current = span.parentId === null ? undefined : byId.get(span.parentId);
    while (current !== undefined && !seen.has(current.id) && out.length < MAX_WALK) {
      seen.add(current.id);
      out.push(current);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    return out;
  };

  const neighbours = (nodeId, pick) => {
    const counts = new Map();
    for (const span of snapshot.spans) {
      const other = pick(span);
      if (other === undefined) continue;
      counts.set(other, (counts.get(other) || 0) + 1);
    }
    return freeze(
      [...counts.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([id, count]) => freeze({ nodeId: id, count, provenance: "recorded" }))
    );
  };
  const parentOf = (span) => (span.parentId === null ? undefined : byId.get(span.parentId));

  const trace = {
    scope: freeze(Object.assign({}, snapshot.scope)),
    coverage: freeze(Object.assign({}, snapshot.coverage)),
    spans: () => freeze(snapshot.spans.map(view)),
    errors: () => freeze(snapshot.spans.filter((span) => span.errored).map(view)),
    ancestors: (ref) => freeze(ancestorsOf(resolve(ref)).map(view)),
    descendants: (ref) => {
      const root = resolve(ref);
      const out = [];
      const seen = new Set([root.id]);
      const queue = [root];
      while (queue.length > 0 && out.length < MAX_WALK) {
        const next = queue.shift();
        for (const child of childrenOf.get(next.id) || []) {
          if (seen.has(child.id)) continue;
          seen.add(child.id);
          out.push(child);
          queue.push(child);
        }
      }
      return freeze(out.map(view));
    },
    path: (from, to) => {
      const a = resolve(from);
      const b = resolve(to);
      if (a.ref.sessionId !== b.ref.sessionId || a.ref.traceId !== b.ref.traceId) return freeze({ state: "no-path" });
      if (a.id === b.id) return freeze({ state: "path", spans: freeze([view(a)]) });
      const chain = ancestorsOf(b);
      const index = chain.findIndex((span) => span.id === a.id);
      if (index !== -1) return freeze({ state: "path", spans: freeze([a, ...chain.slice(0, index).reverse(), b].map(view)) });
      const top = chain.length === 0 ? b : chain[chain.length - 1];
      if (top.orphan) return freeze({ state: "unknown-path", reason: "not-loaded" });
      return freeze({ state: "no-path" });
    },
    callers: (nodeId) =>
      neighbours(nodeId, (span) => {
        const parent = span.nodeId === nodeId ? parentOf(span) : undefined;
        return parent === undefined ? undefined : parent.nodeId;
      }),
    callees: (nodeId) =>
      neighbours(nodeId, (span) => {
        const parent = parentOf(span);
        return parent !== undefined && parent.nodeId === nodeId ? span.nodeId : undefined;
      }),
    at: () => {
      throw new Error("unavailable(replay): trace.at needs the replay capability, which this snapshot does not have");
    },
    value: (ref, field) => {
      if (!FIELDS.includes(field)) throw new TypeError("trace.value field must be args, ret or error");
      const recorded = resolve(ref).values[field];
      if (recorded.state === "recorded") return freeze({ state: "recorded", text: recorded.text });
      if (recorded.state === "unavailable") return freeze({ state: "unavailable", reason: recorded.reason });
      return freeze({ state: recorded.state });
    }
  };
  globalThis.trace = freeze(trace);

  const describe = (error) => {
    try {
      const message = error !== null && typeof error === "object" && "message" in error ? error.message : error;
      const name = error !== null && typeof error === "object" && typeof error.name === "string" ? error.name + ": " : "";
      return (name + String(message)).slice(0, 2000);
    } catch (inner) {
      return "error value could not be described";
    }
  };

  const utf8Length = (text) => {
    let bytes = 0;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdbff ? 4 : code >= 0xdc00 && code <= 0xdfff ? 0 : 3;
    }
    return bytes;
  };

  class Stop {
    constructor(code, reason) {
      this.code = code;
      this.reason = reason;
    }
  }
  const isPromise = (value) =>
    Object.prototype.toString.call(value) === "[object Promise]" ||
    (value !== null && (typeof value === "object" || typeof value === "function") && typeof value.then === "function");

  const serialize = (root, budget) => {
    let used = 0;
    const stack = [];
    const emit = (text) => {
      used += utf8Length(text);
      if (used > budget) throw new Stop("output-too-large", "the result exceeds the output budget");
      return text;
    };
    const walk = (input, key, depth) => {
      let value = input;
      if (value !== null && (typeof value === "object" || typeof value === "function") && typeof value.toJSON === "function") {
        value = value.toJSON(key);
      }
      if (value === null) return emit("null");
      switch (typeof value) {
        case "boolean":
          return emit(value ? "true" : "false");
        case "number":
          return emit(Number.isFinite(value) ? String(value) : "null");
        case "string":
          return emit(JSON.stringify(value));
        case "undefined":
          return undefined;
        case "bigint":
          throw new Stop("unsupported-result", "bigint");
        case "symbol":
          throw new Stop("unsupported-result", "symbol");
        case "function":
          throw new Stop("unsupported-result", "function");
      }
      if (isPromise(value)) throw new Stop("unsupported-result", "promise");
      if (stack.includes(value)) throw new Stop("unsupported-result", "cycle");
      if (depth > 64) throw new Stop("unsupported-result", "too-deep");
      stack.push(value);
      let out;
      if (Array.isArray(value)) {
        emit("[");
        const parts = [];
        for (let i = 0; i < value.length; i += 1) {
          if (i > 0) emit(",");
          const part = walk(value[i], String(i), depth + 1);
          parts.push(part === undefined ? emit("null") : part);
        }
        emit("]");
        out = "[" + parts.join(",") + "]";
      } else {
        emit("{");
        const parts = [];
        for (const name of Object.keys(value)) {
          const part = walk(value[name], name, depth + 1);
          if (part === undefined) continue;
          if (parts.length > 0) emit(",");
          parts.push(emit(JSON.stringify(name)) + emit(":") + part);
        }
        emit("}");
        out = "{" + parts.join(",") + "}";
      }
      stack.pop();
      return out;
    };

    const fail = (stop) => JSON.stringify({ ok: false, code: stop.code, message: stop.reason });
    try {
      if (root === undefined) return fail(new Stop("unsupported-result", "undefined"));
      if (Array.isArray(root) && !isPromise(root) && typeof root.toJSON !== "function") {
        stack.push(root);
        emit("[]");
        const parts = [];
        for (let i = 0; i < root.length; i += 1) {
          const mark = used;
          try {
            if (i > 0) emit(",");
            const part = walk(root[i], String(i), 1);
            parts.push(part === undefined ? emit("null") : part);
          } catch (error) {
            if (!(error instanceof Stop) || error.code !== "output-too-large") throw error;
            used = mark;
            const truncation = { reason: "output-bytes", shownItems: parts.length, totalItems: root.length };
            return '{"ok":true,"truncation":' + JSON.stringify(truncation) + ',"value":[' + parts.join(",") + "]}";
          }
        }
        return '{"ok":true,"truncation":null,"value":[' + parts.join(",") + "]}";
      }
      const body = walk(root, "", 0);
      return '{"ok":true,"truncation":null,"value":' + (body === undefined ? "null" : body) + "}";
    } catch (error) {
      if (error instanceof Stop) return fail(error);
      return JSON.stringify({ ok: false, code: "user-error", message: "serializing the result threw: " + describe(error) });
    }
  };

  return { serialize, describe };
})();
`;

function send(line: string): never {
  writeSync(1, `${line}\n`);
  process.exit(0);
}

function main(): void {
  const input = readFileSync(0, "utf8");
  const newline = input.indexOf("\n");
  if (newline === -1) send(JSON.stringify({ ok: false, code: "protocol-error", message: "missing eval header" }));
  const header = JSON.parse(input.slice(0, newline)) as { code: string; valueBudget: number; rssBudget?: number };

  const context = vm.createContext(Object.create(null) as object, {
    name: "kosmo-eval",
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: "afterEvaluate"
  });
  (context as Record<string, unknown>).__kosmoSnapshot = input.slice(newline + 1);
  const helpers = new vm.Script(PRELUDE, { filename: "kosmo-eval-prelude.js" }).runInContext(context) as {
    serialize(value: unknown, budget: number): string;
    describe(error: unknown): string;
  };

  let script: vm.Script;
  try {
    script = new vm.Script(header.code, { filename: "eval" });
  } catch (error) {
    send(JSON.stringify({ ok: false, code: "syntax-error", message: String((error as Error).message).slice(0, 2000) }));
  }
  let result: unknown;
  try {
    result = script.runInContext(context);
  } catch (error) {
    send(JSON.stringify({ ok: false, code: "user-error", message: helpers.describe(error) }));
  }
  const serialized = helpers.serialize(result, header.valueBudget);
  // Off-heap memory (ArrayBuffers) is outside the V8 heap flags; the parent polls RSS, and
  // this check catches an allocation that finished before the parent's next poll.
  if (typeof header.rssBudget === "number" && process.memoryUsage.rss() > header.rssBudget) {
    send(JSON.stringify({ ok: false, code: "heap-exceeded", message: "rss-budget" }));
  }
  send(serialized);
}

main();
