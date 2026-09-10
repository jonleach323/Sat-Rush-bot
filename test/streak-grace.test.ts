import { describe, expect, it } from "vitest";
import {
  STREAK_GRACE_ROUNDS as SDK_STREAK_GRACE_ROUNDS,
  nextStreakMultiplier as sdkNextStreakMultiplier,
} from "@satrush/client";
import {
  STREAK_GRACE_ROUNDS,
  nextStreakMultiplier,
  skipBreaksStreak,
  streakOptionValueUsd,
} from "../src/strategy/streak.js";

describe("streak grace (V2)", () => {
  it("the grace window is the SDK's", () => {
    expect(STREAK_GRACE_ROUNDS).toBe(SDK_STREAK_GRACE_ROUNDS);
    expect(STREAK_GRACE_ROUNDS).toBe(2);
  });

  it("nextStreakMultiplier agrees with the SDK across streaks, gaps and the cap", () => {
    for (const streak of [0, 1, 5, 28, 99, 100, 150]) {
      for (const gap of [0, 1, 2, 3, 4, 5, 40]) {
        const last = 1000;
        expect(nextStreakMultiplier(streak, last, last + gap), `streak ${streak} gap ${gap}`)
          .toBe(sdkNextStreakMultiplier(streak, last, last + gap));
      }
    }
    // A miner's first ever play: zeroed state, gap = round id.
    expect(nextStreakMultiplier(0, 0, 12345)).toBe(sdkNextStreakMultiplier(0, 0, 12345));
  });

  it("two skips are free, the third breaks it — and V1's rule is grace 0", () => {
    const last = 100;
    expect(skipBreaksStreak(101, last)).toBe(false); // next play at 102, gap 2
    expect(skipBreaksStreak(102, last)).toBe(false); // next play at 103, gap 3
    expect(skipBreaksStreak(103, last)).toBe(true); // next play at 104, gap 4
    expect(skipBreaksStreak(101, last, 0)).toBe(true);
    // The same boundary through the multiplier itself.
    expect(nextStreakMultiplier(10, last, 103)).toBe(11);
    expect(nextStreakMultiplier(10, last, 104)).toBe(1);
  });

  it("the presence credit is zero while the grace still absorbs a skip", () => {
    const base = {
      streak: 100, deployPerRoundUsd: 10, valueUsdPerRawUnit: 0.001, liquidFraction: 0.65, discount: 1,
    };
    const full = streakOptionValueUsd(base);
    expect(full).toBeGreaterThan(0);
    expect(streakOptionValueUsd({ ...base, roundId: 101, lastMinedRoundId: 100, graceRounds: 2 })).toBe(0);
    expect(streakOptionValueUsd({ ...base, roundId: 102, lastMinedRoundId: 100, graceRounds: 2 })).toBe(0);
    expect(streakOptionValueUsd({ ...base, roundId: 103, lastMinedRoundId: 100, graceRounds: 2 })).toBe(full);
    // V1 semantics: every skip is a break.
    expect(streakOptionValueUsd({ ...base, roundId: 101, lastMinedRoundId: 100, graceRounds: 0 })).toBe(full);
    // Without the ids nothing changes from before.
    expect(streakOptionValueUsd({ ...base, graceRounds: 2 })).toBe(full);
  });
});
