# SQL recipes

`kosmo-tui sql "<query>"` and the viewer's `:sql <query>` run one read-only `SELECT` (or
`WITH [RECURSIVE] … SELECT`) through the shared runner of `@kosmo-callflow/query/sql`. The
runner reads a pinned, project-scoped, **sanitized** snapshot of a daemon `events.sqlite` into a
private in-memory database with the schema `kosmo.trace-sql/v1`; SQL never sees the raw store,
another project, config or auth tables. The schema, limits and result envelope are specified in
the kosmo-callflow boundary contract (`docs/contracts/tui-boundary.md` §2.2).

```sh
kosmo-tui sql "SELECT count(*) AS n FROM events" --source .kosmo-callflow/events.sqlite
kosmo-tui sql "<query>" --trace t-checkout --print tab     # one trace, kosmo.query-table/v1
```

Without `--source`, `sql` reads the `events.sqlite` of the project resolved from the current
directory (`KOSMO_CALLFLOW_DATA`, else `<project>/.kosmo-callflow`) and nothing else. The default
output is the JSON table envelope; `--print tab` renders the same table as `kosmo.query-table/v1`.
A table is rows, never spans, so `lisp` is refused as a usage error.

## Read before you query

- **A span is `(session_id, trace_id, span_id)`.** Span ids repeat across sessions and traces.
  Every join below uses all three; joining on `span_id` alone links unrelated spans.
- **`seq` is per table.** `events.seq`, `aggregates.seq` and `probes.seq` are separate sequence
  domains (see `SELECT key, value FROM metadata`); they are never one timeline. `events.seq` is
  the store's commit order: it orders one session's records, not causality across sessions.
- **Recorded edges only.** `parent_span_id` is the parent the producer recorded in the same
  trace. A parent in another session (a browser request calling an API) is not joined by a
  session-aware walk; the cross-session recipe shows those links separately and labelled.
- **Scope and coverage.** A result describes the loaded snapshot, not the world: the envelope's
  `scope` names the project, snapshot id, watermark and trace filter, and `coverage` says whether
  retention or loss removed data (`retention`, `loss`) and how many values were sanitized. A
  missing row can mean "not recorded", "aged out" or "not in this snapshot"; read `coverage`
  before drawing a conclusion from an absence.
- **Deterministic order.** Every recipe ends with `ORDER BY` over full keys, so the same snapshot
  gives the same rows in the same order. Output is capped at 1,000 rows / 51,200 bytes; a cut
  result says `truncated: true` with the reason.
- **Durations** are `ts` differences in the producing session's own clock units. A span without
  a terminal record is running or lost — it is absent from duration results, never zero.

The examples use the ids of the test fixture (`test/fixtures/sqlite/store.sqlite`, sessions
`s-web` and `s-api`); replace the literals with your own. `test/sql-recipes.test.ts` runs every
recipe on this page verbatim against that fixture.

## Slowest spans

Enter and terminal record of the same span, joined on the full span key.

```sql
SELECT s.session_id, s.trace_id, s.span_id, s.node_id,
       t.ts - s.ts AS duration, t.type AS outcome
FROM events s
JOIN events t
  ON t.session_id = s.session_id AND t.trace_id = s.trace_id AND t.span_id = s.span_id
 AND t.type IN ('exit', 'error')
WHERE s.type = 'enter'
ORDER BY duration DESC, s.session_id, s.trace_id, s.span_id, outcome
LIMIT 10;
```

## Errors by kind

Recorded `error` events only, grouped by span kind and the recorded error name. A trace is
counted by its `(session_id, trace_id)` pair.

```sql
SELECT kind, json_extract(payload_json, '$.error.name') AS error_name,
       count(*) AS errors,
       count(DISTINCT session_id || char(31) || trace_id) AS session_traces
FROM events
WHERE type = 'error'
GROUP BY kind, error_name
ORDER BY errors DESC, kind, error_name;
```

## Ancestors of a span

Recursive walk up recorded parent edges inside one session and trace. `visited` is the cycle
guard (a corrupt producer can record `a → b → a`), `depth < 64` the depth cap. The walk stops
at a recorded root, at a parent that is not in this session (see the next recipe), or at the
guards.

```sql
WITH RECURSIVE
  spans AS (SELECT DISTINCT session_id, trace_id, span_id, parent_span_id FROM events),
  chain(session_id, trace_id, span_id, parent_span_id, depth, visited) AS (
    SELECT session_id, trace_id, span_id, parent_span_id, 0, '/' || span_id || '/'
    FROM spans
    WHERE session_id = 's-api' AND trace_id = 't-checkout' AND span_id = 'query'
    UNION ALL
    SELECT p.session_id, p.trace_id, p.span_id, p.parent_span_id, c.depth + 1,
           c.visited || p.span_id || '/'
    FROM chain c
    JOIN spans p
      ON p.session_id = c.session_id AND p.trace_id = c.trace_id AND p.span_id = c.parent_span_id
    WHERE instr(c.visited, '/' || p.span_id || '/') = 0 AND c.depth < 64
  )
SELECT depth, session_id, trace_id, span_id, parent_span_id
FROM chain
ORDER BY depth, session_id, trace_id, span_id;
```

