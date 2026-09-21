import { describe, expect, it } from "vitest";
import { planFleet, type FleetPlanParams, type FleetWalletBalance } from "../src/exec/fleet-plan.js";

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
