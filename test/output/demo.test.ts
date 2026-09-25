/**
 * Task 26: the README is true (spec 13.1 `examples/`, spec 15).
 *
 *  - examples/demo.kosmo-trace.json validates without a single mark, opens through the readers
 *    and prints through the real bin (text, tab, json), with the demo's secrets masked;
 *  - every location points at the recorded line of examples/demo/src from the root the viewer
 *    resolves (snippet state `ok`), so the code window in the README is what a user sees;
 *  - the NDJSON producer printed in the README runs and pipes into `kosmo-tui - --print tab`;
 *  - the README's kind table lists every kind the viewer knows.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveRoot } from "../../src/code/root.js";
import { loadSnippet } from "../../src/code/snippet.js";
import { KNOWN_KINDS } from "../../src/format/kinds.js";
import { validateDocument } from "../../src/format/validate.js";
import { nodeReaderFs } from "../../src/readers/node-fs.js";
import { openTarget } from "../../src/readers/open.js";
import { nodeRootFs, nodeSnippetFs } from "../../src/ui/node-ports.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEMO = path.join(root, "examples", "demo.kosmo-trace.json");
const BIN = path.join(root, "bin", "kosmo-tui.js");
const README = readFileSync(path.join(root, "README.md"), "utf8");

const bin = (args: string[], input?: string) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: "utf8",
    ...(input === undefined ? {} : { input })
  });

describe("examples/demo.kosmo-trace.json", () => {
  it("validates with no degraded field and opens through the readers", async () => {
    const parsed = validateDocument(JSON.parse(readFileSync(DEMO, "utf8")));
    if (!parsed.ok) throw new Error(`${parsed.code} at ${parsed.position}: ${parsed.what}`);
    expect(parsed.unknownFields).toBe(0);
    expect(parsed.acc.traceSummaries().map((trace) => [trace.id, trace.spans, trace.status])).toEqual([
      ["t_cart", 4, "errored"],
      ["t_health", 1, "complete"]
    ]);
    for (const trace of parsed.acc.traceSummaries()) {
      for (const span of parsed.acc.spansOf(trace.id)) expect(span.marks, span.ref.id).toEqual([]);
    }
    const opened = await openTarget({ path: DEMO }, { fs: nodeReaderFs }, new AbortController().signal);
    expect(opened.ok && opened.dataset.kind).toBe("json");
  });

  it("every location matches its code in examples/demo/src (the README code window)", async () => {
    const parsed = validateDocument(JSON.parse(readFileSync(DEMO, "utf8")));
    if (!parsed.ok) throw new Error("demo");
    const codeRoot = await resolveRoot({ traceFile: DEMO, cwd: os.tmpdir() }, nodeRootFs);
    expect(codeRoot).toBe(root);
    for (const trace of parsed.acc.traceSummaries()) {
      for (const span of parsed.acc.spansOf(trace.id)) {
        const snippet = await loadSnippet(codeRoot, span.location!, nodeSnippetFs);
        expect(snippet.state, `${span.ref.id} ${span.location!.file}:${span.location!.line}`).toBe("ok");
      }
    }
  });

  it("prints through the bin: text, tab and json, with the demo's secrets masked", () => {
    const text = bin([DEMO, "--print", "--trace", "t_cart"]);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout.split("\n")[0]).toBe('kosmo-text/v1 trace="t_cart" name="GET /cart" spans=4 status=errored');
    expect(text.stdout).toContain('✗ "calculateLineTotal"  examples/demo/src/cart.ts:12  [cart · cart]  1.8ms');
    expect(text.stdout).not.toContain("demo-token");
    expect(text.stdout).not.toContain("s3cr3t");
    expect(bin([DEMO, "--print", "tab"]).stdout).toBe(
      "t_cart\tGET /cart\t4\terrored\nt_health\tGET /health\t1\tcomplete\n"
    );
    const json = bin([DEMO, "--print", "json"]);
    expect(validateDocument(JSON.parse(json.stdout)).ok).toBe(true);
  });
});

describe("README", () => {
  it("the NDJSON producer runs and pipes into kosmo-tui - --print tab", () => {
    const block = /<!-- ndjson-producer:start -->\s*```js\n([\s\S]*?)```\s*<!-- ndjson-producer:end -->/.exec(README);
    expect(block, "producer block in README.md").not.toBeNull();
    const code = block![1]!;
    expect(code.split("\n").filter((line) => line.trim() !== "").length).toBeLessThanOrEqual(22);
    const dir = mkdtempSync(path.join(os.tmpdir(), "kosmo-readme-"));
    try {
      const producer = path.join(dir, "producer.mjs");
      writeFileSync(producer, code);
      const produced = spawnSync(process.execPath, [producer], { encoding: "utf8" });
      expect(produced.status, produced.stderr).toBe(0);
      const printed = bin(["-", "--print", "tab"], produced.stdout);
      expect(printed.stderr).toBe("");
      expect(printed.stdout).toBe("t1\tGET /cart\t3\tcomplete\n");
      const spans = bin(["-", "--print", "tab", "--trace", "t1"], produced.stdout);
      expect(spans.stdout.split("\n").filter((line) => line !== "")).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists every known kind", () => {
    for (const kind of KNOWN_KINDS) expect(README, kind).toContain(`\`${kind}\``);
  });
});
