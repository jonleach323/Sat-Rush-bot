import { describe, expect, it } from "vitest";
import {
  evOfAllocation,
  evOfMask,
  feeModelFromConfig,
  marginalEv,
  netFactor,
  outcomeReturns,
  potAfterFees,
  TILES_COUNT,
  type EvContext,
} from "../src/strategy/ev.js";
import { usdToBase } from "../src/units.js";
import { seededRng } from "./helpers.js";

// Devnet-measured fee structure (docs/devnet-findings.md). The sats-vault round
// leg is redistributed to winners as BTC shares, so its only cost is the claim fee.
const FEES = { deployFeeBps: 800, satsVaultRoundBps: 1200, satsVaultClaimBps: 1000 };

const zeroStakes = () => new Array<bigint>(TILES_COUNT).fill(0n);

function ctx(overrides: Partial<EvContext> = {}): EvContext {
  return {
    predictedStakes: zeroStakes(),
    fees: FEES,
    multiplier: 1,
    semantics: "raw",
    ...overrides,
  };
}

function allocOn(tiles: number[], perTile: bigint): bigint[] {
  const a = zeroStakes();
  for (const t of tiles) a[t] = perTile;
  return a;
}

describe("fee model", () => {
  it("derives the fee legs from SatrushConfig fields", () => {
    const fees = feeModelFromConfig({
      strike_fee_bps: 264,
      epoch_fee_bps: 262,
      one_btc_fee_bps: 132,
      protocol_fee_bps: 142,
      sats_vault_round_fee_bps: 1200,
      vault_exit_fee_bps: 1000,
    } as never);
    expect(fees.deployFeeBps).toBe(800);
    // V2's buybacks leg joins the deploy layer (208+194+48+100+50 = 600 live)
    expect(
      feeModelFromConfig({
        strike_fee_bps: 208, epoch_fee_bps: 194, one_btc_fee_bps: 48, protocol_fee_bps: 100,
        buybacks_fee_bps: 50, sats_vault_round_fee_bps: 1200, vault_exit_fee_bps: 1000,
      } as never).deployFeeBps,
    ).toBe(600);
    expect(fees.satsVaultRoundBps).toBe(1200);
    expect(fees.satsVaultClaimBps).toBe(1000);
    expect(netFactor(fees)).toBeCloseTo(0.92);
  });

  it("reproduces the measured pipeline: $5 gross → $4.60 net → $4.545 pot (vault leg returns net of claim fee)", () => {
    const c = ctx();
    const alloc = allocOn([0], usdToBase(5));
    // pot = net · (1 − satsVaultRound·satsVaultClaim) = 5·0.92·(1 − 0.12·0.10)
    expect(potAfterFees(c, alloc)).toBeCloseTo(5_000_000 * 0.92 * (1 - 0.12 * 0.1), 0);
  });
});

