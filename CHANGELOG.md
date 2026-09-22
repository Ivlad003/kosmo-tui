# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses SemVer.

## [Unreleased]

### Added

- Repository skeleton: TypeScript strict/ESM/NodeNext, tsc build, vitest, prettier.
- `parseArgv` / `run(proc, deps)` with argument validation and exit codes (0, 1, 2, 3, 130, 143).
- Target detection (`-`, http(s) URL, explicit paths, export/SQLite sniffing, opaque trace ids).
- Grapheme-aware width/truncation, color levels, `NO_COLOR` and opt-in OSC 8 links.
