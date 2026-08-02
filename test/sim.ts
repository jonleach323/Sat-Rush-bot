/**
 * Synthetic round simulator + batch runner.
 *
 * Mechanics mirror the devnet-measured pipeline (docs/devnet-findings.md):
 * 800 bps deploy legs off the gross, even split across masked tiles (or
 * per-tile under the alternate open-question-1 semantics), 1200 bps
 * sats-vault leg off the pot, uniform 1/21 winning tile, parimutuel payout
 * by winning-tile stake share.
 *
 * The bot under test runs the PRODUCTION strategy code — selectAllocation,
 * predictFinalOccupancy, the EV model — no test-only forks.
 *
 * Run the scenario table:  pnpm sim   (10k rounds/scenario by default)
 */
import { TILES_COUNT, type EvContext, type FeeModel } from "../src/strategy/ev.js";
import { predictFinalOccupancy } from "../src/strategy/predict.js";
import { selectAllocation, type SelectorConfig } from "../src/strategy/selector.js";
import { usdToBase } from "../src/units.js";
import { seededRng } from "./helpers.js";

// Devnet-measured fee structure.
export const SIM_FEES: FeeModel = { deployFeeBps: 800, satsVaultRoundBps: 1200 };
const NET_BPS = 10_000n - 800n;
const POT_FACTOR = 1 - 0.12;
const MIN_DEPLOY = usdToBase(1);
export const ROUND_SLOTS = 50;

export type Split = "even" | "per_tile";

// ── rival profiles ───────────────────────────────────────────────────────────

export type RivalProfile =
  | { kind: "static"; grossUsd: number; tileCount: number; slotRange: [number, number] }
  | { kind: "random"; grossUsd: number; tileCount: number; slotRange: [number, number] }
  | {
      kind: "copycat";
      grossUsd: number;
      k: number;
      latencySlots: number;
      slotRange: [number, number];
      /** k=1 lowest-index argmin — the naive herding bot. */
      deterministic?: boolean;
    }
  | { kind: "whale"; grossUsd: number; tileCount: number; slotRange: [number, number] };

interface RivalWallet {
  profile: RivalProfile;
  /** Static automations keep their stored mask across every round. */
  staticTiles: number[] | null;
}

interface DeployRecord {
  wallet: number; // -1 = our bot
  tiles: number[];
  perTileNet: bigint;
  grossCostUsd: number;
}

function pickTiles(count: number, rng: () => number): number[] {
  const tiles = new Set<number>();
  while (tiles.size < count) tiles.add(Math.floor(rng() * TILES_COUNT));
  return [...tiles].sort((a, b) => a - b);
}

function emptiestTiles(stakes: bigint[], k: number, rng: (() => number) | null): number {
  const order = [...Array(TILES_COUNT).keys()].sort((a, b) => {
    const sa = stakes[a] ?? 0n;
    const sb = stakes[b] ?? 0n;
    if (sa !== sb) return sa < sb ? -1 : 1;
    return a - b;
  });
  if (!rng) return order[0]!; // deterministic argmin
  return order[Math.floor(rng() * k)]!;
}

// ── round engine ─────────────────────────────────────────────────────────────

export interface BotDecision {
  tiles: number[];
  totalGrossUsd: number;
}

export type BotFire = (
  visibleStakes: bigint[],
  elapsedSlots: number,
  remainingSlots: number,
) => BotDecision | null;

function applyDeploy(
  stakes: bigint[],
  deploys: DeployRecord[],
  wallet: number,
  tiles: number[],
  grossUsd: number,
  split: Split,
): void {
  const grossBase = usdToBase(grossUsd);
  const net = (grossBase * NET_BPS) / 10_000n;
  const perTileNet = split === "even" ? net / BigInt(tiles.length) : net;
  const grossCostUsd = split === "even" ? grossUsd : grossUsd * tiles.length;
  for (const tile of tiles) stakes[tile] = (stakes[tile] ?? 0n) + perTileNet;
  deploys.push({ wallet, tiles, perTileNet, grossCostUsd });
}

export interface RoundOutcome {
  fired: boolean;
  grossCostUsd: number;
  netUsd: number;
  coveredWinner: boolean;
}

