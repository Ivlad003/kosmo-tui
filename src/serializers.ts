/**
 * Typed result serializers (task 5b.2; trace-programmable-access "Тип результату
 * визначає формат", design D12 "Result kinds").
 *
 * The result KIND decides which formats exist, never the other way round:
 *
 *  - `projection` (a trace-text document built from a canonical page) → Lisp or Tab via
 *    the protocol codecs (`renderTraceText` / `renderTraceTextV2`), or JSON of the same
 *    trace-text IR;
 *  - `table` (a SQL result, `kosmo.trace-sql/v1`) → the JSON envelope, or Tab as a named
 *    `kosmo.query-table/v1` table — never `kosmo.trace-text`, so an aggregate row can never
 *    pass for a span;
 *  - `value` (a computed scalar/object) → JSON only.
 *
 * Any other combination is a usage error. SQL and eval default to JSON.
 *
 * Every output fits OUTPUT_MAX_BYTES UTF-8 bytes including the trailing newline, and
 * stays syntactically valid: whole items/rows are dropped (with `truncated: true` and a
 * reason) rather than cutting a UTF-8 sequence, a JSON token or a Tab row in half.
 * Control characters that JSON leaves raw (DEL and C1) are escaped, and Tab cells escape
 * every control character, so no output can drive the terminal.
 */

import {
  renderTraceText,
  renderTraceTextV2,
  type TraceTextDocumentV1,
  type TraceTextDocumentV2
} from "@kosmo-callflow/protocol";

export const OUTPUT_MAX_BYTES = 51_200;
export const QUERY_TABLE_SCHEMA = "kosmo.query-table/v1";

export type OutputFormat = "lisp" | "tab" | "json";

export type ProjectionResult =
  | { kind: "projection"; version: 1; document: TraceTextDocumentV1 }
  | { kind: "projection"; version: 2; document: TraceTextDocumentV2 };

export type TableTruncation = {
  reason: "row-limit" | "byte-limit";
  maxRows: number;
  maxBytes: number;
  returnedRows: number;
};

/** A table envelope, e.g. the SQL runner's `kosmo.trace-sql/v1` result. */
export type TableResult = {
  kind: "table";
  schema: string;
  scope: Record<string, unknown>;
  coverage: Record<string, unknown>;
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  truncation?: TableTruncation;
};

export type ValueResult = {
  kind: "value";
  provenance: string;
  value: unknown;
  truncated: boolean;
  scope?: Record<string, unknown>;
  coverage?: Record<string, unknown>;
};

export type TypedResult = ProjectionResult | TableResult | ValueResult;

export const RESULT_FORMATS: Record<TypedResult["kind"], readonly OutputFormat[]> = {
  projection: ["lisp", "tab", "json"],
  table: ["json", "tab"],
  value: ["json"]
};

export type SerializeOutcome =
  | { ok: true; text: string; format: OutputFormat; truncated: boolean }
  | { ok: false; code: "unsupported-format"; message: string };

export type SerializeOptions = { maxBytes?: number };

const encoder = new TextEncoder();

export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/** Formats a result kind supports, and the one used when none is asked for. */
export function defaultFormat(kind: TypedResult["kind"]): OutputFormat {
  return kind === "projection" ? "lisp" : "json";
}

/** Usage check without serializing; the message names what the kind does support. */
export function checkFormat(kind: TypedResult["kind"], format: OutputFormat): string | null {
  if (RESULT_FORMATS[kind].includes(format)) return null;
  const why =
    kind === "table"
      ? "a table result is rows, not spans; trace-text is only for projections"
      : kind === "value"
        ? "a computed value is JSON only"
        : "unsupported";
  return `--format ${format} is unsupported for a ${kind} result (${why}); use ${RESULT_FORMATS[kind].join(" or ")}`;
}

/** JSON with DEL and C1 controls escaped too (JSON.stringify leaves them raw). */
export function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

/**
 * The largest `n` in `0..max` for which `fits(n)` holds, assuming `fits` is monotone
 * (fewer items never make the output larger). `fits(0)` is assumed true.
 */
