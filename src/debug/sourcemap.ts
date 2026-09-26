const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * One decoded segment. Lines and columns are 0-based on both sides, as in the mappings themselves and
 * in CDP; callers translating from a 1-based trace line subtract 1 first (spec 9.4).
 */
export type GeneratedPosition = {
  readonly line: number;
  readonly column: number;
  readonly source: string | null;
  readonly sourceLine: number;
  readonly sourceColumn: number;
  readonly name: string | null;
};

export type SourceMapJson = {
  version?: number;
  file?: string;
  sources?: string[];
  sourcesContent?: (string | null)[];
  sourceRoot?: string;
  names?: string[];
  mappings?: string;
  sections?: { offset: { line: number; column: number }; map?: SourceMapJson; url?: string }[];
};

const MAPPINGS_MAX = 64 * 1024 * 1024;

export class SourceMapConsumer {
  readonly sources: readonly string[];
  readonly sourcesContent: readonly (string | null)[];
  readonly sourceRoot: string;
  private readonly mappings: GeneratedPosition[];
  private byLine: Map<number, GeneratedPosition[]> | null = null;
  private bySource: Map<string, Map<number, GeneratedPosition[]>> | null = null;

  /** Tolerates malformed JSON shapes (`mappings: 123`, sections without `map`): they decode to nothing. */
  constructor(map: SourceMapJson) {
    if (Array.isArray(map.sections)) {
      const merged: GeneratedPosition[] = [];
      const sources: string[] = [];
      const contents: (string | null)[] = [];
      for (const section of map.sections) {
        if (section === null || typeof section !== "object" || !section.map || typeof section.map !== "object")
          continue;
        const offset = section.offset ?? { line: 0, column: 0 };
        const inner = new SourceMapConsumer(section.map);
        // Inner `sourceRoot` applies to the inner sources; the outer one is kept as `sourceRoot`.
        const root = inner.sourceRoot;
        sources.push(...inner.sources.map((source) => joinRoot(root, source)));
        contents.push(...inner.sourcesContent);
        for (const pos of inner.all()) {
          merged.push({
            ...pos,
            line: pos.line + (offset.line | 0),
            column: pos.line === 0 ? pos.column + (offset.column | 0) : pos.column,
            source: pos.source === null ? null : joinRoot(root, pos.source)
          });
        }
      }
      this.sources = sources;
      this.sourcesContent = contents;
      this.sourceRoot = typeof map.sourceRoot === "string" ? map.sourceRoot : "";
      this.mappings = merged;
      return;
    }
    this.sources = Array.isArray(map.sources) ? map.sources.map((source) => String(source ?? "")) : [];
    this.sourcesContent = Array.isArray(map.sourcesContent) ? map.sourcesContent : [];
    this.sourceRoot = typeof map.sourceRoot === "string" ? map.sourceRoot : "";
    const mappings = typeof map.mappings === "string" && map.mappings.length <= MAPPINGS_MAX ? map.mappings : "";
    const names = Array.isArray(map.names) ? map.names.map((name) => String(name ?? "")) : [];
    this.mappings = decodeMappings(mappings, this.sources, names);
  }

  all(): readonly GeneratedPosition[] {
    return this.mappings;
  }

  /** Nearest segment at or before `column` on `line`; indexed once, then a binary search per call. */
  originalPositionFor(line: number, column: number): GeneratedPosition | null {
    if (this.byLine === null) {
      this.byLine = new Map();
      for (const pos of this.mappings) {
        const list = this.byLine.get(pos.line);
        if (list === undefined) this.byLine.set(pos.line, [pos]);
        else list.push(pos);
      }
      for (const list of this.byLine.values()) list.sort((a, b) => a.column - b.column);
    }
    const list = this.byLine.get(line);
    if (list === undefined) return null;
    let low = 0;
    let high = list.length - 1;
    let best: GeneratedPosition | null = null;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const pos = list[mid]!;
      if (pos.column <= column) {
        best = pos;
        low = mid + 1;
      } else high = mid - 1;
    }
    return best;
  }

  allGeneratedPositionsFor(source: string, line: number, column?: number): GeneratedPosition[] {
    if (this.bySource === null) {
      this.bySource = new Map();
      for (const pos of this.mappings) {
        if (pos.source === null) continue;
        const lines = this.bySource.get(pos.source) ?? new Map<number, GeneratedPosition[]>();
        this.bySource.set(pos.source, lines);
        const list = lines.get(pos.sourceLine);
        if (list === undefined) lines.set(pos.sourceLine, [pos]);
        else list.push(pos);
      }
    }
    const list = this.bySource.get(source)?.get(line) ?? [];
    return column === undefined ? [...list] : list.filter((pos) => pos.sourceColumn === column);
  }

  sourceIndex(source: string): number {
    return this.sources.indexOf(source);
  }
}

export function decodeMappings(
  mappings: string,
  sources: readonly string[],
  names: readonly string[]
): GeneratedPosition[] {
  const out: GeneratedPosition[] = [];
  let genLine = 0;
  let genCol = 0;
  let sourceIndex = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  let nameIndex = 0;
  for (const line of mappings.split(";")) {
    genCol = 0;
    if (line !== "") {
      for (const segment of line.split(",")) {
        if (segment === "") continue;
        const fields = decodeSegment(segment);
        genCol += fields[0] ?? 0;
        const source = fields.length > 1 ? (sources[(sourceIndex += fields[1] ?? 0)] ?? null) : null;
        if (fields.length > 2) sourceLine += fields[2] ?? 0;
        if (fields.length > 3) sourceColumn += fields[3] ?? 0;
        const name = fields.length > 4 ? (names[(nameIndex += fields[4] ?? 0)] ?? null) : null;
        out.push({
          line: genLine,
          column: genCol,
          source,
          sourceLine: fields.length > 2 ? sourceLine : 0,
          sourceColumn: fields.length > 3 ? sourceColumn : 0,
          name
        });
      }
    }
    genLine += 1;
  }
  return out;
}

function decodeVLQ(input: string, state: { i: number }): number {
  let value = 0;
  let shift = 0;
  let digit = 0;
  do {
    if (state.i >= input.length) break;
    digit = B64.indexOf(input[state.i] ?? "");
    state.i += 1;
    if (digit < 0) break;
    if (shift > 30) break; // > 2^35: not a real position; stop instead of wrapping
    value += (digit & 31) * 2 ** shift;
    shift += 5;
  } while (digit & 32);
  const negated = value % 2 === 1;
  value = Math.floor(value / 2);
  return negated ? -value : value;
}

function decodeSegment(segment: string): number[] {
  const fields: number[] = [];
  const state = { i: 0 };
  while (state.i < segment.length) fields.push(decodeVLQ(segment, state));
  return fields;
}

export function parseSourceMap(text: string): SourceMapJson | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as SourceMapJson) : null;
  } catch {
    return null;
  }
}

export function decodeDataUrl(url: string): string | null {
  if (!url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const meta = url.slice(0, comma);
  const data = url.slice(comma + 1);
  if (meta.includes(";base64")) return Buffer.from(data, "base64").toString("utf8");
  try {
    return decodeURIComponent(data);
  } catch {
    return null;
  }
}

function joinRoot(root: string, source: string): string {
  if (root === "" || /^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith("/")) return source;
  return `${root.replace(/\/?$/, "/")}${source}`;
}
