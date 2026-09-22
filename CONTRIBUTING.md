# Contributing

1. `npm install`, then `npm run build && npm test && npm run lint` must pass.
2. One module, one responsibility; named exports; pure reducers/selectors/render.
   File, network, clock and terminal I/O go through the ports passed to `run(proc, deps)`.
3. Every behaviour change gets a vitest test under `test/` that can actually fail.
4. Versioned contracts (canonical projection, trace-text, replay) come from the published
   `@kosmo-callflow/*` packages; do not re-implement codecs here.
5. Update `CHANGELOG.md` under `Unreleased`.
