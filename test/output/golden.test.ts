/**
 * kosmo-text/v1 golden files (spec 13.3) from the committed fixtures of task 6, plus
 * properties every fixture must keep. The fixture goes through the same validator and
 * model as every reader (validateDocument → DatasetAccumulator → buildTraceModel).
 *
 * The golden cases are also read through the readers (task 8, 9): the .json file with
 * openTarget, and the same document as NDJSON on stdin, so all containers print the
 * same text. SQLite gives the same models by the reader parity test of task 10.
 *
 * Order independence (spec 13.3) is checked on every committed fixture: the reversed
 * span order and 20 seeded shuffles (mulberry32 + Fisher–Yates, as in the task 5
 * property test) give the same text and the same model.dfs().
 *
 * After an intended change of a fixture or of the grammar, regenerate with
 * `KOSMO_UPDATE_GOLDEN=1 npx vitest run test/output/golden.test.ts` and review the diff:
 * kosmo-text/v1 is a contract (CONTRIBUTING), so a golden diff is a format change.
 */
import { createReadStream, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildTraceModel, type TraceModel } from "../../src/format/model.js";
import type { SpanRow } from "../../src/format/types.js";
import { validateDocument } from "../../src/format/validate.js";
import { renderDatasetJson } from "../../src/output/json.js";
import { OUTPUT_BYTE_CAP, jstr, renderKosmoText } from "../../src/output/kosmo-text.js";
import { renderSpansTab } from "../../src/output/tab.js";
import { openTarget } from "../../src/readers/open.js";
import type { ReaderFs } from "../../src/readers/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, "../fixtures");
const GOLDEN = path.resolve(here, "../golden");
const UPDATE = process.env.KOSMO_UPDATE_GOLDEN === "1";
const GOLDEN_CASES = [
  "kosmo-trace/basic",
  "frameworks/express-chain",
  "kosmo-trace/statuses-values",
  "frameworks/nest-pipeline",
  "frameworks/react-strict",
  "frameworks/next-action",
  "frameworks/attrs-hostile"
];
const RAW_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const noLookup = () => undefined;
const SHUFFLE_SEED = 20260924;
const SHUFFLE_RUNS = 20;

/** Deterministic PRNG (mulberry32) and Fisher–Yates shuffle, so the shuffled runs are reproducible. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], next: () => number): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const other = Math.floor(next() * (index + 1));
    [out[index], out[other]] = [out[other] as T, out[index] as T];
  }
  return out;
}

/** Every trace of a fixture as a model; `reorder` shuffles the spans before the model is built. */
function load(
  relative: string,
  reorder: (spans: readonly SpanRow[]) => SpanRow[] = (spans) => [...spans]
): TraceModel[] {
  const raw: unknown = JSON.parse(readFileSync(path.join(FIXTURES, `${relative}.kosmo-trace.json`), "utf8"));
  const result = validateDocument(raw);
  if (!result.ok) throw new Error(`${relative}: ${result.code} at ${result.position}: ${result.what}`);
  return result.acc
    .traceSummaries()
    .map((summary) =>
      buildTraceModel(
        { id: summary.id, name: summary.name },
        reorder(result.acc.spansOf(summary.id)),
        result.acc.linksOf(summary.id)
      )
    );
}

function expectGolden(file: string, actual: string): void {
  const full = path.join(GOLDEN, file);
  if (UPDATE) writeFileSync(full, actual);
  expect(existsSync(full), `missing golden ${file}; run with KOSMO_UPDATE_GOLDEN=1`).toBe(true);
  expect(actual).toBe(readFileSync(full, "utf8"));
}

function allFixtures(): string[] {
  return ["kosmo-trace", "frameworks"].flatMap((dir) =>
    readdirSync(path.join(FIXTURES, dir))
      .filter((name) => name.endsWith(".kosmo-trace.json"))
      .map((name) => `${dir}/${name.slice(0, -".kosmo-trace.json".length)}`)
      .sort()
  );
}

describe("kosmo-text/v1 golden files", () => {
  for (const relative of GOLDEN_CASES) {
    it(`${relative} --detail 1`, () => {
      for (const model of load(relative)) {
        const name = `${path.basename(relative)}.${model.trace.id}.kosmo-text`;
        expectGolden(name, renderKosmoText(model, { detail: 1, values: noLookup }));
      }
    });
  }

  it("basic --format tab (tabs written as \\t, so no golden file)", () => {
    const [model] = load("kosmo-trace/basic");
    expect(renderSpansTab(model!)).toBe(
      [
        "s1\tsp_1\t-\terrored\thttp.server\tsrc/server.ts:10\tGET /cart",
        "s1\tsp_2\tsp_1\tcomplete\tfunction\tsrc/cart.ts:3\tloadCart",
        "s1\tsp_3\tsp_1\terrored\tfunction\tsrc/cart.ts:12\tcalculateLineTotal",
        "s1\tsp_4\tsp_3\tcomplete\tfunction\tsrc/pricing.ts:5\tprice",
        ""
      ].join("\n")
    );
  });
});

