/**
 * V2 board EV model — the parimutuel is gone, the pro-rata pools are not.
 *
 * WHAT THE PROGRAM DOES NOW (from @satrush/client@0.1.15, the V2 SDK)
 *
 *  - A deploy of gross G on n tiles still splits G/n per tile and still loses
 *    the deploy fee layer f (strike + epoch + one_btc + protocol + buybacks
 *    legs, announced 8% → 6%) before it hits the tiles.
 *  - Every LOSING tile refunds r = 89% of its gross in USD
 *    (`PublicDeploySettled.wonUsdAmount`: "losing-tile refunds (89% of gross
 *    per losing tile)"). What is neither refunded nor fee, s = 1 − f − r
 *    (= 5% at the announced layer), is the new "Sats Fee": the round swaps
 *    it to BTC and pays it to the WINNING tile's stakers pro-rata, as Sats
 *    Vault shares. The winning tile's own net stake is swapped with it, so a
 *    winner's stake comes back as BTC rather than USD.
 *  - Each round the mint program issues M RUSH at rotation
 *    (`Round.mintedTokenAmount`, a function of gross volume the SDK does not
 *    define — it is measured, `pnpm v2-strategy`). Split: 64% to the winning
 *    tile's stakers pro-rata, 16% to losing-tile stakers pro-rata, 14% to the
 *    strike pot, 6% to the epoch vault. Paid as Token Vault shares.
 *  - Sat Strike is unchanged in shape: ~1/1440 per round, rolls onto the
 *    winning tile pro-rata, now in USD + BTC + RUSH legs.
 *  - Hashrate is unchanged: (m + 21/n) raw per USD, and it still buys vault
 *    tickets. The streak now survives two skipped rounds.
 *  - Both vaults charge the same exit fee (10%) on redemption, and the fee
 *    stays in the vault: holding shares is paid by whoever claims.
 *
 * SO THE ROUND, PER DOLLAR OF GROSS ON TILE i, WHEN TILE j WINS:
 *
 *   i ≠ j :  r                     USD refund
 *          + 0.16·M·P · 1/(V − W_j) RUSH, my share of all losing gross
 *   i = j :  r                     BTC (own stake, swapped)
 *          + s·V / W_j             BTC, my pro-rata slice of the sats pool
 *          + 0.64·M·P / W_j        RUSH, my slice of the winners' leg
 *          + E_strike / W_j        the jackpot's expectation, same share
 *
 * with V the round's gross volume, W_j the gross on the winning tile (both
 * including mine), P the RUSH price. Sum over j at 1/21 each, subtract the
 * gross, add the hashrate rebate and the presence credit, and that is
 * `evOfAllocationV2`. Two things fall out of the algebra and matter:
 *
 *   1. The contested pool is  C = s·V + 0.64·M·P + E_strike  — everything
 *      keyed to the winning tile — and it is shared exactly the way V1's pot
 *      was. So the water-filler's logic is untouched: an under-stocked tile
 *      is worth (1/21)·C·a/(W+a) and own-dilution still sets the stop. Only
 *      the size of the pot changed: 5% of volume where V1 put ~88% up.
 *   2. The most a dollar can lose on the board is 1 − r = 11% (tile loses,
 *      no RUSH). Under V1 it was the whole dollar. `tollAtRiskFraction` is
 *      that number, and it is what per-round and daily caps should be sized
 *      against — a $100 V2 deploy carries the risk of an $11 V1 deploy.
 *
 * At a uniform board a proportional player gets back exactly 1 − f from the
 * USD/BTC legs and 0.80·(M·P/V) in RUSH: the fee layer is the toll, the
 * token yield per dollar of volume is the only thing that can beat it. That
 * yield is the decisive input of the whole V2 strategy and is NOT known until
 * rounds run — this model takes it as `mintedTokenValueBase` and refuses to
 * invent it (0 by default, i.e. the token is credited at nothing).
 *
 * WHAT IS ASSUMED, AND WHAT WOULD MOVE IF IT IS WRONG
 *
 *  - The winners' and losers' RUSH legs are pro-rata BY STAKE (per-tile stake
 *    sums are the only weights the program keeps). If they were per-deploy
 *    instead, small deploys would be worth more and the model would UNDER-
 *    state them. Check `wonTokenAmount / winningStake` across settlements.
 *  - The winning tile's own net stake is swapped to BTC (reading A). If it
 *    were refunded in USD (reading B) the USD/BTC mix changes, not the value
 *    at spot — the pro-rata slice of s·V is identical either way.
 *  - The refund is 8900 bps of gross regardless of the fee legs
 *    (facts.ts V2_LOSING_TILE_REFUND_BPS, stated). `v2EconomicsFromConfig`
 *    throws if the chain's fee layer makes that impossible.
 *  - Predicted stakes are NET (what Round.public_tile_stakes holds), as under
 *    V1; gross is recovered by dividing by 1 − f.
 */
