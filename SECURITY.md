# Security policy

kosmo-tui is a viewer for `kosmo-trace/v1` traces and, after you confirm, a live debugger. The viewer opens no
network connection and runs no code from a trace. The debugger talks only to a loopback inspector and only after
attach is confirmed. `-r` and `--print` disable every debug effect.

- **Reads only.** JSON and NDJSON files are opened for reading; SQLite stores are opened with `readOnly: true` through
  the built-in `node:sqlite`. On Node >= 22.15 a WAL store in a read-only directory opens as `immutable`; on older
  Node it is a named `read-error`. kosmo-tui never writes to a trace, never installs probes and never starts a
  capture.
- **The only write is `recent.json`**: `$XDG_CONFIG_HOME/kosmo-tui/recent.json` (or `~/.config/kosmo-tui/recent.json`)
  keeps at most 20 absolute paths with the time each was opened, nothing else. It is written through a temp file and
  a rename, with mode `0600` in a directory created with mode `0700`. `-r` / `--read-only` turns it off; `--print`
  never writes it. Without a home directory and without `$XDG_CONFIG_HOME` it is off as well.
- **Code is read only inside the project root.** `location.file` must be a relative path without `..`, a scheme or
  control characters; a file whose real path leaves the root through a symlink is not read (`outside-root`), and
  files over 2 MiB are not read (`too-large`). Every root is stored as its real path when it is chosen (also
  `--root`/`:root`) and never resolved again: if the root directory later resolves elsewhere (for example it was
  swapped for a symlink to your home directory), nothing is read (`root-changed`).
- **A trace cannot choose the project root.** The root is `--root`/`:root` if you give one (taken as given, even
  `/` or your home directory). Otherwise it is chosen automatically: `dataset.root` from the trace only when it is
  an absolute path whose real path is, or contains, the current directory or the trace file's directory (for
  stdin: the current directory only); else the nearest directory with `.git` or `package.json` above the trace
  file; else the current directory. No automatic choice may be `/`, your home directory or a directory above it
  (compared by real path). A `dataset.root` that fails is ignored and the status line says so; when every
  automatic choice fails (for example a dotfiles repo at `~/.git` and the current directory `~`), there is no root:
  no code is read, no file links are drawn, and the status line says `code root not set`. So without `--root` or
  `:root`, code is shown only from a directory that is or contains the current directory or the trace file's
  directory (as the path you opened), and never from `/`, your home directory or a directory above it.
- **Terminal safety.** Every string from a trace, a code file or an error message that quotes the input is escaped
  (C0, DEL, C1 and bidi controls become `\uXXXX`) before it is laid out. The terminal writer then lets through only
  SGR colors and OSC 8 links it validated itself; any other escape sequence in a frame is shown escaped.
- **OSC 8 file links** are drawn only with `KOSMO_TUI_LINKS=1`, and only for `file://` URIs inside the project root;
  a root of `/`, or no root, allows no links at all.
- **Masking** of values, `attrs` and URL query parameters (by key: `password`, `token`, `authorization`, `cookie`,
  `api key`, `session id`, …; by content: `Bearer …`, JWTs) applies in the viewer, in `--print` and in `y`. It is a
  second layer and cannot be complete: a secret copied into an innocently named field is not caught. Producers must
  mask when they record.
- **Clipboard.** `y` starts `pbcopy`, `wl-copy`, `xclip` or `clip` without a shell, found on absolute `PATH` entries
  only, with an allowlisted environment (no tokens or credential variables). Without an adapter the text is printed
  to stdout after the terminal is restored.
- **Debug is a separate effect.** It runs only after you confirm an attach (`A`, `:attach`, `:launch-browser`,
  `:attach-browser`). `-r` and `--print` disable it. Inspector and browser endpoints must be loopback. Probes of
  `/json/version` can hit an application's HTTP server; wildcard binds are probed only on `R`.
- **What is injected.** A fixed helper (and, for Edge, a binding) is evaluated in the target. The first
  `process.getBuiltinModule("node:inspector")` loads Node's inspector modules. Breakpoint conditions are generated
  from fixed fragments, validated identifiers and a hex nonce — never from trace or debuggee text. The browser
  helper is installed with `Page.addScriptToEvaluateOnNewDocument` in a temporary profile. Page code can see the
  `Symbol.for` key and can delete or spoof the helper; the nonce does not prevent that. A DevTools window in the
  launched browser sees kosmo-tui `console.trace` messages.
- **Detach.** Breakpoints are removed, our pause is resumed, the helper is deleted, `Runtime.discardConsoleEntries`
  clears console history for every client, then `Debugger.disable`. The terminal is restored without waiting for
  those replies (deadline 1.5s). Node prints the full `ws://` URL in the application's own terminal. An inspector
  kosmo-tui opened with SIGUSR1 (Enter on `○`, confirmed) is reachable by every local process until that process
  exits; `:detach` offers to close it (`inspector.close()` in the target, which also detaches other debuggers), and
  if you decline the status says so. Live-value masking is the same incomplete key mask as the viewer.
- **Source maps.** Maps are read from `data:` URLs, from files inside the trace root only, and in the browser over
  HTTP from the script's own loopback origin (no redirects, 32 MiB, 5 s); `/__nextjs_source-map` is never fetched.
- **Browser.** The default launch uses `--remote-debugging-pipe` and a `0700` temporary profile, never your everyday
  profile and never `--remote-allow-origins`. `:attach-browser` is refused unless the listener is loopback Chrome/Edge
  with a non-default `--user-data-dir`. That TCP port is reachable by any local process. Only `Page`, `Runtime`,
  `Debugger`, `Target` and `Browser.close` are used.

Report vulnerabilities privately to the maintainers instead of opening a public issue.