The same walk over a recorded cycle terminates with each span listed once:

```sql
WITH RECURSIVE
  spans AS (SELECT DISTINCT session_id, trace_id, span_id, parent_span_id FROM events),
  chain(session_id, trace_id, span_id, parent_span_id, depth, visited) AS (
    SELECT session_id, trace_id, span_id, parent_span_id, 0, '/' || span_id || '/'
    FROM spans
    WHERE session_id = 's-api' AND trace_id = 't-cycle' AND span_id = 'a'
    UNION ALL
    SELECT p.session_id, p.trace_id, p.span_id, p.parent_span_id, c.depth + 1,
           c.visited || p.span_id || '/'
    FROM chain c
    JOIN spans p
      ON p.session_id = c.session_id AND p.trace_id = c.trace_id AND p.span_id = c.parent_span_id
    WHERE instr(c.visited, '/' || p.span_id || '/') = 0 AND c.depth < 64
  )
SELECT depth, session_id, trace_id, span_id, parent_span_id
FROM chain
ORDER BY depth, session_id, trace_id, span_id;
```

## Cross-session parent candidates

Spans whose recorded parent id is not in their own session, next to spans with that id in
another session of the same trace. These are **candidates** from an explicit `trace_id` join:
more than one candidate means the parent is ambiguous, and none means it was not recorded or
not loaded.

```sql
WITH spans AS (SELECT DISTINCT session_id, trace_id, span_id, parent_span_id FROM events)
SELECT c.trace_id, c.session_id AS child_session, c.span_id AS child_span,
       c.parent_span_id, p.session_id AS candidate_session
FROM spans c
LEFT JOIN spans p
  ON p.trace_id = c.trace_id AND p.span_id = c.parent_span_id AND p.session_id <> c.session_id
WHERE c.parent_span_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM spans s
    WHERE s.session_id = c.session_id AND s.trace_id = c.trace_id AND s.span_id = c.parent_span_id
  )
ORDER BY c.trace_id, c.session_id, c.span_id, candidate_session;
```

## Value-equality candidates (not lineage)

Spans whose recorded return value equals a recorded argument of another span. **Equal values are
not lineage:** two spans can see `"order-7"` independently, and a masked, truncated or unrecorded
value can hide a real flow. Treat each row as a lead to check, never as proof that data moved.
Masked values (`[masked]`) are excluded because they all compare equal.

```sql
WITH v AS (
  SELECT session_id, trace_id, span_id, node_id, 'ret' AS side,
         json_extract(payload_json, '$.ret') AS value
  FROM events
  WHERE type = 'exit' AND json_type(payload_json, '$.ret') = 'text'
  UNION ALL
  SELECT e.session_id, e.trace_id, e.span_id, e.node_id, 'arg' AS side, a.value
  FROM events e, json_each(e.payload_json, '$.args') a
  WHERE e.type = 'enter' AND a.type = 'text'
)
SELECT r.value,
       r.session_id AS ret_session, r.trace_id AS ret_trace, r.span_id AS ret_span,
       g.session_id AS arg_session, g.trace_id AS arg_trace, g.span_id AS arg_span
FROM v r
JOIN v g ON g.value = r.value AND g.side = 'arg'
WHERE r.side = 'ret' AND r.value <> '[masked]'
  AND NOT (g.session_id = r.session_id AND g.trace_id = r.trace_id AND g.span_id = r.span_id)
ORDER BY r.value, ret_session, ret_trace, ret_span, arg_session, arg_trace, arg_span;
```

## Per-request timeline

Every record of one request span and its recorded descendants in the same session, in commit
order. Pick the request span from the viewer (a span with `framework.role: request` when the
producer records it, otherwise the trace root). Descendants recorded by another session (the API
side of a browser request) are not reached by this session-aware walk; list them with the
cross-session recipe and run the timeline again from their span.

```sql
WITH RECURSIVE
  spans AS (SELECT DISTINCT session_id, trace_id, span_id, parent_span_id FROM events),
  tree(session_id, trace_id, span_id, depth, visited) AS (
    SELECT session_id, trace_id, span_id, 0, '/' || span_id || '/'
    FROM spans
    WHERE session_id = 's-web' AND trace_id = 't-checkout' AND span_id = 'req'
    UNION ALL
    SELECT c.session_id, c.trace_id, c.span_id, t.depth + 1, t.visited || c.span_id || '/'
    FROM tree t
    JOIN spans c
      ON c.session_id = t.session_id AND c.trace_id = t.trace_id AND c.parent_span_id = t.span_id
    WHERE instr(t.visited, '/' || c.span_id || '/') = 0 AND t.depth < 64
  )
SELECT e.seq, e.session_id, e.trace_id, e.span_id, tree.depth, e.type, e.node_id, e.ts
FROM tree
JOIN events e
  ON e.session_id = tree.session_id AND e.trace_id = tree.trace_id AND e.span_id = tree.span_id
ORDER BY e.seq, e.session_id, e.trace_id, e.span_id;
```
