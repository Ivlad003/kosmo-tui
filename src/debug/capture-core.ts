// @ts-nocheck
export const CAPTURE_DEPTH = 2;
export const CAPTURE_ITEMS = 50;
export const CAPTURE_STRING = 1000;
export const HIT_VALUE_MAX = 16 * 1024;
export const DEFAULT_TP_CAP = 100;
export const HOT_HITS_PER_SEC = 200;

const MASKED_WORDS = new Set([
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "auth",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "jwt",
  "bearer",
  "otp"
]);
const MASKED_PAIRS = new Set(["api key", "session id", "private key", "access key", "client secret"]);
const MASKED_WHOLE = new Set(["apikey", "sessionid", "sid", "set-cookie"]);

function kosmoKeyWords(key) {
  return String(key)
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/(\p{L})(\p{N})/gu, "$1 $2")
    .replace(/(\p{N})(\p{L})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

function kosmoIsMaskedKey(key) {
  if (MASKED_WHOLE.has(String(key).toLowerCase())) return true;
  const words = kosmoKeyWords(key);
  for (let index = 0; index < words.length; index += 1) {
    if (MASKED_WORDS.has(words[index])) return true;
    if (index + 1 < words.length && MASKED_PAIRS.has(`${words[index]} ${words[index + 1]}`)) return true;
  }
  return false;
}

function kosmoIsCredential(text) {
  return /^(?:Bearer|Basic|Digest|Negotiate)\s+\S+/i.test(text) || /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(text);
}

function kosmoMaskString(text) {
  if (kosmoIsCredential(text)) return "masked";
  return text.replace(/(^|[?&;]\s*)([^=&#?;\s]+)=([^&#;\s]*)/g, (match, lead, key, value) => {
    if (value === "") return match;
    let decoded = key;
    try {
      decoded = decodeURIComponent(String(key).replace(/\+/g, " "));
    } catch {
      decoded = key;
    }
    if (kosmoIsMaskedKey(decoded)) return `${lead}${key}=masked`;
    return match;
  });
}

/** Brand check that survives other realms (vm contexts, iframes) and never invokes user code. */
function kosmoBrand(value) {
  return Object.prototype.toString.call(value);
}

/** Own data property only: getters are never run while reading a shape (spec 9.6). */
function kosmoOwnData(value, key) {
  const desc = Object.getOwnPropertyDescriptor(value, key);
  return desc && "value" in desc ? desc : undefined;
}

function kosmoTagChild(value, depth, ancestors, paths, here) {
  try {
    return kosmoTag(value, depth, ancestors, paths, here);
  } catch (error) {
    return { $type: "unavailable", reason: error && error.message ? String(error.message) : String(error) };
  }
}

function kosmoTag(value, depth, ancestors, paths, here) {
  if (value === undefined) return { $type: "undefined" };
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { $type: "number", value: "NaN" };
    if (value === Infinity) return { $type: "number", value: "Infinity" };
    if (value === -Infinity) return { $type: "number", value: "-Infinity" };
    if (Object.is(value, -0)) return { $type: "number", value: "-0" };
    return value;
  }
  if (typeof value === "bigint") return { $type: "bigint", value: value.toString() };
  if (typeof value === "string") {
    const masked = kosmoMaskString(value);
    if (masked === "masked" && kosmoIsCredential(value)) return { $type: "masked" };
    if (masked.length > 1000) return { $type: "string-cut", value: masked.slice(0, 1000), length: masked.length };
    return masked;
  }
  if (typeof value === "function") return { $type: "function", name: value.name || "" };
  if (typeof value === "symbol") return { $type: "symbol", description: value.description || "" };
  const brand = kosmoBrand(value);
  if (brand === "[object Date]") {
    const time = Date.prototype.getTime.call(value);
    return { $type: "date", value: Number.isNaN(time) ? "Invalid Date" : new Date(time).toISOString() };
  }
  if (brand === "[object RegExp]") {
    return { $type: "class", name: "RegExp", value: { source: String(value.source), flags: String(value.flags) } };
  }
  if (brand === "[object Error]" || value instanceof Error) {
    const name = kosmoOwnData(value, "name");
    const message = kosmoOwnData(value, "message");
    return {
      $type: "class",
      name: name ? String(name.value) : value.name || "Error",
      value: { message: message ? String(message.value) : "" }
    };
  }
  if (brand === "[object Promise]") return { $type: "class", name: "Promise", value: { state: "unknown" } };
  if (brand === "[object ArrayBuffer]" || brand === "[object SharedArrayBuffer]") {
    return { $type: "class", name: brand.slice(8, -1), value: { length: value.byteLength } };
  }
  if (ArrayBuffer.isView(value)) {
    return { $type: "class", name: brand.slice(8, -1), value: { length: value.length ?? value.byteLength } };
  }
  const index = ancestors.indexOf(value);
  if (index >= 0) return { $type: "cycle", path: paths[index] };
  if (depth > 2) return { $type: "deeper" };
  ancestors.push(value);
  paths.push(here);
  try {
    return kosmoTagObject(value, depth, ancestors, paths, brand, here);
  } finally {
    ancestors.pop();
    paths.pop();
  }
}

function kosmoTagObject(value, depth, ancestors, paths, brand, here) {
  const summarized = kosmoSummarize(value);
  if (summarized !== null) return summarized;
  if (brand === "[object Map]") {
    const entries = [];
    let count = 0;
    let total = 0;
    for (const [key, item] of Map.prototype.entries.call(value)) {
      total += 1;
      if (count >= 50) continue;
      count += 1;
      entries.push([
        kosmoTagChild(key, depth + 1, ancestors, paths, `${here}.<key ${count - 1}>`),
        kosmoTagChild(item, depth + 1, ancestors, paths, `${here}.<${count - 1}>`)
      ]);
    }
    if (total > 50) entries.push({ $type: "more", count: total - 50 });
    return { $type: "map", entries };
  }
  if (brand === "[object Set]") {
    const values = [];
    let count = 0;
    let total = 0;
    for (const item of Set.prototype.values.call(value)) {
      total += 1;
      if (count >= 50) continue;
      count += 1;
      values.push(kosmoTagChild(item, depth + 1, ancestors, paths, `${here}.<${count - 1}>`));
    }
    if (total > 50) values.push({ $type: "more", count: total - 50 });
    return { $type: "set", values };
  }
  if (Array.isArray(value)) {
    const items = [];
    const limit = Math.min(value.length, 50);
    for (let index = 0; index < limit; index += 1) {
      items.push(
        index in value
          ? kosmoTagChild(value[index], depth + 1, ancestors, paths, `${here}[${index}]`)
          : { $type: "hole" }
      );
    }
    if (value.length > 50) items.push({ $type: "more", count: value.length - 50 });
    return items;
  }
  const entries = {};
  const all = Object.keys(value);
  const keys = all.slice(0, 50);
  for (const key of keys) {
    if (kosmoIsMaskedKey(key)) {
      entries[key] = { $type: "masked" };
      continue;
    }
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc) continue;
    if ("value" in desc) entries[key] = kosmoTagChild(desc.value, depth + 1, ancestors, paths, `${here}.${key}`);
    else entries[key] = { $type: "accessor", get: typeof desc.get === "function", set: typeof desc.set === "function" };
  }
  if (all.length > 50) return { $type: "object", entries, more: all.length - 50 };
  // A real object with a `$type` key must be escaped so the viewer does not read it as a tag.
  if (Object.prototype.hasOwnProperty.call(entries, "$type")) return { $type: "object", entries };
  return entries;
}

