# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses SemVer.

## [Unreleased]

### Changed: standalone kosmo-tui on `kosmo-trace/v1` (breaking)

kosmo-tui no longer depends on kosmo-callflow and reads its own trace format.

- **Removed:** the live daemon source, replay, compare, review (findings, todos, `R`), eval (`kosmo-tui eval`, `:js`),
  SQL (`kosmo-tui sql`, `:sql`, `docs/sql-recipes.md`), depth mappings, and every kosmo-callflow format (canonical
  projections, the portable export, the NDJSON connect stream v1/v2, the callflow SQLite store). The
  `@kosmo-callflow/*` dependencies, the `deps:tarballs` script and the optional `better-sqlite3` peer are gone: there
  are no runtime dependencies.
- **Added:** `kosmo-trace/v1` as JSON, NDJSON (file or stdin) and SQLite, with a JSON Schema exported as
  `@ivlad003/kosmo-tui/schema/kosmo-trace-v1.schema.json`; the start screen with found and recent traces; the traces
  screen; Areas (module/feature, derived `~` areas); code snippets from disk in the detail pane with named states;
  framework kinds and `attrs` for Node, Express, NestJS, Next.js and React; `kosmo-text/v1` for `--print`, `d` and
  `y`; `examples/demo.kosmo-trace.json`.
- **Changed:** `--print` takes `text|json|tab` (was `lisp|tab|json`) and `--detail 0|1`; span refs are
  `<id>`, `<session>:<id>` and `<trace>:<session>:<id>`; `engines.node` is `>=22.13.0` (was `>=18.19.0`); SIGHUP
  restores the terminal and exits 129; the only file written is `recent.json` (`-r` turns it off).

### Release candidate 2026-09-23 (local, unpublished)

Local release candidate for task 8.5 of kosmo-callflow `extract-tui-trace-debugger`. Nothing was
published. The tarball is `artifacts/kosmo-tui-0.0.0.tgz` (sha256 in kosmo-callflow
`docs/releases/2026-09-23-kosmo-tui-rc.md`), packed from `f4a32cc` plus the framework fixture
parity test. That document also records the kosmo-callflow compatibility tuple and the publish
blockers. The version stays `0.0.0` until the owner picks one at publish time.

- Framework fixture parity (8.5): `test/framework-fixture-parity.test.ts` reads the Express, Nest,
  Next/Edge and Next Node (`next-node-action-request`) fixtures from the installed
  `@kosmo-callflow/protocol` package, re-projects them with the installed projector, and checks
  request rows, labels, depth and the viewer frame.
- Next-specific evidence (`requestType`, `actionId`, `cache`, `rewrite`, `redirect`) now appears in
  `frameworkSummary` and in the request selector row, so an action and a prefetch of the same
  route no longer look identical (validation gap G1).

### Added

- Repository skeleton: TypeScript strict/ESM/NodeNext, tsc build, vitest, prettier.
- `parseArgv` / `run(proc, deps)` with argument validation and exit codes (0, 1, 2, 3, 130, 143).
- Target detection (`-`, http(s) URL, explicit paths, export/SQLite sniffing, opaque trace ids).
- Grapheme-aware width/truncation, color levels, `NO_COLOR` and opt-in OSC 8 links.
- `terminal.ts`: raw mode, alternate screen, cursor hide/show, row diffing and full redraw on resize
  over injectable input/output (ported from kosmo-callflow `connect/terminal.ts`).
- `terminal-input.ts`: keyboard port separate from data stdin; `kosmo-tui -` reads keys from the
  controlling terminal (`/dev/tty`, `CONIN$` on Windows) and never puts the data pipe into raw mode.
- `terminal-session.ts`: 40x10 minimum ("terminal too small" frame) and a single cleanup on q,
  Ctrl+C, SIGINT (130), SIGTERM (143), render and source failures.
- Release gates 8.1 (export in a real PTY: error → `b` → args → `f` → `R`, cleanup on normal
  and error exits) and 8.2 (real `kosmo-callflow connect --format ndjson` pipe, interactive and
  `--print`), and the KT half of cross-source parity 4.5 over a fixture kosmo-callflow records.

### Fixed

- The header named every source "connected; live"; an export, a SQLite snapshot and a stdin
  stream now say `export snapshot`, `sqlite snapshot (static)` and `stream vN (ended|incomplete)`.
- `producer | kosmo-tui -`: the exiting producer (any Node process sharing the terminal) restored
  cooked mode behind the viewer, so keys echoed and stopped working after data EOF; raw mode is
  now reclaimed at EOF. `q` also quits while a stream is still loading.
- `:js` eval child: the whole V8 heap (old + young generation) is bounded to 64 MiB; on Node 25
  `--max-old-space-size` alone left a 256 MiB heap limit.
