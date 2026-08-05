import { describe, expect, it } from "vitest";
import { TILES_COUNT } from "../src/strategy/ev.js";
import { predictFinalOccupancy } from "../src/strategy/predict.js";
import { usdToBase } from "../src/units.js";

const zeroStakes = () => new Array<bigint>(TILES_COUNT).fill(0n);

describe("predictFinalOccupancy v1", () => {
  it("extrapolates linearly from the observed fill rate", () => {
    const visible = zeroStakes();
    visible[4] = usdToBase(10); // $10 in 10 slots → $1/slot
    const { stakes } = predictFinalOccupancy({
      visibleStakes: visible,
      hiddenPoolEstimate: 0n,
      elapsedSlots: 10,
      remainingSlots: 40,
    });
    expect(stakes[4]).toBe(usdToBase(50)); // 10 + 1·40
    expect(stakes[0]).toBe(0n);
  });

  it("does not extrapolate with zero elapsed (just-armed) or unknown remaining", () => {
    const visible = zeroStakes();
    visible[0] = usdToBase(5);
    for (const inputs of [
      { visibleStakes: visible, hiddenPoolEstimate: 0n, elapsedSlots: 0, remainingSlots: 50 },
      { visibleStakes: visible, hiddenPoolEstimate: 0n, elapsedSlots: 10 },
      { visibleStakes: visible, hiddenPoolEstimate: 0n, elapsedSlots: 10, remainingSlots: -3 },
    ]) {
      expect(predictFinalOccupancy(inputs).stakes[0]).toBe(usdToBase(5));
    }
  });

  it("guards against phantom pots: no rate from a too-short window", () => {
    // The documented overshoot case: $0.92 observed at elapsed 1 once
    // implied a ~50× pot. Below MIN_ELAPSED_FOR_EXTRAPOLATION → no rate.
    const visible = zeroStakes();
    visible[3] = usdToBase(0.92);
    const { stakes } = predictFinalOccupancy({
      visibleStakes: visible,
      hiddenPoolEstimate: 0n,
      elapsedSlots: 1,
      remainingSlots: 49,
    });
    expect(stakes[3]).toBe(usdToBase(0.92));
  });

  it("clamps the extrapolation ratio", () => {
    const visible = zeroStakes();
    visible[3] = usdToBase(1);
    const { stakes } = predictFinalOccupancy({
      visibleStakes: visible,
      hiddenPoolEstimate: 0n,
      elapsedSlots: 5,
      remainingSlots: 45, // raw ratio 9 → clamped to 5 → 1 + 5 = $6
    });
    expect(stakes[3]).toBe(usdToBase(6));
  });

  it("spreads the hidden pool estimate uniformly", () => {
    const { stakes } = predictFinalOccupancy({
      visibleStakes: zeroStakes(),
      hiddenPoolEstimate: usdToBase(21),
      elapsedSlots: 0,
    });
    for (const s of stakes) expect(s).toBe(usdToBase(1));
  });

  it("adds expected automation inflow when provided", () => {
    const inflow = zeroStakes();
    inflow[7] = usdToBase(3);
    const { stakes } = predictFinalOccupancy({
      visibleStakes: zeroStakes(),
      hiddenPoolEstimate: 0n,
      expectedAutomationInflow: inflow,
    });
    expect(stakes[7]).toBe(usdToBase(3));
  });

  describe("endgame convergence", () => {
    it("is off by default — thin tiles stay thin", () => {
      const visible = zeroStakes().map(() => usdToBase(10));
      visible[0] = 0n; // one empty tile amid a thick board
      const { stakes } = predictFinalOccupancy({
        visibleStakes: visible,
        hiddenPoolEstimate: 0n,
        elapsedSlots: 0,
      });
      expect(stakes[0]).toBe(0n); // no convergence requested
    });

    it("pulls below-mean tiles toward the board mean, leaves above-mean tiles alone", () => {
      // 20 tiles at $10, one empty. Mean = 200/21 ≈ $9.52. With convergence 0.5
      // the empty tile rises halfway to the mean (~$4.76); the $10 tiles (above
      // mean) are untouched — money doesn't leave a tile in this model.
      const visible = zeroStakes().map(() => usdToBase(10));
      visible[0] = 0n;
      const { stakes } = predictFinalOccupancy({
        visibleStakes: visible,
        hiddenPoolEstimate: 0n,
        elapsedSlots: 0,
        endgameConvergence: 0.5,
      });
      const mean = (usdToBase(10) * 20n) / BigInt(TILES_COUNT);
      expect(stakes[0]).toBe(mean / 2n); // (mean - 0)·0.5
      expect(stakes[1]).toBe(usdToBase(10)); // above mean → unchanged
    });

    it("full convergence lifts an empty tile to the mean (kills the thin-snipe edge)", () => {
      const visible = zeroStakes().map(() => usdToBase(10));
      visible[0] = 0n;
      const { stakes } = predictFinalOccupancy({
        visibleStakes: visible,
        hiddenPoolEstimate: 0n,
        elapsedSlots: 0,
        endgameConvergence: 1,
      });
      const mean = (usdToBase(10) * 20n) / BigInt(TILES_COUNT);
      expect(stakes[0]).toBe(mean);
    });

    it("barely moves a near-empty uniform board (early era stays snipeable)", () => {
      // The $12 flat board: mean is tiny, so convergence adds almost nothing and
      // genuine empty-board edges survive.
      const visible = zeroStakes();
      visible[5] = usdToBase(1); // a lone small stake
      const { stakes } = predictFinalOccupancy({
        visibleStakes: visible,
        hiddenPoolEstimate: 0n,
        elapsedSlots: 0,
        endgameConvergence: 0.5,
      });
      // mean = $1/21 ≈ 47619 base; empty tiles rise only ~half that.
      expect(stakes[0]).toBeLessThan(usdToBase(0.03));
    });
  });

  it("validates input lengths", () => {
    expect(() =>
      predictFinalOccupancy({ visibleStakes: [0n], hiddenPoolEstimate: 0n }),
    ).toThrow(RangeError);
    expect(() =>
      predictFinalOccupancy({
        visibleStakes: zeroStakes(),
        hiddenPoolEstimate: 0n,
        expectedAutomationInflow: [0n],
      }),
    ).toThrow(RangeError);
  });
});
