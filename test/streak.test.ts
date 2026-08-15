import { describe, expect, it } from "vitest";
import { streakBreakRawLoss, streakOptionValueUsd } from "../src/strategy/streak.js";
import { evOfAllocation, outcomeReturns, marginalEv, TILES_COUNT, type EvContext } from "../src/strategy/ev.js";

const fees = { deployFeeBps: 800, satsVaultRoundBps: 1200, satsVaultClaimBps: 1000 };
const ctx = (over: Partial<EvContext> = {}): EvContext => ({
  predictedStakes: new Array<bigint>(TILES_COUNT).fill(1_000_000_000n),
  fees,
  multiplier: 1,
  semantics: "raw",
  ...over,
});
const alloc = (tile: number, amount: bigint): bigint[] => {
  const a = new Array<bigint>(TILES_COUNT).fill(0n);
  a[tile] = amount;
  return a;
};

describe("streakBreakRawLoss", () => {
  it("is zero for a streak that has nothing to lose", () => {
    expect(streakBreakRawLoss(0)).toBe(0);
    expect(streakBreakRawLoss(1)).toBe(0);
  });

  it("matches the closed form at the cap: Σ(cap−j) = cap(cap−1)/2", () => {
    expect(streakBreakRawLoss(100)).toBe((100 * 99) / 2);
  });

  it("matches the hand-computed value for the observed 28 → 1 reset", () => {
    // 72 rounds at the full 28-unit gap, then the gap closes as the broken path
    // saturates: 72·28 + Σ_{k=1..27} k = 2016 + 378.
    expect(streakBreakRawLoss(28)).toBe(2016 + 378);
  });

  it("is monotonic in streak and saturates at the cap", () => {
    expect(streakBreakRawLoss(5)).toBeLessThan(streakBreakRawLoss(50));
    expect(streakBreakRawLoss(150)).toBe(streakBreakRawLoss(100));
  });
});

describe("streakOptionValueUsd", () => {
  const base = {
    streak: 100,
    deployPerRoundUsd: 10,
    valueUsdPerRawUnit: 0.001,
    liquidFraction: 0.65,
    discount: 1,
  };

  it("dwarfs a round's board toll — the point of the whole term", () => {
    // 4,950 raw × $10 × 0.65 × $0.001 = $32.18, against a 6.36% toll on $10.
    expect(streakOptionValueUsd(base)).toBeCloseTo(32.175, 3);
    expect(streakOptionValueUsd(base)).toBeGreaterThan(50 * 0.0636 * 10);
  });

  it("is inert when hashrate has no priced sink", () => {
    expect(streakOptionValueUsd({ ...base, valueUsdPerRawUnit: 0 })).toBe(0);
  });

  it("is inert with nothing staked or nothing to protect", () => {
    expect(streakOptionValueUsd({ ...base, deployPerRoundUsd: 0 })).toBe(0);
    expect(streakOptionValueUsd({ ...base, streak: 1 })).toBe(0);
  });

  it("scales linearly with the discount", () => {
    expect(streakOptionValueUsd({ ...base, discount: 0.5 })).toBeCloseTo(
      streakOptionValueUsd(base) / 2,
      6,
    );
  });
});

describe("presenceCreditBase in the EV model", () => {
  it("is awarded once for deploying, and not at all for staking nothing", () => {
    const c = ctx({ presenceCreditBase: 5_000_000 });
    expect(evOfAllocation(c, new Array<bigint>(TILES_COUNT).fill(0n))).toBe(0);
    const withCredit = evOfAllocation(c, alloc(0, 1_000_000n));
    const without = evOfAllocation(ctx(), alloc(0, 1_000_000n));
    expect(withCredit - without).toBeCloseTo(5_000_000, 6);
  });

  it("does not scale with size — it is presence, not volume", () => {
    const c = ctx({ presenceCreditBase: 5_000_000 });
    const small = evOfAllocation(c, alloc(0, 1_000_000n)) - evOfAllocation(ctx(), alloc(0, 1_000_000n));
    const large = evOfAllocation(c, alloc(0, 90_000_000n)) - evOfAllocation(ctx(), alloc(0, 90_000_000n));
    expect(large).toBeCloseTo(small, 6);
  });

  it("moves only the 0 → first-quantum step, so water-filling still stops correctly", () => {
    const c = ctx({ presenceCreditBase: 5_000_000 });
    const empty = new Array<bigint>(TILES_COUNT).fill(0n);
    // First quantum: the credit lands here.
    expect(marginalEv(c, empty, 0, 1_000_000n)).toBeGreaterThan(
      marginalEv(ctx(), empty, 0, 1_000_000n) + 4_000_000,
    );
    // Any later quantum: the constant cancels in the difference.
    const started = alloc(0, 1_000_000n);
    expect(marginalEv(c, started, 1, 1_000_000n)).toBeCloseTo(
      marginalEv(ctx(), started, 1, 1_000_000n),
      6,
    );
  });

  it("lifts every outcome, including losses", () => {
    const c = ctx({ presenceCreditBase: 500_000 });
    const a = alloc(0, 1_000_000n);
    const lifted = outcomeReturns(c, a);
    const plain = outcomeReturns(ctx(), a);
    for (let i = 0; i < TILES_COUNT; i++) {
      expect((lifted[i] as number) - (plain[i] as number)).toBeCloseTo(0.5, 6);
    }
  });

  it("rejects a negative credit", () => {
    expect(() => evOfAllocation(ctx({ presenceCreditBase: -1 }), alloc(0, 1_000_000n))).toThrow(
      RangeError,
    );
  });
});
