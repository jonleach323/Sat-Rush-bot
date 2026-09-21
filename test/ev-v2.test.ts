import { describe, expect, it } from "vitest";
import {
  blanketReturnV2,
  breakEvenTokenYield,
  evOfAllocationV2,
  evOfMaskV2,
  marginalEvV2,
  outcomeReturnsV2,
  satsLegBps,
  statedV2Economics,
  tokenYield,
  tollAtRiskFraction,
  v2EconomicsFromConfig,
  v2Model,
  type V2EvContext,
} from "../src/strategy/ev-v2.js";
import { TILES_COUNT, evOfAllocation, outcomeReturns, type EvContext } from "../src/strategy/ev.js";
import { kellyFraction } from "../src/strategy/kelly.js";
import { usdToBase } from "../src/units.js";

/**
 * Every number here is checked against a closed form derived in the file
 * header of ev-v2.ts, not against the code's own output — the V1 model was
 * "verified exact" against itself while its inputs were wrong.
 */
const ECON = statedV2Economics(); // 600 bps layer, 8900 bps refund, 1000 bps exit
const F = 0.06;
const R = 0.89;
const S = 0.05;

const zero = () => new Array<bigint>(TILES_COUNT).fill(0n);

/** Others: $100 gross on every tile except the listed empty ones (stakes are NET). */
function board(emptyTiles: number[] = [], grossPerTile = 100): bigint[] {
  const stakes = zero();
  for (let i = 0; i < TILES_COUNT; i++) {
    if (!emptyTiles.includes(i)) stakes[i] = usdToBase(grossPerTile * (1 - F));
  }
  return stakes;
}

function ctx(over: Partial<V2EvContext> = {}): V2EvContext {
  return { predictedStakes: board(), econ: ECON, mintedTokenValueBase: 0, ...over };
}

function on(tiles: number[], perTileUsd: number): bigint[] {
  const a = zero();
  for (const t of tiles) a[t] = usdToBase(perTileUsd);
  return a;
}

const ALL = [...Array(TILES_COUNT).keys()];

describe("V2 economics", () => {
  it("derives the sats leg from the fee layer and the refund: 10000 − 600 − 8900 = 500", () => {
    expect(satsLegBps(ECON)).toBe(500);
    expect(tollAtRiskFraction(ECON)).toBeCloseTo(0.11, 12);
  });

  it("reads the layer from a V2-shaped config, buybacks leg included", () => {
    const e = v2EconomicsFromConfig({
      strike_fee_bps: 198, epoch_fee_bps: 197, one_btc_fee_bps: 99,
      protocol_fee_bps: 76, buybacks_fee_bps: 30, vault_exit_fee_bps: 1000,
    });
    expect(e.feeLayerBps).toBe(600);
    expect(e.losingRefundBps).toBe(8900);
    expect(e.vaultExitFeeBps).toBe(1000);
  });

  it("refuses a config the stated refund cannot coexist with", () => {
    expect(() =>
      v2EconomicsFromConfig({
        strike_fee_bps: 264, epoch_fee_bps: 262, one_btc_fee_bps: 132, protocol_fee_bps: 900,
      }),
    ).toThrow(/exceed 100%/);
  });

  it("a blanket at a uniform board returns 1 − f plus 80% of the token yield", () => {
    expect(blanketReturnV2(ECON, 0)).toBeCloseTo(0.94, 12);
    expect(blanketReturnV2(ECON, 0.10)).toBeCloseTo(0.94 + 0.08, 12);
  });

  it("break-even token yield brackets: whole layer 7.5%, protocol-only 1.325%", () => {
    expect(breakEvenTokenYield(600)).toBeCloseTo(0.075, 12);
    expect(breakEvenTokenYield(106)).toBeCloseTo(0.01325, 12);
    expect(tokenYield(75, 1000)).toBeCloseTo(0.075, 12);
    expect(tokenYield(75, 0)).toBe(0);
  });
});