describe("evOfAllocation", () => {
  it("solo play on an empty board is EV-negative (fees)", () => {
    // Sole player: wins own pot back minus fees with prob n/21 per covered tile.
    const ev = evOfAllocation(ctx(), allocOn([0, 1, 2], usdToBase(1)));
    expect(ev).toBeLessThan(0);
  });

  it("chasing a large existing pot on empty tiles is EV-positive", () => {
    const stakes = zeroStakes();
    for (let i = 2; i < TILES_COUNT; i++) stakes[i] = usdToBase(10); // $190 of others
    const ev = evOfAllocation(ctx({ predictedStakes: stakes }), allocOn([0], usdToBase(1)));
    // pot' ≈ (190 + 0.92)·(1 − 0.12·0.10) ≈ 189; win 1/21 of it with share 1 → ~$9 − $1.
    expect(ev).toBeGreaterThan(5_000_000); // > $5 expected profit

  });

  it("crowded tiles dilute the payout share", () => {
    const stakes = zeroStakes();
    stakes[0] = usdToBase(100);
    stakes[1] = 0n;
    for (let i = 2; i < TILES_COUNT; i++) stakes[i] = usdToBase(10);
    const c = ctx({ predictedStakes: stakes });
    const onCrowded = evOfAllocation(c, allocOn([0], usdToBase(1)));
    const onEmpty = evOfAllocation(c, allocOn([1], usdToBase(1)));
    expect(onEmpty).toBeGreaterThan(onCrowded);
  });

  it("higher multiplier raises EV on contested tiles", () => {
    const stakes = zeroStakes();
    for (let i = 0; i < TILES_COUNT; i++) stakes[i] = usdToBase(10);
    const alloc = allocOn([0], usdToBase(1));
    const evM1 = evOfAllocation(ctx({ predictedStakes: stakes }), alloc);
    const evM2 = evOfAllocation(ctx({ predictedStakes: stakes, multiplier: 2 }), alloc);
    expect(evM2).toBeGreaterThan(evM1);
  });

  it("raw and effective semantics coincide in v1 (documented assumption)", () => {
    const stakes = zeroStakes();
    stakes[3] = usdToBase(7);
    const alloc = allocOn([3, 4], usdToBase(2));
    expect(evOfAllocation(ctx({ predictedStakes: stakes, semantics: "raw" }), alloc)).toBe(
      evOfAllocation(ctx({ predictedStakes: stakes, semantics: "effective" }), alloc),
    );
  });

  it("property: EV is finite and ≤ pot' for random inputs", () => {
    const rng = seededRng(42);
    for (let iter = 0; iter < 500; iter++) {
      const stakes = zeroStakes().map(() =>
        rng() < 0.3 ? 0n : usdToBase(Math.floor(rng() * 500)),
      );
      const alloc = zeroStakes().map(() =>
        rng() < 0.5 ? 0n : usdToBase(1 + Math.floor(rng() * 20)),
      );
      if (alloc.reduce((x, y) => x + y, 0n) === 0n) alloc[0] = usdToBase(1);
      const c = ctx({
        predictedStakes: stakes,
        multiplier: 1 + rng() * 4,
        semantics: rng() < 0.5 ? "raw" : "effective",
      });
      const ev = evOfAllocation(c, alloc);
      const pot = potAfterFees(c, alloc);
      expect(Number.isFinite(ev)).toBe(true);
      expect(ev).toBeLessThanOrEqual(pot + 1e-6);
    }
  });
});

describe("evOfMask", () => {
  it("even split matches the equivalent explicit allocation", () => {
    const stakes = zeroStakes();
    stakes[5] = usdToBase(20);
    const c = ctx({ predictedStakes: stakes });
    const mask = 0b111; // tiles 0,1,2
    const viaMask = evOfMask(c, mask, usdToBase(3), "even");
    const explicit = evOfAllocation(c, allocOn([0, 1, 2], usdToBase(1)));
    expect(viaMask).toBeCloseTo(explicit, 6);
  });

  it("per_tile semantics costs n× more than even split", () => {
    const stakes = zeroStakes();
    for (let i = 0; i < TILES_COUNT; i++) stakes[i] = usdToBase(50);
    const c = ctx({ predictedStakes: stakes });
    const mask = 0b1111; // 4 tiles
    const amount = usdToBase(4);
    const even = evOfMask(c, mask, amount, "even");
    const perTile = evOfMask(c, mask, amount, "per_tile");
    // per_tile deploys 4× the capital; on a crowded board both lose, per_tile more.
    expect(perTile).toBeLessThan(even);
  });
});

