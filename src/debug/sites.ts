import { isCaptureName } from "../code/params.js";
import { assertNonce } from "./helper.js";

export type Registration = {
  readonly id: number;
  readonly kind: "tp" | "bp";
  readonly names: readonly string[];
  readonly sameCase: boolean;
  readonly capPlus50: number;
};

export function siteCondition(nonce: string, siteId: string, registrations: readonly Registration[]): string {
  assertNonce(nonce);
  if (!/^[0-9a-f]+$/.test(siteId)) throw new Error("bad site id");
  const objectOf = (reg: Registration): string => {
    const fields = reg.names.map((name) => {
      if (!isCaptureName(name)) throw new Error(`refusing capture name ${name}`);
      return `${name}: () => ${name === "this" ? "this" : name}`;
    });
    return `{${fields.join(", ")}}`;
  };
  const hits = registrations
    .filter((reg) => reg.kind === "tp")
    .map((reg) => {
      if (!Number.isSafeInteger(reg.id) || !Number.isSafeInteger(reg.capPlus50)) throw new Error("bad id");
      return `globalThis[Symbol.for("kosmo-tui:${nonce}")]?.hit(${reg.id}, ${reg.capPlus50}, ${objectOf(reg)})`;
    });
  const breakpoints = registrations.filter((reg) => reg.kind === "bp");
  const pause = breakpoints.some((reg) => !reg.sameCase)
    ? "true"
    : breakpoints.length === 0
      ? "false"
      : breakpoints
          .map((reg) => `globalThis[Symbol.for("kosmo-tui:${nonce}")]?.match(${reg.id}, ${objectOf(reg)}) === true`)
          .join(" || ");
  return `(${[...hits, pause].join(", ")})\n//# sourceURL=kosmo-tui://site/${siteId}\n`;
}

export type ScriptKind = "user" | "node_modules" | "node" | "tool" | "react-fake";

export function classifyScript(url: string, sourceMapURL: string | undefined, source?: string): ScriptKind | "drop" {
  if (url.startsWith("kosmo-tui://") || url.startsWith("wasm://") || url.startsWith("evalmachine.")) return "drop";
  if (url === "" && (sourceMapURL === undefined || sourceMapURL === "")) return "drop";
  if (url.startsWith("about://React/") || url.startsWith("rsc://React/")) return "react-fake";
  if (url.includes("/__nextjs-internal-proxy.")) return "tool";
  if (source !== undefined && source.includes("This module was rendered by a Server Component")) return "react-fake";
  if (url.startsWith("node:") || url.startsWith("internal/")) return "node";
  if (url.includes("/node_modules/") || url.includes("/@vite/client") || url.includes("/@react-refresh"))
    return "node_modules";
  return "user";
}

/**
 * First position inside the function body for a header at `line` (spec 9.5 step 2): after the `{`
 * or `=>` that follows the parameter list, never inside the parameters (`({ a, b }) =>`) and never
 * on the header itself when the body starts later. Lines are 1-based, columns 0-based.
 */
export function bodyAnchor(source: string, line: number, endLine?: number): { line: number; column: number } | null {
  const lines = source.split(/\r?\n/);
  const start = Math.max(0, line - 1);
  const last = Math.min(lines.length, endLine ?? line + 40);
  // Join the header window so a parameter list spanning several lines is one string.
  const offsets: number[] = [];
  let joined = "";
  for (let index = start; index < last; index += 1) {
    offsets.push(joined.length);
    joined += `${lines[index] ?? ""}\n`;
  }
  const paren = joined.indexOf("(");
  let from = 0;
  if (paren >= 0 && paren < (lines[start]?.length ?? 0) + 1) {
    let depth = 0;
    for (let index = paren; index < joined.length; index += 1) {
      const ch = joined[index];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          from = index + 1;
          break;
        }
      }
    }
    if (from === 0) return null;
  }
  const arrow = joined.indexOf("=>", from);
  const brace = joined.indexOf("{", from);
  let opener = -1;
  if (arrow >= 0 && (brace < 0 || arrow < brace)) {
    const afterArrow = brace >= 0 && /^\s*$/.test(joined.slice(arrow + 2, brace)) ? brace + 1 : arrow + 2;
    opener = afterArrow;
  } else if (brace >= 0) {
    opener = brace + 1;
  }
  if (opener < 0) return null;
  // Skip whitespace, comment-only and closing-only lines to the first statement.
  let row = offsets.findIndex((offset, index) => opener >= offset && opener < (offsets[index + 1] ?? joined.length));
  if (row < 0) return null;
  let column = opener - offsets[row]!;
  for (; row < offsets.length; row += 1) {
    const text = lines[start + row] ?? "";
    const rest = text.slice(column);
    if (rest.trim() !== "" && !/^\s*(\/\/|\/\*|[})\]])/.test(rest)) {
      return { line: start + row + 1, column: column + (rest.length - rest.trimStart().length) };
    }
    column = 0;
  }
  return null;
}