describe("evOfAllocationV2 — closed forms", () => {
  it("blanket on a uniform board with the token at nothing loses exactly the fee layer", () => {
    // Refunds on 20 tiles + own stake back on the winner + the pro-rata slice
    // of the sats pool sum to (1 − f)·A for every winning tile.
    const A = 21;
    const ev = evOfAllocationV2(ctx(), on(ALL, 1));
    expect(ev).toBeCloseTo(-F * usdToBaseN(A), 0);
  });

  it("blanket on a uniform board captures 80% of the mint pro-rata by volume", () => {
    const A = 21;
    const mp = usdToBaseN(1000); // $1,000 of RUSH this round
    const c = ctx({ mintedTokenValueBase: mp });
    const volume = 21 * 100 + A;
    const expected = -F * usdToBaseN(A) + 0.8 * mp * (A / volume);
    expect(evOfAllocationV2(c, on(ALL, 1))).toBeCloseTo(expected, 0);
  });

  it("an empty tile pays the whole sats pool at 1/21 for an 11% toll", () => {
    // $10 alone on tile 0, $100 on each of the other 20 tiles: V = 2010.
    // EV = −(1 − r)·10 + s·V/21.
    const c = ctx({ predictedStakes: board([0]) });
    const a = 10;
    const expected = -(1 - R) * usdToBaseN(a) + (S * usdToBaseN(2000 + a)) / 21;
    expect(evOfAllocationV2(c, on([0], a))).toBeCloseTo(expected, 0);
    expect(expected).toBeGreaterThan(0);
  });

  it("the empty-tile edge is 1/21 of the contested pool, tokens and strike included", () => {
    const mp = usdToBaseN(210);
    const strike = usdToBaseN(42);
    const c = ctx({ predictedStakes: board([0]), mintedTokenValueBase: mp, strikeExpectedPot: strike });
    const a = 10;
    const volume = 2000 + a;
    // Winners' leg + strike ride with the sats pool; the losers' leg pays
    // a/(V − W_j) on each of the 20 other outcomes, W_j = 100 there.
    const contested = S * usdToBaseN(volume) + 0.64 * mp + strike;
    const losersLeg = (20 / 21) * 0.16 * mp * (a / (volume - 100));
    const expected = -(1 - R) * usdToBaseN(a) + contested / 21 + losersLeg;
    expect(evOfAllocationV2(c, on([0], a))).toBeCloseTo(expected, 0);
  });

  it("crowded tiles dilute the slice: a full tile is worth less than an empty one", () => {
    const empty = evOfAllocationV2(ctx({ predictedStakes: board([0]) }), on([0], 10));
    const crowded = evOfAllocationV2(ctx(), on([0], 10));
    expect(crowded).toBeLessThan(empty);
    // On a uniform board a single tile is NOT quite proportional: the slice is
    // a/(g + a) of the pool at 1/21, and own-dilution makes that a little less
    // than the a/V a blanket would get. Exact form: −(1 − r)·a + s·V/21 · a/(g + a).
    const a = 10;
    const g = 100;
    const volume = 21 * g + a;
    const expected = -(1 - R) * usdToBaseN(a) + ((S * usdToBaseN(volume)) / 21) * (a / (g + a));
    expect(crowded).toBeCloseTo(expected, 0);
    // …and it is worse than the proportional −f·a a blanket loses.
    expect(crowded).toBeLessThan(-F * usdToBaseN(a));
  });

  it("own-dilution: the second quantum on an empty tile has negative marginal EV", () => {
    const c = ctx({ predictedStakes: board([0]) });
    const q = usdToBase(1);
    const first = marginalEvV2(c, zero(), 0, q);
    const second = marginalEvV2(c, on([0], 1), 0, q);
    expect(first).toBeGreaterThan(0);
    // Alone on the tile the share is already 1, so a further dollar only adds
    // its own 5% to the pool: −(1 − r) + s/21 per dollar.
    expect(second).toBeCloseTo((-(1 - R) + S / 21) * 1e6, 0);
    expect(second).toBeLessThan(0);
  });

  it("valuing legs net of the exit fee haircuts BTC and RUSH but never the USD refund", () => {
    const hold = ctx({ predictedStakes: board([0]), mintedTokenValueBase: usdToBaseN(100) });
    const claim = { ...hold, valueNetOfExitFee: true };
    const a = on([0], 10);
    expect(evOfAllocationV2(claim, a)).toBeLessThan(evOfAllocationV2(hold, a));
    // The losing outcomes are pure USD refund + losers' RUSH: only the RUSH shrinks.
    const rh = outcomeReturnsV2(hold, a);
    const rc = outcomeReturnsV2(claim, a);
    expect(rc[1]).toBeLessThan(rh[1] as number);
    expect(rc[1]).toBeGreaterThan(-(1 - R));
  });

  it("nothing staked is worth nothing", () => {
    expect(evOfAllocationV2(ctx(), zero())).toBe(0);
    expect(outcomeReturnsV2(ctx(), zero()).every((r) => r === 0)).toBe(true);
  });

  it("all of the round on the winning tile: the losers' leg is not ours and never NaN", () => {
    const stakes = zero();
    stakes[5] = usdToBase(94);
    const c = ctx({ predictedStakes: stakes, mintedTokenValueBase: usdToBaseN(100) });
    const ev = evOfAllocationV2(c, on([5], 10));
    expect(Number.isFinite(ev)).toBe(true);
  });

  it("evOfMaskV2 splits the amount evenly, matching the on-chain semantics", () => {
    const c = ctx({ predictedStakes: board([0, 1]) });
    expect(evOfMaskV2(c, 0b11, usdToBase(20))).toBeCloseTo(evOfAllocationV2(c, on([0, 1], 10)), 6);
  });

  it("rejects malformed inputs", () => {
    expect(() => evOfAllocationV2(ctx({ predictedStakes: [] }), zero())).toThrow(RangeError);
    expect(() => evOfAllocationV2(ctx({ mintedTokenValueBase: -1 }), zero())).toThrow(RangeError);
    expect(() => evOfAllocationV2(ctx(), zero().slice(1))).toThrow(RangeError);
    expect(() => marginalEvV2(ctx(), zero(), 21, 1n)).toThrow(RangeError);
  });
});

