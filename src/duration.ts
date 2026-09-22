/**
 * The one duration grammar the viewer flags share (ported from kosmo-callflow
 * `packages/cli/src/connect/duration.ts`).
 *
 * `--refresh` and `--step-interval` mean different things — one is a redraw rate, the
 * other advances the replay position — but they must not disagree about what "300ms"
 * is, so the grammar lives here once and each caller supplies its own range.
 */
export function parseDurationMs(value: string, minMs: number, maxMs: number): number | undefined {
  const match = /^(\d+)(ms|s)?$/.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const ms = match[2] === "s" ? amount * 1_000 : amount;
  if (ms < minMs || ms > maxMs) return undefined;
  return ms;
}