function largestFitting(max: number, fits: (n: number) => boolean): number {
  let low = 0;
  let high = max;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

function withinBudget(text: string, maxBytes: number): boolean {
  return utf8Bytes(`${text}\n`) <= maxBytes;
}

/* ---------------------------------------------------------------- projection */

function serializeProjection(result: ProjectionResult, format: OutputFormat, maxBytes: number): SerializeOutcome {
  if (format === "json") {
    const document = result.document as { items: unknown[]; truncated: boolean };
    const cut = (count: number): string =>
      safeJson({
        ...document,
        items: document.items.slice(0, count),
        truncated: document.truncated || count < document.items.length
      });
    const full = cut(document.items.length);
    if (withinBudget(full, maxBytes)) return { ok: true, text: `${full}\n`, format, truncated: document.truncated };
    const count = largestFitting(document.items.length - 1, (n) => withinBudget(cut(n), maxBytes));
    return { ok: true, text: `${cut(count)}\n`, format, truncated: true };
  }
  // The codecs bound their own output by dropping whole items and marking truncation.
  const body =
    result.version === 1
      ? renderTraceText(result.document, { dialect: format, maxBytes: maxBytes - 1 })
      : renderTraceTextV2(result.document, { dialect: format, maxBytes: maxBytes - 1 });
  const text = body.endsWith("\n") ? body : `${body}\n`;
  if (utf8Bytes(text) > maxBytes) {
    throw new Error(`trace-text codec returned ${utf8Bytes(text)} bytes over the ${maxBytes}-byte cap`);
  }
  const unbounded =
    result.version === 1
      ? renderTraceText(result.document, { dialect: format })
      : renderTraceTextV2(result.document, { dialect: format });
  return { ok: true, text, format, truncated: result.document.truncated || unbounded !== body };
}

/* ---------------------------------------------------------------- table */

function tableJson(result: TableResult, maxBytes: number): SerializeOutcome {
  const full = safeJson(result);
  if (withinBudget(full, maxBytes)) return { ok: true, text: `${full}\n`, format: "json", truncated: result.truncated };
  const cut = (count: number): string =>
    safeJson({
      ...result,
      rows: result.rows.slice(0, count),
      truncated: true,
      truncation: {
        reason: "byte-limit",
        maxRows: result.truncation?.maxRows ?? 1_000,
        maxBytes,
        returnedRows: count
      } satisfies TableTruncation
    });
  const count = largestFitting(result.rows.length - 1, (n) => withinBudget(cut(n), maxBytes));
  return { ok: true, text: `${cut(count)}\n`, format: "json", truncated: true };
}

/**
 * One Tab cell, losslessly: SQL NULL is `\N`; strings escape backslash and every control
 * character (`\t`, `\n`, `\r`, `\xNN`, `\u{NNNN}`), so `\N` can only mean NULL; numbers are
 * decimal; lossless markers (`$int`, `$blob`, `$real`, `$oversized`) stay JSON.
 */
export function tabCell(value: unknown): string {
  if (value === null || value === undefined) return "\\N";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : safeJson({ $real: String(value) });
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "1" : "0";
  const text = typeof value === "string" ? value : safeJson(value);
  return text.replace(/[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (char) => {
    switch (char) {
      case "\\":
        return "\\\\";
      case "\t":
        return "\\t";
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      default: {
        const code = char.charCodeAt(0);
        return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u{${code.toString(16)}}`;
      }
    }
  });
}

function tableTab(result: TableResult, maxBytes: number): SerializeOutcome {
  const scope = result.scope as { snapshotId?: unknown; projectId?: unknown; traceId?: unknown };
  const header = (rows: number, truncation: TableTruncation | undefined): string[] => [
    QUERY_TABLE_SCHEMA,
    [
      `# source=${tabCell(result.schema)}`,
      `project=${tabCell(scope.projectId ?? null)}`,
      `snapshot=${tabCell(scope.snapshotId ?? null)}`,
      `trace=${tabCell(scope.traceId ?? null)}`,
      `rows=${rows}`,
      `truncated=${truncation === undefined ? "false" : `true reason=${truncation.reason}`}`
    ].join(" "),
    result.columns.map(tabCell).join("\t")
  ];
  const lines = result.rows.map((row) => row.map(tabCell).join("\t"));
  const render = (count: number, truncation: TableTruncation | undefined): string =>
    [...header(count, truncation), ...lines.slice(0, count)].join("\n");
  const full = render(lines.length, result.truncated ? result.truncation : undefined);
  if (withinBudget(full, maxBytes)) return { ok: true, text: `${full}\n`, format: "tab", truncated: result.truncated };
  const cutAt = (count: number): string =>
    render(count, {
      reason: "byte-limit",
      maxRows: result.truncation?.maxRows ?? 1_000,
      maxBytes,
      returnedRows: count
    });
  const count = largestFitting(lines.length - 1, (n) => withinBudget(cutAt(n), maxBytes));
  return { ok: true, text: `${cutAt(count)}\n`, format: "tab", truncated: true };
}

/* ---------------------------------------------------------------- value */

function serializeValue(result: ValueResult, maxBytes: number): SerializeOutcome {
  const full = safeJson(result);
  if (withinBudget(full, maxBytes)) return { ok: true, text: `${full}\n`, format: "json", truncated: result.truncated };
  const bytes = utf8Bytes(safeJson(result.value) ?? "null");
  const text = safeJson({ ...result, value: { $truncated: { bytes } }, truncated: true });
  return { ok: true, text: `${text}\n`, format: "json", truncated: true };
}

/* ---------------------------------------------------------------- entry */

/**
 * Serialize a typed result. `format` undefined means the kind's default. An unsupported
 * combination is refused before anything is rendered.
 */
export function serializeResult(
  result: TypedResult,
  format?: OutputFormat,
  options: SerializeOptions = {}
): SerializeOutcome {
  const maxBytes = options.maxBytes ?? OUTPUT_MAX_BYTES;
  const chosen = format ?? defaultFormat(result.kind);
  const problem = checkFormat(result.kind, chosen);
  if (problem !== null) return { ok: false, code: "unsupported-format", message: problem };
  switch (result.kind) {
    case "projection":
      return serializeProjection(result, chosen, maxBytes);
    case "table":
      return chosen === "tab" ? tableTab(result, maxBytes) : tableJson(result, maxBytes);
    case "value":
      return serializeValue(result, maxBytes);
  }
}
