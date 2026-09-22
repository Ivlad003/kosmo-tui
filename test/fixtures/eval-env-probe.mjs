// Stand-in eval child for the env allowlist test: reports what the spawned process
// actually received, in the eval child's own result protocol.
import { readFileSync, writeSync } from "node:fs";
import v8 from "node:v8";

readFileSync(0, "utf8");
const value = {
  env: process.env,
  execArgv: process.execArgv,
  heapLimitBytes: v8.getHeapStatistics().heap_size_limit
};
writeSync(1, `${JSON.stringify({ ok: true, truncation: null, value })}\n`);
process.exit(0);
