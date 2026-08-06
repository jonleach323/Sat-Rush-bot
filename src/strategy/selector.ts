/**
 * Tile selection.
 *
 * v1 strategy "water_filling": greedily allocate ladder quanta to the tile
 * with the highest marginal EV until MAX_PER_ROUND is reached or marginal
 * EV ≤ 0, then convert the support set to a selection mask. Ties break
 * randomly (injectable rng).
 *
 * Fallback "k_emptiest": uniform random among the K emptiest tiles,
 * full amount.
 *
 * Both respect the on-chain min_deploy_usd_amount.
 */
import { tilesToMask } from "../adapter/mask.js";
import {
  TILES_COUNT,
  evOfAllocation,
  marginalEv,
  outcomeReturns,
  type EvContext,
} from "./ev.js";
import { kellyFraction } from "./kelly.js";

export type StrategyName = "water_filling" | "k_emptiest";

export interface SelectorConfig {
  strategy: StrategyName;
  /** Stake ladder (base units, ascending). The smallest entry is the greedy quantum. */
  ladder: bigint[];
  /** Max gross spend this round (base units), post any strike boost/caps. */
  maxPerRound: bigint;
  /** On-chain SatrushConfig.min_deploy_usd_amount (gross, base units). */
  minDeploy: bigint;
  kEmptiest: number;
  /**
   * Minimum modeled edge required to fire, in bps of the gross deploy. The
   * selector otherwise fires on any EV > 0, including razor-thin edges that a
   * slightly-optimistic occupancy forecast turns negative in reality (measured
   * live: wins paid ~2× when ~3.1× was needed to break even). Requiring a fat
   * modeled margin absorbs residual model optimism and skips marginal rounds.
   * 0 = off (fire on any positive EV, the old behavior).
   */
  minEdgeBps?: number | undefined;
  /**
   * Fractional-Kelly multiplier ∈ (0,1]. When set (with `bankrollBase`), the
   * total round stake is capped at this fraction of the growth-optimal Kelly
   * bet — sizing up on fat edges and down on thin/high-variance ones, scaled to
   * the bankroll. It only ever *reduces* below the EV-maximizing water-filling
   * stake (betting past Kelly lowers long-run growth), never raises it above the
   * cap. 0/undefined = off (pure EV-max water-filling). Half-Kelly (0.5) is the
   * conservative default.
   */
  kellyFraction?: number | undefined;
  /** Deployable bankroll (base units) Kelly sizes against. Required for Kelly. */
  bankrollBase?: bigint | undefined;
  /** Injectable randomness for tie-breaks and k-emptiest choice. */
  rng?: (() => number) | undefined;
}

export type Selection =
  | {
      kind: "deploy";
      mask: number;
      tiles: number[];
      /** Per-tile gross allocation (base units), length 21. */
      allocation: bigint[];
      totalGross: bigint;
      /** Model EV (base units, float) of this allocation. */
      ev: number;
      strategy: StrategyName;
      /**
       * True when allocation stopped at MAX_PER_ROUND while the best
       * marginal EV was still positive — capital was the binding
       * constraint, not the model ("leaving money on the table").
       */
      capBound: boolean;
      /** Marginal EV (base units) of the next quantum at the stop point. */
      marginalEvAtStop: number;
    }
  | { kind: "skip"; reason: string; strategy: StrategyName };

const EV_EPSILON = 1e-6;
const BPS = 10_000;

/** True when `ev` clears the configured minimum-edge floor for `gross`. */
function clearsEdgeFloor(ev: number, gross: bigint, minEdgeBps: number | undefined): boolean {
  const bps = minEdgeBps ?? 0;
  if (bps <= 0) return true;
  return ev >= (Number(gross) * bps) / BPS;
}

function validate(cfg: SelectorConfig): void {
  if (cfg.ladder.length === 0 || cfg.ladder.some((l) => l <= 0n)) {
    throw new RangeError("ladder must be non-empty positive amounts");
  }
  if (cfg.maxPerRound <= 0n) throw new RangeError("maxPerRound must be positive");
  if (cfg.minDeploy < 0n) throw new RangeError("minDeploy must be non-negative");
  if (!Number.isInteger(cfg.kEmptiest) || cfg.kEmptiest < 1 || cfg.kEmptiest > TILES_COUNT) {
    throw new RangeError(`invalid kEmptiest: ${cfg.kEmptiest}`);
  }
}

function pickRandom<T>(items: T[], rng: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))] as T;
}

export function selectAllocation(ctx: EvContext, cfg: SelectorConfig): Selection {
  validate(cfg);
  return cfg.strategy === "k_emptiest"
    ? selectKEmptiest(ctx, cfg)
    : selectWaterFilling(ctx, cfg);
}