/** DOM elements only: nodeName is a platform accessor, not user code; anything else stays unread. */
function kosmoElementTag(node) {
  if (!node || typeof node !== "object") return null;
  const brand = kosmoBrand(node);
  return /^\[object (HTML|SVG|MathML)?\w*Element\]$/.test(brand) ? String(node.nodeName) : null;
}

/** Framework shapes, recognised by own data properties only; nothing here calls into the object. */
function kosmoSummarize(value) {
  if (value === null || typeof value !== "object") return null;
  const typeOf = kosmoOwnData(value, "$$typeof");
  if (
    typeOf &&
    (typeOf.value === Symbol.for("react.element") || typeOf.value === Symbol.for("react.transitional.element"))
  ) {
    const type = kosmoOwnData(value, "type");
    const key = kosmoOwnData(value, "key");
    let name = "component";
    if (type && typeof type.value === "string") name = type.value;
    else if (type && type.value) {
      const fnName = kosmoOwnData(type.value, "name") || kosmoOwnData(type.value, "displayName");
      if (fnName && typeof fnName.value === "string") name = fnName.value;
    }
    return {
      $type: "class",
      name: "ReactElement",
      value: { type: name, key: key && key.value != null ? key.value : null }
    };
  }
  const nativeEvent = kosmoOwnData(value, "nativeEvent");
  const eventType = kosmoOwnData(value, "type");
  const target = kosmoOwnData(value, "target");
  if (nativeEvent && nativeEvent.value && eventType && typeof eventType.value === "string" && target) {
    const currentTarget = kosmoOwnData(value, "currentTarget");
    return {
      $type: "class",
      name: "SyntheticEvent",
      value: {
        type: eventType.value,
        target: kosmoElementTag(target.value),
        currentTarget: kosmoElementTag(currentTarget && currentTarget.value)
      }
    };
  }
  const method = kosmoOwnData(value, "method");
  const headers = kosmoOwnData(value, "rawHeaders");
  if (method && headers && Array.isArray(headers.value)) {
    const headerMap = {};
    for (let index = 0; index + 1 < headers.value.length; index += 2) {
      const key = String(headers.value[index]);
      headerMap[key] = kosmoIsMaskedKey(key) ? { $type: "masked" } : String(headers.value[index + 1]);
    }
    const url = kosmoOwnData(value, "url");
    return {
      $type: "class",
      name: "IncomingMessage",
      value: { method: String(method.value), url: url ? String(url.value) : "", headers: headerMap }
    };
  }
  const statusCode = kosmoOwnData(value, "statusCode");
  const finished = kosmoOwnData(value, "finished");
  if (statusCode && finished) {
    return {
      $type: "class",
      name: "ServerResponse",
      value: { statusCode: statusCode.value, finished: finished.value }
    };
  }
  const args = kosmoOwnData(value, "args");
  const contextType = kosmoOwnData(value, "contextType");
  if (args && Array.isArray(args.value) && contextType && typeof contextType.value === "string") {
    const handler = kosmoOwnData(value, "handler");
    const handlerName = handler && typeof handler.value === "function" ? handler.value.name : undefined;
    return {
      $type: "class",
      name: "ExecutionContext",
      value: { contextType: contextType.value, handler: handlerName }
    };
  }
  return null;
}

