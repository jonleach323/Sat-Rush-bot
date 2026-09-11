import { describe, expect, it } from "vitest";
import {
  reconcileRoundOutcome,
  reconcileRoundOutcomeV2,
  reconcileWalletDrift,
  type RoundOutcomeInputs,
  type RoundOutcomeInputsV2,
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

describe("reconcileRoundOutcomeV2 — the exact refund rule", () => {
  // $30 over 3 tiles, winner not covered: refund = 0.89 × $30 = $26.70 exactly
  // (the per-deployment rule verified on mainnet, FINDINGS E-v2-live).
  function base(): RoundOutcomeInputsV2 {
    return {
      ourGrossBase: usdToBase(30),
      tilesCovered: 3,
      coveredWinner: false,
      refundBps: 8900,
      realizedWonUsdBase: usdToBase(26.7),
      realizedWonShares: 0n,
      realizedWonTokenShares: 12_490_748_418n,
      roundMintedToken: true,
      strikeTriggered: false,
      toleranceFrac: 0.01,
      floorBase: usdToBase(0.01),
    };
  }

  it("passes the exact refund on a losing deploy", () => {
    const r = reconcileRoundOutcomeV2(base());
    expect(r.ok).toBe(true);
    expect(r.modeledUsdBase).toBe(usdToBase(26.7));
    expect(r.driftFrac).toBe(0);
  });

  it("covered winner: refund on the losing tiles only, BTC shares required", () => {
    const r = reconcileRoundOutcomeV2({
      ...base(),
      coveredWinner: true,
      realizedWonUsdBase: usdToBase(17.8), // 0.89 × $20
      realizedWonShares: 3_939_958n,
    });
    expect(r.ok).toBe(true);
    expect(r.modeledUsdBase).toBe(usdToBase(17.8));
    expect(reconcileRoundOutcomeV2({ ...base(), coveredWinner: true, realizedWonUsdBase: usdToBase(17.8) }).reason)
      .toMatch(/no BTC shares/);
  });

  it("trips on BTC shares without covering the winner (parse/model error)", () => {
    expect(reconcileRoundOutcomeV2({ ...base(), realizedWonShares: 1n }).reason).toMatch(/did not cover/);
  });

  it("trips on a missing RUSH leg in a minting round, and on RUSH in a non-minting one", () => {
    expect(reconcileRoundOutcomeV2({ ...base(), realizedWonTokenShares: 0n }).reason).toMatch(/no token shares/);
    expect(reconcileRoundOutcomeV2({ ...base(), roundMintedToken: false }).reason).toMatch(/minted nothing/);
    expect(reconcileRoundOutcomeV2({ ...base(), roundMintedToken: false, realizedWonTokenShares: 0n }).ok).toBe(true);
  });

  it("trips below the refund rule; a strike may only add", () => {
    const low = reconcileRoundOutcomeV2({ ...base(), realizedWonUsdBase: usdToBase(24) });
    expect(low.ok).toBe(false);
    expect(low.reason).toMatch(/below/);
    const high = reconcileRoundOutcomeV2({ ...base(), realizedWonUsdBase: usdToBase(40) });
    expect(high.reason).toMatch(/above/);
    expect(reconcileRoundOutcomeV2({ ...base(), realizedWonUsdBase: usdToBase(40), strikeTriggered: true }).ok).toBe(true);
    expect(reconcileRoundOutcomeV2({ ...base(), realizedWonUsdBase: usdToBase(24), strikeTriggered: true }).ok).toBe(false);
  });

  it("tolerates per-tile floor rounding (a few base units)", () => {
    // $1 over 21 tiles: per tile 47619 base units; refund of 20 tiles = 847_618
    const r = reconcileRoundOutcomeV2({
      ...base(),
      ourGrossBase: usdToBase(1),
      tilesCovered: 21,
      coveredWinner: true,
      realizedWonShares: 5n,
      realizedWonUsdBase: 847_618n - 20n,
    });
    expect(r.ok).toBe(true);
  });

  it("refuses to reason without a gross or with a bad tile count", () => {
    expect(reconcileRoundOutcomeV2({ ...base(), ourGrossBase: 0n }).ok).toBe(false);
    expect(reconcileRoundOutcomeV2({ ...base(), tilesCovered: 22 }).ok).toBe(false);
  });
});