function selectWaterFilling(ctx: EvContext, cfg: SelectorConfig): Selection {
  // Fractional-Kelly overlay: find the EV-optimal allocation first, then cap the
  // total stake at the growth-optimal Kelly bet if that is smaller. Two-pass so
  // the shape is re-optimized for the reduced budget; the recursive call has
  // Kelly disabled to avoid looping.
  if (cfg.kellyFraction && cfg.kellyFraction > 0 && cfg.bankrollBase != null) {
    const evMax = { ...cfg, kellyFraction: undefined, bankrollBase: undefined };
    const base = selectWaterFilling(ctx, evMax);
    if (base.kind !== "deploy") return base;
    const f = kellyFraction(outcomeReturns(ctx, base.allocation)) * cfg.kellyFraction;
    const kellyBudget = BigInt(Math.floor(f * Number(cfg.bankrollBase)));
    if (kellyBudget >= base.totalGross) return base; // Kelly does not reduce
    if (kellyBudget < cfg.minDeploy) {
      return { kind: "skip", reason: "kelly_below_min_deploy", strategy: "water_filling" };
    }
    return selectWaterFilling(ctx, { ...evMax, maxPerRound: kellyBudget });
  }

  const rng = cfg.rng ?? Math.random;
  const quantum = cfg.ladder.reduce((a, b) => (b < a ? b : a));
  if (quantum > cfg.maxPerRound) {
    return { kind: "skip", reason: "ladder_quantum_exceeds_max_per_round", strategy: "water_filling" };
  }

  const allocation = new Array<bigint>(TILES_COUNT).fill(0n);
  let total = 0n;

  let lastBestMarginal = Number.NEGATIVE_INFINITY;
  const bestTileFor = (predicate: (ev: number) => boolean): number | null => {
    let bestEv = Number.NEGATIVE_INFINITY;
    const candidates: number[] = [];
    for (let tile = 0; tile < TILES_COUNT; tile++) {
      const gain = marginalEv(ctx, allocation, tile, quantum);
      if (gain > bestEv + EV_EPSILON) {
        bestEv = gain;
        candidates.length = 0;
        candidates.push(tile);
      } else if (Math.abs(gain - bestEv) <= EV_EPSILON) {
        candidates.push(tile);
      }
    }
    lastBestMarginal = bestEv;
    if (candidates.length === 0 || !predicate(bestEv)) return null;
    return pickRandom(candidates, rng);
  };

  // Greedy: allocate quanta while the best marginal EV is positive.
  while (total + quantum <= cfg.maxPerRound) {
    const tile = bestTileFor((ev) => ev > 0);
    if (tile === null) break;
    allocation[tile] = (allocation[tile] ?? 0n) + quantum;
    total += quantum;
  }

  if (total === 0n) {
    return { kind: "skip", reason: "no_positive_marginal_ev", strategy: "water_filling" };
  }

  // Respect the on-chain minimum: top up along best marginals (even if ≤ 0),
  // then skip the round entirely if the padded allocation is EV-negative.
  while (total < cfg.minDeploy && total + quantum <= cfg.maxPerRound) {
    const tile = bestTileFor(() => true);
    if (tile === null) break;
    allocation[tile] = (allocation[tile] ?? 0n) + quantum;
    total += quantum;
  }
  if (total < cfg.minDeploy) {
    return { kind: "skip", reason: "cannot_reach_min_deploy", strategy: "water_filling" };
  }
  const ev = evOfAllocation(ctx, allocation);
  if (ev <= 0) {
    return { kind: "skip", reason: "min_deploy_padding_made_ev_negative", strategy: "water_filling" };
  }
  if (!clearsEdgeFloor(ev, total, cfg.minEdgeBps)) {
    return { kind: "skip", reason: "below_min_edge", strategy: "water_filling" };
  }

  // Cap-bound detection: the loop ended because the next quantum would
  // exceed MAX_PER_ROUND — was the model still asking for more?
  let capBound = false;
  let marginalEvAtStop = lastBestMarginal;
  if (total + quantum > cfg.maxPerRound) {
    bestTileFor(() => true); // refresh lastBestMarginal at the stop point
    marginalEvAtStop = lastBestMarginal;
    capBound = lastBestMarginal > 0;
  }

  const tiles = allocation.flatMap((a, i) => (a > 0n ? [i] : []));
  return {
    kind: "deploy",
    mask: tilesToMask(tiles),
    tiles,
    allocation,
    totalGross: total,
    ev,
    strategy: "water_filling",
    capBound,
    marginalEvAtStop,
  };
}

function selectKEmptiest(ctx: EvContext, cfg: SelectorConfig): Selection {
  const rng = cfg.rng ?? Math.random;

  // Full amount: the largest ladder entry that fits under the cap.
  const amount = [...cfg.ladder]
    .sort((a, b) => (a < b ? -1 : 1))
    .filter((l) => l <= cfg.maxPerRound)
    .at(-1);
  if (amount === undefined) {
    return { kind: "skip", reason: "no_ladder_entry_fits_max_per_round", strategy: "k_emptiest" };
  }
  if (amount < cfg.minDeploy) {
    return { kind: "skip", reason: "amount_below_min_deploy", strategy: "k_emptiest" };
  }

  const byStake = [...Array(TILES_COUNT).keys()].sort((a, b) => {
    const sa = ctx.predictedStakes[a] ?? 0n;
    const sb = ctx.predictedStakes[b] ?? 0n;
    if (sa !== sb) return sa < sb ? -1 : 1;
    return a - b;
  });
  const tile = pickRandom(byStake.slice(0, cfg.kEmptiest), rng);

  const allocation = new Array<bigint>(TILES_COUNT).fill(0n);
  allocation[tile] = amount;
  const ev = evOfAllocation(ctx, allocation);
  if (!clearsEdgeFloor(ev, amount, cfg.minEdgeBps)) {
    return { kind: "skip", reason: "below_min_edge", strategy: "k_emptiest" };
  }
  return {
    kind: "deploy",
    mask: tilesToMask([tile]),
    tiles: [tile],
    allocation,
    totalGross: amount,
    ev,
    strategy: "k_emptiest",
    capBound: false, // fixed-size strategy — the cap is the size by design
    marginalEvAtStop: 0,
  };
}