describe("marginalEv", () => {
  it("equals the EV difference of the bumped allocation", () => {
    const stakes = zeroStakes();
    stakes[8] = usdToBase(30);
    const c = ctx({ predictedStakes: stakes });
    const base = allocOn([8], usdToBase(1));
    const gain = marginalEv(c, base, 9, usdToBase(1));
    const bumped = [...base];
    bumped[9] = usdToBase(1);
    expect(gain).toBeCloseTo(evOfAllocation(c, bumped) - evOfAllocation(c, base), 9);
  });

  it("rejects bad inputs", () => {
    expect(() => marginalEv(ctx(), zeroStakes(), 21, 1n)).toThrow(RangeError);
    expect(() => marginalEv(ctx(), zeroStakes(), 0, 0n)).toThrow(RangeError);
    expect(() => evOfAllocation(ctx(), zeroStakes().slice(1))).toThrow(RangeError);
    expect(() => evOfAllocation(ctx({ multiplier: 0 }), zeroStakes())).toThrow(
      RangeError,
    );
  });
});

describe("outcomeReturns", () => {
  it("is all-zero when nothing is staked", () => {
    expect(outcomeReturns(ctx(), zeroStakes())).toEqual(
      new Array<number>(TILES_COUNT).fill(0),
    );
  });

  it("a lone empty-tile snipe wins ~the whole pot, loses the stake elsewhere", () => {
    // 20 tiles at $10, tile 0 empty; I put $1 on tile 0 only.
    const stakes = zeroStakes();
    for (let i = 1; i < TILES_COUNT; i++) stakes[i] = usdToBase(10);
    const r = outcomeReturns(ctx({ predictedStakes: stakes }), allocOn([0], usdToBase(1)));
    // Tile 0 wins → I own it outright → payout ≈ full pot ≫ my $1 stake.
    expect(r[0]).toBeGreaterThan(100);
    // Any other tile wins → I lose my whole stake → return −1.
    for (let i = 1; i < TILES_COUNT; i++) expect(r[i]).toBeCloseTo(-1, 9);
  });

  it("the probability-weighted mean return equals EV/cost", () => {
    const stakes = zeroStakes();
    for (let i = 2; i < TILES_COUNT; i++) stakes[i] = usdToBase(8);
    const c = ctx({ predictedStakes: stakes });
    const alloc = allocOn([0, 1], usdToBase(1));
    const r = outcomeReturns(c, alloc);
    const meanReturn = r.reduce((a, b) => a + b, 0) / TILES_COUNT;
    const cost = Number(usdToBase(2));
    expect(meanReturn).toBeCloseTo(evOfAllocation(c, alloc) / cost, 6);
  });

  it("the hashrate rebate softens loss outcomes and lifts EV", () => {
    const stakes = zeroStakes();
    for (let i = 1; i < TILES_COUNT; i++) stakes[i] = usdToBase(10);
    const alloc = allocOn([0], usdToBase(1));
    const noRebate = ctx({ predictedStakes: stakes });
    const withRebate = ctx({ predictedStakes: stakes, hashrateRebateFraction: 0.2 });

    // Losing outcomes: −1 without the rebate, −(1 − 0.2) = −0.8 with it.
    const rLoss = outcomeReturns(withRebate, alloc)[5]!;
    expect(outcomeReturns(noRebate, alloc)[5]).toBeCloseTo(-1, 9);
    expect(rLoss).toBeCloseTo(-0.8, 9);

    // EV rises by exactly rebate × cost.
    const cost = Number(usdToBase(1));
    expect(evOfAllocation(withRebate, alloc)).toBeCloseTo(
      evOfAllocation(noRebate, alloc) + 0.2 * cost,
      6,
    );
  });

  it("credits hashrate per the program formula, favouring concentration", () => {
    // Same $21 gross, spread 21 ways vs concentrated on 1 tile. The pot term is
    // held equal by using an empty board, so the only difference is hashrate:
    // 1 tile earns m+21 raw/$, 21 tiles earn m+1 — an 11x gap at m=1.
    const hashrate = { streak: 1, valueUsdPerRawUnit: 0.01, multiplier: 1 };
    const c = ctx({ hashrate });
    const one = zeroStakes();
    one[0] = usdToBase(21);
    const spread = zeroStakes().map(() => usdToBase(1));

    const cost = Number(usdToBase(21));
    // rebate(1 tile) = 22 x 0.01 = 22% of gross; rebate(21 tiles) = 2%.
    const evOne = evOfAllocation(c, one);
    const evSpread = evOfAllocation(c, spread);
    const noHr = ctx();
    expect(evOne - evOfAllocation(noHr, one)).toBeCloseTo(0.22 * cost, 3);
    expect(evSpread - evOfAllocation(noHr, spread)).toBeCloseTo(0.02 * cost, 3);
    // and the concentrated allocation is the one the credit favours
    expect(evOne - evOfAllocation(noHr, one)).toBeGreaterThan(
      evSpread - evOfAllocation(noHr, spread),
    );
  });

  it("the post-Strike window doubles the hashrate credit", () => {
    const alloc = allocOn([0], usdToBase(10));
    const normal = ctx({ hashrate: { streak: 1, valueUsdPerRawUnit: 0.01, multiplier: 1 } });
    const bonus = ctx({ hashrate: { streak: 1, valueUsdPerRawUnit: 0.01, multiplier: 2 } });
    const plain = ctx();
    const creditNormal = evOfAllocation(normal, alloc) - evOfAllocation(plain, alloc);
    const creditBonus = evOfAllocation(bonus, alloc) - evOfAllocation(plain, alloc);
    expect(creditBonus).toBeCloseTo(2 * creditNormal, 6);
  });

  it("the hashrate credit softens every loss outcome, not just the mean", () => {
    const stakes = zeroStakes();
    for (let i = 1; i < TILES_COUNT; i++) stakes[i] = usdToBase(10);
    const alloc = allocOn([0], usdToBase(1));
    const c = ctx({
      predictedStakes: stakes,
      hashrate: { streak: 1, valueUsdPerRawUnit: 0.01, multiplier: 1 },
    });
    // 1 tile at m=1 → 22 raw/$ → 22% credit, so a loss returns −0.78 not −1.
    expect(outcomeReturns(c, alloc)[5]).toBeCloseTo(-0.78, 6);
  });

  it("is inert while hashrate is unpriced", () => {
    const alloc = allocOn([0], usdToBase(5));
    const priced = ctx({ hashrate: { streak: 50, valueUsdPerRawUnit: 0, multiplier: 2 } });
    expect(evOfAllocation(priced, alloc)).toBeCloseTo(evOfAllocation(ctx(), alloc), 9);
  });

  it("rejects a negative hashrate rebate", () => {
    expect(() =>
      evOfAllocation(ctx({ hashrateRebateFraction: -0.1 }), allocOn([0], usdToBase(1))),
    ).toThrow(RangeError);
  });

  it("credits the expected strike jackpot into the payout, scaled by share", () => {
    // Lone snipe on empty tile 0 (share ≈ 1) amid a $10 field.
    const stakes = zeroStakes();
    for (let i = 1; i < TILES_COUNT; i++) stakes[i] = usdToBase(10);
    const alloc = allocOn([0], usdToBase(1));
    const strikePot = Number(usdToBase(2)); // P(strike)·jackpot, e.g. $2,880/1440
    const withStrike = ctx({ predictedStakes: stakes, strikeExpectedPot: strikePot });
    const noStrike = ctx({ predictedStakes: stakes });

    // EV rises by P_WIN · strikePot · share_0 (≈ (1/21)·strikePot since share≈1).
    const lift = evOfAllocation(withStrike, alloc) - evOfAllocation(noStrike, alloc);
    expect(lift).toBeGreaterThan(0);
    expect(lift).toBeCloseTo((strikePot * 1) / TILES_COUNT, 0);
  });

  it("rejects a negative strikeExpectedPot", () => {
    expect(() =>
      evOfAllocation(ctx({ strikeExpectedPot: -1 }), allocOn([0], usdToBase(1))),
    ).toThrow(RangeError);
  });
});
