import { describe, expect, it } from "vitest";
import { dynamicFloatBase, planFleet, type FleetPlanParams, type FleetWalletBalance } from "../src/exec/fleet-plan.js";

const P: FleetPlanParams = {
  targetUsdcBase: 20_000_000n,
  lowUsdcBase: 8_000_000n,
  targetLamports: 20_000_000,
  lowLamports: 8_000_000,
  reserveUsdcBase: 0n,
  minTransferUsdcBase: 1_000_000n,
  minTransferLamports: 2_000_000,
};
const w = (pubkey: string, usd: number, sol: number, perRound = 1): FleetWalletBalance => ({
  pubkey,
  usdcBase: BigInt(Math.round(usd * 1e6)),
  lamports: Math.round(sol * 1e9),
  perRoundBase: BigInt(Math.round(perRound * 1e6)),
});

describe("fleet treasury planner", () => {
  it("tops up the lowest-runway wallet first, to target, from the primary's excess", () => {
    const plan = planFleet([w("P", 100, 1), w("A", 7, 0.02, 1), w("B", 2, 0.02, 1), w("C", 15, 0.02, 1)], P);
    const ups = plan.transfers.filter((t) => t.reason === "top_up" && t.asset === "usdc");
    expect(ups.map((t) => t.to)).toEqual(["B", "A"]); // B has 2 rounds of runway, A has 7; C is above LOW
    expect(ups.map((t) => t.amount)).toEqual([18_000_000n, 13_000_000n]);
    expect(plan.shortfallUsdcBase).toBe(0n);
    expect(plan.minRunwayRounds).toBe(2);
  });

  it("reports the shortfall when the primary cannot cover, and never touches the primary's own target", () => {
    const plan = planFleet([w("P", 25, 1), w("A", 0, 0.02), w("B", 0, 0.02)], P);
    // pool = 25 − 20 target = 5 → A gets 5, B gets nothing; shortfall = (20−5) + 20
    expect(plan.transfers.filter((t) => t.asset === "usdc")).toEqual([{ from: "P", to: "A", asset: "usdc", amount: 5_000_000n, reason: "top_up" }]);
    expect(plan.shortfallUsdcBase).toBe(35_000_000n);
  });

  it("sweeps a wallet above twice the target back to the primary and reuses it for top-ups", () => {
    const plan = planFleet([w("P", 20, 1), w("A", 60, 0.02), w("B", 1, 0.02)], P);
    const sweep = plan.transfers.find((t) => t.reason === "sweep" && t.asset === "usdc")!;
    expect(sweep).toEqual({ from: "A", to: "P", asset: "usdc", amount: 20_000_000n, reason: "sweep" });
    const up = plan.transfers.find((t) => t.reason === "top_up" && t.asset === "usdc")!;
    expect(up.to).toBe("B");
    expect(up.amount).toBe(19_000_000n);
    expect(plan.shortfallUsdcBase).toBe(0n);
  });

  it("handles SOL the same way and skips dust transfers", () => {
    const plan = planFleet([w("P", 20, 1), w("A", 20, 0.001), w("B", 19.5, 0.02)], P);
    const sol = plan.transfers.filter((t) => t.asset === "sol");
    expect(sol).toEqual([{ from: "P", to: "A", asset: "sol", amount: 19_000_000n, reason: "top_up" }]);
    // B is 0.5 below target but above LOW: no transfer; a wallet below LOW by less than the minimum is skipped too
    expect(plan.transfers.filter((t) => t.to === "B")).toEqual([]);
  });

  it("keeps the reserve on the primary", () => {
    const plan = planFleet([w("P", 30, 1), w("A", 0, 0.02)], { ...P, reserveUsdcBase: 10_000_000n });
    expect(plan.transfers.filter((t) => t.asset === "usdc")).toEqual([]);
    expect(plan.shortfallUsdcBase).toBe(20_000_000n);
  });
});

describe("dynamic float target", () => {
  const base = { floorBase: 20_000_000n, perRoundCapBase: 14_000_000n, floatRounds: 8, headroom: 1.5 };
  it("follows the observed peak leg with headroom over the float rounds", () => {
    expect(dynamicFloatBase({ ...base, observedPeakLegBase: 7_000_000n })).toBe(84_000_000n); // $7 × 1.5 × 8
  });
  it("never drops below the configured floor and never exceeds what a round can ask", () => {
    expect(dynamicFloatBase({ ...base, observedPeakLegBase: 0n })).toBe(20_000_000n);
    expect(dynamicFloatBase({ ...base, observedPeakLegBase: 50_000_000n })).toBe(112_000_000n); // capped at $14 × 8
  });
});

describe("auto risk limits", () => {
  it("per-round cap is the fleet's USDC; daily cap a fraction of the day's opening USDC; configured values win", async () => {
    const { deriveLimits, autoAffiliateTag } = await import("../src/exec/limits.js");
    const auto = { MAX_PER_ROUND_USD: 0, DAILY_LOSS_CAP_USD: 0, AUTO_DAILY_LOSS_FRACTION: 0.5 };
    expect(deriveLimits(auto, 2_000_000_000n, null)).toEqual({ maxPerRound: 2_000_000_000n, dailyLossCap: 1_000_000_000n });
    expect(deriveLimits(auto, 500_000n, null)).toEqual({ maxPerRound: 1_000_000n, dailyLossCap: 5_000_000n }); // floors
    expect(deriveLimits(auto, 100_000_000n, 2_000_000_000n).dailyLossCap).toBe(1_000_000_000n); // anchored to the day's open
    expect(deriveLimits({ MAX_PER_ROUND_USD: 50, DAILY_LOSS_CAP_USD: 300, AUTO_DAILY_LOSS_FRACTION: 0.5 }, 9_000_000_000n, null)).toEqual({ maxPerRound: 50_000_000n, dailyLossCap: 300_000_000n });
    const { Keypair } = await import("@solana/web3.js");
    const tag = autoAffiliateTag(Keypair.generate().publicKey);
    expect(tag).toMatch(/^sr[a-z0-9]{10}$/);
  });
});