import { maskToTiles } from "../adapter/mask.js";
import { TILES_COUNT, type EvModel } from "./ev.js";
import { hashrateRebateUsd, type HashrateValuation } from "./hashrate.js";
import {
  RUSH_LAUNCH_PRICE_USD,
  RUSH_MINT_PER_USD_VOLUME,
  TOKEN_SPLIT_LOSERS_BPS,
  TOKEN_SPLIT_WINNERS_BPS,
  V2_DEPLOY_FEE_LAYER_BPS,
  V2_LOSING_TILE_REFUND_BPS,
  V2_VAULT_EXIT_FEE_BPS,
} from "./facts.js";

const P_WIN = 1 / TILES_COUNT;
const BPS = 10_000;

/** The deploy fee legs of the V2 SatrushConfig (bps of gross). */
export interface V2FeeLegs {
  strike_fee_bps: number;
  epoch_fee_bps: number;
  one_btc_fee_bps: number;
  protocol_fee_bps: number;
  /** New under V2; pre-migration accounts read 0. */
  buybacks_fee_bps?: number | undefined;
  /** Exit fee on both vaults; V1's `sats_vault_claim_fee_bps` was the same slot. */
  vault_exit_fee_bps?: number | undefined;
}

export interface V2Economics {
  /** Sum of the deploy fee legs, bps of gross. Derived from SatrushConfig at use time. */
  feeLayerBps: number;
  /** USD refunded per losing-tile gross, bps. Stated 8900 until the first settlements confirm it. */
  losingRefundBps: number;
  /** Exit fee on vault redemptions, bps. Paid only if we claim. */
  vaultExitFeeBps: number;
}

/** The economics implied by the announcement, for use before the upgrade lands. */
export function statedV2Economics(): V2Economics {
  return {
    feeLayerBps: V2_DEPLOY_FEE_LAYER_BPS.value,
    losingRefundBps: V2_LOSING_TILE_REFUND_BPS.value,
    vaultExitFeeBps: V2_VAULT_EXIT_FEE_BPS.value,
  };
}

/**
 * Economics from the live config. Throws when the chain's fee layer cannot
 * coexist with the stated refund (their sum exceeding 100% means the 89% is
 * not what the program does and the model must not run on it).
 */
export function v2EconomicsFromConfig(
  config: V2FeeLegs,
  overrides: Partial<V2Economics> = {},
): V2Economics {
  const econ: V2Economics = {
    feeLayerBps:
      config.strike_fee_bps +
      config.epoch_fee_bps +
      config.one_btc_fee_bps +
      config.protocol_fee_bps +
      (config.buybacks_fee_bps ?? 0),
    losingRefundBps: V2_LOSING_TILE_REFUND_BPS.value,
    vaultExitFeeBps: config.vault_exit_fee_bps ?? V2_VAULT_EXIT_FEE_BPS.value,
    ...overrides,
  };
  validateEconomics(econ);
  return econ;
}

function validateEconomics(e: V2Economics): void {
  for (const [name, bps] of [
    ["feeLayerBps", e.feeLayerBps],
    ["losingRefundBps", e.losingRefundBps],
    ["vaultExitFeeBps", e.vaultExitFeeBps],
  ] as const) {
    if (!Number.isFinite(bps) || bps < 0 || bps > BPS) {
      throw new RangeError(`invalid ${name}: ${bps}`);
    }
  }
  if (e.feeLayerBps + e.losingRefundBps > BPS) {
    throw new RangeError(
      `fee layer ${e.feeLayerBps} bps + losing refund ${e.losingRefundBps} bps exceed 100%: ` +
        "the stated 89% refund cannot hold against this config — re-measure before trading",
    );
  }
}

/** The sats leg, bps of gross: what funds the winning tile's BTC pool. */
export function satsLegBps(e: V2Economics): number {
  validateEconomics(e);
  return BPS - e.feeLayerBps - e.losingRefundBps;
}

/**
 * Largest fraction of a gross deploy the board itself can take in one round:
 * every covered tile loses, nothing comes back but the refund. RUSH and
 * hashrate can only lift it. This is the number caps should be sized against.
 */
