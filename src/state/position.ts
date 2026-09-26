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

/**
 * Hold the shares, or claim and stake? Claiming pays the vault exit fee
 * (10%) once; RUSH can then be staked at the staking yield (paid in BTC),
 * claimed BTC earns nothing. Holding earns the vault carry (the exit fees
 * of everyone who leaves). Per leg, over `days`: value if held vs value
 * if claimed now, and the carry rate below which claiming would win.
 */
export interface HoldVerdictLeg {
  heldUsd: number;
  claimedUsd: number;
  /** heldUsd − claimedUsd: positive = holding wins. */
  holdEdgeUsd: number;
  /** Daily carry at which the two tie over `days`; holding wins while the live carry is above it. */
  breakevenCarryDaily: number;
}
export interface HoldVerdict {
  days: number;
  btc: HoldVerdictLeg;
  rush: HoldVerdictLeg;
  /** Break-even carry over a full year, where the exit fee has amortised most. */
  breakevenCarryDailyYear: { btc: number; rush: number };
  holdWins: boolean;
}

export function holdVsClaim(input: {
  btcUsd: number;
  rushUsd: number;
  carry: { sats: number; token: number };
  stakingYieldDaily: number;
  exitFeeBps: number;
  days: number;
  /**
   * USD value of the deferred hashrate a full BTC claim releases (claim_sats
   * converts Miner.unclaimed_hashrate into spendable hashrate pro rata to
   * the shares claimed). A one-off benefit on the claim side.
   */
  btcClaimReleasesUsd?: number | undefined;
}): HoldVerdict {
  const d = input.days;
  const keep = 1 - input.exitFeeBps / 10_000;
  const leg = (usd: number, carry: number, afterClaimDaily: number, bonusUsd: number): HoldVerdictLeg => {
    const heldUsd = usd * Math.pow(1 + carry, d);
    const claimedUsd = usd * keep * Math.pow(1 + afterClaimDaily, d) + bonusUsd;
    // (1+c)^d = keep·(1+y)^d + bonus/usd  ⇒  c = (keep·(1+y)^d + r)^(1/d) − 1
    const r = usd > 0 ? bonusUsd / usd : 0;
    const breakevenCarryDaily = Math.pow(keep * Math.pow(1 + afterClaimDaily, d) + r, 1 / d) - 1;
    return { heldUsd, claimedUsd, holdEdgeUsd: heldUsd - claimedUsd, breakevenCarryDaily };
  };
  const release = Math.max(0, input.btcClaimReleasesUsd ?? 0);
  const btc = leg(input.btcUsd, input.carry.sats, 0, release);
  const rush = leg(input.rushUsd, input.carry.token, input.stakingYieldDaily, 0);
  const rYear = input.btcUsd > 0 ? release / input.btcUsd : 0;
  return {
    days: d,
    btc,
    rush,
    breakevenCarryDailyYear: {
      btc: Math.pow(keep + rYear, 1 / 365) - 1,
      rush: Math.pow(keep, 1 / 365) * (1 + input.stakingYieldDaily) - 1,
    },
    holdWins: btc.holdEdgeUsd + rush.holdEdgeUsd >= 0,
  };
}

/**
 * Break-even on the carry alone: net cash put in (deployed − returned,
 * all time) against the holdings' value today, growing at the blended
 * daily carry of the legs. Days until value ≥ cost; 0 when already ahead;
 * null when the carry cannot get there (no holdings, or no carry).
 */
export interface Breakeven {
  costBasisUsd: number;
  holdingsUsd: number;
  shortfallUsd: number;
  blendedCarryDaily: number;
  days: number | null;
  alreadyAhead: boolean;
}

export function breakevenOnCarry(input: { costBasisUsd: number; btcUsd: number; rushUsd: number; usdcUnclaimed: number; carry: { sats: number; token: number } }): Breakeven {
  const holdings = input.btcUsd + input.rushUsd + input.usdcUnclaimed;
  const growing = input.btcUsd + input.rushUsd;
  const blended = growing > 0 ? (input.btcUsd * input.carry.sats + input.rushUsd * input.carry.token) / growing : 0;
  const cost = input.costBasisUsd;
  const shortfall = cost - holdings;
  if (shortfall <= 0) return { costBasisUsd: cost, holdingsUsd: holdings, shortfallUsd: shortfall, blendedCarryDaily: blended, days: 0, alreadyAhead: true };
  if (growing <= 0 || blended <= 0 || cost - input.usdcUnclaimed <= 0) return { costBasisUsd: cost, holdingsUsd: holdings, shortfallUsd: shortfall, blendedCarryDaily: blended, days: null, alreadyAhead: false };
  // growing·(1+b)^t + usdc = cost  ⇒  t = ln((cost − usdc)/growing) / ln(1+b)
  const days = Math.log((cost - input.usdcUnclaimed) / growing) / Math.log(1 + blended);
  return { costBasisUsd: cost, holdingsUsd: holdings, shortfallUsd: shortfall, blendedCarryDaily: blended, days: Math.ceil(days), alreadyAhead: false };
}
