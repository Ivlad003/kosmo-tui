#!/usr/bin/env node
// Thin launcher: all logic lives in dist/cli.js so it stays testable through run(proc, deps).
import { run } from "../dist/cli.js";

const code = await run(process, {});
process.exitCode = code;
