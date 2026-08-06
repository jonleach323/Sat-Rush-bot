import { describe, expect, it } from "vitest";
import { kellyFraction } from "../src/strategy/kelly.js";

/** Reference: expected log-growth Σ (1/n) log(1 + f·r). */
function growth(returns: number[], f: number): number {
  let g = 0;
  for (const r of returns) g += Math.log(1 + f * r) / returns.length;
  return g;
}

describe("kellyFraction", () => {
  it("returns 0 for a non-positive-edge bet", () => {
    // Classic coin flip paying even money: +1 / −1 → zero edge → don't bet.
    expect(kellyFraction([1, -1])).toBe(0);
    // Negative edge.
    expect(kellyFraction([0.5, -1])).toBe(0);
  });

  it("matches the closed-form Kelly for a simple win/lose bet", () => {
    // Win prob p with net odds b: here modeled as outcomes, half win +b, half
    // lose −1. Full Kelly f* = (p·b − q)/b. With equal weights p=q=0.5, b=3:
    // f* = (0.5·3 − 0.5)/3 = 1/3.
    const f = kellyFraction([3, 3, -1, -1]);
    expect(f).toBeCloseTo(1 / 3, 3);
  });

  it("sizes bigger for a fatter edge", () => {
    const lean = kellyFraction([1.5, 1.5, -1, -1]); // b=1.5
    const rich = kellyFraction([5, 5, -1, -1]); // b=5
    expect(rich).toBeGreaterThan(lean);
  });

  it("actually maximizes log-growth (numeric check)", () => {
    const returns = [9, -1, -1, -1, -1]; // one 10× outcome in five
    const f = kellyFraction(returns);
    const gStar = growth(returns, f);
    for (const df of [-0.05, -0.01, 0.01, 0.05]) {
      const alt = f + df;
      if (alt > 0 && alt < 1) expect(gStar).toBeGreaterThanOrEqual(growth(returns, alt) - 1e-9);
    }
  });

  it("stays feasible — never bets enough to be wiped by a full-stake loss", () => {
    // A monster edge; f* is bounded below 1 because r = −1 outcomes exist.
    const f = kellyFraction([100, 100, 100, -1]);
    expect(f).toBeGreaterThan(0);
    expect(f).toBeLessThan(1);
    // 1 + f·(−1) must stay positive (bankroll survives the loss outcome).
    expect(1 - f).toBeGreaterThan(0);
  });

  it("handles the empty array", () => {
    expect(kellyFraction([])).toBe(0);
  });
});
