# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses SemVer.

## [Unreleased]

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