export function simulateRound(
  wallets: RivalWallet[],
  botFire: BotFire,
  roundSeed: number,
  split: Split,
  fireOffset: number,
): RoundOutcome {
  const rng = seededRng(roundSeed);
  const winningTile = Math.floor(seededRng(roundSeed ^ 0x5bd1e995)() * TILES_COUNT);
  const fireSlot = ROUND_SLOTS - fireOffset;

  // Schedule rival deploys.
  const schedule = wallets
    .map((wallet, index) => {
      const [lo, hi] = wallet.profile.slotRange;
      return { index, wallet, slot: lo + Math.floor(rng() * Math.max(1, hi - lo + 1)) };
    })
    .sort((a, b) => a.slot - b.slot || a.index - b.index);

  const stakes = new Array<bigint>(TILES_COUNT).fill(0n);
  const deploys: DeployRecord[] = [];
  // Snapshots for copycat latency: state of the board after each slot seen.
  const snapshots: { slot: number; stakes: bigint[] }[] = [{ slot: -1, stakes: [...stakes] }];
  const stakesAsOf = (slot: number): bigint[] => {
    for (let i = snapshots.length - 1; i >= 0; i--) {
      if (snapshots[i]!.slot <= slot) return snapshots[i]!.stakes;
    }
    return snapshots[0]!.stakes;
  };

  let botFired = false;
  let botDeploy: DeployRecord | null = null;

  const fireBot = (): void => {
    if (botFired) return;
    botFired = true;
    const decision = botFire([...stakes], fireSlot, fireOffset);
    if (!decision) return;
    applyDeploy(stakes, deploys, -1, decision.tiles, decision.totalGrossUsd, split);
    botDeploy = deploys.at(-1)!;
    snapshots.push({ slot: fireSlot, stakes: [...stakes] });
  };

  for (const entry of schedule) {
    if (entry.slot >= fireSlot) fireBot();
    const { profile } = entry.wallet;
    let tiles: number[];
    if (profile.kind === "static") {
      tiles = entry.wallet.staticTiles!;
    } else if (profile.kind === "random") {
      tiles = pickTiles(profile.tileCount, rng);
    } else if (profile.kind === "copycat") {
      const observed = stakesAsOf(entry.slot - profile.latencySlots);
      tiles = [
        profile.deterministic
          ? emptiestTiles(observed, 1, null)
          : emptiestTiles(observed, profile.k, rng),
      ];
    } else {
      tiles = pickTiles(profile.tileCount, rng);
    }
    applyDeploy(stakes, deploys, entry.index, tiles, profile.grossUsd, split);
    snapshots.push({ slot: entry.slot, stakes: [...stakes] });
  }
  fireBot(); // no rival at/after the fire slot — fire on the tick anyway

  // Settlement: parimutuel on the winning tile.
  const totalNet = deploys.reduce(
    (acc, d) => acc + d.perTileNet * BigInt(d.tiles.length),
    0n,
  );
  const potUsd = (Number(totalNet) / 1e6) * POT_FACTOR;
  const winners = deploys.filter((d) => d.tiles.includes(winningTile));
  const totalOnWinner = winners.reduce((acc, d) => acc + d.perTileNet, 0n);

  if (!botDeploy) {
    return { fired: false, grossCostUsd: 0, netUsd: 0, coveredWinner: false };
  }
  const mine: DeployRecord = botDeploy;
  const covered = mine.tiles.includes(winningTile);
  const payout =
    covered && totalOnWinner > 0n
      ? potUsd * (Number(mine.perTileNet) / Number(totalOnWinner))
      : 0;
  return {
    fired: true,
    grossCostUsd: mine.grossCostUsd,
    netUsd: payout - mine.grossCostUsd,
    coveredWinner: covered,
  };
}

// ── strategies under test (bot + baselines) ─────────────────────────────────

export interface StrategySpec {
  name: string;
  makeFire: (rng: () => number, split: Split) => BotFire;
}

const LADDER_USD = [1];
const MAX_PER_ROUND_USD = 5;

