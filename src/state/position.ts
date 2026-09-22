/**
 * The fleet's position and where it goes if held: unclaimed USD, BTC and
 * RUSH vault shares valued at the vault rate, hashrate as tickets — summed
 * over every wallet's Miner — and a projection that compounds the vault
 * carry on what is held while adding what the current run rate accrues.
 * Pure: the orchestrator supplies Miners, vaults, prices and the run rate.
 */
import type { Miner, SatsVault, TokenVault } from "../adapter/generated-types.js";

const BTC_DECIMALS = 8; // cbBTC-style (FINDINGS E6)
const RUSH_DECIMALS = 9;

export interface FleetPosition {
  wallets: number;
  /** Claimable USDC across Miners (base units). */
  usdcUnclaimedBase: bigint;
  satsShares: bigint;
  btc: number;
  btcUsd: number;
  /** BTC per share at the vault rate (0 when the vault is unknown). */
  btcPerShare: number;
  tokenShares: bigint;
  rush: number;
  rushUsd: number;
  rushPerShare: number;
  /** Liquid hashrate held on the Miners (raw units) and the deferred 35% still to be claimed. */
  hashrateLiquid: number;
  hashrateDeferred: number;
  tickets: number;
  grubstakeUsd: number;
  /** Everything unclaimed, in USD at today's prices. */
  totalUnclaimedUsd: number;
}

export function fleetPosition(input: {
  miners: Miner[];
  satsVault: SatsVault | null;
  tokenVault: TokenVault | null;
  btcUsd: number;
  rushUsd: number;
  rawPerTicket: number;
}): FleetPosition {
  const n = (x: { toString(): string }) => Number(x.toString());
  const sv = input.satsVault;
  const tv = input.tokenVault;
  const btcPerShare = sv && n(sv.btc_shares) > 0 ? n(sv.btc_amount) / n(sv.btc_shares) / 10 ** BTC_DECIMALS : 0;
  const rushPerShare = tv && n(tv.token_shares) > 0 ? n(tv.token_amount) / n(tv.token_shares) / 10 ** RUSH_DECIMALS : 0;
  let usdc = 0n, satsShares = 0n, tokenShares = 0n, hrLiquid = 0, hrDeferred = 0, grub = 0;
  for (const m of input.miners) {
    usdc += BigInt(m.unclaimed_usd_amount.toString());
    satsShares += BigInt(m.unclaimed_btc_shares.toString());
    tokenShares += BigInt(m.unclaimed_token_shares.toString());
    hrLiquid += n(m.hashrate_amount);
    hrDeferred += n(m.unclaimed_hashrate);
    grub += n(m.grubstake_usd_amount) / 1e6;
  }
  const btc = Number(satsShares) * btcPerShare;
  const rush = Number(tokenShares) * rushPerShare;
  const btcUsd = btc * input.btcUsd;
  const rushUsd = rush * input.rushUsd;
  return {
    wallets: input.miners.length,
    usdcUnclaimedBase: usdc,
    satsShares, btc, btcUsd, btcPerShare,
    tokenShares, rush, rushUsd, rushPerShare,
    hashrateLiquid: hrLiquid,
    hashrateDeferred: hrDeferred,
    tickets: input.rawPerTicket > 0 ? (hrLiquid + hrDeferred) / input.rawPerTicket : 0,
    grubstakeUsd: grub,
    totalUnclaimedUsd: Number(usdc) / 1e6 + btcUsd + rushUsd,
  };
}

/** What one day of the current run rate adds, in the position's units. */
export interface RunRate {
  /** Wall-clock span the rate was measured over (hours), for the caveat line. */
  sampleHours: number;
  btcPerDay: number;
  rushPerDay: number;
  hashratePerDay: number;
  /** Settled USD back minus gross deployed, per day. */
  usdNetPerDay: number;
  grossPerDay: number;
}

export interface Projection {
  days: number;
  btc: number;
  rush: number;
  hashrate: number;
  tickets: number;
  btcUsd: number;
  rushUsd: number;
  usdNet: number;
  /** Total USD change vs today at today's prices: shares' growth + net USD. */
  gainUsd: number;
  /** Of which, the vault carry on what is held and accrued. */
  carryUsd: number;
}

/**
 * Held × (1+c)^d plus accrual a per day compounding from the day it lands:
 * a · ((1+c)^d − 1) / c. Prices held constant — it is the same price risk
 * on every leg, and the point is quantities.
 */
export function projectHolding(input: {
  position: FleetPosition;
  rate: RunRate;
  days: number;
  carry: { sats: number; token: number };
  btcUsd: number;
  rushUsd: number;
  rawPerTicket: number;
}): Projection {
  const { position: p, rate: r, days: d } = input;
  const grow = (held: number, perDay: number, c: number) => {
    if (c <= 0) return held + perDay * d;
    const g = Math.pow(1 + c, d);
    return held * g + perDay * ((g - 1) / c);
  };
  const btc = grow(p.btc, r.btcPerDay, input.carry.sats);
  const rush = grow(p.rush, r.rushPerDay, input.carry.token);
  const btcNoCarry = p.btc + r.btcPerDay * d;
  const rushNoCarry = p.rush + r.rushPerDay * d;
  const hashrate = p.hashrateLiquid + p.hashrateDeferred + r.hashratePerDay * d;
  const btcUsd = btc * input.btcUsd;
  const rushUsd = rush * input.rushUsd;
  const usdNet = r.usdNetPerDay * d;
  const carryUsd = (btc - btcNoCarry) * input.btcUsd + (rush - rushNoCarry) * input.rushUsd;
  return {
    days: d, btc, rush, hashrate,
    tickets: input.rawPerTicket > 0 ? hashrate / input.rawPerTicket : 0,
    btcUsd, rushUsd, usdNet,
    gainUsd: btcUsd - p.btcUsd + (rushUsd - p.rushUsd) + usdNet,
    carryUsd,
  };
}
