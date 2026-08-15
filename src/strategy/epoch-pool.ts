/**
 * Projecting the epoch pool from LIVE volume rather than a stale constant.
 *
 * Every EV figure in this project has been priced against a hardcoded pool —
 * $46,553, measured off iteration 4. Volume then fell about 4.7x (roughly
 * $581/round net down to ~$108 in Round-account units), which supports a pool
 * nearer $12,000. Farming's margin was thinner than that swing, so the sign of
 * the answer moved without anything in the code changing.
 *
 * The fix is not a better constant. It is to derive the pool from volume
 * measured now, and to be explicit that a projection made early in an
 * iteration is mostly guess.
 *
 * The subtle part is what does NOT scale. Our own take is roughly
 * share x pool, and when volume falls both the pool and the field's tickets
 * fall with it, so the two largely cancel and our take is more stable than the
 * pool alone suggests. What breaks the cancellation is banked hashrate: there
 * is a large idle overhang that can be spent into a thin pool regardless of
 * current volume, so the field decays more slowly than the pool does. Both
 * bounds are returned rather than a single number, because the honest answer
 * is a range and collapsing it hides exactly the risk that matters.
 */

export interface EpochPoolInput {
  /** Gross USD deployed per round, measured now. */
  grossPerRound: number;
  /** Rounds in one epoch iteration (iteration_duration / round_duration). */
  roundsPerIteration: number;
  /** epoch_fee_bps from SatrushConfig. */
  epochFeeBps: number;
  /** Pool already banked this iteration, USD (carry + inflow so far). */
  bankedUsd: number;
  /** Fraction of the iteration elapsed, 0..1. */
  progress: number;
}

export interface EpochPoolProjection {
  /** Inflow the current volume rate implies over a whole iteration. */
  inflowPerIteration: number;
  /** Banked now plus the inflow still to come at the current rate. */
  projectedPool: number;
  /** Implied carry — banked less the inflow the elapsed fraction explains. */
  impliedCarry: number;
  /**
   * How much of the projection is measured rather than extrapolated. Low early
   * in an iteration; a caller sizing off a projection with low confidence
   * should widen its margins, not just take the midpoint.
   */
  confidence: number;
}

export function projectEpochPool(input: EpochPoolInput): EpochPoolProjection {
  const { grossPerRound, roundsPerIteration, epochFeeBps, bankedUsd } = input;
  const progress = Math.min(1, Math.max(0, input.progress));
  const volume = Math.max(0, grossPerRound) * Math.max(0, roundsPerIteration);
  const inflowPerIteration = volume * (Math.max(0, epochFeeBps) / 10_000);
  const projectedPool = Math.max(0, bankedUsd) + (1 - progress) * inflowPerIteration;
  const impliedCarry = Math.max(0, bankedUsd - progress * inflowPerIteration);
  return { inflowPerIteration, projectedPool, impliedCarry, confidence: progress };
}

export interface FieldBounds {
  /** Field tickets at the last completed draw. */
  lastCloseTickets: number;
  /** Volume now, relative to the volume that produced that close (1 = same). */
  volumeRatio: number;
  /**
   * Fraction of the field funded by hashrate banked BEFORE this iteration, so
   * insensitive to current volume. Measured aggregate idle hashrate is roughly
   * 3x a single iteration's draw, so this is not a rounding term.
   */
  bankedShare: number;
}

/**
 * Bracket the field at close. The low bound assumes tickets track volume
 * one-for-one; the high bound assumes the banked portion is spent regardless.
 * A caller wanting one number should use the HIGH bound, since being wrong
 * about competition costs more than being wrong about the pool.
 */
export function projectField(b: FieldBounds): { low: number; high: number } {
  const ratio = Math.max(0, b.volumeRatio);
  const banked = Math.min(1, Math.max(0, b.bankedShare));
  const base = Math.max(0, b.lastCloseTickets);
  return {
    low: base * ratio,
    high: base * (banked + (1 - banked) * ratio),
  };
}

/**
 * Our epoch take per iteration, bracketed. Uses the linear approximation,
 * which holds while our share is small — check `share` on the returned high
 * bound before trusting it, because per-wallet dedup makes the true payoff
 * concave and linear overstates it above roughly 5%.
 */
export function bracketEpochTake(
  myTickets: number,
  field: { low: number; high: number },
  pool: number,
  payoutFraction = 0.9,
): { low: number; high: number; shareAtHigh: number } {
  const take = (f: number): number => {
    const total = myTickets + f;
    return total > 0 ? (myTickets / total) * pool * payoutFraction : 0;
  };
  return {
    // A BIGGER field is the worse case for us, so it produces the LOW take.
    low: take(field.high),
    high: take(field.low),
    shareAtHigh: myTickets / Math.max(1, myTickets + field.high),
  };
}
