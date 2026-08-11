/**
 * Hashrate accrual — the program's reward formula, mirrored exactly.
 *
 *   R = floor( s · (α·m·n + β·N) / (n · usd_unit) )        α = β = 1
 *
 * i.e. per whole USD deployed you earn `m + N/n` RAW units, where
 *   m = streak multiplier frozen at deploy (capped at REWARD_MAX_STREAK),
 *   n = tiles covered by the deployment,
 *   N = total tiles (21).
 * Raw units carry 2 display decimals: 100 raw = 1.00 point.
 *
 * Two channels, and the second one is why this belongs in the EV model rather
 * than as a flat per-dollar constant:
 *   - loyalty  (m)   — linear in streak, so never missing a round compounds.
 *   - skill    (N/n) — INVERSELY proportional to coverage. A single-tile bet
 *                      earns 21; covering the whole board earns 1.
 *
 * That means hashrate value is a function of the ALLOCATION, not just its size:
 * spreading wide dilutes it 11×. Modelling it as a flat rebate (the previous
 * approach) hides that entirely and lets the selector spread for free.
 *
 * A promo multiplier (currently 2× for 4h after each Sat Strike) scales R.
 *
 * NOT credited here: the deferred bonus (unclaimed_hashrate_bps, 35% of R) is
 * real but locked until `claim_sats`, which costs the 10% sats-vault claim fee.
 * Leaving it out keeps the estimate conservative — the safe direction when this
 * feeds Kelly sizing.
 */
import { TILES_COUNT } from "./ev.js";

/** Program cap on the streak multiplier (REWARD_MAX_STREAK). */
export const REWARD_MAX_STREAK = 100;

/** Raw hashrate units per whole USD deployed: m + N/n. */
export function hashrateRawPerUsd(streak: number, tilesCovered: number): number {
  if (!Number.isFinite(streak) || streak < 0) {
    throw new RangeError(`invalid streak: ${streak}`);
  }
  if (!Number.isInteger(tilesCovered) || tilesCovered < 1 || tilesCovered > TILES_COUNT) {
    throw new RangeError(`invalid tilesCovered: ${tilesCovered}`);
  }
  const m = Math.min(streak, REWARD_MAX_STREAK);
  return m + TILES_COUNT / tilesCovered;
}

export interface HashrateValuation {
  /** Miner's current_streak_count at deploy time (capped internally at 100). */
  streak: number;
  /** USD value of ONE RAW hashrate unit (100 raw = 1 display point). */
  valueUsdPerRawUnit: number;
  /** Promo multiplier on earned hashrate (2 during the post-Strike window). */
  multiplier: number;
}

/**
 * Hashrate value earned per unit of gross deployed, as a FRACTION of gross —
 * directly addable to an EV computed in the same units.
 *
 * Derivation (the base-unit scale cancels): for gross G base units,
 *   R_raw   = (G / 1e6) · (m + N/n) · multiplier
 *   value$  = R_raw · valueUsdPerRawUnit
 *   value_base = value$ · 1e6 = G · (m + N/n) · multiplier · valueUsdPerRawUnit
 * so the fraction of gross is simply (m + N/n) · multiplier · valuePerRaw.
 */
export function hashrateRebateFraction(
  v: HashrateValuation,
  tilesCovered: number,
): number {
  if (!Number.isFinite(v.valueUsdPerRawUnit) || v.valueUsdPerRawUnit < 0) {
    throw new RangeError(`invalid valueUsdPerRawUnit: ${v.valueUsdPerRawUnit}`);
  }
  if (!Number.isFinite(v.multiplier) || v.multiplier <= 0) {
    throw new RangeError(`invalid multiplier: ${v.multiplier}`);
  }
  if (v.valueUsdPerRawUnit === 0) return 0;
  return hashrateRawPerUsd(v.streak, tilesCovered) * v.multiplier * v.valueUsdPerRawUnit;
}

/**
 * Promo multiplier for the post-Sat-Strike bonus window: 2× for `windowMs`
 * after a Strike, with the timer RESET by any Strike inside the window (so we
 * only track the most recent trigger). 1 when no Strike has been seen.
 */
export function strikeBonusMultiplier(opts: {
  lastStrikeAtMs: number | null;
  nowMs: number;
  windowMs: number;
  multiplier: number;
}): number {
  const { lastStrikeAtMs, nowMs, windowMs, multiplier } = opts;
  if (lastStrikeAtMs === null) return 1;
  if (!(windowMs > 0) || !(multiplier > 0)) return 1;
  const elapsed = nowMs - lastStrikeAtMs;
  return elapsed >= 0 && elapsed < windowMs ? multiplier : 1;
}
