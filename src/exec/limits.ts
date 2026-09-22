/**
 * Risk limits derived from the bankroll, and the auto affiliate tag. Pure:
 * no orchestrator import, so tests and scripts can use them without
 * loading the whole bot (the orchestrator module graph takes seconds on a
 * cold runner — importing it inside a 5 s test timed CI out).
 */
import type { PublicKey } from "@solana/web3.js";
import { usdToBase } from "../units.js";

/**
 * The risk limits in auto mode. Per round: the fleet's deployable USDC (cash
 * is the only cap; the selector and Kelly size below it). Daily: a fraction
 * of the day's opening USDC, never below $5. A configured positive value is a
 * hard figure instead. Exported for tests.
 */
export function deriveLimits(
  cfg: { MAX_PER_ROUND_USD: number; DAILY_LOSS_CAP_USD: number; AUTO_DAILY_LOSS_FRACTION: number },
  fleetUsdcBase: bigint,
  dayOpenUsdcBase: bigint | null,
): { maxPerRound: bigint; dailyLossCap: bigint } {
  const floor = usdToBase(1);
  const maxPerRound = cfg.MAX_PER_ROUND_USD > 0 ? usdToBase(cfg.MAX_PER_ROUND_USD) : fleetUsdcBase > floor ? fleetUsdcBase : floor;
  const base = dayOpenUsdcBase ?? fleetUsdcBase;
  const autoDaily = BigInt(Math.round(Number(base) * cfg.AUTO_DAILY_LOSS_FRACTION));
  const dailyFloor = usdToBase(5);
  const dailyLossCap = cfg.DAILY_LOSS_CAP_USD > 0 ? usdToBase(cfg.DAILY_LOSS_CAP_USD) : autoDaily > dailyFloor ? autoDaily : dailyFloor;
  return { maxPerRound, dailyLossCap };
}

/** Affiliate tag derived from the primary's public key when none is configured: `sr` + the first 10 alphanumerics, lower-cased. */
export function autoAffiliateTag(primary: PublicKey): string {
  return ("sr" + primary.toBase58().toLowerCase().replace(/[^a-z0-9]/g, "")).slice(0, 12);
}
