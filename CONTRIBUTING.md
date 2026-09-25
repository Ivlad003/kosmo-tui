# Contributing

1. `npm ci`, then `npm run build && npm test && npm run lint` must pass.
2. One module, one responsibility; named exports; pure reducers/selectors/render.
   File, process, clock and terminal I/O go through the ports passed to `run(proc, deps)`.
3. Every behaviour change gets a vitest test under `test/` that can actually fail.
4. The formats `kosmo-trace/v1` and `kosmo-text/v1` are contracts of this repository. Change them only through the
   format version, the JSON Schema (`schema/kosmo-trace-v1.schema.json`) and the golden files (`test/golden/`).
5. Update `CHANGELOG.md` under `Unreleased`.
