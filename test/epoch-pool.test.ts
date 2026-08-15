import { describe, expect, it } from "vitest";
import {
  bracketEpochTake,
  projectEpochPool,
  projectField,
} from "../src/strategy/epoch-pool.js";

const base = {
  grossPerRound: 631,
  roundsPerIteration: 4320,
  epochFeeBps: 232,
  bankedUsd: 5000,
  progress: 0.1,
};

describe("projectEpochPool", () => {
  it("derives inflow from live volume, not a constant", () => {
    // 631 x 4320 x 0.0232
    expect(projectEpochPool(base).inflowPerIteration).toBeCloseTo(63_241.3, 1);
  });

  it("tracks the volume collapse that broke the hardcoded pool", () => {
    const before = projectEpochPool(base).inflowPerIteration;
    const after = projectEpochPool({ ...base, grossPerRound: 135 }).inflowPerIteration;
    expect(after / before).toBeCloseTo(135 / 631, 3);
    expect(after).toBeLessThan(15_000);
  });

  it("adds only the inflow still to come", () => {
    const p = projectEpochPool({ ...base, progress: 0.25 });
    expect(p.projectedPool).toBeCloseTo(5000 + 0.75 * p.inflowPerIteration, 4);
  });

  it("is just the banked amount once the iteration is over", () => {
    expect(projectEpochPool({ ...base, progress: 1 }).projectedPool).toBe(5000);
  });

  it("backs out the carry, and never reports a negative one", () => {
    const rich = projectEpochPool({ ...base, bankedUsd: 20_000, progress: 0.1 });
    expect(rich.impliedCarry).toBeGreaterThan(0);
    const thin = projectEpochPool({ ...base, bankedUsd: 100, progress: 0.9 });
    expect(thin.impliedCarry).toBe(0);
  });

  it("reports confidence as elapsed fraction, and clamps it", () => {
    expect(projectEpochPool({ ...base, progress: 0.07 }).confidence).toBeCloseTo(0.07, 6);
    expect(projectEpochPool({ ...base, progress: 5 }).confidence).toBe(1);
    expect(projectEpochPool({ ...base, progress: -1 }).confidence).toBe(0);
  });
});

describe("projectField", () => {
  const f = { lastCloseTickets: 806_582, volumeRatio: 0.21, bankedShare: 0.3 };

  it("brackets: banked hashrate stops the field tracking volume down", () => {
    const { low, high } = projectField(f);
    expect(low).toBeCloseTo(806_582 * 0.21, 0);
    expect(high).toBeGreaterThan(low);
    // 0.3 + 0.7 x 0.21
    expect(high).toBeCloseTo(806_582 * 0.447, 0);
  });

  it("collapses to one number when nothing is banked", () => {
    const { low, high } = projectField({ ...f, bankedShare: 0 });
    expect(low).toBeCloseTo(high, 6);
  });

  it("is volume-insensitive when everything is banked", () => {
    const { low, high } = projectField({ ...f, bankedShare: 1 });
    expect(high).toBeCloseTo(806_582, 0);
    expect(low).toBeLessThan(high);
  });
});

describe("bracketEpochTake", () => {
  it("pairs the BIGGER field with the LOWER take", () => {
    const r = bracketEpochTake(6307, { low: 170_000, high: 360_000 }, 12_000);
    expect(r.low).toBeLessThan(r.high);
    // low bound must correspond to the high field
    expect(r.low).toBeCloseTo((6307 / (6307 + 360_000)) * 12_000 * 0.9, 4);
  });

  it("reports the share so the caller can tell when linear stops holding", () => {
    const small = bracketEpochTake(6307, { low: 800_000, high: 800_000 }, 12_000);
    expect(small.shareAtHigh).toBeLessThan(0.01);
    const big = bracketEpochTake(200_000, { low: 800_000, high: 800_000 }, 12_000);
    expect(big.shareAtHigh).toBeGreaterThan(0.05);
  });

  it("is zero with no tickets and safe with no field", () => {
    expect(bracketEpochTake(0, { low: 1000, high: 1000 }, 12_000).high).toBe(0);
    expect(bracketEpochTake(100, { low: 0, high: 0 }, 12_000).high).toBeCloseTo(10_800, 4);
  });
});

describe("the collapse this module exists for", () => {
  it("shows the take surviving better than the pool, but not fully", () => {
    const poolBefore = 46_553;
    const poolAfter = projectEpochPool({
      ...base, grossPerRound: 135, bankedUsd: 2000, progress: 0.15,
    }).projectedPool;
    expect(poolAfter).toBeLessThan(poolBefore / 3);

    const before = bracketEpochTake(6307, { low: 806_582, high: 806_582 }, poolBefore);
    const after = bracketEpochTake(
      6307,
      projectField({ lastCloseTickets: 806_582, volumeRatio: 0.21, bankedShare: 0.3 }),
      poolAfter,
    );
    // The field shrinks too, so the take falls by far less than the pool does.
    expect(after.high).toBeGreaterThan(before.high * 0.5);
    // But banked hashrate keeps a floor under the field, so it still falls.
    expect(after.low).toBeLessThan(before.high);
  });
});
