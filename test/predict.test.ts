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
