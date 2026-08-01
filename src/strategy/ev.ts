/**
 * Parimutuel EV model.
 *
 * p(tile wins) = 1/21 (slot-hash entropy, uniform). For an allocation vector
 * a[i] (gross base units) with my effective multiplier m:
 *
 *   EV(a) = Σ_i (1/21) · pot' · (aNet_i·m)/(S_i + aNet_i·m)  −  Σ_i a_i
 *
 * where S_i is tile i's predicted-final stake and pot' includes my own
 * contribution. All five fee legs from SatrushConfig are accounted for, in
 * the pipeline measured on devnet (docs/devnet-findings.md): the deploy legs
 * (strike + epoch + one_btc + protocol) come off the gross before stakes hit
 * tiles; the sats_vault_round leg comes off the round pot at the swap.
 *
 * STAKE_SEMANTICS (CLAUDE.md open question 1): under "raw", S_i is other
 * players' raw net USD and we assume their multiplier is 1 (unobservable);
 * under "effective", S_i already embeds their multipliers. Both reduce to
 * the same arithmetic today — the flag is plumbed through so the two can
 * diverge after devnet experiments without touching callers.
 */
import type { SatrushConfig } from "../adapter/idl.js";
import { maskToTiles } from "../adapter/mask.js";

export const TILES_COUNT = 21;
const P_WIN = 1 / TILES_COUNT;
const BPS = 10_000;

export type StakeSemantics = "raw" | "effective";
export type SplitSemantics = "even" | "per_tile";

export interface FeeModel {
  /** Legs deducted from the gross deploy before stakes hit tiles (bps). */
  deployFeeBps: number;
  /** Leg deducted from the round pot at the USD→BTC swap (bps). */
  satsVaultRoundBps: number;
}

/** All five fee legs, read from the on-chain SatrushConfig. */
export function feeModelFromConfig(config: SatrushConfig): FeeModel {
  return {
    deployFeeBps:
      config.strike_fee_bps +
      config.epoch_fee_bps +
      config.one_btc_fee_bps +
      config.protocol_fee_bps,
    satsVaultRoundBps: config.sats_vault_round_fee_bps,
  };
}

export interface EvContext {
  /** Predicted-final per-tile stakes S_i (base units), length 21. */
  predictedStakes: bigint[];
  fees: FeeModel;
  /** My effective streak multiplier m (≥ 1; 1 when unknown). */
  multiplier: number;
  semantics: StakeSemantics;
}

function validateContext(ctx: EvContext): void {
  if (ctx.predictedStakes.length !== TILES_COUNT) {
    throw new RangeError(`predictedStakes must have ${TILES_COUNT} entries`);
  }
  if (!Number.isFinite(ctx.multiplier) || ctx.multiplier <= 0) {
    throw new RangeError(`invalid multiplier: ${ctx.multiplier}`);
  }
  const { deployFeeBps, satsVaultRoundBps } = ctx.fees;
  for (const [name, bps] of [
    ["deployFeeBps", deployFeeBps],
    ["satsVaultRoundBps", satsVaultRoundBps],
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
 * Round pot after all fees (base units, as a float), including my own
 * contribution: (ΣS + Σa·netFactor) · (1 − satsVaultRound).
 */
export function potAfterFees(ctx: EvContext, allocGross: bigint[]): number {
  let stakeSum = 0;
  for (const s of ctx.predictedStakes) stakeSum += Number(s);
  let grossSum = 0;
  for (const a of allocGross) grossSum += Number(a);
  const myNet = grossSum * netFactor(ctx.fees);
  return (stakeSum + myNet) * (1 - ctx.fees.satsVaultRoundBps / BPS);
}

/** Expected profit (base units, float; negative = losing bet). */
export function evOfAllocation(ctx: EvContext, allocGross: bigint[]): number {
  validateContext(ctx);
  if (allocGross.length !== TILES_COUNT) {
    throw new RangeError(`allocation must have ${TILES_COUNT} entries`);
  }
  const pot = potAfterFees(ctx, allocGross);
  const nf = netFactor(ctx.fees);
  const m = ctx.multiplier;

  let expectedPayout = 0;
  let cost = 0;
  for (let i = 0; i < TILES_COUNT; i++) {
    const gross = allocGross[i] ?? 0n;
    if (gross < 0n) throw new RangeError(`negative allocation on tile ${i}`);
    if (gross === 0n) continue;
    cost += Number(gross);
    const myEffective = Number(gross) * nf * m;
    // "raw": S_i is others' raw stake, assumed multiplier 1.
    // "effective": S_i is already in effective units.
    // Identical arithmetic today; the branch point lives here by design.
    const othersEffective = Number(ctx.predictedStakes[i] ?? 0n);
    expectedPayout += P_WIN * pot * (myEffective / (othersEffective + myEffective));
  }
  return expectedPayout - cost;
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
