# Probe scripts (evidence, not code)

Throwaway scripts written during the 2026-09-24 design research for
`../../2026-09-24-kosmo-tui-standalone-design.md` (sections 14.1–14.2). They are kept only as
evidence and as a starting point for the stage-2/3 integration tests. They are not built,
linted, formatted or run by `npm test`, and they may reference absolute paths and package
versions from the machine they ran on.

- `tracepoint-probe/` — the first non-pausing tracepoint probe (Node 22.22 / 25.2).
- `skeptic/`, `review-s2/`, `rev2/`, `v3-review/` — reviewer experiments (TDZ thunks, console replay,
  skipAllPauses, vm contexts, scriptHash, `--inspect-brk`, env proxy, `node:sqlite` warnings, V8
  breakpoint ids, arrow-function breakpoint starts).
- `nextjs/`, `verify-nextjs/` — Next.js 15.5 / 16.3 topology, script/map shapes, React Flight
  fakes, Edge Runtime helper, restarts.
- `node-express-nest/`, `verify-node-express-nest/` — Node loaders (strip, transform, tsx,
  ts-node, watch), Express 4/5 chains, Nest 11 enhancer order and maps.
- `browser-react/`, `verify-browser-react/` — Chrome pipe/port launch, auto-attach, Vite /
  React Router / Next client maps, StrictMode hit counts.
- `framework-semantics/`, `verify-vocabulary/` — Express/Nest semantics behind the kind vocabulary.
