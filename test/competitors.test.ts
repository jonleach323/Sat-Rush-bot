import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLASSIFY,
  fieldSummary,
  predictRivalInflow,
  profileCompetitors,
  type CompetitorDeployRow,
  type RoundWindow,
} from "../src/strategy/competitors.js";
import { selectAllocation, type SelectorConfig } from "../src/strategy/selector.js";
import { TILES_COUNT, type EvContext } from "../src/strategy/ev.js";
import { usdToBase } from "../src/units.js";
import { tilesToMask } from "../src/adapter/mask.js";

const CUTOFF = 1000;
const windows = new Map<number, RoundWindow>();
for (let r = 1; r <= 50; r++) windows.set(r, { end: CUTOFF });

function row(
  authority: string,
  round: number,
  tiles: number[],
  usd: number,
  slotBeforeCutoff: number,
  automation = false,
): CompetitorDeployRow {
  return {
    round_id: round,
    authority,
    mask: tilesToMask(tiles),
    amount: usdToBase(usd).toString(),
    is_automation: automation ? 1 : 0,
    slot: CUTOFF - slotBeforeCutoff,
  };
}

describe("profileCompetitors + classify", () => {
  it("classifies a late, concentrated wallet as a sniper", () => {
    const rows = [
      row("SNIPE", 1, [3], 5, 3),
      row("SNIPE", 2, [7, 8], 5, 2),
      row("SNIPE", 3, [1], 5, 4),
    ];
    const p = profileCompetitors(rows, windows).get("SNIPE")!;
    expect(p.kind).toBe("sniper");
    expect(p.avgLatenessSlots).toBeLessThanOrEqual(DEFAULT_CLASSIFY.sniperMaxLatenessSlots);
    expect(p.avgTiles).toBeLessThanOrEqual(DEFAULT_CLASSIFY.sniperMaxTiles);
  });

  it("classifies the automation crank as a spreader", () => {
    const many = Array.from({ length: 19 }, (_, i) => i);
    const rows = [row("CRANK", 1, many, 20, 1, true), row("CRANK", 2, many, 20, 1, true)];
    expect(profileCompetitors(rows, windows).get("CRANK")!.kind).toBe("spreader");
  });

  it("classifies a big early broad player as a whale", () => {
    const rows = [
      row("WHALE", 1, [2, 3, 4, 5, 6, 7, 8], 300, 40),
      row("WHALE", 2, [2, 3, 4, 5, 6, 7, 8], 300, 45),
    ];
    expect(profileCompetitors(rows, windows).get("WHALE")!.kind).toBe("whale");
  });

  it("computes tile frequency and averages", () => {
    const rows = [row("W", 1, [0], 10, 5), row("W", 2, [0, 1], 20, 5)];
    const p = profileCompetitors(rows, windows).get("W")!;
    expect(p.deploys).toBe(2);
    expect(p.avgTiles).toBeCloseTo(1.5);
    expect(p.tileFreq[0]).toBeCloseTo(1); // tile 0 in both
    expect(p.tileFreq[1]).toBeCloseTo(0.5);
    expect(p.avgAmountBase).toBe(usdToBase(15));
  });

  it("fieldSummary counts kinds and drops one-offs", () => {
    const rows = [
      row("S1", 1, [3], 5, 3),
      row("S1", 2, [4], 5, 3),
      row("ONE", 1, [9], 5, 3), // single deploy → dropped
    ];
    const summary = fieldSummary(profileCompetitors(rows, windows).values());
    expect(summary.sniper).toBe(1);
  });
});

describe("predictRivalInflow", () => {
  const zeros = () => new Array<bigint>(TILES_COUNT).fill(0n);

  it("puts a sniper's expected size on the currently-emptiest tiles", () => {
    const stakes = new Array<bigint>(TILES_COUNT).fill(usdToBase(10));
    stakes[0] = 0n; // emptiest
    stakes[1] = 0n;
    const rows = [row("S", 1, [5], 40, 3), row("S", 2, [6], 40, 3)]; // 1-tile sniper, $40
    const profiles = profileCompetitors(rows, windows);
    const inflow = predictRivalInflow(profiles.values(), stakes);
    // avgTiles≈1 → all $40 on the single emptiest tile (0)
    expect(inflow[0]).toBe(usdToBase(40));
    expect(inflow[1]).toBe(0n);
  });

  it("ignores one-off rivals below minDeploys", () => {
    const rows = [row("ONE", 1, [0], 40, 3)];
    const inflow = predictRivalInflow(profileCompetitors(rows, windows).values(), zeros());
    expect(inflow.every((v) => v === 0n)).toBe(true);
  });
});

describe("anti-collision routing", () => {
  const FEES = { deployFeeBps: 800, satsVaultRoundBps: 1200, satsVaultClaimBps: 1000 };
  const selCfg: SelectorConfig = {
    strategy: "water_filling",
    ladder: [usdToBase(1)],
    maxPerRound: usdToBase(5),
    minDeploy: usdToBase(1),
    kEmptiest: 3,
  };
  const ctx = (predictedStakes: bigint[]): EvContext => ({
    predictedStakes,
    fees: FEES,
    multiplier: 1,
    semantics: "raw",
  });

  it("routes off the tile a rival sniper is predicted to take", () => {
    // Board: tiles 2..20 hold $10 each; tiles 0 and 1 are empty.
    const visible = new Array<bigint>(TILES_COUNT).fill(usdToBase(10));
    visible[0] = 0n;
    visible[1] = 0n;
    // A 1-tile sniper with $40 → predicted onto the emptiest tile (0).
    const rows = [row("S", 1, [5], 40, 3), row("S", 2, [6], 40, 3)];
    const inflow = predictRivalInflow(profileCompetitors(rows, windows).values(), visible);
    const withPred = visible.map((v, i) => v + inflow[i]!);

    const naive = selectAllocation(ctx(visible), selCfg);
    const aware = selectAllocation(ctx(withPred), selCfg);
    expect(naive.kind).toBe("deploy");
    expect(aware.kind).toBe("deploy");
    if (naive.kind !== "deploy" || aware.kind !== "deploy") return;

    // Naive piles onto the empty tile 0 (where the sniper will land → collision).
    expect(naive.allocation[0]).toBeGreaterThan(0n);
    // Collision-aware avoids tile 0 and takes the still-empty tile 1.
    expect(aware.allocation[0]).toBe(0n);
    expect(aware.allocation[1]).toBeGreaterThan(0n);
  });
});
