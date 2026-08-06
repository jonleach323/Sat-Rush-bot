import { describe, expect, it } from "vitest";
import { scaledTipLamports } from "../src/exec/tip.js";
import { usdToBase } from "../src/units.js";

const cfg = { baseLamports: 10_000, maxLamports: 1_000_000, evFraction: 0.1, solUsd: 150 };

describe("scaledTipLamports", () => {
  it("returns the base tip when EV scaling is off", () => {
    expect(scaledTipLamports(Number(usdToBase(50)), { ...cfg, evFraction: 0 })).toBe(10_000);
  });

  it("returns the base tip for non-positive EV", () => {
    expect(scaledTipLamports(0, cfg)).toBe(10_000);
    expect(scaledTipLamports(Number(usdToBase(-5)), cfg)).toBe(10_000);
  });

  it("bids a fraction of EV on top of the base", () => {
    // EV $5, 10% → $0.50 of SOL at $150 = 0.5/150 SOL = 3,333,333 lamports,
    // but clamped to the 1,000,000 ceiling.
    expect(scaledTipLamports(Number(usdToBase(5)), cfg)).toBe(1_000_000);
    // EV $0.15, 10% → $0.015 = 100,000 lamports + 10,000 base = 110,000.
    expect(scaledTipLamports(Number(usdToBase(0.15)), cfg)).toBe(110_000);
  });

  it("scales monotonically with EV up to the ceiling", () => {
    const small = scaledTipLamports(Number(usdToBase(0.05)), cfg);
    const big = scaledTipLamports(Number(usdToBase(0.1)), cfg);
    expect(big).toBeGreaterThan(small);
  });

  it("never exceeds the ceiling or drops below the base", () => {
    expect(scaledTipLamports(Number(usdToBase(1000)), cfg)).toBe(cfg.maxLamports);
    expect(scaledTipLamports(1, cfg)).toBeGreaterThanOrEqual(cfg.baseLamports);
  });
});