describe("outcome returns and sizing", () => {
  it("the floor of a losing outcome is −11%, not −100%", () => {
    const r = outcomeReturnsV2(ctx({ predictedStakes: board([0]) }), on([0], 10));
    for (let j = 1; j < TILES_COUNT; j++) expect(r[j]).toBeCloseTo(-(1 - R), 9);
    expect(r[0]).toBeGreaterThan(5); // ~10x on the $10 when the empty tile hits
  });

  it("Kelly sizes the same board many times larger than under V1, because the downside shrank", () => {
    const v2 = ctx({ predictedStakes: board([0]) });
    const a = on([0], 10);
    const fV2 = kellyFraction(outcomeReturnsV2(v2, a));

    const v1: EvContext = {
      predictedStakes: board([0]),
      fees: { deployFeeBps: 800, satsVaultRoundBps: 1200, satsVaultClaimBps: 1000 },
      multiplier: 1,
      semantics: "raw",
    };
    const fV1 = kellyFraction(outcomeReturns(v1, a));
    expect(evOfAllocation(v1, a)).toBeGreaterThan(0); // V1 liked this board too
    // Closed form for V2: 9.94/(1+9.94f) = 20·0.11/(1−0.11f) → f ≈ 0.337.
    expect(fV2).toBeCloseTo(0.337, 2);
    expect(fV2).toBeGreaterThan(5 * fV1);
  });

  it("the EvModel wrapper is the same arithmetic", () => {
    const c = ctx({ predictedStakes: board([0, 3]), mintedTokenValueBase: usdToBaseN(50) });
    const m = v2Model(c);
    const a = on([0, 3], 5);
    expect(m.ev(a)).toBe(evOfAllocationV2(c, a));
    expect(m.returns(a)).toEqual(outcomeReturnsV2(c, a));
    expect(m.marginal(a, 0, usdToBase(1))).toBe(marginalEvV2(c, a, 0, usdToBase(1)));
    expect(m.predictedStakes).toBe(c.predictedStakes);
  });
});

function usdToBaseN(usd: number): number {
  return Number(usdToBase(usd));
}

describe("the owner's launch numbers: 1 RUSH per $500 at $10", () => {
  it("is a 2% token yield, and the mint scales with our own deploy", async () => {
    const { statedTokenYield, breakEvenTokenPriceUsd } = await import("../src/strategy/ev-v2.js");
    expect(statedTokenYield()).toBeCloseTo(0.02, 12);
    expect(statedTokenYield(5)).toBeCloseTo(0.01, 12);
    // Blanket at a uniform board: (−f + 0.8·y)·A = −4.4% of stake, exactly.
    const A = 21;
    const c = ctx({ tokenYieldPerVolume: statedTokenYield() });
    expect(evOfAllocationV2(c, on(ALL, 1))).toBeCloseTo((-F + 0.8 * 0.02) * usdToBaseN(A), 0);
    // The yield route and the fixed-mint route agree when the mint equals y·V.
    const volume = 21 * 100 + A;
    const fixed = ctx({ mintedTokenValueBase: 0.02 * usdToBaseN(volume) });
    expect(evOfAllocationV2(c, on(ALL, 1))).toBeCloseTo(evOfAllocationV2(fixed, on(ALL, 1)), 0);
    // Break-even prices bracket $10: whole layer as toll needs $37.50, the
    // protocol leg alone $6.62 (at 106 bps).
    expect(breakEvenTokenPriceUsd(600)).toBeCloseTo(37.5, 6);
    expect(breakEvenTokenPriceUsd(106)).toBeCloseTo(6.625, 6);
  });
});

