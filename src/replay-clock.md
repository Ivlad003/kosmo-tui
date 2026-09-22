# Q20 clock semantics for replay in kosmo-tui

Ported from kosmo-callflow `packages/cli/src/connect/replay-clock.md` (task 27.5 there,
task 3.1 of `extract-tui-trace-debugger`). The contract is unchanged; the only addition is
§7 (full identity).

This is the contract the replay code in `replay.ts` implements. It is written down first
because every honest-failure branch below is a decision, not an accident, and a later
change that "improves" replay by smoothing one of them would be a regression.

Source (kosmo-callflow repo): `docs/plans/2026-09-20-unified-transition-plan.md:235` (Q20) — _define event-time
clock domains, tie-breaking, idle gaps, clock skew and lag/resume; `seq` is the order of
observation, not duration and not causality; cross-session `speed` does not promise
accurate timing without clock alignment._

## 1. Clock domains

A clock domain is the pair `(sessionId, clock.domain)`, where `clock.domain` is
`monotonic` or `wall` as recorded by the SDK (`@kosmo-callflow/protocol` event schema).

- A `monotonic` reading is an offset from an unspecified origin inside one process. It
  is meaningful only against other monotonic readings **from the same session**.
- A `wall` reading is comparable across sessions only up to unquantified skew. We do not
  have an NTP offset, a round-trip estimate or a handshake, so we do not claim one.
- An event with no `clock` reading has **no source-clock evidence**. Its `ts` field is a
  recording-side number; it is not promoted to a source clock, because doing so would
  present daemon arrival time as application time.

Consequence: a replay range whose frames span more than one clock domain, or that
contains any frame without a source-clock reading, is `unaligned`.

## 2. Ordering and tie-breaking

Replay order is ascending `seq` — the daemon's order of **observation**. Ties (which the
store's monotonic seq should prevent, but which a merged or imported dataset can still
produce) break by `sessionId`, then `localSeq`.

`seq` is never used as a time:

- a difference between two `seq` values is not rendered as a duration, in any unit;
- `seq` order is not causality — B observed after A does not mean A caused B, and the
  viewer never says it did.

## 3. Idle gaps

A hole in the `seq` numbers is **not** a missing frame. Other traces, other sessions and
non-event records occupy seq values, so gaps are the normal case. Therefore:

- missing frames are reported only for seqs the recording itself **declares** should be
  there (a trace projection's `firstSeq`/`lastSeq`), not inferred from numeric gaps;
- a declared seq absent from the recorded range is reported to the user, never silently
  skipped over;
- elapsed time between two frames is reported only from two same-domain clock readings.
  Unknown elapsed time stays unavailable; it is never shown as `0ms` and never
  interpolated from neighbours.

## 4. Clock skew and unsynced domains

`--speed <multiplier>` is a **source-clock multiplier**: the recorded interval between
two frames divided by the multiplier. It requires an aligned timeline (§1). When the
timeline is unaligned, replay falls back honestly:

- it switches to fixed-interval stepping,
- it states the reason in the view (`speed unavailable: <reason>`),
- it does **not** invent an offset, pick a "reference" session, or silently pretend the
  domains are the same clock.

The multiplier's inclusive range is `0.1..10`; anything outside it, NaN or Infinity is an
`INVALID_ARGUMENT` usage error before any I/O.

`--step-interval <duration>` is a separate mode: it advances one recorded projection
state per fixed interval of _viewer_ time and makes no claim about source timing at all.
The two flags are mutually exclusive, because a run cannot simultaneously honour the
source clock and ignore it.

## 5. Lag and resume

- Live lag (`behind live`) and retention gaps are surfaced in the view, not smoothed away.
- Entering replay does not change capture, recording policy or the subscription.
- Returning to live is **explicit** (the `L` key). Reaching the end of the recording parks
  at the last frame and says so; it never rejoins live by itself, because an automatic
  jump would silently replace what the user was looking at.

## 6. Aggregate data

An aggregate capture record describes a **window** — counts and duration statistics — and
deliberately does not retain per-call order. So a timeline containing aggregate frames is
`windowOnly`:

- stepping moves window to window;
- the view states that per-call ordering is unavailable for that range;
- no per-call sequence is synthesised from window metrics.

## 7. Full identity

Every row a frame carries is keyed by the full ref `(datasetId, projectId, sessionId,
traceId[, spanId])`, using the shared `replayTraceKey`/`replaySpanKey` from
`@kosmo-callflow/replay` (reducer version 2). Two sessions that reuse a traceId or spanId
are two different traces/spans in every frame; stepping carries the selection across by
that full ref, never by bare id or list index.
