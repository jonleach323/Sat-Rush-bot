/**
 * Parimutuel EV model.
 *
 * p(tile wins) = 1/21 (slot-hash entropy, uniform). For an allocation vector
 * a[i] (gross base units) with my effective multiplier m:
 *
 *   EV(a) = Σ_i (1/21) · pot' · (aNet_i·m)/(S_i + aNet_i·m)  −  Σ_i a_i
 *
 * where S_i is tile i's predicted-final stake and pot' includes my own
 * contribution. Fee legs from SatrushConfig, per the confirmed game economics:
 * the deploy legs (strike + epoch + one_btc + protocol) come off the gross
 * before stakes hit tiles. The sats_vault_round leg does NOT leave the pot: it
 * is swapped to BTC and paid back to the winning tile's stakers pro-rata as
 * vault shares (the same pro-rata distribution as the USD pot). Its only true
 * cost is the sats_vault_claim fee paid to convert those shares back to BTC, so
 * it reduces the effective pot by (satsVaultRound · satsVaultClaim), not by the
 * full satsVaultRound. Treating it as fully lost (the previous model) under-
 * valued every win by ~the vault leg and made the selector skip beatable boards.
 *
 * Conservative scope: the deploy legs are modeled as a cost, partially rebated
 * by the hashrate a deploy earns (hashrateRebateFraction) — every deploy earns
 * hashrate, winners and losers, so it lowers the effective fee and softens loss
 * outcomes. That rebate is 0 until the hashrate→USD value is actually known
 * (the vault path prices a point), so nothing speculative is credited. The
 * strike jackpot is credited at its true expectation (strikeExpectedPot =
 * jackpot / modulus) — a random ~1/1440 draw that can't be timed, but whose
 * expected value is real and rises with the pending pool.
 *
 * STAKE_SEMANTICS (CLAUDE.md open question 1): under "raw", S_i is other
 * players' raw net USD and we assume their multiplier is 1 (unobservable);
 * under "effective", S_i already embeds their multipliers. Both reduce to
 * the same arithmetic today — the flag is plumbed through so the two can
 * diverge after devnet experiments without touching callers.
 */
import type { SatrushConfig } from "../adapter/idl.js";
import { maskToTiles } from "../adapter/mask.js";
import { hashrateRebateFraction, type HashrateValuation } from "./hashrate.js";

export const TILES_COUNT = 21;
const P_WIN = 1 / TILES_COUNT;
const BPS = 10_000;

export type StakeSemantics = "raw" | "effective";
export type SplitSemantics = "even" | "per_tile";

export interface FeeModel {
  /** Legs deducted from the gross deploy before stakes hit tiles (bps). */
  deployFeeBps: number;
  /** Round leg swapped to BTC and paid back to winners as vault shares (bps). */
  satsVaultRoundBps: number;
  /** Fee to convert vault shares back to BTC — the real cost of the round leg (bps). */
  satsVaultClaimBps: number;
}

/** Fee legs read from the on-chain SatrushConfig. */
export function feeModelFromConfig(config: SatrushConfig): FeeModel {
  return {
    deployFeeBps:
      config.strike_fee_bps +
      config.epoch_fee_bps +
      config.one_btc_fee_bps +
      config.protocol_fee_bps,
    satsVaultRoundBps: config.sats_vault_round_fee_bps,
    satsVaultClaimBps: config.sats_vault_claim_fee_bps,
  };
}

export interface EvContext {
  /** Predicted-final per-tile stakes S_i (base units), length 21. */
  predictedStakes: bigint[];
  fees: FeeModel;
  /** My effective streak multiplier m (≥ 1; 1 when unknown). */
  multiplier: number;
  semantics: StakeSemantics;
  /**
   * Hashrate rebate as a FLAT fraction of gross deployed. Legacy/manual escape
   * hatch — prefer `hashrate` below, which derives the rebate from the program
   * formula and so correctly depends on tile coverage and streak. When both are
   * set they are summed (normally only one is used). Undefined = 0.
   */
  hashrateRebateFraction?: number | undefined;
  /**
   * Hashrate valuation, applied per the program formula R = s·(m + N/n): the
   * rebate scales with the miner's streak and INVERSELY with the number of
   * tiles covered, so the selector correctly prefers concentration. Inert while
   * `valueUsdPerRawUnit` is 0 (i.e. until the vault prices a hashrate unit).
   */
  hashrate?: HashrateValuation | undefined;
  /**
   * Expected strike-jackpot value distributed to the winning tile this round
   * (base units) = P(strike) · jackpot = strikePool / strike_trigger_modulus.
   * Sat Strike fires when `rng % modulus == 0` (truly random, ~1/1440) and rolls
   * the accumulated jackpot onto the winning tile's stakers pro-rata — the same
   * share as the pot. It cannot be timed, but its expectation is real and grows
   * with the pending pool, so late-cycle rounds are genuinely richer and sizing
   * responds on its own. Added to the pot in the payout term only. Undefined = 0.
   */
  strikeExpectedPot?: number | undefined;
}

