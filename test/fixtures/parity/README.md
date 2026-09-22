# Frame-parity fixtures (task 3.3)

kosmo-tui's viewer is a port of kosmo-callflow's `connect` TTY viewer. These fixtures pin
that the unchanged generic view renders **byte-identically**, and keep every intentional
difference visible instead of hidden in a rewritten baseline.

## Files

| Path                     | What it is                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `cases.json`             | Baseline cases. ASCII-only recorded data, written in kosmo-callflow's bare-id vocabulary.       |
| `golden/*.txt`           | The baseline: kosmo-callflow's own frames for every case at 80x24, 120x40 and 60x16.            |
| `intentional-cases.json` | Cases where kosmo-tui deliberately renders differently. Each has a `change` tag.                |
| `intentional/kc/*.txt`   | kosmo-callflow's frames for those cases, kept for reference so the difference stays reviewable. |
| `intentional/kt/*.txt`   | kosmo-tui's frames for those cases.                                                             |

Each frame file is the frame's rows joined by `\n`, plus a trailing `\n`.

## How the files are produced

- `golden/` and `intentional/kc/` are written **only** by `node scripts/parity-kc.mjs`,
  which imports the renderer from a built kosmo-callflow checkout
  (`../kosmo-callflow/packages/cli/dist/connect`, or `--kc <path>`). They are never
  edited by hand and never produced from kosmo-tui output. When that checkout is built,
  `test/frame-parity.test.ts` also re-renders every baseline case through kosmo-callflow
  and checks the stored goldens still match it.
- `intentional/kt/` is written by `UPDATE_PARITY=1 npx vitest run test/frame-parity.test.ts`.
  That switch never touches `golden/`.

The test builds kosmo-tui's state from the same case: every row gets dataset `local`,
project `p` and session `s-1` unless the row names its own `sessionId`. The viewport is
`rows - 4`, as in both viewers.

## Intentional differences

Each is asserted by the property that changed, not only by its golden.

### `unicode-width` — `unicode-wide-node`

kosmo-callflow truncated rows by `string.length` (UTF-16 code units). CJK ideographs and
emoji occupy two columns, and an emoji ZWJ sequence is many code units, so its rows either
overflowed the terminal width or were cut through a surrogate pair (a stray `�`).
kosmo-tui measures with `visibleWidth`/`truncateVisible` from `src/ansi.ts`: per grapheme
cluster, wide clusters count 2, a cluster is never split, and every row fits `cols`.

### `full-identity` — `duplicate-ids-two-sessions`

kosmo-callflow keyed spans by `traceId + spanId`, so two sessions that recorded the same
ids collapsed into one row (the later write won) and the selection could not tell them
apart. kosmo-tui keys by `(datasetId, projectId, sessionId, traceId, spanId)`; both rows
are shown, and **only where bare ids collide** the row is qualified with `@<sessionId>`
(or `@<dataset>/<project>/<session>` when the collision crosses datasets or projects).
Unique ids get no qualifier, which is why the baseline stays byte-identical.

### `terminal-escaping` — `control-chars-in-recorded-data`

kosmo-callflow wrote recorded trace ids and node ids to the terminal verbatim, so an
`ESC`/`CSI`/`OSC`/`BEL` inside recorded data was executed by the terminal. kosmo-tui
passes every recorded string through the shared `escapeTerminalControls` from
`@kosmo-callflow/trace-artifacts`, so it is shown as visible `\u001b…` text.

### `tab-expansion` — `tab-dialect-projection`

The tab dialect separates fields with real tab characters. kosmo-callflow emitted them
raw and counted each as one column, so the terminal moved to the next tab stop and the
row was wider than its truncation assumed. kosmo-tui expands tabs to the next stop of 8
before measuring (what the terminal would have shown), then truncates. The case only has
sizes 80x24 and 120x40: at 60x16 the details pane has no room for projection rows, so
there is nothing to differ. The baseline keeps `detail-tab-table` (tab dialect, no
projection document) at all three sizes.
