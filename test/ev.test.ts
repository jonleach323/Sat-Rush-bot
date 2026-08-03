import { describe, expect, it } from "vitest";
import {
  evOfAllocation,
  evOfMask,
  feeModelFromConfig,
  marginalEv,
  netFactor,
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
      sats_vault_claim_fee_bps: 1000,
    } as never);
    expect(fees.deployFeeBps).toBe(800);
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