describe("vault carry on the share legs", () => {
  const econ = { feeLayerBps: 600, losingRefundBps: 8900, vaultExitFeeBps: 1000 };
  const uniform = new Array<bigint>(TILES_COUNT).fill(usdToBase(20));
  const single = (usd: number) => {
    const a = new Array<bigint>(TILES_COUNT).fill(0n);
    a[4] = usdToBase(usd);
    return a;
  };
  const blanket = (usd: number) => new Array<bigint>(TILES_COUNT).fill(usdToBase(usd / TILES_COUNT));

  it("the sats shares a dollar acquires are ≈ (0.05·21 + 0.89)/21 of gross, whatever the mask", () => {
    // Value with a 100% carry minus value without it = the share legs' size.
    const base = { predictedStakes: uniform, econ, mintedTokenValueBase: 0 };
    for (const alloc of [single(1), blanket(21)]) {
      const without = evOfAllocationV2(base, alloc);
      const withCarry = evOfAllocationV2({ ...base, shareCarry: { sats: 1, token: 0 } }, alloc);
      const gross = Number(alloc.reduce((a, b) => a + b, 0n));
      const sharesPerUsd = (withCarry - without) / gross;
      expect(sharesPerUsd).toBeGreaterThan(0.085); // 9.24% at a uniform board, minus our own weight
      expect(sharesPerUsd).toBeLessThan(0.0925);
    }
  });

  it("token carry scales only the RUSH legs; zero carry is the identity; negative is refused", () => {
    const base = { predictedStakes: uniform, econ, mintedTokenValueBase: 0, tokenYieldPerVolume: 0.015 };
    const alloc = single(5);
    const plain = evOfAllocationV2(base, alloc);
    expect(evOfAllocationV2({ ...base, shareCarry: { sats: 0, token: 0 } }, alloc)).toBeCloseTo(plain, 6);
    const tok = evOfAllocationV2({ ...base, shareCarry: { sats: 0, token: 1 } }, alloc);
    // RUSH legs ≈ 80% of the 1.5% yield ≈ 1.2% of gross
    expect((tok - plain) / Number(usdToBase(5))).toBeGreaterThan(0.010);
    expect((tok - plain) / Number(usdToBase(5))).toBeLessThan(0.013);
    expect(() => evOfAllocationV2({ ...base, shareCarry: { sats: -0.1, token: 0 } }, alloc)).toThrow(RangeError);
  });

  it("a long enough hold flips a single tile positive; the measured steady rate needs months", () => {
    const base = { predictedStakes: uniform, econ, mintedTokenValueBase: 0, tokenYieldPerVolume: 0.015 };
    const alloc = single(5);
    const plain = evOfAllocationV2(base, alloc);
    expect(plain).toBeLessThan(0);
    // Carry needed = toll / share leg; the share leg is what a unit carry adds.
    const unit = evOfAllocationV2({ ...base, shareCarry: { sats: 1, token: 0 } }, alloc) - plain;
    const need = -plain / unit;
    expect(need).toBeGreaterThan(0.4); // ≈ 4–5% toll on an ≈8–9% share leg
    expect(need).toBeLessThan(0.8);
    // At the measured steady 0.25%/day that is months of holding, not days.
    expect(need / 0.0025).toBeGreaterThan(150);
    expect(evOfAllocationV2({ ...base, shareCarry: { sats: need * 1.1, token: 0 } }, alloc)).toBeGreaterThan(0);
    expect(evOfAllocationV2({ ...base, shareCarry: { sats: need * 0.9, token: 0 } }, alloc)).toBeLessThan(0);
  });
});

describe("Kelly on V2 outcome returns", () => {
  it("the worst outcome is the toll, not the stake, so the feasible fraction is 1 (Kelly never throttles below the cap)", async () => {
    const { kellyFraction } = await import("../src/strategy/kelly.js");
    const econ = { feeLayerBps: 600, losingRefundBps: 8900, vaultExitFeeBps: 1000 };
    const uniform = new Array<bigint>(TILES_COUNT).fill(usdToBase(20));
    const alloc = new Array<bigint>(TILES_COUNT).fill(0n);
    alloc[4] = usdToBase(5);
    // Give the round a real edge (a fat carry) so Kelly has something to size.
    const returns = outcomeReturnsV2({ predictedStakes: uniform, econ, mintedTokenValueBase: 0, tokenYieldPerVolume: 0.02, shareCarry: { sats: 1.5, token: 0 } }, alloc);
    const worst = Math.min(...returns);
    expect(worst).toBeGreaterThan(-0.2); // ≈ −11% toll, not −100%
    expect(worst).toBeLessThan(0);
    const f = kellyFraction(returns);
    expect(f).toBeGreaterThan(0);
    // The same edge with V1-shaped misses (−100% of stake) sizes far smaller:
    // the bounded downside is what lets V2 stake near the cap.
    const v1Shaped = returns.map((r) => (r < 0 ? -1 : r));
    expect(kellyFraction(v1Shaped)).toBeLessThan(f / 3);
  });
});

