import { describe, expect, it } from "vitest";
import {
  TILES_COUNT,
  evOfAllocation,
  marginalEv,
  type EvContext,
} from "../src/strategy/ev.js";

/**
 * Farming is gated off until it is proven +EV. These tests pin the MECHANISM
 * that gate relies on — that a deploy's EV is judged on the board alone once
 * the hashrate credit is withheld — so re-enabling it has to be a deliberate
 * act rather than a side effect of touching the EV model.
 */
const fees = { deployFeeBps: 800, satsVaultRoundBps: 1200, satsVaultClaimBps: 1000 };
const stakes = (v: bigint): bigint[] => new Array<bigint>(TILES_COUNT).fill(v);
const alloc = (tile: number, amt: bigint): bigint[] => {
  const a = new Array<bigint>(TILES_COUNT).fill(0n);
  a[tile] = amt;
  return a;
};

const boardOnly: EvContext = {
  predictedStakes: stakes(1_000_000_000n),
  fees,
  multiplier: 1,
  semantics: "raw",
};
/** What the context looks like with the credit switched back on. */
const withCredit: EvContext = {
  ...boardOnly,
  hashrate: {
    streak: 100,
    valueUsdPerRawUnit: 0.001,
    multiplier: 1,
    maxRawUnitsPerRound: 1_000_000,
  },
};

describe("the hashrate deploy credit is what makes farming look playable", () => {
  it("a marginal round is EV-negative on the board alone", () => {
    // A uniform board is the blanket case: no tile is underpriced, so there is
    // nothing to win beyond the toll.
    expect(evOfAllocation(boardOnly, alloc(0, 5_000_000n))).toBeLessThan(0);
  });

  it("and the credit is what flips it", () => {
    const a = alloc(0, 5_000_000n);
    expect(evOfAllocation(withCredit, a)).toBeGreaterThan(evOfAllocation(boardOnly, a));
  });

  it("the gap is the whole subsidy — it scales with the credit's value", () => {
    const a = alloc(0, 5_000_000n);
    const base = evOfAllocation(boardOnly, a);
    const cheap = evOfAllocation(
      { ...withCredit, hashrate: { ...withCredit.hashrate!, valueUsdPerRawUnit: 0.001 } },
      a,
    );
    const rich = evOfAllocation(
      { ...withCredit, hashrate: { ...withCredit.hashrate!, valueUsdPerRawUnit: 0.002 } },
      a,
    );
    expect(rich - base).toBeCloseTo(2 * (cheap - base), 4);
  });

  it("withholding it changes nothing else about the model", () => {
    // Same board, same allocation, no credit configured either way.
    const a = alloc(3, 2_000_000n);
    const noHashrateField: EvContext = { ...boardOnly };
    const zeroValued: EvContext = {
      ...boardOnly,
      hashrate: { streak: 100, valueUsdPerRawUnit: 0, multiplier: 1 },
    };
    expect(evOfAllocation(zeroValued, a)).toBeCloseTo(evOfAllocation(noHashrateField, a), 6);
  });

  it("gates the marginal decision, not just the total", () => {
    // Water-filling allocates while marginal EV is positive, so the credit has
    // to be absent THERE for a round to be declined, not only in the total.
    const empty = new Array<bigint>(TILES_COUNT).fill(0n);
    const q = 1_000_000n;
    expect(marginalEv(withCredit, empty, 0, q)).toBeGreaterThan(
      marginalEv(boardOnly, empty, 0, q),
    );
  });

  it("still finds a genuinely underpriced tile without any credit", () => {
    // The gate must not blind the selector to real board edges — an empty tile
    // on an otherwise-loaded board is still worth taking.
    const lopsided = stakes(1_000_000_000n);
    lopsided[7] = 1_000_000n;
    const ctx: EvContext = { ...boardOnly, predictedStakes: lopsided };
    expect(evOfAllocation(ctx, alloc(7, 1_000_000n))).toBeGreaterThan(0);
  });
});