describe("every fixture", () => {
  for (const relative of allFixtures()) {
    it(`${relative}: bounded, escaped, complete, order-independent`, () => {
      const backward = load(relative, (spans) => [...spans].reverse());
      load(relative).forEach((model, index) => {
        for (const detail of [0, 1] as const) {
          const out = renderKosmoText(model, { detail, values: noLookup });
          expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(OUTPUT_BYTE_CAP);
          expect(out).not.toMatch(RAW_CONTROL);
          expect(out.split("\n")[0]).toContain(` spans=${model.size} `);
          expect(renderKosmoText(backward[index]!, { detail, values: noLookup })).toBe(out);
          if (!out.includes("… truncated:")) {
            const lines = out.split("\n").slice(1, -1);
            expect(lines).toHaveLength(model.size * (detail + 1));
          }
        }
        const detail0 = renderKosmoText(model, { detail: 0, values: noLookup });
        const detail1 = renderKosmoText(model, { detail: 1, values: noLookup });
        if (!detail1.includes("… truncated:")) {
          const spanLinesOnly = detail1.split("\n").filter((line) => !line.trimStart().startsWith("args="));
          expect(spanLinesOnly.join("\n")).toBe(detail0);
        }
        if (!detail0.includes("… truncated:")) {
          // Same order and depth as model.dfs()/depthOf, so the text view (d) and the tree agree (spec 4.3).
          const order = model.dfs();
          detail0
            .split("\n")
            .slice(1, -1)
            .forEach((line, index) => {
              const ref = order[index]!;
              const head = `${"  ".repeat(model.depthOf(ref))}${line.trimStart().slice(0, 1)} ${jstr(model.get(ref)!.name)}`;
              expect(line.startsWith(head), line).toBe(true);
            });
        }
      });
    });

    it(`${relative}: ${SHUFFLE_RUNS} seeded shuffles give the same text and DFS`, () => {
      const models = load(relative);
      const texts = models.map((model) => renderKosmoText(model, { detail: 1, values: noLookup }));
      const orders = models.map((model) => model.dfs());
      const next = prng(SHUFFLE_SEED);
      for (let run = 0; run < SHUFFLE_RUNS; run += 1) {
        load(relative, (spans) => shuffle(spans, next)).forEach((model, index) => {
          expect(renderKosmoText(model, { detail: 1, values: noLookup }), `run ${run}`).toBe(texts[index]);
          expect(model.dfs(), `run ${run}`).toEqual(orders[index]);
        });
      }
    });

    it(`${relative}: --format json validates again and keeps every span`, () => {
      const models = load(relative);
      const result = validateDocument(
        JSON.parse(
          renderDatasetJson({ dataset: { id: "ds" }, traces: models.map((m) => m.trace), models, values: noLookup })
        )
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.acc.spanCount).toBe(models.reduce((sum, model) => sum + model.size, 0));
    });
  }
});

/** ReaderFs over node:fs for the reader round trip. */
const diskReaderFs: ReaderFs = {
  async stat(file) {
    const info = await stat(file).catch(() => undefined);
    return info === undefined ? undefined : { size: info.size, isFile: info.isFile(), isDirectory: info.isDirectory() };
  },
  async readHead(file, bytes) {
    const handle = await open(file, "r");
    try {
      const buffer = new Uint8Array(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
  async readFile(file, maxBytes) {
    const info = await stat(file);
    if (info.size > maxBytes) throw new Error(`${file} is larger than ${maxBytes} bytes`);
    return new Uint8Array(readFileSync(file));
  },
  createReadStream: (file) => createReadStream(file)
};

/** The same document as NDJSON lines (spec 4.5): fields flat next to `type`. */
function toNdjson(doc: {
  format: unknown;
  version: unknown;
  dataset: unknown;
  traces?: object[];
  spans: object[];
  links?: object[];
}): string {
  const lines = [
    { type: "header", format: doc.format, version: doc.version, dataset: doc.dataset },
    ...(doc.traces ?? []).map((trace) => ({ type: "trace", ...trace })),
    ...doc.spans.map((span) => ({ type: "span", ...span })),
    ...(doc.links ?? []).map((link) => ({ type: "link", ...link }))
  ];
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

describe("the golden files through the readers", () => {
  for (const relative of GOLDEN_CASES) {
    it(`${relative}: .json file and NDJSON on stdin print the golden text`, async () => {
      const file = path.join(FIXTURES, `${relative}.kosmo-trace.json`);
      const ndjson = new TextEncoder().encode(toNdjson(JSON.parse(readFileSync(file, "utf8"))));
      const signal = new AbortController().signal;
      for (const origin of [{ path: file }, "stdin"] as const) {
        const opened = await openTarget(origin, { fs: diskReaderFs, stdin: once(ndjson) }, signal);
        if (!opened.ok) throw new Error(`${relative} via ${JSON.stringify(origin)}: ${opened.error.message}`);
        expect(opened.dataset.kind).toBe(origin === "stdin" ? "ndjson" : "json");
        for (const summary of opened.dataset.traces.items) {
          const loaded = await opened.dataset.loadTrace(summary.id, signal);
          if (!loaded.ok) throw new Error(loaded.error.message);
          const golden = readFileSync(path.join(GOLDEN, `${path.basename(relative)}.${summary.id}.kosmo-text`), "utf8");
          expect(renderKosmoText(loaded.model, { detail: 1, values: noLookup })).toBe(golden);
        }
        await opened.dataset.close();
      }
    });
  }
});
