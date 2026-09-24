// Helper source injected into the page/worker main world. Masks before data leaves the page.
export const HELPER = String.raw`(() => {
  const KEY = Symbol.for("kosmo-tui");
  if (globalThis[KEY]) return "already";
  const con = console.context("kosmo-tui");
  const trace = con.trace;
  const stringify = JSON.stringify;
  const gopd = Object.getOwnPropertyDescriptor, keysOf = Object.keys, isArr = Array.isArray;
  const MASK = /password|passwd|token|secret|authorization|cookie|api[-_]?key|session/i;
  const REACT_EL = new Set([Symbol.for("react.element"), Symbol.for("react.transitional.element")]);
  const NodeCtor = globalThis.Node;
  const counts = new Map(); const CAP = 150;
  function nameOfType(t) { return typeof t === "string" ? t : (t && (t.displayName || t.name)) || "Anonymous"; }
  function ser(v, depth) {
    const t = typeof v;
    if (v === null || t === "boolean" || t === "string") return t === "string" && v.length > 1000 ? { $type: "string-cut", value: v.slice(0, 1000), length: v.length } : v;
    if (t === "number") return Number.isFinite(v) && !Object.is(v, -0) ? v : { $type: "number", value: Object.is(v, -0) ? "-0" : String(v) };
    if (t === "undefined") return { $type: "undefined" };
    if (t === "bigint") return { $type: "bigint", value: String(v) };
    if (t === "symbol") return { $type: "symbol", description: v.description ?? "" };
    if (t === "function") return { $type: "function", name: v.name || "" };
    if (REACT_EL.has(v.$$typeof)) return { $type: "react-element", name: nameOfType(v.type), key: v.key ?? null };
    if (NodeCtor && v instanceof NodeCtor) return { $type: "dom-node", name: v.constructor?.name || "Node", tag: v.nodeName };
    if (depth >= 2) return { $type: "deeper" };
    if (isArr(v)) { const out = []; for (let i = 0; i < v.length && i < 50; i++) out.push(ser(v[i], depth + 1)); if (v.length > 50) out.push({ $type: "more", count: v.length - 50 }); return out; }
    const out = {}; let n = 0; const ks = keysOf(v);
    for (const k of ks) {
      if (n++ >= 50) { out["…"] = { $type: "more", count: ks.length - 50 }; break; }
      if (MASK.test(k)) { out[k] = { $type: "masked" }; continue; }
      const d = gopd(v, k);
      out[k] = d && "value" in d ? ser(d.value, depth + 1) : { $type: "getter" };
    }
    const ctor = v.constructor && v.constructor.name;
    return ctor && ctor !== "Object" ? { $type: "class", name: ctor, value: out } : out;
  }
  function hit(tp, pairs) {
    const c = (counts.get(tp) ?? 0) + 1; counts.set(tp, c); if (c > CAP) return false;
    const out = {};
    for (const [name, thunk] of pairs) {
      if (MASK.test(name)) { out[name] = { $type: "masked" }; continue; }
      try { out[name] = ser(thunk(), 0); } catch (e) { out[name] = { $type: "unavailable" }; }
    }
    trace.call(con, "KOSMO_TP", tp, stringify(out));
    return false;
  }
  Object.defineProperty(globalThis, KEY, { value: Object.freeze({ hit, counts }), enumerable: false, configurable: true, writable: false });
  return "installed";
})()`;

export function condition(tpId, names) {
  const pairs = names.map((n) => `[${JSON.stringify(n)}, () => ${n}]`).join(", ");
  return `(globalThis[Symbol.for("kosmo-tui")]?.hit(${tpId}, [${pairs}]), false)`;
}
