/**
 * Adaptive fire-offset: how many slots before the round cutoff to send the
 * deploy. Firing earlier is a *tax paid every round* — a staler board read and a
 * bigger window for the field and reactive bots to pile onto your tiles. Firing
 * later risks landing after `end_slot` (a 6005 miss, which costs only the tx fee,
 * never USDC). Max extraction = fire as late as your measured send latency
 * safely allows, and re-calibrate as that latency changes.
 *
 * A deploy sent at offset O lands O_actual = (landed_slot − fired_slot) slots
 * later; it's in time iff that land latency ≤ O. So the smallest offset that
 * still lands with probability `targetLandProb` is the target-quantile of the
 * observed latency distribution, plus a one-slot cushion for the program-level
 * cutoff (empirically a deploy landing exactly on end_slot can still miss).
 *
 *   offset = clamp(⌈quantile(latencies, targetLandProb)⌉ + cushion, floor, ceil)
 *
 * With too few samples we fall back to the static configured offset. As the send
 * path improves (staked/Jito → lower latency), the quantile drops and the bot
 * fires later on its own; if the network degrades, it backs off. Bounded by
 * `floor` (never fire recklessly late) and `ceiling` (never fire absurdly early).
 */
export interface FireOffsetOptions {
  /** Fraction of fires that must land in time (e.g. 0.95). */
  targetLandProb: number;
  /** Extra slots added to the quantile (program-cutoff safety). */
  cushionSlots: number;
  /** Hard minimum offset — never fire later than this many slots before cutoff. */
  floor: number;
  /** Hard maximum offset — never fire earlier than this. */
  ceiling: number;
  /** Static offset used when there aren't enough samples to calibrate. */
  fallback: number;
  /** Minimum samples (landed + missed) required before adapting. */
  minSamples: number;
  /**
   * Deploys in the same window that did NOT land in time. Load-bearing: a miss
   * is a RIGHT-CENSORED latency observation — we know it exceeded the offset we
   * used, we just don't know by how much. Calibrating on landed deploys alone
   * is survivorship bias: the evidence that the offset is too aggressive is
   * exactly the evidence being discarded, so the estimate can never widen no
   * matter how many rounds are missed.
   */
  missCount?: number | undefined;
}

/** Nearest-rank quantile of an unsorted numeric sample. */
export function quantile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const clampP = Math.max(0, Math.min(1, p));
  const rank = Math.ceil(clampP * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx] as number;
}

/**
 * The offset to fire at, given land latencies (landed_slot − fired_slot) for
 * recent LANDED deploys plus the count of deploys in the same window that
 * missed. Always returned within [floor, ceiling].
 *
 * Misses are treated as right-censored: each one sorts above every landed
 * observation, because its true latency exceeded the offset in use. The target
 * quantile is then taken over the FULL sample (landed + missed):
 *
 *   rank = ceil(targetLandProb · total)
 *   rank <= landed  → the quantile is observable; use it as before.
 *   rank >  landed  → no observed latency achieves the target land probability,
 *                     so widen past the worst observation. The overshoot scales
 *                     with how far into the censored region the target sits, so
 *                     a light miss rate nudges the offset and a heavy one drives
 *                     it to the ceiling.
 */
export function adaptiveFireOffset(
  latencies: number[],
  opts: FireOffsetOptions,
): number {
  const clampToBounds = (v: number) =>
    Math.min(opts.ceiling, Math.max(opts.floor, v));
  const misses = Math.max(0, Math.trunc(opts.missCount ?? 0));
  const total = latencies.length + misses;
  if (total < opts.minSamples) return clampToBounds(opts.fallback);

  const sorted = [...latencies].sort((a, b) => a - b);
  const p = Math.max(0, Math.min(1, opts.targetLandProb));
  const rank = Math.ceil(p * total);

  if (rank <= sorted.length && sorted.length > 0) {
    return clampToBounds(Math.ceil(sorted[rank - 1] as number) + opts.cushionSlots);
  }
  // Censored region: even firing at our worst observed latency would not hit
  // the target land rate. Widen beyond it by the shortfall in landed samples.
  const worst = sorted.length > 0 ? (sorted[sorted.length - 1] as number) : opts.fallback;
  const shortfall = rank - sorted.length;
  return clampToBounds(Math.ceil(worst) + opts.cushionSlots + shortfall);
}
