#!/usr/bin/env node
/**
 * Frame-parity baseline generator (task 3.3).
 *
 * Renders every case in test/fixtures/parity/*.json with the ORIGINAL kosmo-callflow
 * viewer (`packages/cli/dist/connect/*` of a built kosmo-callflow checkout) and writes
 * the frames as golden files. kosmo-tui's test/frame-parity.test.ts then asserts its own
 * renderer produces the same bytes.
 *
 *   node scripts/parity-kc.mjs [--kc <path-to-kosmo-callflow>]
 *
 * Default kosmo-callflow path: ../kosmo-callflow next to this repo. Run `npm run build`
 * there first. Goldens are only ever produced by this script from the kosmo-callflow
 * renderer; they are never edited by hand or regenerated from kosmo-tui output.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const KT_ROOT = path.resolve(here, "..");
export const PARITY_DIR = path.join(KT_ROOT, "test/fixtures/parity");
export const DEFAULT_KC_ROOT = path.resolve(KT_ROOT, "../kosmo-callflow");

/** Load the kosmo-callflow viewer modules from a built checkout. */
export async function loadKc(kcRoot = DEFAULT_KC_ROOT) {
  const dist = path.join(kcRoot, "packages/cli/dist/connect");
  const load = (file) => import(pathToFileURL(path.join(dist, file)).href);
  const [viewState, render, replay, protocol] = await Promise.all([
    load("view-state.js"),
    load("render.js"),
    load("replay.js"),
    import(pathToFileURL(path.join(kcRoot, "packages/protocol/dist/index.js")).href)
  ]);
  return { viewState, render, replay, protocol };
}

/** Steps of a case with `{ include: name }` expanded, in order. */
export function expandSteps(cases, steps) {
  return steps.flatMap((step) => {
    if (step.include === undefined) return [step];
    const included = cases.find((candidate) => candidate.name === step.include);
    if (!included) throw new Error(`unknown include ${step.include}`);
    return expandSteps(cases, included.steps);
  });
}

export function parseDocument(protocol, text) {
  if (text === null || text === undefined) return null;
  const parsed = protocol.parseTraceText(text, { dialect: "lisp" });
  if (!parsed.ok) throw new Error(`fixture trace-text does not parse: ${JSON.stringify(parsed)}`);
  return parsed.data;
}

/**
 * Build the kosmo-callflow ViewState for a case at a terminal height. Mirrors the
 * kosmo-callflow viewer: viewport = rows - 4. Rows keep bare ids, as kosmo-callflow does.
 */
export function kcState(kc, cases, testCase, rows) {
  const { applyAction, applyDelta, initialViewState } = kc.viewState;
  let state = initialViewState({ viewportHeight: Math.max(1, rows - 4) });
  for (const step of expandSteps(cases, testCase.steps)) {
    if (step.delta) state = applyDelta(state, step.delta);
    else if (step.action) state = applyAction(state, step.action);
    else if (step.select) {
      state = { ...state, selection: { traceId: step.select.traceId, spanId: step.select.spanId } };
      state = applyAction(state, { kind: "move", delta: 0 });
    } else if (step.detail) {
      const { documentLisp, ...detail } = step.detail;
      state = applyDelta(state, {
        kind: "detail",
        detail: { ...detail, document: parseDocument(kc.protocol, documentLisp) }
      });
    } else if (step.replay) {
      const timeline = kc.replay.buildReplayTimeline({
        frames: step.replay.frames,
        requestedSeqs: step.replay.requestedSeqs
      });
      const schedule = kc.replay.planReplaySchedule(timeline, step.replay.plan);
      state = { ...state, replay: { timeline, schedule, index: step.replay.index } };
    } else throw new Error(`unknown step ${JSON.stringify(step)}`);
  }
  return state;
}

export function kcFrame(kc, cases, testCase, cols, rows) {
  return kc.render.renderFrame(kcState(kc, cases, testCase, rows), cols, rows);
}

export function frameText(frame) {
  return `${frame.join("\n")}\n`;
}

export function goldenName(name, cols, rows) {
  return `${name}.${cols}x${rows}.txt`;
}

async function main() {
  const flag = process.argv.indexOf("--kc");
  const kcRoot = flag === -1 ? DEFAULT_KC_ROOT : path.resolve(process.argv[flag + 1]);
  const kc = await loadKc(kcRoot);
  const targets = [
    ["cases.json", path.join(PARITY_DIR, "golden")],
    ["intentional-cases.json", path.join(PARITY_DIR, "intentional/kc")]
  ];
  for (const [file, outDir] of targets) {
    const { sizes, cases } = JSON.parse(readFileSync(path.join(PARITY_DIR, file), "utf8"));
    mkdirSync(outDir, { recursive: true });
    for (const testCase of cases) {
      for (const [cols, rows] of testCase.sizes ?? sizes) {
        writeFileSync(
          path.join(outDir, goldenName(testCase.name, cols, rows)),
          frameText(kcFrame(kc, cases, testCase, cols, rows))
        );
      }
    }
    process.stdout.write(`wrote frames for ${cases.length} cases to ${path.relative(KT_ROOT, outDir)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
