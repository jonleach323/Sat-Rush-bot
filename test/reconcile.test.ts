import { describe, expect, it } from "vitest";
import {
  reconcileRoundOutcome,
  reconcileWalletDrift,
  type RoundOutcomeInputs,
} from "../src/strategy/reconcile.js";
import { usdToBase } from "../src/units.js";

function base(): RoundOutcomeInputs {
  // We covered the winner with $0.30 of a $0.60 winner pool; pot $4.05 →
  // modeled win = 4.05 * 0.30/0.60 = $2.025.
  return {
    ourStakeOnWinnerBase: usdToBase(0.3),
    totalStakeOnWinnerBase: usdToBase(0.6),
    potBase: usdToBase(4.05),
    realizedWonUsdBase: usdToBase(2.025),
    realizedWonShares: 100n,
    toleranceFrac: 0.25,
    floorBase: usdToBase(0.5),
  };
}

describe("reconcileRoundOutcome — settlement tripwire", () => {
  it("passes when modeled ≈ realized", () => {
    const r = reconcileRoundOutcome(base());
    expect(r.ok).toBe(true);
    expect(r.modeledUsdBase).toBe(usdToBase(2.025));
  });

  it("TRIPS (exact): paid on a tile we did not cover", () => {
    const r = reconcileRoundOutcome({
      ...base(),
      ourStakeOnWinnerBase: 0n,
      realizedWonUsdBase: usdToBase(2),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("did not cover");
  });

  it("TRIPS (exact): covered the winner but received nothing", () => {
    const r = reconcileRoundOutcome({
      ...base(),
      realizedWonUsdBase: 0n,
      realizedWonShares: 0n,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("received nothing");
  });

  it("TRIPS (magnitude): realized far below modeled beyond tolerance", () => {
    const r = reconcileRoundOutcome({ ...base(), realizedWonUsdBase: usdToBase(0.5) });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("drift");
  });

  it("does not false-trip within tolerance", () => {
    // modeled 2.025, realized 1.8 → ~11% drift < 25%
    expect(reconcileRoundOutcome({ ...base(), realizedWonUsdBase: usdToBase(1.8) }).ok).toBe(true);
  });

  it("uncovered + zero payout is fine (a normal loss)", () => {
    const r = reconcileRoundOutcome({
      ...base(),
      ourStakeOnWinnerBase: 0n,
      realizedWonUsdBase: 0n,
      realizedWonShares: 0n,
    });
    expect(r.ok).toBe(true);
  });
});

describe("reconcileWalletDrift — coarse drain tripwire", () => {
  it("passes when actual outflow ≤ expected worst case + tolerance", () => {
    // expected worst case: lose everything deployed ($100). actual dropped $100.
    const r = reconcileWalletDrift({
      expectedDeltaBase: -usdToBase(100),
      actualDeltaBase: -usdToBase(100),
      toleranceBase: usdToBase(5),
    });
    expect(r.ok).toBe(true);
  });

  it("passes on an inflow (winning day)", () => {
    const r = reconcileWalletDrift({
      expectedDeltaBase: -usdToBase(100),
      actualDeltaBase: usdToBase(50),
      toleranceBase: usdToBase(5),
    });
    expect(r.ok).toBe(true);
  });

  it("TRIPS when the wallet drained more than everything deployed + tolerance", () => {
    const r = reconcileWalletDrift({
      expectedDeltaBase: -usdToBase(100), // worst legit: -$100
      actualDeltaBase: -usdToBase(140), // actually lost $140 — $40 unexplained
      toleranceBase: usdToBase(5),
    });
    expect(r.ok).toBe(false);
    expect(r.unexplainedBase).toBe(usdToBase(40));
  });
});
