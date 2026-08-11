import { describe, expect, it } from "vitest";
import {
  hashrateRawPerUsd,
  hashrateRebateFraction,
  REWARD_MAX_STREAK,
  strikeBonusMultiplier,
} from "../src/strategy/hashrate.js";

describe("hashrateRawPerUsd — the program formula m + N/n", () => {
  it("matches the owner's worked example", () => {
    // "$2 deployed, streak 15, 3 of 21 tiles → 2·(15 + 21/3) = 44 raw"
    expect(2 * hashrateRawPerUsd(15, 3)).toBeCloseTo(44, 9);
  });

  it("pays $1 at base multiplier, full coverage, exactly 2 raw", () => {
    // Docs: "$1 at base multiplier (m=1, full coverage) earns raw 2 = 0.02 points"
    expect(hashrateRawPerUsd(1, 21)).toBeCloseTo(2, 9);
  });

  it("rewards concentration 11x at base streak", () => {
    expect(hashrateRawPerUsd(1, 1)).toBeCloseTo(22, 9); // single tile
    expect(hashrateRawPerUsd(1, 21)).toBeCloseTo(2, 9); // whole board
  });

  it("caps the streak at REWARD_MAX_STREAK", () => {
    expect(hashrateRawPerUsd(100, 1)).toBe(hashrateRawPerUsd(5000, 1));
    expect(hashrateRawPerUsd(REWARD_MAX_STREAK, 21)).toBeCloseTo(101, 9);
  });

  it("is monotonically decreasing in coverage and increasing in streak", () => {
    for (let n = 1; n < 21; n++) {
      expect(hashrateRawPerUsd(3, n)).toBeGreaterThan(hashrateRawPerUsd(3, n + 1));
    }
    expect(hashrateRawPerUsd(50, 5)).toBeGreaterThan(hashrateRawPerUsd(1, 5));
  });

  it("rejects impossible inputs", () => {
    expect(() => hashrateRawPerUsd(1, 0)).toThrow(RangeError);
    expect(() => hashrateRawPerUsd(1, 22)).toThrow(RangeError);
    expect(() => hashrateRawPerUsd(-1, 1)).toThrow(RangeError);
  });
});

describe("hashrateRebateFraction", () => {
  const v = { streak: 1, valueUsdPerRawUnit: 0.01, multiplier: 1 };

  it("is zero when hashrate is unpriced (the safe default)", () => {
    expect(hashrateRebateFraction({ ...v, valueUsdPerRawUnit: 0 }, 5)).toBe(0);
  });

  it("is (m + 21/n) x multiplier x value-per-raw", () => {
    // 1 tile, m=1 → 22 raw/$ → 22 x 0.01 = 22% of gross
    expect(hashrateRebateFraction(v, 1)).toBeCloseTo(0.22, 9);
    // 21 tiles → 2 raw/$ → 2%
    expect(hashrateRebateFraction(v, 21)).toBeCloseTo(0.02, 9);
  });

  it("doubles inside the post-Strike bonus window", () => {
    expect(hashrateRebateFraction({ ...v, multiplier: 2 }, 1)).toBeCloseTo(0.44, 9);
  });

  it("rejects a negative value or non-positive multiplier", () => {
    expect(() => hashrateRebateFraction({ ...v, valueUsdPerRawUnit: -1 }, 1)).toThrow(RangeError);
    expect(() => hashrateRebateFraction({ ...v, multiplier: 0 }, 1)).toThrow(RangeError);
  });
});

describe("strikeBonusMultiplier", () => {
  const W = 4 * 60 * 60_000; // 4h
  const base = { windowMs: W, multiplier: 2 };

  it("is 1 before any Strike is seen", () => {
    expect(strikeBonusMultiplier({ ...base, lastStrikeAtMs: null, nowMs: 1_000 })).toBe(1);
  });

  it("is 2x inside the window and 1 after it lapses", () => {
    expect(strikeBonusMultiplier({ ...base, lastStrikeAtMs: 0, nowMs: 0 })).toBe(2);
    expect(strikeBonusMultiplier({ ...base, lastStrikeAtMs: 0, nowMs: W - 1 })).toBe(2);
    expect(strikeBonusMultiplier({ ...base, lastStrikeAtMs: 0, nowMs: W })).toBe(1);
  });

  it("a later Strike resets the timer (we track only the most recent)", () => {
    // First strike at 0 would have lapsed by 5h; a strike at 4.5h keeps us hot.
    const fiveHours = 5 * 60 * 60_000;
    expect(strikeBonusMultiplier({ ...base, lastStrikeAtMs: 0, nowMs: fiveHours })).toBe(1);
    expect(
      strikeBonusMultiplier({ ...base, lastStrikeAtMs: 4.5 * 60 * 60_000, nowMs: fiveHours }),
    ).toBe(2);
  });

  it("is 1 when the feature is disabled", () => {
    expect(
      strikeBonusMultiplier({ lastStrikeAtMs: 0, nowMs: 0, windowMs: 0, multiplier: 2 }),
    ).toBe(1);
  });
});
