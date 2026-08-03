/**
 * Sim proof that anti-collision helps where it *must*: against rivals that fire
 * AFTER our bot (invisible at decision time), so reacting to the visible board
 * can't save us — only predicting them can. We compare naive water-filling
 * (production selector on observed occupancy) against the same selector fed the
 * rival-inflow forecast, and measure DILUTION: how often, when the bot wins its
 * tile, a rival is also on it splitting the pot. Anti-collision routes off the
 * tile the sniper pack floods, so its wins are far less diluted.
 */
import { describe, expect, it } from "vitest";
import {
  SIM_FEES,
  simulateRound,
  type BotFire,
  type RivalProfile,
} from "./sim.js";
import { selectAllocation, type SelectorConfig } from "../src/strategy/selector.js";
import { predictFinalOccupancy } from "../src/strategy/predict.js";
import {
  predictRivalInflow,
  type RivalProfile as LearnedProfile,
} from "../src/strategy/competitors.js";
import { TILES_COUNT, type EvContext } from "../src/strategy/ev.js";
import { usdToBase } from "../src/units.js";

const SEED = 20260803;
const ROUNDS = 3000;
const SNIPERS = 5;

// A base pot, plus a pack of snipers that fire AFTER the bot (slots 47-49, past
// the fire slot at 50-4=46) with enough latency to act on the pre-bot board —
// so they independently pick the same emptiest tile the bot does, invisibly.
const S = (grossUsd: number, staticTiles: number[]) => ({
  profile: { kind: "static", grossUsd, tileCount: staticTiles.length, slotRange: [0, 15] } as RivalProfile,
  staticTiles,
});
const wallets = [
  // A thick base pot concentrated on tiles 2-13, leaving 0,1,14-20 empty and
  // high-leverage — so sniping an empty tile is genuinely +EV and the bot fires.
  S(20, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]),
  S(20, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]),
  S(20, [6, 7, 8, 9, 10, 11, 12, 13]),
  S(20, [8, 9, 10, 11, 12, 13]),
  ...Array.from({ length: SNIPERS }, () => ({
    profile: {
      kind: "copycat",
      grossUsd: 5,
      k: 1,
      latencySlots: 5,
      slotRange: [47, 49],
      deterministic: true,
    } as RivalProfile,
    staticTiles: null,
  })),
];

const selCfg: SelectorConfig = {
  strategy: "water_filling",
  ladder: [usdToBase(1)],
  maxPerRound: usdToBase(5),
  minDeploy: usdToBase(1),
  kEmptiest: 3,
};

function makeFire(useInflow: boolean): BotFire {
  // What the anti-collision bot has learned: SNIPERS one-tile late snipers.
  const learned: LearnedProfile[] = Array.from({ length: SNIPERS }, (_, i) => ({
    authority: "sniper" + i,
    deploys: 20,
    avgTiles: 1,
    avgAmountBase: usdToBase(5),
    tileFreq: new Array<number>(TILES_COUNT).fill(0),
    avgLatenessSlots: 2,
    isAutomation: false,
    kind: "sniper",
  }));
  return (visible, elapsed, remaining) => {
    const inflow = useInflow ? predictRivalInflow(learned, visible) : null;
    const pred = predictFinalOccupancy({
      visibleStakes: visible,
      hiddenPoolEstimate: 0n,
      elapsedSlots: elapsed,
      remainingSlots: remaining,
      expectedAutomationInflow: inflow,
    });
    const ctx: EvContext = {
      predictedStakes: pred.stakes,
      fees: SIM_FEES,
      multiplier: 1,
      semantics: "raw",
    };
    const sel = selectAllocation(ctx, selCfg);
    return sel.kind === "deploy"
      ? { tiles: sel.tiles, totalGrossUsd: Number(sel.totalGross) / 1e6 }
      : null;
  };
}

function run(fire: BotFire) {
  let net = 0;
  let coveredWins = 0;
  let dilutedWins = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const o = simulateRound(wallets, fire, SEED * 7 + i, "even", 4);
    net += o.netUsd;
    if (o.coveredWinner) {
      coveredWins++;
      if (o.dilutedWin) dilutedWins++;
    }
  }
  return {
    net,
    coveredWins,
    dilutionRate: coveredWins > 0 ? dilutedWins / coveredWins : 0,
  };
}

describe("anti-collision vs post-fire snipers", () => {
  it("cuts dilution of the bot's wins (and doesn't cost net)", () => {
    const naive = run(makeFire(false));
    const anti = run(makeFire(true));
    // Both actually play and win sometimes.
    expect(naive.coveredWins).toBeGreaterThan(0);
    expect(anti.coveredWins).toBeGreaterThan(0);
    // The core claim: routing off the sniper-flooded tile means far fewer of our
    // wins are shared/diluted by rivals.
    expect(anti.dilutionRate).toBeLessThan(naive.dilutionRate);
    // And avoiding the crowded tile does not cost net PnL (small tolerance).
    expect(anti.net).toBeGreaterThan(naive.net - 1);
  });
});
