/**
 * The option value of an unbroken streak.
 *
 * Hashrate accrues at (m + 21/n) raw units per USD, where m is the streak
 * counter — capped at REWARD_MAX_STREAK, incremented on every consecutively
 * played round, and RESET TO 1 by a single missed round (measured: 28 → 1).
 *
 * That reset is the largest single number in this client's economics and
 * nothing was pricing it. A round's deploy was judged on its own board EV, so
 * the bot would decline a round to avoid a few cents of parimutuel toll and, in
 * doing so, throw away the accrual rate that every FUTURE round depends on.
 * Over 2,100 consecutive rounds it did exactly that.
 *
 * What a break actually costs, in raw units per dollar-per-round:
 *
 *   without the break, round j earns  min(S + j, CAP)
 *   with it,           round j earns  min(j, CAP)
 *
 * so the loss is Σ_j [min(S+j, CAP) − j] over the catch-up window — the streak
 * is not lost forever, only until the counter re-saturates, which bounds the
 * cost. At S = CAP = 100 that sum is 4,950 raw per dollar-per-round; at S = 28
 * it is 2,394. Multiplied by a $10/round deploy and a realisable hashrate price
 * it lands in the tens of dollars, against a per-round board toll measured in
 * cents. Two orders of magnitude — which is why the model has to carry it.
 *
 * This is a PRESENCE credit, not a size credit: it is earned by deploying at
 * all, and is identical whether the deploy is the minimum or the maximum. So it
 * belongs as a fixed term on the first unit allocated, never as a per-dollar
 * rebate — crediting it per dollar would argue for deploying the maximum every
 * round, which is a different (and wrong) claim.
 */
import { REWARD_MAX_STREAK } from "./hashrate.js";
import { STREAK_GRACE_ROUNDS as STREAK_GRACE_ROUNDS_FACT } from "./facts.js";

/**
 * Rounds a miner may skip without losing the streak. SDK-sourced (facts.ts);
 * 2 under V2, and effectively 0 under V1 where E5 measured one missed round
 * resetting 28 → 1. Callers on the V1 program must pass `graceRounds: 0`.
 */
export const STREAK_GRACE_ROUNDS = STREAK_GRACE_ROUNDS_FACT.value;

/**
 * The multiplier a deploy into `nextRoundId` would freeze onto its
 * deployment, mirroring the SDK's `nextStreakMultiplier` (itself a mirror of
 * `Miner::record_play`): a play `gap` rounds after the last one continues the
 * streak iff `1 <= gap <= grace + 1`, otherwise the counter restarts at 1.
 * `test/streak-grace.test.ts` pins this against the SDK across a grid.
 */
export function nextStreakMultiplier(
  currentStreakCount: number,
  lastMinedRoundId: number,
  nextRoundId: number,
  graceRounds = STREAK_GRACE_ROUNDS,
  cap = REWARD_MAX_STREAK,
): number {
  const gap = Math.max(nextRoundId - lastMinedRoundId, 0);
  const streak = gap >= 1 && gap <= graceRounds + 1 ? currentStreakCount + 1 : 1;
  return Math.min(streak, cap);
}

/**
 * Would sitting out `roundId` cost the streak? Only when the next possible
 * play (`roundId + 1`) would already be past the grace gap — i.e. when the
 * grace has been used up by the rounds already skipped since
 * `lastMinedRoundId`. While it has not, a skip is free THIS round, and the
 * presence credit below must be zero or the bot would pay a toll to protect
 * something the program is not about to take.
 */
export function skipBreaksStreak(
  roundId: number,
  lastMinedRoundId: number,
  graceRounds = STREAK_GRACE_ROUNDS,
): boolean {
  return roundId + 1 - lastMinedRoundId > graceRounds + 1;
}

/**
 * Raw hashrate units per (dollar per round) forgone by breaking a streak of
 * `streak` and rebuilding from 1. Coverage cancels: the 21/n term is identical
 * on both paths, so only the streak counter differs.
 */
export function streakBreakRawLoss(streak: number, cap = REWARD_MAX_STREAK): number {
  if (!Number.isFinite(streak) || streak <= 1) return 0;
  const s = Math.min(streak, cap);
  let lost = 0;
  // Catch-up completes once the broken path re-saturates the cap.
  for (let j = 1; j < cap; j++) lost += Math.min(s + j, cap) - Math.min(j, cap);
  return lost;
}

export interface StreakOptionInput {
  /** current_streak_count, as it stands before this round's deploy. */
  streak: number;
  /** Gross USD we expect to deploy per round going forward. */
  deployPerRoundUsd: number;
  /** USD value of one RAW hashrate unit at our operating margin. */
  valueUsdPerRawUnit: number;
  /** Fraction of earned hashrate that is liquid now (1 − unclaimed_hashrate_bps). */
  liquidFraction: number;
  /**
   * Confidence haircut. The loss is real but it is a projection: it assumes we
   * keep deploying at this rate, that the vaults keep pricing hashrate near
   * today's margin, and that we are not about to stop anyway. Discounting it
   * keeps a large speculative term from dominating a decision about real money.
   */
  discount: number;
  /**
   * Grace-window inputs. When all three are given, the credit is zero for a
   * round whose skip the grace still absorbs (see `skipBreaksStreak`); when
   * omitted every skip is treated as a break, which is V1's rule. Pass
   * `graceRounds: 0` on the V1 program even when the ids are known.
   */
  roundId?: number | undefined;
  lastMinedRoundId?: number | undefined;
  graceRounds?: number | undefined;
}

/**
 * USD cost of breaking the streak this round — the credit a deploy earns purely
 * by keeping the counter alive. Returns 0 when hashrate has no priced sink, so
 * disabling the vault strategy also disables this term rather than leaving a
 * phantom credit behind.
 */
export function streakOptionValueUsd(input: StreakOptionInput): number {
  const { streak, deployPerRoundUsd, valueUsdPerRawUnit, liquidFraction, discount } = input;
  if (!(valueUsdPerRawUnit > 0) || !(deployPerRoundUsd > 0)) return 0;
  if (!(liquidFraction > 0) || !(discount > 0)) return 0;
  if (
    input.roundId !== undefined &&
    input.lastMinedRoundId !== undefined &&
    input.graceRounds !== undefined &&
    !skipBreaksStreak(input.roundId, input.lastMinedRoundId, input.graceRounds)
  ) {
    return 0;
  }
  const rawLoss = streakBreakRawLoss(streak);
  if (rawLoss <= 0) return 0;
  return rawLoss * deployPerRoundUsd * liquidFraction * valueUsdPerRawUnit * discount;
}
