import { describe, expect, it } from "vitest";
import {
  EPOCH_EQUAL_CURVE_BPS,
  EPOCH_PAYOUT_FRACTION,
  EPOCH_REWARD_CURVE_BPS,
  epochWinFraction,
  expectedWinningsUsd,
  selectVaultTickets,
  type VaultTicketContext,
} from "../src/strategy/vault.js";

describe("V2 equal-share epoch curve", () => {
  it("is 21 equal slots carrying the same 9000 bps payout as V1", () => {
    expect(EPOCH_EQUAL_CURVE_BPS).toHaveLength(EPOCH_REWARD_CURVE_BPS.length);
    expect(EPOCH_EQUAL_CURVE_BPS.reduce((a, b) => a + b, 0)).toBeCloseTo(9000, 9);
    expect(new Set(EPOCH_EQUAL_CURVE_BPS).size).toBe(1);
  });

  it("pays a small holder the same as V1 — the shape changes, not the mean at the margin", () => {
    // Both reduce to 0.9·p to first order; the ranked curve is front-loaded so
    // it sits a fraction of a percent above the flat one at any finite p.
    const p = 0.001;
    const flat = epochWinFraction(p, 1, EPOCH_EQUAL_CURVE_BPS);
    const ranked = epochWinFraction(p);
    expect(Math.abs(flat / ranked - 1)).toBeLessThan(0.01);
    expect(Math.abs(flat / (EPOCH_PAYOUT_FRACTION * p) - 1)).toBeLessThan(0.01);
    expect(flat).toBeLessThan(ranked);
  });

  it("caps one wallet at a single flat slot: 1/21 of the payout at p → 1, not rank 1's 32%", () => {
    expect(epochWinFraction(1, 1, EPOCH_EQUAL_CURVE_BPS)).toBeCloseTo(EPOCH_PAYOUT_FRACTION / 21, 9);
    expect(epochWinFraction(1)).toBeCloseTo(0.32, 9);
    // And it saturates far earlier: at a 30% share V1 still pays ~55% of
    // linear, the flat curve only what one slot can be worth.
    expect(epochWinFraction(0.3, 1, EPOCH_EQUAL_CURVE_BPS)).toBeLessThan(epochWinFraction(0.3));
  });

  it("the dedup uplift can never mint pool past the payout fraction, flat or ranked", () => {
    expect(epochWinFraction(0.5, 10, EPOCH_EQUAL_CURVE_BPS)).toBeLessThanOrEqual(EPOCH_PAYOUT_FRACTION);
  });

  it("the ticket selector buys fewer tickets under the flat curve at the same price", () => {
    const base: VaultTicketContext = {
      kind: "epoch",
      poolValueUsd: 10_000,
      othersTickets: 1_000,
      myTickets: 0,
      hashrateAvailable: 100_000,
      hashrateValueUsd: 0.5,
      maxTickets: 100_000,
    };
    const ranked = selectVaultTickets(base);
    const flat = selectVaultTickets({ ...base, curve: EPOCH_EQUAL_CURVE_BPS });
    expect(ranked.tickets).toBeGreaterThan(0);
    expect(flat.tickets).toBeGreaterThan(0);
    expect(flat.tickets).toBeLessThan(ranked.tickets);
    // The first ticket is worth the same to within a percent either way.
    const flatFirst = expectedWinningsUsd(1, 1_000, 10_000, "epoch", 1, EPOCH_EQUAL_CURVE_BPS);
    const rankedFirst = expectedWinningsUsd(1, 1_000, 10_000);
    expect(Math.abs(flatFirst / rankedFirst - 1)).toBeLessThan(0.01);
  });

  it("the 1-BTC vault ignores the curve", () => {
    expect(expectedWinningsUsd(5, 95, 1000, "one_btc", 1, EPOCH_EQUAL_CURVE_BPS)).toBeCloseTo(50, 9);
  });
});
