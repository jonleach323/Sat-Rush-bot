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
}

export interface OccupancyPrediction {
  /** Predicted-final per-tile stakes S_i (base units), length 21. */
  stakes: bigint[];
}

export type OccupancyPredictor = (inputs: PredictInputs) => OccupancyPrediction;

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

  const stakes = visibleStakes.map((visible, i) => {
    // Linear fill-rate extrapolation; no rate is observable at elapsed 0.
    const extrapolated =
      elapsed > 0 && remaining > 0
        ? (visible * BigInt(Math.round((remaining / elapsed) * 1e6))) / 1_000_000n
        : 0n;
    return visible + extrapolated + hiddenPerTile + (inflow?.[i] ?? 0n);
  });
  return { stakes };
};