export function tollAtRiskFraction(e: V2Economics): number {
  validateEconomics(e);
  return 1 - e.losingRefundBps / BPS;
}

/**
 * Return on a blanket at a uniform board, as a fraction of gross, given the
 * RUSH minted per dollar of round volume (`tokenYield` = M·P/V, USD per USD).
 * Refunds and the sats pool sum to 1 − f whatever the tile draw; the winners'
 * and losers' RUSH legs both pay pro-rata by volume share, so 80% of the
 * mint comes back per dollar. The strike (14%) and epoch (6%) legs reach
 * players later and are left out here — a floor, not a point estimate.
 */
export function blanketReturnV2(e: V2Economics, tokenYield: number): number {
  validateEconomics(e);
  if (!Number.isFinite(tokenYield) || tokenYield < 0) {
    throw new RangeError(`invalid tokenYield: ${tokenYield}`);
  }
  const rushBack = (TOKEN_SPLIT_WINNERS_BPS.value + TOKEN_SPLIT_LOSERS_BPS.value) / BPS;
  return 1 - e.feeLayerBps / BPS + rushBack * tokenYield;
}

/**
 * Token yield (M·P per dollar of volume) at which presence stops losing money
 * against a toll of `leakBps`. Pass the whole fee layer for the board-only
 * view, or just the legs that never return to players (protocol; buybacks
 * buy RUSH we hold) for the all-in view. The two bracket the answer.
 */
export function breakEvenTokenYield(leakBps: number): number {
  if (!Number.isFinite(leakBps) || leakBps < 0 || leakBps > BPS) {
    throw new RangeError(`invalid leakBps: ${leakBps}`);
  }
  const rushBack = (TOKEN_SPLIT_WINNERS_BPS.value + TOKEN_SPLIT_LOSERS_BPS.value) / BPS;
  return leakBps / BPS / rushBack;
}

export interface V2EvContext {
  /**
   * Predicted-final NET per-tile stakes of OTHER players (base units), length
   * 21 — what `Round.public_tile_stakes` holds, after the fee layer.
   */
  predictedStakes: bigint[];
  econ: V2Economics;
  /**
   * USD value (base units) of the RUSH this round will mint: M·P. The one
   * input the program does not publish ahead of time; 0 credits the token at
   * nothing, which is the honest default until it is measured and priced.
   */
  mintedTokenValueBase: number;
  /**
   * USD of RUSH minted per USD of gross round volume — the token yield `y`
   * when the mint is PROPORTIONAL to volume (the owner's launch rule: 1 RUSH
   * per $500 at $10 is y = 0.02). When set it replaces `mintedTokenValueBase`
   * with y·V, where V includes our own allocation — so the token leg grows
   * with the deploy the way the program's does. Use `statedTokenYield()` for
   * the launch numbers, or the measured rate times the oracle price.
   */
  tokenYieldPerVolume?: number | undefined;
  /**
   * Expected strike jackpot rolled onto the winning tile this round (base
   * units) — USD + BTC + RUSH legs valued, times the payout fraction, over the
   * trigger modulus. Undefined = 0.
   */
  strikeExpectedPot?: number | undefined;
  /** Hashrate valuation, as under V1 (see hashrate.ts). */
  hashrate?: HashrateValuation | undefined;
  /** Fixed presence credit (base units), as under V1 (see streak.ts). */
  presenceCreditBase?: number | undefined;
  /**
   * Presence credit PER COVERED TILE (base units, length 21): the fleet's
   * tile mode sends tile i from wallet i, and every wallet has its own
   * streak — so "deploying at all" is worth something once per wallet that
   * deploys, not once per round. A single fixed credit was claimed by the
   * selector with $1 on one tile, one wallet advancing while twenty stood
   * still (2026-09-22). Added on top of `presenceCreditBase`.
   */
  presenceCreditPerTileBase?: readonly number[] | undefined;
  /**
   * Value BTC and RUSH legs net of the vault exit fee, i.e. as if we will
   * claim them. Default false: the carry makes holding at least as good as
   * claiming, and the bot holds.
   */
  valueNetOfExitFee?: boolean | undefined;
  /**
   * The vault carry credited on the share legs: the FRACTION the shares are
   * expected to appreciate over the holding horizon (daily carry × days), for
   * the sats vault (BTC leg, strike BTC) and the token vault (RUSH legs).
   * Both vaults keep the 10% exit fee of every redemption for the holders
   * who stay, so the ratio ratchets up as others claim (facts.ts
   * SATS_VAULT_CARRY_DAILY). Undefined = 0: the honest default, since the
   * carry is a transfer from leavers that decays, and it only exists for a
   * holder who never claims.
   */
  shareCarry?: { sats: number; token: number } | undefined;
}

