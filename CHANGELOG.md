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
