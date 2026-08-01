/** USD amount conversions. All on-chain amounts are base units (6 decimals). */

export const USD_DECIMALS = 6;
export const USD_BASE = 10n ** BigInt(USD_DECIMALS);

export function usdToBase(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) throw new RangeError(`invalid USD amount: ${usd}`);
  return BigInt(Math.round(usd * Number(USD_BASE)));
}

export function baseToUsd(base: bigint): number {
  return Number(base) / Number(USD_BASE);
}