function validateContext(ctx: V2EvContext): void {
  if (ctx.predictedStakes.length !== TILES_COUNT) {
    throw new RangeError(`predictedStakes must have ${TILES_COUNT} entries`);
  }
  validateEconomics(ctx.econ);
  if (!Number.isFinite(ctx.mintedTokenValueBase) || ctx.mintedTokenValueBase < 0) {
    throw new RangeError(`invalid mintedTokenValueBase: ${ctx.mintedTokenValueBase}`);
  }
  for (const [name, v] of [
    ["tokenYieldPerVolume", ctx.tokenYieldPerVolume],
    ["strikeExpectedPot", ctx.strikeExpectedPot],
    ["presenceCreditBase", ctx.presenceCreditBase],
    ...(ctx.presenceCreditPerTileBase ?? []).map((v, i) => [`presenceCreditPerTileBase[${i}]`, v] as const),
    ["shareCarry.sats", ctx.shareCarry?.sats],
    ["shareCarry.token", ctx.shareCarry?.token],
  ] as const) {
    if (v !== undefined && (!Number.isFinite(v) || v < 0)) {
      throw new RangeError(`invalid ${name}: ${v}`);
    }
  }
}

function validateAllocation(allocGross: bigint[]): void {
  if (allocGross.length !== TILES_COUNT) {
    throw new RangeError(`allocation must have ${TILES_COUNT} entries`);
  }
  for (let i = 0; i < TILES_COUNT; i++) {
    if ((allocGross[i] ?? 0n) < 0n) throw new RangeError(`negative allocation on tile ${i}`);
  }
}

interface Outcomes {
  /** Total gross allocated (base units). */
  cost: number;
  /** Payout if tile j wins (base units), length 21, before rebate/presence. */
  payouts: number[];
  /** Hashrate rebate plus presence credit (base units), earned in every outcome. */
  fixed: number;
}

/**
 * Per-outcome payouts. Reading A for the winning tile (own stake to BTC);
 * reading B differs only in whether that leg is USD, which at spot is the same
 * number — and only the exit-fee haircut can tell them apart.
 */
function outcomes(ctx: V2EvContext, allocGross: bigint[]): Outcomes {
  const f = ctx.econ.feeLayerBps / BPS;
  const r = ctx.econ.losingRefundBps / BPS;
  const s = satsLegBps(ctx.econ) / BPS;
  const haircut = ctx.valueNetOfExitFee ? 1 - ctx.econ.vaultExitFeeBps / BPS : 1;
  // Carry on what we HOLD: BTC shares (sats vault) and RUSH shares (token vault).
  const satsCarry = 1 + (ctx.shareCarry?.sats ?? 0);
  const tokenCarry = 1 + (ctx.shareCarry?.token ?? 0);
  const winnersLeg = TOKEN_SPLIT_WINNERS_BPS.value / BPS;
  const losersLeg = TOKEN_SPLIT_LOSERS_BPS.value / BPS;
  const strike = ctx.strikeExpectedPot ?? 0;

  const mine = allocGross.map((a) => Number(a));
  // Others' stakes are net; the pools are keyed to gross.
  const othersGross = ctx.predictedStakes.map((sNet) => Number(sNet) / (1 - f));
  let cost = 0;
  let tilesCovered = 0;
  let perTileCredit = 0;
  for (const [i, a] of mine.entries()) {
    cost += a;
    if (a > 0) {
      tilesCovered++;
      perTileCredit += ctx.presenceCreditPerTileBase?.[i] ?? 0;
    }
  }
  let volume = cost;
  for (const w of othersGross) volume += w;
  // Proportional emission: the mint scales with the round's gross, ours included.
  const mp = ctx.tokenYieldPerVolume !== undefined
    ? ctx.tokenYieldPerVolume * volume
    : ctx.mintedTokenValueBase;

  const payouts = new Array<number>(TILES_COUNT).fill(0);
  if (cost <= 0) return { cost: 0, payouts, fixed: 0 };

  for (let j = 0; j < TILES_COUNT; j++) {
    const aj = mine[j] ?? 0;
    const wj = (othersGross[j] ?? 0) + aj;
    let payout = 0;
    if (aj > 0) {
      const share = aj / wj;
      // Own stake back as BTC, the contested sats pool, the winners' RUSH leg
      // and the jackpot, all by the same pro-rata share.
      payout +=
        haircut * satsCarry * (r * aj + s * volume * share + strike * share) +
        haircut * tokenCarry * winnersLeg * mp * share;
    }
    // Every other covered tile refunds in USD, no haircut.
    const losing = cost - aj;
    payout += r * losing;
    // The losers' RUSH leg is pro-rata across ALL losing gross. When the whole
    // round sat on the winning tile it goes to the strike pot instead.
    const losingGross = volume - wj;
    if (losing > 0 && losingGross > 0) {
      payout += haircut * tokenCarry * losersLeg * mp * (losing / losingGross);
    }
    payouts[j] = payout;
  }

  let fixed = (ctx.presenceCreditBase ?? 0) + perTileCredit;
  if (ctx.hashrate) {
    // Same units dance as V1: cost is base units, the valuation wants USD.
    fixed += hashrateRebateUsd(ctx.hashrate, tilesCovered, cost / 1e6) * 1e6;
  }
  return { cost, payouts, fixed };
}

