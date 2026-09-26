import { captureFunctionSources, capturePrelude } from "./capture-core.js";

const NONCE = /^[0-9a-f]{32}$/;

export function assertNonce(nonce: string): void {
  if (!NONCE.test(nonce)) throw new Error("nonce must match ^[0-9a-f]{32}$");
}

export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bundle(nonce: string, body: string): string {
  assertNonce(nonce);
  return `(() => {
${capturePrelude()}
${captureFunctionSources()}
const nonce = "${nonce}";
const kosmoArms = new Map();
const kosmoCounts = new Map();
const kosmoUnchecked = new Map();
${body}
})();
`;
}

export function nodeHelperSource(nonce: string): string {
  return `${bundle(
    nonce,
    `// Taken once at install (spec 9.6): later swaps of globalThis.process/console cannot intercept hits.
const ctx = process.getBuiltinModule("node:inspector").console.context("kosmo-tui");
const trace = ctx.trace.bind(ctx);
const sink = (n, tpId, json) => {
  trace("KOSMO_TP", n, tpId, json);
};
const api = {
  hit(tpId, capPlus50, thunks) { return kosmoHit(nonce, sink, tpId, capPlus50, thunks); },
  match(bpId, thunks) { return kosmoMatch(bpId, thunks); },
  arm(bpId, expected) { return kosmoArm(bpId, expected); },
  unchecked(bpId) { return kosmoUncheckedCount(bpId); }
};
Object.defineProperty(globalThis, Symbol.for("kosmo-tui:" + nonce), {
  value: api, enumerable: false, configurable: true, writable: false
});`
  )}//# sourceURL=kosmo-tui://helper\n`;
}

export function edgeHelperSource(nonce: string): string {
  return `${bundle(
    nonce,
    `const binding = globalThis["__kosmo_tui_" + nonce];
const sink = (n, tpId, json) => {
  if (typeof binding === "function") binding(JSON.stringify({ nonce: n, tpId, values: json, stack: new Error().stack }));
};
const api = {
  hit(tpId, capPlus50, thunks) { return kosmoHit(nonce, sink, tpId, capPlus50, thunks); },
  match(bpId, thunks) { return kosmoMatch(bpId, thunks); },
  arm(bpId, expected) { return kosmoArm(bpId, expected); },
  unchecked(bpId) { return kosmoUncheckedCount(bpId); }
};
Object.defineProperty(globalThis, Symbol.for("kosmo-tui:" + nonce), {
  value: api, enumerable: false, configurable: true, writable: false
});`
  )}//# sourceURL=kosmo-tui://edge-helper\n`;
}

export function browserHelperSource(nonce: string): string {
  return `${bundle(
    nonce,
    `const host = location && location.hostname;
const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
if (!loopback) return;
// Bound once before page code runs (runImmediately + new-document script): later console patches miss.
const ctx = typeof console.context === "function" ? console.context("kosmo-tui") : console;
const trace = ctx.trace.bind(ctx);
const sink = (n, tpId, json) => {
  trace("KOSMO_TP", n, tpId, json);
};
const api = {
  hit(tpId, capPlus50, thunks) { return kosmoHit(nonce, sink, tpId, capPlus50, thunks); },
  match(bpId, thunks) { return kosmoMatch(bpId, thunks); },
  arm(bpId, expected) { return kosmoArm(bpId, expected); },
  unchecked(bpId) { return kosmoUncheckedCount(bpId); }
};
Object.defineProperty(globalThis, Symbol.for("kosmo-tui:" + nonce), {
  value: api, enumerable: false, configurable: true, writable: false
});`
  )}//# sourceURL=kosmo-tui://browser-helper\n`;
}

export function deleteHelperExpression(nonce: string): string {
  assertNonce(nonce);
  return `delete globalThis[Symbol.for("kosmo-tui:${nonce}")]`;
}
