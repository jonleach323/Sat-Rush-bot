import { describe, expect, it } from "vitest";
import { evenSplit, everyoneDrawn, simulateSplitTake } from "../src/strategy/wallet-split.js";
import { EPOCH_EQUAL_CURVE_BPS, EPOCH_PAYOUT_FRACTION, EPOCH_REWARD_CURVE_BPS } from "../src/strategy/vault.js";
import { seededRng } from "./helpers.js";

const SLOT = EPOCH_PAYOUT_FRACTION / 21;

describe("epoch take split across wallets (V2 flat curve)", () => {
  it("with 21 or fewer participants every wallet takes exactly one slot, tickets notwithstanding", () => {
    const field = [50_000, 10_000, 1_000, 500, 1, 1];
    const one = simulateSplitTake({ myWallets: [1], field, trials: 500, rng: seededRng(1) });
    expect(one.value).toBeCloseTo(SLOT, 9);
    expect(one.stderr).toBe(0);
    const five = simulateSplitTake({ myWallets: evenSplit(5, 5), field, trials: 500, rng: seededRng(1) });
    expect(five.value).toBeCloseTo(5 * SLOT, 9);
    expect(everyoneDrawn(field.length + 5)).toBe(true);
    expect(everyoneDrawn(22)).toBe(false);
  });

  it("a dominant holder in one wallet is capped at one slot; split, it collects the pool it funds", () => {
    // 90 field wallets sharing 100k tickets; we hold 900k (90% of the total).
    const rng = seededRng(3);
    const field = Array.from({ length: 90 }, () => 500 + Math.floor(rng() * 1_700));
    const one = simulateSplitTake({ myWallets: [900_000], field, trials: 2_000, rng: seededRng(5) });
    expect(one.value).toBeCloseTo(SLOT, 6); // always drawn, never more than one slot
    const split = simulateSplitTake({ myWallets: evenSplit(900_000, 21), field, trials: 2_000, rng: seededRng(5) });
    expect(split.value).toBeGreaterThan(0.75 * EPOCH_PAYOUT_FRACTION);
    expect(split.value).toBeGreaterThan(one.value * 10);
    // Never more than the payout fraction, and the error bar is reported.
    expect(split.value).toBeLessThanOrEqual(EPOCH_PAYOUT_FRACTION + 1e-9);
    expect(split.stderr).toBeGreaterThan(0);
  });

  it("splitting never lowers the expected take", () => {
    const rng = seededRng(9);
    const field = Array.from({ length: 60 }, () => 100 + Math.floor(rng() * 5_000));
    let prev = 0;
    for (const k of [1, 2, 5, 10]) {
      const est = simulateSplitTake({ myWallets: evenSplit(50_000, k), field, trials: 3_000, rng: seededRng(11) });
      expect(est.value + 3 * est.stderr).toBeGreaterThanOrEqual(prev);
      prev = est.value;
    }
  });

  it("under V1's rank curve the same split gains far less — the flat curve is what makes wallets matter", () => {
    const rng = seededRng(21);
    const field = Array.from({ length: 90 }, () => 500 + Math.floor(rng() * 1_700));
    const v1One = simulateSplitTake({ myWallets: [900_000], field, curve: EPOCH_REWARD_CURVE_BPS, trials: 2_000, rng: seededRng(7) });
    const v2One = simulateSplitTake({ myWallets: [900_000], field, curve: EPOCH_EQUAL_CURVE_BPS, trials: 2_000, rng: seededRng(7) });
    // One dominant wallet: V1 pays rank 1 (32%) nine times in ten and rank 2
    // or lower otherwise (~0.30 in all); V2 pays a flat slot (4.3%).
    expect(v1One.value).toBeGreaterThan(0.28);
    expect(v1One.value).toBeLessThan(0.32);
    expect(v2One.value).toBeCloseTo(SLOT, 6);
    expect(v1One.value).toBeGreaterThan(6 * v2One.value);
  });

  it("splits whole tickets evenly", () => {
    expect(evenSplit(10, 3)).toEqual([4, 3, 3]);
    expect(evenSplit(0, 2)).toEqual([0, 0]);
    expect(() => evenSplit(1, 0)).toThrow(RangeError);
  });
});
