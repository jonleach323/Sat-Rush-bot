/** USD amount conversions. All on-chain amounts are base units (6 decimals). */

export const USD_DECIMALS = 6;
export const USD_BASE = 10n ** BigInt(USD_DECIMALS);

/** Sign-agnostic conversion — negatives are valid for P&L deltas. */
export function usdToBase(usd: number): bigint {
  if (!Number.isFinite(usd)) throw new RangeError(`invalid USD amount: ${usd}`);
  return BigInt(Math.round(usd * Number(USD_BASE)));
}

export function baseToUsd(base: bigint): number {
  return Number(base) / Number(USD_BASE);
}

/**
 * Nominal Solana slot time. Solana targets 400ms; real slots run slightly
 * longer under load and skipped slots stretch wall-clock further, so treat any
 * slots→seconds conversion as an estimate and never as a deadline.
 */
export const SLOT_SECONDS = 0.4;
