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

## Development

```sh
npm install
npm run build
npm test
npm run lint   # tsc --noEmit + prettier --check (ESLint intentionally omitted to keep deps small)
```

During the extraction the `@kosmo-callflow/*` dependencies are `file:` links to a sibling
`kosmo-callflow` checkout. They are replaced by the published tarballs (KC task 1.11)
before the first release.
