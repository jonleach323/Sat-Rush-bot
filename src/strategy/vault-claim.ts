/**
 * Pure win-detection + crank helpers for the vault claim lifecycle. Kept
 * separate from the entry EV so the (I/O-heavy) claim/crank orchestration in
 * index.ts can lean on tested decisions.
 *
 * Lifecycles:
 *   epoch:  Open → trigger_epoch_draw → Settling → select_epoch_winner ×N →
 *           Settled → claim_epoch_reward → Complete
 *   1-BTC:  Open → (fills) → trigger_one_btc_draw → Settled →
 *           claim_one_btc_reward → Complete
 */
import type { PublicKey } from "@solana/web3.js";

/** Index of our first unclaimed win in the epoch winners array, or -1. */
export function epochWinIndex(
  winners: { authority: PublicKey; claimed: boolean }[],
  me: PublicKey,
): number {
  return winners.findIndex((w) => !w.claimed && w.authority.equals(me));
}

/** True if any of our ticket ranges contains the drawn winning ticket. */
export function oneBtcHoldsWinner(
  winningTicket: bigint,
  entries: { startTicketId: bigint; ticketsCount: bigint }[],
): boolean {
  return entries.some(
    (e) =>
      winningTicket >= e.startTicketId &&
      winningTicket < e.startTicketId + e.ticketsCount,
  );
}

/**
 * Page index whose contiguous ticket range contains `ticket` — the page
 * select_epoch_winner must be given for the current winning ticket. -1 if none
 * (e.g. pages not yet sealed/known).
 */
export function epochWinnerPageIndex(
  pages: { pageIndex: number; cumulativeBase: bigint; totalTickets: bigint }[],
  ticket: bigint,
): number {
  const p = pages.find(
    (pg) => ticket >= pg.cumulativeBase && ticket < pg.cumulativeBase + pg.totalTickets,
  );
  return p ? p.pageIndex : -1;
}

export type EpochStateName = "Open" | "Settling" | "Settled" | "Complete";
export type OneBtcStateName = "Open" | "Settled" | "Complete";

/** What to do this tick for an epoch iteration we hold tickets in. */
export function epochAction(input: {
  state: EpochStateName;
  windowElapsed: boolean;
  winnersSelected: number;
  winnersTarget: number;
  weWon: boolean;
  selfCrank: boolean;
}): "trigger" | "select" | "claim" | "done" | "wait" {
  switch (input.state) {
    case "Open":
      return input.selfCrank && input.windowElapsed ? "trigger" : "wait";
    case "Settling":
      if (input.selfCrank && input.winnersSelected < input.winnersTarget) return "select";
      return "wait";
    case "Settled":
      return input.weWon ? "claim" : "done";
    case "Complete":
      return input.weWon ? "claim" : "done";
  }
}

/** What to do this tick for a 1-BTC iteration we hold tickets in. */
export function oneBtcAction(input: {
  state: OneBtcStateName;
  triggerable: boolean;
  weWon: boolean;
  selfCrank: boolean;
}): "trigger" | "claim" | "done" | "wait" {
  switch (input.state) {
    case "Open":
      return input.selfCrank && input.triggerable ? "trigger" : "wait";
    case "Settled":
      return input.weWon ? "claim" : "done";
    case "Complete":
      return input.weWon ? "claim" : "done";
  }
}