/** PRODUCTION selector path — the same code the orchestrator fires with. */
function productionFire(
  strategy: "water_filling" | "k_emptiest",
  kEmptiest: number,
  rng: () => number,
  split: Split,
): BotFire {
  const selectorCfg: SelectorConfig = {
    strategy,
    ladder: LADDER_USD.map(usdToBase),
    maxPerRound: usdToBase(MAX_PER_ROUND_USD),
    minDeploy: MIN_DEPLOY,
    kEmptiest,
    rng,
  };
  return (visibleStakes, elapsedSlots, remainingSlots) => {
    const prediction = predictFinalOccupancy({
      visibleStakes,
      hiddenPoolEstimate: 0n,
      elapsedSlots,
      remainingSlots,
    });
    const ctx: EvContext = {
      predictedStakes: prediction.stakes,
      fees: SIM_FEES,
      multiplier: 1,
      semantics: split === "even" ? "raw" : "effective",
    };
    const selection = selectAllocation(ctx, selectorCfg);
    if (selection.kind !== "deploy") return null;
    return {
      tiles: selection.tiles,
      totalGrossUsd: Number(selection.totalGross) / 1e6,
    };
  };
}

export const STRATEGIES: StrategySpec[] = [
  {
    name: "water_filling",
    makeFire: (rng, split) => productionFire("water_filling", 3, rng, split),
  },
  {
    name: "k_emptiest(3)",
    makeFire: (rng, split) => productionFire("k_emptiest", 3, rng, split),
  },
  {
    name: "single_emptiest",
    makeFire: (rng) => (visible) => ({
      tiles: [emptiestTiles(visible, 1, null)],
      totalGrossUsd: MAX_PER_ROUND_USD,
    }),
  },
  {
    name: "random_tile",
    makeFire: (rng) => (visible) => ({
      tiles: [Math.floor(rng() * TILES_COUNT)],
      totalGrossUsd: MAX_PER_ROUND_USD,
    }),
  },
  {
    name: "static_tile0",
    makeFire: () => () => ({ tiles: [0], totalGrossUsd: MAX_PER_ROUND_USD }),
  },
];

// ── scenarios ────────────────────────────────────────────────────────────────

export interface ScenarioSpec {
  name: string;
  rivals: RivalProfile[];
}

const early: [number, number] = [0, 15];
const mid: [number, number] = [10, 35];
const late: [number, number] = [40, 45];
const postFire: [number, number] = [ROUND_SLOTS - 3, ROUND_SLOTS - 1];

export const SCENARIOS: ScenarioSpec[] = [
  {
    name: "sparse_automations",
    rivals: [
      { kind: "static", grossUsd: 5, tileCount: 5, slotRange: early },
      { kind: "static", grossUsd: 5, tileCount: 3, slotRange: early },
      { kind: "static", grossUsd: 5, tileCount: 10, slotRange: mid },
      { kind: "random", grossUsd: 5, tileCount: 4, slotRange: mid },
      { kind: "random", grossUsd: 5, tileCount: 7, slotRange: mid },
    ],
  },
  {
    name: "busy_board",
    rivals: [
      ...Array.from({ length: 8 }, (_, i): RivalProfile => ({
        kind: "static",
        grossUsd: 5,
        tileCount: 2 + (i % 6),
        slotRange: i % 2 ? early : mid,
      })),
      ...Array.from({ length: 5 }, (): RivalProfile => ({
        kind: "random",
        grossUsd: 5,
        tileCount: 5,
        slotRange: mid,
      })),
      { kind: "whale", grossUsd: 50, tileCount: 2, slotRange: late },
      { kind: "whale", grossUsd: 50, tileCount: 3, slotRange: postFire },
    ],
  },
  {
    name: "copycats",
    rivals: [
      { kind: "static", grossUsd: 5, tileCount: 6, slotRange: early },
      { kind: "static", grossUsd: 5, tileCount: 4, slotRange: early },
      { kind: "static", grossUsd: 5, tileCount: 8, slotRange: mid },
      { kind: "copycat", grossUsd: 5, k: 3, latencySlots: 2, slotRange: mid },
      { kind: "copycat", grossUsd: 5, k: 3, latencySlots: 4, slotRange: late },
      { kind: "copycat", grossUsd: 5, k: 2, latencySlots: 6, slotRange: late },
      { kind: "copycat", grossUsd: 5, k: 3, latencySlots: 3, slotRange: postFire },
    ],
  },
  {
    name: "herding",
    rivals: [
      { kind: "static", grossUsd: 10, tileCount: 12, slotRange: early },
      // A pack of naive deterministic-emptiest bots sharing one stale view:
      // they all pick the same tile and split it.
      ...Array.from({ length: 5 }, (): RivalProfile => ({
        kind: "copycat",
        grossUsd: 5,
        k: 1,
        latencySlots: 8,
        slotRange: [42, 45],
        deterministic: true,
      })),
    ],
  },
  {
    name: "whale_dominated",
    rivals: [
      { kind: "static", grossUsd: 2, tileCount: 3, slotRange: early },
      { kind: "whale", grossUsd: 80, tileCount: 1, slotRange: mid },
      { kind: "whale", grossUsd: 60, tileCount: 2, slotRange: late },
    ],
  },
  { name: "empty_board", rivals: [] },
];

