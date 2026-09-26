import { describe, expect, it } from "vitest";
import { AlertThrottle, Digest } from "../src/ops/digest.js";

describe("Digest — routine events are summarised, not pushed", () => {
  it("tallies notes by kind with their USD, and fleet legs with the most-missed wallets, then resets", () => {
    let t = 0;
    const d = new Digest(() => t);
    for (let i = 0; i < 40; i++) d.note("compound_claim", `claim ${i}`, 50.73);
    d.note("vault_buy", "bought 12 epoch tickets");
    d.fleetRound(21, 18, ["FrYYxk", "72DGo8", "Cbt2CJ"]);
    d.fleetRound(21, 20, ["72DGo8"]);
    d.fleetRound(21, 21, []);
    t = 6 * 3_600_000;
    const text = d.flush()!;
    expect(text).toContain("last 6.0 h");
    expect(text).toContain("fleet: 3 rounds · 59/63 legs landed (93.7%)");
    expect(text).toMatch(/most missed: 72DGo8×2/);
    expect(text).toContain("USD compound claims: 40 · $2029.20");
    expect(text).toContain("vault ticket buys: 1");
    expect(d.flush()).toBeNull(); // reset
  });

  it("reports the landed fraction over a rolling window for escalation", () => {
    const d = new Digest();
    let frac = 1;
    for (let i = 0; i < 10; i++) frac = d.fleetRound(21, 21, []);
    expect(frac).toBe(1);
    for (let i = 0; i < 5; i++) frac = d.fleetRound(21, 10, []);
    expect(frac).toBeCloseTo((5 + 5 * (10 / 21)) / 10, 9);
    expect(d.recentFleetRounds()).toBe(10);
  });
});

describe("AlertThrottle — one push per incident per window", () => {
  it("allows the first, blocks repeats inside the window, allows again after it", () => {
    let t = 0;
    const th = new AlertThrottle(() => t);
    expect(th.allow("missed_round", 3_600_000)).toBe(true);
    t = 60_000;
    expect(th.allow("missed_round", 3_600_000)).toBe(false);
    expect(th.allow("deploy_failed", 3_600_000)).toBe(true); // independent keys
    t = 3_600_001;
    expect(th.allow("missed_round", 3_600_000)).toBe(true);
  });
});