/** Expected profit (base units, float; negative = losing bet). */
export function evOfAllocationV2(ctx: V2EvContext, allocGross: bigint[]): number {
  validateContext(ctx);
  validateAllocation(allocGross);
  const o = outcomes(ctx, allocGross);
  if (o.cost <= 0) return 0;
  let expected = 0;
  for (const p of o.payouts) expected += P_WIN * p;
  return expected - o.cost + o.fixed;
}

/**
 * Per-outcome return on total stake, length 21 — what Kelly sizes off. The
 * floor is −(1 − r) plus whatever RUSH and hashrate add, never −1: that is the
 * whole reason V2 sizing differs from V1's.
 */
export function outcomeReturnsV2(ctx: V2EvContext, allocGross: bigint[]): number[] {
  validateContext(ctx);
  validateAllocation(allocGross);
  const o = outcomes(ctx, allocGross);
  if (o.cost <= 0) return new Array<number>(TILES_COUNT).fill(0);
  return o.payouts.map((p) => (p + o.fixed - o.cost) / o.cost);
}

/** EV gain from adding `incrementGross` to `tile` on top of `allocGross`. */
export function marginalEvV2(
  ctx: V2EvContext,
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
  return evOfAllocationV2(ctx, bumped) - evOfAllocationV2(ctx, allocGross);
}

/** EV of deploying `amountGross` evenly across `mask` (the on-chain split). */
export function evOfMaskV2(ctx: V2EvContext, mask: number, amountGross: bigint): number {
  if (amountGross <= 0n) throw new RangeError(`amount must be positive: ${amountGross}`);
  const tiles = maskToTiles(mask);
  const alloc = new Array<bigint>(TILES_COUNT).fill(0n);
  const per = amountGross / BigInt(tiles.length);
  for (const tile of tiles) alloc[tile] = per;
  return evOfAllocationV2(ctx, alloc);
}

/** The V2 economics as an `EvModel`, for `selectAllocation`. */
export function v2Model(ctx: V2EvContext): EvModel {
  validateContext(ctx);
  return {
    predictedStakes: ctx.predictedStakes,
    ev: (alloc) => evOfAllocationV2(ctx, alloc),
    marginal: (alloc, tile, inc) => marginalEvV2(ctx, alloc, tile, inc),
    returns: (alloc) => outcomeReturnsV2(ctx, alloc),
  };
}

/**
 * RUSH minted per dollar of round volume, valued: the number that decides
 * whether V2 presence pays. Both inputs in USD.
 */
export function tokenYield(mintedTokenValueUsd: number, grossVolumeUsd: number): number {
  if (!(grossVolumeUsd > 0)) return 0;
  return Math.max(0, mintedTokenValueUsd) / grossVolumeUsd;
}

/**
 * The launch token yield from the owner's two stated numbers: 1 RUSH per
 * $500 of volume at $10 → 2% of volume. Pass a live oracle price to re-mark.
 */
export function statedTokenYield(priceUsd = RUSH_LAUNCH_PRICE_USD.value): number {
  if (!Number.isFinite(priceUsd) || priceUsd < 0) throw new RangeError(`invalid price: ${priceUsd}`);
  return RUSH_MINT_PER_USD_VOLUME.value * priceUsd;
}

/**
 * RUSH price at which presence breaks even against a toll of `leakBps`, given
 * the launch mint rate: the yield needed divided by tokens per dollar.
 */
export function breakEvenTokenPriceUsd(leakBps: number): number {
  return breakEvenTokenYield(leakBps) / RUSH_MINT_PER_USD_VOLUME.value;
}