function validateContext(ctx: EvContext): void {
  if (ctx.predictedStakes.length !== TILES_COUNT) {
    throw new RangeError(`predictedStakes must have ${TILES_COUNT} entries`);
  }
  if (!Number.isFinite(ctx.multiplier) || ctx.multiplier <= 0) {
    throw new RangeError(`invalid multiplier: ${ctx.multiplier}`);
  }
  const rebate = ctx.hashrateRebateFraction;
  if (rebate !== undefined && (!Number.isFinite(rebate) || rebate < 0)) {
    throw new RangeError(`invalid hashrateRebateFraction: ${rebate}`);
  }
  const strike = ctx.strikeExpectedPot;
  if (strike !== undefined && (!Number.isFinite(strike) || strike < 0)) {
    throw new RangeError(`invalid strikeExpectedPot: ${strike}`);
  }
  const { deployFeeBps, satsVaultRoundBps, satsVaultClaimBps } = ctx.fees;
  for (const [name, bps] of [
    ["deployFeeBps", deployFeeBps],
    ["satsVaultRoundBps", satsVaultRoundBps],
    ["satsVaultClaimBps", satsVaultClaimBps],
  ] as const) {
    if (!Number.isInteger(bps) || bps < 0 || bps >= BPS) {
      throw new RangeError(`invalid ${name}: ${bps}`);
    }
  }
}

/** Fraction of a gross deploy that reaches the tiles. */
export function netFactor(fees: FeeModel): number {
  return 1 - fees.deployFeeBps / BPS;
}

/**
 * Total hashrate rebate for an allocation, in base units. Combines the flat
 * legacy fraction with the formula-driven term, which needs the allocation's
 * tile count — covering fewer tiles earns proportionally more hashrate, so this
 * is what lets the selector price concentration correctly.
 */
function rebateBase(ctx: EvContext, cost: number, tilesCovered: number): number {
  if (cost <= 0 || tilesCovered <= 0) return 0;
  let fraction = ctx.hashrateRebateFraction ?? 0;
  if (ctx.hashrate) fraction += hashrateRebateFraction(ctx.hashrate, tilesCovered);
  return fraction * cost;
}

/**
 * Effective round pot distributed to the winning tile's stakers (base units,
 * as a float), including my own contribution. The USD portion is
 * (ΣS + Σa·netFactor)·(1 − satsVaultRound); the sats_vault_round leg is paid
 * back to the same winners as BTC shares, worth (1 − satsVaultClaim) of itself
 * after the claim fee. Summing the two, the effective pot is
 *   (ΣS + Σa·netFactor) · (1 − satsVaultRound·satsVaultClaim).
 */
export function potAfterFees(ctx: EvContext, allocGross: bigint[]): number {
  let stakeSum = 0;
  for (const s of ctx.predictedStakes) stakeSum += Number(s);
  let grossSum = 0;
  for (const a of allocGross) grossSum += Number(a);
  const myNet = grossSum * netFactor(ctx.fees);
  const v = ctx.fees.satsVaultRoundBps / BPS;
  const c = ctx.fees.satsVaultClaimBps / BPS;
  return (stakeSum + myNet) * (1 - v * c);
}

