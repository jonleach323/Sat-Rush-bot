import { describe, expect, it } from "vitest";
import { adaptiveFireOffset, quantile } from "../src/strategy/fire-offset.js";

const opts = {
  targetLandProb: 0.95,
  cushionSlots: 1,
  floor: 2,
  ceiling: 6,
  fallback: 4,
  minSamples: 20,
};

describe("quantile (nearest-rank)", () => {
  it("returns 0 for an empty sample", () => {
    expect(quantile([], 0.95)).toBe(0);
  });

  it("picks the target-rank value", () => {
    const v = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
    expect(quantile(v, 0.95)).toBe(19); // ceil(0.95·20)=19th value
    expect(quantile(v, 0.5)).toBe(10);
    expect(quantile(v, 1)).toBe(20);
  });

  it("does not mutate the input", () => {
    const v = [3, 1, 2];
    quantile(v, 0.5);
    expect(v).toEqual([3, 1, 2]);
  });
});

describe("adaptiveFireOffset", () => {
  it("falls back to the static offset below minSamples", () => {
    expect(adaptiveFireOffset([1, 1, 1], opts)).toBe(4); // fallback, clamped
  });

  it("fires late (near the floor) when the send path is fast", () => {
    // Consistently 1-slot land latency over enough samples → p95 = 1, +1 cushion
    // = 2 = the floor. Much later than the static 4.
    const fast = new Array<number>(50).fill(1);
    expect(adaptiveFireOffset(fast, opts)).toBe(2);
  });

  it("backs off when latency is worse", () => {
    // Mostly 2-slot, a few 3s → p95 ≈ 3, +1 = 4.
    const mixed = [...new Array<number>(45).fill(2), ...new Array<number>(5).fill(3)];
    expect(adaptiveFireOffset(mixed, opts)).toBe(4);
  });

  it("never exceeds the ceiling even with a long latency tail", () => {
    const slow = new Array<number>(50).fill(9);
    expect(adaptiveFireOffset(slow, opts)).toBe(opts.ceiling);
  });

  it("never drops below the floor even with instant lands", () => {
    const instant = new Array<number>(50).fill(0);
    expect(adaptiveFireOffset(instant, opts)).toBe(opts.floor); // 0+1 → clamped up to 2
  });

  it("re-tunes lower as latency improves (the send-path upgrade payoff)", () => {
    const before = adaptiveFireOffset(new Array<number>(50).fill(2), opts); // 3
    const after = adaptiveFireOffset(new Array<number>(50).fill(1), opts); // 2
    expect(after).toBeLessThan(before);
  });
});
