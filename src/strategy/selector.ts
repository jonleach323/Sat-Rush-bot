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
  isEvModel,
  v1Model,
  type EvContext,
  type EvModel,
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
   * Absolute EV floor (base units) the round must clear on top of the bps
   * floor: the real costs and the alternative use of the money — round-trip
   * transaction fees for every leg the fire needs, and what the stake would
   * have earned elsewhere over the round. A round whose modelled EV does not
   * cover them is not worth firing even though it is "positive".
   */
  minEvBase?: bigint | undefined;
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
function clearsEdgeFloor(ev: number, gross: bigint, minEdgeBps: number | undefined, minEvBase?: bigint | undefined): boolean {
  const bps = minEdgeBps ?? 0;
  const relative = bps > 0 ? (Number(gross) * bps) / BPS : 0;
  const absolute = minEvBase !== undefined && minEvBase > 0n ? Number(minEvBase) : 0;
  return ev >= Math.max(relative, absolute);
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

/**
 * Structural tile bias, measured over 400 rounds: automations run fixed masks
 * and cover the high tiles least (t20 94.0% of deploys against ~100% for the
 * low ones), so those tiles carry consistently less stake — t20 averages 4.506%
 * of round stake against the 4.762% a fair board gives.
 *
 * Deliberately used ONLY to break ties, never to steer allocation. The effect
 * is about 5% on stake, and a strategy of always deploying the cheapest tile
 * measured -4.24% of volume over the same window — better than a blanket's
 * -6.4%, but with 1/21 odds that difference is smaller than a single win, so
 * it is noise. Breaking an otherwise-even tie toward the cheap end costs
 * nothing and needs no significance: when two tiles are equal on EV, one of
 * them is reliably a little emptier.
 *
 * Ordered cheapest-first. Re-measure with `pnpm tile-bias` if the field's
 * automation mix changes — this is a property of who is playing, not of the
 * program, and it will move.
 */
const STRUCTURAL_TILE_ORDER: readonly number[] = [20, 19, 17, 0, 4, 18, 12, 1, 2, 3, 5, 6, 7, 9, 14, 15, 16, 10, 13, 11, 8];
const TILE_RANK: readonly number[] = (() => {
  const rank = new Array<number>(TILES_COUNT).fill(TILES_COUNT);
  STRUCTURAL_TILE_ORDER.forEach((tile, i) => {
    if (tile >= 0 && tile < TILES_COUNT) rank[tile] = i;
  });
  return rank;
})();

/**
 * Break a tie toward the structurally emptier tile, keeping randomisation
 * among equally-ranked ones. The randomisation matters: deterministic tile
 * choice is what lets rivals collide with us on purpose, which is why
 * pickRandom exists at all — this narrows the pool it draws from rather than
 * replacing it.
 *
 * Used by water-filling only, where candidates are already equal on marginal
 * EV and the set is small. k_emptiest deliberately keeps the unbiased draw:
 * spreading across the K emptiest IS its anti-collision design, and trading
 * that for a 5% stake tilt would be a bad swap.
 */
function pickBiased(candidates: number[], rng: () => number): number {
  if (candidates.length <= 1) return pickRandom(candidates, rng);
  let best = TILES_COUNT;
  for (const t of candidates) best = Math.min(best, TILE_RANK[t] ?? TILES_COUNT);
  const tied = candidates.filter((t) => (TILE_RANK[t] ?? TILES_COUNT) === best);
  return pickRandom(tied, rng);
}

/**
 * Pick this round's allocation. Takes either a V1 `EvContext` (the parimutuel
 * economics, bound here to `v1Model`) or any `EvModel` — the V2 economics in
 * `ev-v2.ts` are passed that way. The allocation logic below never touches
 * the economics directly, so a model swap cannot change how quanta are placed,
 * only how they are valued.
 */
export function selectAllocation(ctx: EvContext | EvModel, cfg: SelectorConfig): Selection {
  validate(cfg);
  const model = isEvModel(ctx) ? ctx : v1Model(ctx);
  return cfg.strategy === "k_emptiest"
    ? selectKEmptiest(model, cfg)
    : selectWaterFilling(model, cfg);
}

function selectWaterFilling(model: EvModel, cfg: SelectorConfig): Selection {
  // Fractional-Kelly overlay: find the EV-optimal allocation first, then cap the
  // total stake at the growth-optimal Kelly bet if that is smaller. Two-pass so
  // the shape is re-optimized for the reduced budget; the recursive call has
  // Kelly disabled to avoid looping.
  if (cfg.kellyFraction && cfg.kellyFraction > 0 && cfg.bankrollBase != null) {
    const evMax = { ...cfg, kellyFraction: undefined, bankrollBase: undefined };
    const base = selectWaterFilling(model, evMax);
    if (base.kind !== "deploy") return base;
    const f = kellyFraction(model.returns(base.allocation)) * cfg.kellyFraction;
    const kellyBudget = BigInt(Math.floor(f * Number(cfg.bankrollBase)));
    if (kellyBudget >= base.totalGross) return base; // Kelly does not reduce
    if (kellyBudget < cfg.minDeploy) {
      return { kind: "skip", reason: "kelly_below_min_deploy", strategy: "water_filling" };
    }
    return selectWaterFilling(model, { ...evMax, maxPerRound: kellyBudget });
  }

  const rng = cfg.rng ?? Math.random;
  const quantum = cfg.ladder.reduce((a, b) => (b < a ? b : a));
  if (quantum > cfg.maxPerRound) {
    return { kind: "skip", reason: "ladder_quantum_exceeds_max_per_round", strategy: "water_filling" };
  }

  // Water-fill from a seed: allocate quanta to the best-marginal tile while
  // the best marginal EV is positive. Returns the allocation, its total and
  // a refresher for the marginal at the stop point.
  const fill = (seed: readonly bigint[]) => {
    const allocation = [...seed];
    let total = allocation.reduce((a, b) => a + b, 0n);
    let lastBestMarginal = Number.NEGATIVE_INFINITY;
    const bestTileFor = (predicate: (ev: number) => boolean): number | null => {
      let bestEv = Number.NEGATIVE_INFINITY;
      const candidates: number[] = [];
      for (let tile = 0; tile < TILES_COUNT; tile++) {
        const gain = model.marginal(allocation, tile, quantum);
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
      return pickBiased(candidates, rng);
    };
    while (total + quantum <= cfg.maxPerRound) {
      const tile = bestTileFor((ev) => ev > 0);
      if (tile === null) break;
      allocation[tile] = (allocation[tile] ?? 0n) + quantum;
      total += quantum;
    }
    return {
      allocation,
      get total() {
        return total;
      },
      add(tile: number) {
        allocation[tile] = (allocation[tile] ?? 0n) + quantum;
        total += quantum;
      },
      bestTileFor,
      marginalAtStop: () => lastBestMarginal,
    };
  };

  // Two seeds. From EMPTY, greedy water-filling only ever reaches a blanket
  // through a chain of positive single-tile marginals — but coverage is
  // non-convex under V2 (the 89% losing-tile refund and the strike pot make
  // the 21-tile blanket positive while every lone tile is negative), so the
  // empty seed can stall at zero with a positive blanket on the table. The
  // BLANKET seed (one quantum on every tile, when affordable) fills from
  // full coverage; the higher-EV result wins.
  let best = fill(new Array<bigint>(TILES_COUNT).fill(0n));
  const blanketCost = quantum * BigInt(TILES_COUNT);
  if (blanketCost <= cfg.maxPerRound) {
    const fromBlanket = fill(new Array<bigint>(TILES_COUNT).fill(quantum));
    const evEmpty = best.total > 0n ? model.ev(best.allocation) : 0;
    const evBlanket = model.ev(fromBlanket.allocation);
    if (evBlanket > evEmpty + EV_EPSILON) best = fromBlanket;
  }
  const { allocation, bestTileFor } = best;
  let total = best.total;

  if (total === 0n) {
    return { kind: "skip", reason: "no_positive_marginal_ev", strategy: "water_filling" };
  }

  // Respect the on-chain minimum: top up along best marginals (even if ≤ 0),
  // then skip the round entirely if the padded allocation is EV-negative.
  while (total < cfg.minDeploy && total + quantum <= cfg.maxPerRound) {
    const tile = bestTileFor(() => true);
    if (tile === null) break;
    best.add(tile);
    total = best.total;
  }
  if (total < cfg.minDeploy) {
    return { kind: "skip", reason: "cannot_reach_min_deploy", strategy: "water_filling" };
  }
  const ev = model.ev(allocation);
  if (ev <= 0) {
    return { kind: "skip", reason: "min_deploy_padding_made_ev_negative", strategy: "water_filling" };
  }
  if (!clearsEdgeFloor(ev, total, cfg.minEdgeBps, cfg.minEvBase)) {
    return { kind: "skip", reason: "below_min_edge", strategy: "water_filling" };
  }

  // Cap-bound detection: the loop ended because the next quantum would
  // exceed MAX_PER_ROUND — was the model still asking for more?
  let capBound = false;
  let marginalEvAtStop = best.marginalAtStop();
  if (total + quantum > cfg.maxPerRound) {
    bestTileFor(() => true); // refresh the marginal at the stop point
    marginalEvAtStop = best.marginalAtStop();
    capBound = marginalEvAtStop > 0;
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

function selectKEmptiest(model: EvModel, cfg: SelectorConfig): Selection {
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
    const sa = model.predictedStakes[a] ?? 0n;
    const sb = model.predictedStakes[b] ?? 0n;
    if (sa !== sb) return sa < sb ? -1 : 1;
    return a - b;
  });
  // NOT pickBiased: randomising across the K emptiest is k_emptiest's explicit
  // anti-collision property, and narrowing it to favour a structurally cheap
  // tile makes our choice predictable to copycats. A ~5% stake tilt is not
  // worth becoming easy to sit on.
  const tile = pickRandom(byStake.slice(0, cfg.kEmptiest), rng);

  const allocation = new Array<bigint>(TILES_COUNT).fill(0n);
  allocation[tile] = amount;
  const ev = model.ev(allocation);
  if (!clearsEdgeFloor(ev, amount, cfg.minEdgeBps, cfg.minEvBase)) {
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