function kosmoMaskTree(value) {
  return kosmoTagChild(value, 0, [], [], "$");
}

const kosmoArms = new Map();
const kosmoCounts = new Map();
const kosmoUnchecked = new Map();

function kosmoReadThunks(thunks) {
  const values = {};
  const names = thunks && typeof thunks === "object" ? Object.keys(thunks) : [];
  for (const name of names) {
    try {
      values[name] = kosmoMaskTree(thunks[name]());
    } catch (error) {
      values[name] = { $type: "unavailable", reason: error && error.message ? String(error.message) : String(error) };
    }
  }
  return values;
}

function kosmoHit(nonce, sink, tpId, capPlus50, thunks) {
  const next = (kosmoCounts.get(tpId) || 0) + 1;
  kosmoCounts.set(tpId, next);
  if (next > capPlus50) return false;
  const values = kosmoReadThunks(thunks);
  let json = "{}";
  try {
    json = JSON.stringify(values);
  } catch {
    json = '{"$type":"unavailable","reason":"stringify"}';
  }
  if (json.length > 16384) json = '{"$type":"deeper"}';
  try {
    sink(nonce, tpId, json);
  } catch {
    // the sink (inspector console / binding) is gone: a hit must never throw into the debuggee
  }
  return false;
}

function kosmoMatch(bpId, thunks) {
  const expected = kosmoArms.get(bpId);
  if (expected === undefined) {
    kosmoUnchecked.set(bpId, (kosmoUnchecked.get(bpId) || 0) + 1);
    return false;
  }
  const values = kosmoReadThunks(thunks);
  for (const name of Object.keys(expected)) {
    const want = expected[name];
    const got = values[name];
    if (want === undefined) continue;
    if (JSON.stringify(got) !== JSON.stringify(want)) return false;
  }
  return true;
}

function kosmoArm(bpId, expected) {
  kosmoArms.set(bpId, expected && typeof expected === "object" ? expected : {});
  return true;
}

function kosmoUncheckedCount(bpId) {
  return kosmoUnchecked.get(bpId) || 0;
}

export function capturePrelude(): string {
  return [
    `const MASKED_WORDS = new Set(${JSON.stringify([...MASKED_WORDS])});`,
    `const MASKED_PAIRS = new Set(${JSON.stringify([...MASKED_PAIRS])});`,
    `const MASKED_WHOLE = new Set(${JSON.stringify([...MASKED_WHOLE])});`
  ].join("\n");
}

export function captureFunctionSources(): string {
  return [
    kosmoKeyWords,
    kosmoIsMaskedKey,
    kosmoIsCredential,
    kosmoMaskString,
    kosmoBrand,
    kosmoOwnData,
    kosmoTagChild,
    kosmoTag,
    kosmoTagObject,
    kosmoElementTag,
    kosmoSummarize,
    kosmoMaskTree,
    kosmoReadThunks,
    kosmoHit,
    kosmoMatch,
    kosmoArm,
    kosmoUncheckedCount
  ]
    .map((fn) => fn.toString())
    .join("\n");
}

export function serializeLive(value: unknown): unknown {
  return kosmoMaskTree(value);
}

export { kosmoIsMaskedKey as captureIsMaskedKey, kosmoMaskString as captureMaskString };