// ── batch runner ─────────────────────────────────────────────────────────────

export interface StrategyResult {
  strategy: string;
  fireRate: number;
  hitRate: number;
  meanNetUsd: number;
  stdUsd: number;
  totalNetUsd: number;
}

export interface ScenarioResult {
  scenario: string;
  split: Split;
  rounds: number;
  results: StrategyResult[];
}

export function runScenario(
  scenario: ScenarioSpec,
  rounds: number,
  seed: number,
  split: Split,
  fireOffset = 4,
  strategies: StrategySpec[] = STRATEGIES,
): ScenarioResult {
  const results: StrategyResult[] = [];
  for (const [strategyIndex, spec] of strategies.entries()) {
    // Static automations keep one mask for the whole batch (per wallet).
    const walletRng = seededRng(seed ^ 0xabcdef);
    const wallets: RivalWallet[] = scenario.rivals.map((profile) => ({
      profile,
      staticTiles:
        profile.kind === "static" ? pickTiles(profile.tileCount, walletRng) : null,
    }));
    const botRng = seededRng(seed ^ (0x1000 + strategyIndex));
    const fire = spec.makeFire(botRng, split);

    let fired = 0;
    let hits = 0;
    let total = 0;
    let totalSq = 0;
    for (let i = 0; i < rounds; i++) {
      // Common random numbers: rival schedule + winning tile identical
      // across strategies — paired comparison, low-variance deltas.
      const outcome = simulateRound(wallets, fire, seed * 7 + i, split, fireOffset);
      if (outcome.fired) {
        fired++;
        if (outcome.coveredWinner) hits++;
      }
      total += outcome.netUsd;
      totalSq += outcome.netUsd * outcome.netUsd;
    }
    const mean = total / rounds;
    results.push({
      strategy: spec.name,
      fireRate: fired / rounds,
      hitRate: fired > 0 ? hits / fired : 0,
      meanNetUsd: mean,
      stdUsd: Math.sqrt(Math.max(0, totalSq / rounds - mean * mean)),
      totalNetUsd: total,
    });
  }
  return { scenario: scenario.name, split, rounds, results };
}

export function runAll(rounds: number, seed = 20260802): ScenarioResult[] {
  const out: ScenarioResult[] = [];
  for (const scenario of SCENARIOS) {
    for (const split of ["even", "per_tile"] as Split[]) {
      out.push(runScenario(scenario, rounds, seed, split));
    }
  }
  return out;
}

// ── table printer (pnpm sim) ─────────────────────────────────────────────────

function printTable(all: ScenarioResult[]): void {
  const pad = (s: string, n: number) => s.padEnd(n);
  const num = (v: number, n: number, digits = 3) => v.toFixed(digits).padStart(n);
  console.log(
    pad("scenario", 20) +
      pad("split", 10) +
      pad("strategy", 18) +
      "fire%   hit%   mean$/rd     σ$     total$",
  );
  console.log("─".repeat(88));
  for (const { scenario, split, results } of all) {
    for (const r of results) {
      console.log(
        pad(scenario, 20) +
          pad(split, 10) +
          pad(r.strategy, 18) +
          num(r.fireRate * 100, 5, 1) +
          "  " +
          num(r.hitRate * 100, 5, 1) +
          "  " +
          num(r.meanNetUsd, 9, 4) +
          "  " +
          num(r.stdUsd, 6, 2) +
          "  " +
          num(r.totalNetUsd, 9, 0),
      );
    }
    console.log("─".repeat(88));
  }
}

const isMain = process.argv[1]?.endsWith("sim.ts") ?? false;
if (isMain) {
  const rounds = Number(process.env["SIM_ROUNDS"] ?? 10_000);
  const started = Date.now();
  const all = runAll(rounds);
  printTable(all);
  console.log(
    `\n${SCENARIOS.length} scenarios × 2 splits × ${STRATEGIES.length} strategies, ` +
      `${rounds} rounds each — ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}
