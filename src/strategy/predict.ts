/**
 * Final-occupancy prediction. v1 is a per-tile linear extrapolation of this
 * round's observed fill rate, plus a uniform spread of the hidden-pool
 * estimate (0 in the public-only era) and an optional expected-automation
 * inflow term (populated once crank timing is measured from the events log).
 *
 * The OccupancyPredictor type is the swap point: a learned model replaces
 * predictFinalOccupancy without touching callers.
 */
import { TILES_COUNT } from "./ev.js";

export interface PredictInputs {
  /** Current visible per-tile stakes (base units), length 21. */
  visibleStakes: bigint[];
  /** Estimated hidden (private-deployment) pool; 0 for now. */
  hiddenPoolEstimate: bigint;
  /** Slots since the round clock armed (0 or undefined = just armed/disarmed). */
  elapsedSlots?: number | undefined;
  /** Slots until the deploy cutoff (undefined = unknown → no extrapolation). */
  remainingSlots?: number | undefined;
  /**
   * Expected additional per-tile stake from automations before cutoff,
   * measurable from is_automation + slot on PublicDeployCreated events.
   * Null/undefined until crank timing is characterized.
   */
  expectedAutomationInflow?: bigint[] | null | undefined;
  /**
   * Endgame convergence ∈ [0,1]. Thin tiles do not stay thin: late money and
   * other snipers pile onto the cheapest tiles before close, so by cutoff the
   * board trends toward uniform (observed live — a $12 board at open settled
   * near-uniform at ~$10/tile once the field arrived). This raises every
   * below-mean tile toward the board's mean stake by this fraction of the gap,
   * which is where the payout dilution comes from: without it the model
   * believes it will own an undiluted share of an empty tile and overvalues
   * the snipe. 0 = off (pure own-observation, the old optimistic behavior).
   */
  endgameConvergence?: number | undefined;
}

export interface OccupancyPrediction {
  /** Predicted-final per-tile stakes S_i (base units), length 21. */
  stakes: bigint[];
}

export type OccupancyPredictor = (inputs: PredictInputs) => OccupancyPrediction;

/**
 * Extrapolation guards. A fill rate inferred from 1-2 slots is noise (a
 * single early deploy once implied a 50× pot), and with the per-round cap
 * set equal to the daily cap, phantom predicted EV is the main oversizing
 * risk — the EV stop is only as good as these stakes.
 */
export const MIN_ELAPSED_FOR_EXTRAPOLATION = 5;
export const MAX_EXTRAPOLATION_RATIO = 5;

export const predictFinalOccupancy: OccupancyPredictor = (inputs) => {
  const { visibleStakes, hiddenPoolEstimate } = inputs;
  if (visibleStakes.length !== TILES_COUNT) {
    throw new RangeError(`visibleStakes must have ${TILES_COUNT} entries`);
  }
  const elapsed = inputs.elapsedSlots ?? 0;
  const remaining = Math.max(0, inputs.remainingSlots ?? 0);
  const inflow = inputs.expectedAutomationInflow ?? null;
  if (inflow && inflow.length !== TILES_COUNT) {
    throw new RangeError(`expectedAutomationInflow must have ${TILES_COUNT} entries`);
  }
  const hiddenPerTile = hiddenPoolEstimate / BigInt(TILES_COUNT);

  const ratio =
    elapsed >= MIN_ELAPSED_FOR_EXTRAPOLATION && remaining > 0
      ? Math.min(remaining / elapsed, MAX_EXTRAPOLATION_RATIO)
      : 0;
  const stakes = visibleStakes.map((visible, i) => {
    // Linear fill-rate extrapolation, guarded: no rate from a too-short
    // observation window, and never more than MAX_EXTRAPOLATION_RATIO×.
    const extrapolated =
      ratio > 0 ? (visible * BigInt(Math.round(ratio * 1e6))) / 1_000_000n : 0n;
    return visible + extrapolated + hiddenPerTile + (inflow?.[i] ?? 0n);
  });

  // Endgame convergence: the fill-rate extrapolation above is proportional to a
  // tile's current stake, so it forecasts ~zero inflow onto empty tiles — the
  // exact tiles the bot snipes and the exact tiles the field crowds late. That
  // is what makes wins pay less than modeled. Correct it by pulling every
  // below-mean tile a fraction of the way to the board's mean, so the model
  // prices the dilution it will actually suffer on a thin snipe.
  const convergence = Math.max(0, Math.min(1, inputs.endgameConvergence ?? 0));
  if (convergence > 0) {
    let total = 0n;
    for (const s of stakes) total += s;
    const mean = total / BigInt(TILES_COUNT);
    const scale = BigInt(Math.round(convergence * 1_000_000));
    for (let i = 0; i < stakes.length; i++) {
      const s = stakes[i] ?? 0n;
      if (s < mean) stakes[i] = s + ((mean - s) * scale) / 1_000_000n;
    }
  }
  return { stakes };
};
