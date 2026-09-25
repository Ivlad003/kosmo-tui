# Security policy

kosmo-tui is a read-only viewer for `kosmo-trace/v1` traces. Stage 1 opens no network connection and runs no code
from a trace.

- **Reads only.** JSON and NDJSON files are opened for reading; SQLite stores are opened with `readOnly: true` through
  the built-in `node:sqlite`. On Node >= 22.15 a WAL store in a read-only directory opens as `immutable`; on older
  Node it is a named `read-error`. kosmo-tui never writes to a trace, never installs probes and never starts a
  capture.
- **The only write is `recent.json`**: `$XDG_CONFIG_HOME/kosmo-tui/recent.json` (or `~/.config/kosmo-tui/recent.json`)
  keeps at most 20 absolute paths with the time each was opened, nothing else. It is written through a temp file and
  a rename, with mode `0600` in a directory created with mode `0700`. `-r` / `--read-only` turns it off; `--print`
  never writes it.
- **Code is read only inside the project root.** `location.file` must be a relative path without `..`, a scheme or
  control characters; a file whose real path leaves the root through a symlink is not read (`outside-root`), and
  files over 2 MiB are not read (`too-large`).
- **Terminal safety.** Every string from a trace, a code file or an error message that quotes the input is escaped
  (C0, DEL, C1 and bidi controls become `\uXXXX`) before it is laid out. The terminal writer then lets through only
  SGR colors and OSC 8 links it validated itself; any other escape sequence in a frame is shown escaped.
- **OSC 8 file links** are drawn only with `KOSMO_TUI_LINKS=1`, and only for `file://` URIs inside the project root.
- **Masking** of values, `attrs` and URL query parameters (by key: `password`, `token`, `authorization`, `cookie`,
  `api key`, `session id`, …; by content: `Bearer …`, JWTs) applies in the viewer, in `--print` and in `y`. It is a
  second layer and cannot be complete: a secret copied into an innocently named field is not caught. Producers must
  mask when they record.
- **Clipboard.** `y` starts `pbcopy`, `wl-copy`, `xclip` or `clip` without a shell, found on absolute `PATH` entries
  only, with an allowlisted environment (no tokens or credential variables). Without an adapter the text is printed
  to stdout after the terminal is restored.

Report vulnerabilities privately to the maintainers instead of opening a public issue.
