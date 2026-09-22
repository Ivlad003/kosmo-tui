# kosmo-tui

Terminal viewer and read-only debugger for recorded [kosmo-callflow](../kosmo-callflow) traces.
It works without a browser and without a mandatory daemon: it can read a live daemon, a
SQLite store, a portable export or an NDJSON stream on stdin.

```sh
kosmo-tui                      # live project resolved from cwd
kosmo-tui t_9f                 # live trace by id
kosmo-tui ./trace-export.json  # portable export
kosmo-tui ./callflow.sqlite    # SQLite store (node:sqlite or optional better-sqlite3)
kosmo-callflow connect --format ndjson --stream-version 2 | kosmo-tui -
kosmo-tui ./trace-export.json --print --format lisp --trace t_9f
kosmo-tui sql "select * from spans" --source ./trace-export.json
```

Requires Node >= 18.19.0. See `kosmo-tui --help` for the full flag list.

Interactive keys beyond navigation: `>` loads the next page of the pinned snapshot, `r`
reads a new snapshot (not for a stdin stream), `f`/`t` add a review finding/todo (the note
is typed on the `:` line), `R` marks the review ready, `y` copies the selection's
trace-text, and `:` runs commands (`:ancestors`, `:path`, `:callers`, `:find`, `:sql` on a
SQLite source, `:js` trusted local eval on export/SQLite). A key whose capability is
missing answers `unavailable(reason)` in the footer.

`--print` never opens the terminal UI or writes a review: without `--trace` it prints the
dataset's trace list (`kosmo.trace-list/v1`, JSON or Tab); with `--trace` the trace's
projection (Lisp by default). Output is capped at 51,200 bytes with explicit truncation.

## Development

```sh
npm install
npm run build
npm test
npm run lint   # tsc --noEmit + prettier --check (ESLint intentionally omitted to keep deps small)
```

The `@kosmo-callflow/*` dependencies are pinned to tarballs packed from a sibling
`kosmo-callflow` checkout (`file:../kosmo-callflow/artifacts/tarballs/<name>.tgz`, KC task 1.11),
never to workspace links or the public registry (which holds stale `0.0.0` copies of some names):

```sh
(cd ../kosmo-callflow && npm ci && npm run build)
npm run deps:tarballs            # packs the five packages there and installs exactly those tarballs
npm run build && npm test
```

`deps:tarballs` installs the tarballs by path on purpose: a plain `npm install` keeps a stale copy
when a tarball changed under the same name. `-- --no-pack` installs tarballs that are already in
place (CI downloads them). `.github/workflows/ci.yml` runs the suite against a pinned and the
latest kosmo-callflow on Node 18.19 / 22 / 24 with the SQLite driver cells none / built-in /
better-sqlite3 (see `test/package.test.ts`, `KOSMO_TUI_SQLITE_CELL`).
