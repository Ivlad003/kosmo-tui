/**
 * Scope values of the paused frame (spec 9.7): `local`, `block` and `closure` scopes of the top
 * frame through `Runtime.getProperties(ownProperties: true)`. Getters are never invoked (accessor
 * properties are shown as such), keys pass the same mask as recorded values, and every answer is
 * checked against the pause epoch it was asked for: `objectId`s die with the resume.
 */
import { captureIsMaskedKey, captureMaskString } from "./capture-core.js";
import type { CdpSend } from "./points.js";

type RemoteObject = {
  type?: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  className?: string;
  preview?: { overflow?: boolean; properties?: { name: string; type: string; value?: string; subtype?: string }[] };
};

type PropertyDescriptor = {
  name: string;
  value?: RemoteObject;
  get?: RemoteObject;
  set?: RemoteObject;
};

export type Scope = { readonly type: string; readonly object?: { objectId?: string } };
export type CallFrameScopes = { readonly scopeChain?: readonly Scope[] };

const SCOPE_TYPES = new Set(["local", "block", "closure", "catch"]);
const VALUE_MAX = 160;
const PROPERTIES_MAX = 40;

export function formatRemote(value: RemoteObject | undefined): string {
  if (value === undefined) return "undefined";
  if (value.unserializableValue !== undefined) return value.unserializableValue;
  if (value.type === "string") return JSON.stringify(captureMaskString(String(value.value)));
  if (value.type === "undefined") return "undefined";
  if (value.type === "boolean" || value.type === "number" || value.type === "bigint") {
    return value.description ?? String(value.value);
  }
  if (value.type === "symbol") return value.description ?? "Symbol()";
  if (value.type === "function")
    return `ƒ ${
      (value.description ?? "")
        .split("(")[0]
        ?.replace(/^(async\s+)?function\s*/, "")
        .trim() || "anonymous"
    }`;
  if (value.subtype === "null") return "null";
  const properties = value.preview?.properties;
  if (properties !== undefined) {
    const parts = properties.slice(0, PROPERTIES_MAX).map((property) => {
      const shown = captureIsMaskedKey(property.name)
        ? "masked"
        : property.type === "string"
          ? JSON.stringify(captureMaskString(property.value ?? ""))
          : (property.value ?? property.subtype ?? property.type);
      return value.subtype === "array" ? shown : `${property.name}: ${shown}`;
    });
    if (value.preview?.overflow === true || properties.length > PROPERTIES_MAX) parts.push("…");
    const open = value.subtype === "array" ? "[" : "{";
    const close = value.subtype === "array" ? "]" : "}";
    const name = value.subtype === "array" || value.className === "Object" ? "" : `${value.className ?? ""} `;
    return `${name}${open}${parts.join(", ")}${close}`;
  }
  return value.description ?? value.className ?? value.type ?? "?";
}

function clip(text: string): string {
  return text.length > VALUE_MAX ? `${text.slice(0, VALUE_MAX - 1)}…` : text;
}

export function formatScope(type: string, properties: readonly PropertyDescriptor[]): string[] {
  const rows: string[] = [];
  for (const property of properties.slice(0, PROPERTIES_MAX)) {
    if (captureIsMaskedKey(property.name)) {
      rows.push(`  ${property.name} = masked`);
      continue;
    }
    if (property.value === undefined) {
      rows.push(
        `  ${property.name} = accessor(get: ${property.get !== undefined}, set: ${property.set !== undefined})`
      );
      continue;
    }
    rows.push(clip(`  ${property.name} = ${formatRemote(property.value)}`));
  }
  if (properties.length > PROPERTIES_MAX) rows.push(`  … ${properties.length - PROPERTIES_MAX} more`);
  return [`${type}:`, ...rows];
}

/**
 * Lines describing the scopes of `frame`. `stillCurrent` is asked after every round-trip so answers
 * for a pause that has already ended are dropped (pause epoch, spec 9.7).
 */
export async function fetchScopes(
  send: CdpSend,
  frame: CallFrameScopes,
  sessionId: string | undefined,
  stillCurrent: () => boolean
): Promise<string[]> {
  const out: string[] = [];
  const scopes = (frame.scopeChain ?? []).filter((scope) => SCOPE_TYPES.has(scope.type)).slice(0, 4);
  for (const scope of scopes) {
    const objectId = scope.object?.objectId;
    if (objectId === undefined) continue;
    let properties: PropertyDescriptor[] = [];
    try {
      const result = (await send(
        "Runtime.getProperties",
        { objectId, ownProperties: true, generatePreview: true },
        sessionId
      )) as { result?: PropertyDescriptor[] };
      properties = result.result ?? [];
    } catch {
      continue;
    }
    if (!stillCurrent()) return [];
    if (properties.length === 0) continue;
    out.push(...formatScope(scope.type, properties));
  }
  return out;
}
