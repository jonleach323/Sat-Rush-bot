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

  it("REGRESSION: widens when misses appear, instead of ignoring them", () => {
    // The survivorship bug: calibrating on landed deploys only, a consistently
    // 1-slot-landing bot sits at the floor forever even while missing 30% of
    // rounds — the evidence it is too aggressive is exactly what was discarded.
    const landed = new Array<number>(35).fill(1);
    const blind = adaptiveFireOffset(landed, opts); // no miss information
    const withMisses = adaptiveFireOffset(landed, { ...opts, missCount: 15 }); // 30%
    expect(blind).toBe(opts.floor);
    expect(withMisses).toBeGreaterThan(blind);
  });

  it("ignores a miss rate inside the allowed failure budget", () => {
    // targetLandProb 0.95 tolerates 5% misses: the target quantile is still
    // observable, so the offset should not move.
    const landed = new Array<number>(96).fill(1);
    const clean = adaptiveFireOffset(landed, opts);
    const tolerated = adaptiveFireOffset(landed, { ...opts, missCount: 4 });
    expect(tolerated).toBe(clean);
  });

  it("escalates monotonically with the miss rate, up to the ceiling", () => {
    const landed = new Array<number>(50).fill(2);
    const a = adaptiveFireOffset(landed, { ...opts, missCount: 5 });
    const b = adaptiveFireOffset(landed, { ...opts, missCount: 20 });
    const c = adaptiveFireOffset(landed, { ...opts, missCount: 200 });
    expect(b).toBeGreaterThanOrEqual(a);
    expect(c).toBeGreaterThanOrEqual(b);
    expect(c).toBe(opts.ceiling); // a hopeless miss rate pins it wide
  });

  it("counts misses toward minSamples so an all-miss start still calibrates", () => {
    // 0 landed, 25 missed: we have plenty of evidence, all of it censored.
    expect(adaptiveFireOffset([], { ...opts, missCount: 25 })).toBeGreaterThan(opts.fallback);
  });

  it("re-tunes lower as latency improves (the send-path upgrade payoff)", () => {
    const before = adaptiveFireOffset(new Array<number>(50).fill(2), opts); // 3
    const after = adaptiveFireOffset(new Array<number>(50).fill(1), opts); // 2
    expect(after).toBeLessThan(before);
  });
});