/** Expected profit (base units, float; negative = losing bet). */
export function evOfAllocation(ctx: EvContext, allocGross: bigint[]): number {
  validateContext(ctx);
  if (allocGross.length !== TILES_COUNT) {
    throw new RangeError(`allocation must have ${TILES_COUNT} entries`);
  }
  // The expected strike jackpot is distributed to the winning tile by the same
  // pro-rata share as the pot, so it rides in the payout term as extra pot.
  const pot = potAfterFees(ctx, allocGross) + (ctx.strikeExpectedPot ?? 0);
  const nf = netFactor(ctx.fees);
  const m = ctx.multiplier;

  let expectedPayout = 0;
  let cost = 0;
  let tilesCovered = 0;
  for (let i = 0; i < TILES_COUNT; i++) {
    const gross = allocGross[i] ?? 0n;
    if (gross < 0n) throw new RangeError(`negative allocation on tile ${i}`);
    if (gross === 0n) continue;
    cost += Number(gross);
    tilesCovered++;
    const myEffective = Number(gross) * nf * m;
    // "raw": S_i is others' raw stake, assumed multiplier 1.
    // "effective": S_i is already in effective units.
    // Identical arithmetic today; the branch point lives here by design.
    const othersEffective = Number(ctx.predictedStakes[i] ?? 0n);
    expectedPayout += P_WIN * pot * (myEffective / (othersEffective + myEffective));
  }
  // Hashrate value earned on the gross deploy regardless of outcome.
  return expectedPayout - cost + rebateBase(ctx, cost, tilesCovered);
}

/**
 * EV of deploying `amountGross` with `mask`, under either answer to open
 * question 1's first half: "even" splits the amount across masked tiles
 * (the behavior measured on devnet), "per_tile" applies it to each tile.
 */
export function evOfMask(
  ctx: EvContext,
  mask: number,
  amountGross: bigint,
  split: SplitSemantics,
): number {
  if (amountGross <= 0n) throw new RangeError(`amount must be positive: ${amountGross}`);
  const tiles = maskToTiles(mask);
  const alloc = new Array<bigint>(TILES_COUNT).fill(0n);
  const per = split === "even" ? amountGross / BigInt(tiles.length) : amountGross;
  for (const tile of tiles) alloc[tile] = per;
  return evOfAllocation(ctx, alloc);
}

/**
 * Per-outcome return distribution for `allocGross`, length 21: entry i is the
 * return on total stake if tile i wins — (payout_i − cost)/cost — where
 * payout_i is my pro-rata share of the pot on tile i (0 if I'm not on it). The
 * 21 outcomes are equally likely; this is the raw distribution Kelly sizing
 * needs (probabilities applied by the caller). Returns an all-zero array when
 * nothing is staked.
 */
export function outcomeReturns(ctx: EvContext, allocGross: bigint[]): number[] {
  validateContext(ctx);
  if (allocGross.length !== TILES_COUNT) {
    throw new RangeError(`allocation must have ${TILES_COUNT} entries`);
  }
  let cost = 0;
  let tilesCovered = 0;
  for (const a of allocGross) {
    cost += Number(a);
    if (a > 0n) tilesCovered++;
  }
  if (cost <= 0) return new Array<number>(TILES_COUNT).fill(0);

  const pot = potAfterFees(ctx, allocGross) + (ctx.strikeExpectedPot ?? 0);
  const nf = netFactor(ctx.fees);
  const m = ctx.multiplier;
  // Hashrate value is earned in every outcome, so it lifts every return —
  // a losing round returns −(1 − rebate) instead of −1.
  const rebate = rebateBase(ctx, cost, tilesCovered);
  const returns = new Array<number>(TILES_COUNT).fill(0);
  for (let i = 0; i < TILES_COUNT; i++) {
    const gross = allocGross[i] ?? 0n;
    let payout = 0;
    if (gross > 0n) {
      const myEffective = Number(gross) * nf * m;
      const othersEffective = Number(ctx.predictedStakes[i] ?? 0n);
      payout = pot * (myEffective / (othersEffective + myEffective));
    }
    returns[i] = (payout + rebate - cost) / cost;
  }
  return returns;
}

/** EV gain from adding `incrementGross` to `tile` on top of `allocGross`. */
export function marginalEv(
  ctx: EvContext,
  allocGross: bigint[],
  tile: number,
  incrementGross: bigint,
): number {
  if (tile < 0 || tile >= TILES_COUNT) throw new RangeError(`invalid tile ${tile}`);
  if (incrementGross <= 0n) {
    throw new RangeError(`increment must be positive: ${incrementGross}`);
  }
  const bumped = [...allocGross];
  bumped[tile] = (bumped[tile] ?? 0n) + incrementGross;
  return evOfAllocation(ctx, bumped) - evOfAllocation(ctx, allocGross);
}
