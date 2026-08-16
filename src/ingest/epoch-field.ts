/**
 * The epoch field, read live instead of loaded from a stale file.
 *
 * Every epoch EV figure in this repo has been priced against
 * `data/epoch-iteration-4.json` — 157 wallets, 806,582 tickets — captured once
 * and then reused as though it were a constant of nature. It is not. The field
 * is a live account: EpochVaultPage carries every entrant's authority and
 * ticket count for the current iteration, paged.
 *
 * That distinction decides the farming question. Our epoch take is
 * `share x pool`, and share is OUR tickets over THEIR tickets. Pricing today's
 * deploys against a field measured when volume was 4.7x higher does not just
 * add noise — it biases the answer, because pool and field do not move
 * together. The pool scales with volume; the field scales with volume TIMES
 * streak, and streaks only ever grow while a wallet keeps playing.
 *
 * The per-wallet BLOCKS matter, not just the total. Winners are deduped by
 * wallet: when a wallet is drawn, all of its tickets leave the pool. So the
 * same total split across 5 whales and across 500 minnows gives a small holder
 * very different odds, and only the actual distribution can price that.
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import {
  decodeAccount,
  type EpochVault,
  type EpochVaultIteration,
  type EpochVaultPage,
} from "../adapter/idl.js";
import {
  epochVaultIterationPda,
  epochVaultPagePda,
  epochVaultPda,
} from "../adapter/pdas.js";

export interface EpochField {
  iterationId: number;
  /** Per-wallet ticket blocks, descending. Empty if pages are unreadable. */
  blocks: number[];
  /** iteration.total_tickets — authoritative, even when pages are missing. */
  totalTickets: number;
  participants: number;
  /** Pool banked so far: USD legs plus BTC valued at the passed price. */
  poolUsd: number;
  /** Fraction of the iteration elapsed, 0..1. */
  progress: number;
  /** True when the blocks sum matches total_tickets — i.e. paging is complete. */
  complete: boolean;
}

export interface ReadFieldOptions {
  connection: Connection;
  programId: PublicKey;
  btcUsd: number;
  /** epoch_vault_iteration_duration, in slots. */
  iterationSlots: number;
  /** Current slot; pass one already fetched to avoid a second round trip. */
  slot: number;
}

/**
 * Read the live epoch iteration: pool, per-wallet ticket blocks, progress.
 *
 * Pages are fetched in one multi-get. A missing page is reported through
 * `complete: false` rather than silently yielding a short field, because a
 * short field understates the denominator and overstates our share — the exact
 * direction that would flatter farming.
 */
export async function readEpochField(opts: ReadFieldOptions): Promise<EpochField> {
  const { connection, programId, btcUsd, iterationSlots, slot } = opts;
  const vInfo = await connection.getAccountInfo(epochVaultPda(programId), "confirmed");
  if (!vInfo) throw new Error("EpochVault account unavailable");
  const vault = decodeAccount<EpochVault>("EpochVault", vInfo.data);
  const n = (v: { toString(): string }): number => Number(v.toString());

  const poolUsd =
    n(vault.pool_usd_amount) / 1e6 +
    n(vault.pending_usd_amount) / 1e6 +
    (n(vault.pool_btc_amount) / 1e8) * btcUsd;
  const elapsed = slot - n(vault.last_trigger_slot);
  const progress = Math.min(1, Math.max(0, elapsed / Math.max(1, iterationSlots)));

  const itInfo = await connection.getAccountInfo(
    epochVaultIterationPda(vault.iteration_id, programId), "confirmed",
  );
  if (!itInfo) {
    return {
      iterationId: vault.iteration_id, blocks: [], totalTickets: 0,
      participants: 0, poolUsd, progress, complete: false,
    };
  }
  const iter = decodeAccount<EpochVaultIteration>("EpochVaultIteration", itInfo.data);
  const totalTickets = n(iter.total_tickets);

  const pageInfos = iter.page_count > 0
    ? await connection.getMultipleAccountsInfo(
        Array.from({ length: iter.page_count }, (_, i) =>
          epochVaultPagePda(vault.iteration_id, i, programId)),
        "confirmed",
      )
    : [];

  const blocks: number[] = [];
  let readable = 0;
  for (const info of pageInfos) {
    if (!info) continue;
    readable++;
    const page = decodeAccount<EpochVaultPage>("EpochVaultPage", info.data);
    // `entries` is a fixed-size array; only the first entry_count are real.
    for (const e of page.entries.slice(0, page.entry_count)) {
      const t = n(e.tickets);
      if (t > 0) blocks.push(t);
    }
  }
  blocks.sort((a, b) => b - a);
  const summed = blocks.reduce((a, b) => a + b, 0);

  return {
    iterationId: vault.iteration_id,
    blocks,
    totalTickets,
    participants: iter.participants_count,
    poolUsd,
    progress,
    complete: readable === iter.page_count && summed === totalTickets,
  };
}

/**
 * Project a partly-elapsed field onto its end-of-iteration shape.
 *
 * Scaling everyone's ticket count by 1/progress is the obvious move and it is
 * wrong, because it silently assumes the ENTRANT COUNT is already final. Payout
 * is deduped by wallet across 21 slots, so entrant count is what decides how
 * much a small holder collects: with 52 entrants a fifth of the field wins
 * something almost regardless of ticket share; at 157 that edge is gone. A
 * projection that inflates tickets while freezing entrants at their early-
 * iteration value models a world nobody else joins — the single most optimistic
 * assumption available, and the one that flipped this project's farming verdict
 * by roughly $200/day.
 *
 * So resample the MEASURED distribution's shape onto `participants` wallets
 * summing to `totalTickets`. Shape is preserved (the Lorenz curve carries the
 * concentration the dedup is sensitive to); only count and scale move, and both
 * are stated by the caller rather than assumed here.
 */
export function resampleField(
  observed: readonly number[],
  participants: number,
  totalTickets: number,
): number[] {
  if (observed.length === 0 || participants <= 0 || totalTickets <= 0) return [];
  const src = [...observed].sort((a, b) => b - a);
  const out: number[] = [];
  for (let i = 0; i < participants; i++) {
    // Midpoint quantiles: sample the empirical curve at (i+0.5)/p rather than
    // i/p, so a resample to the same count reproduces the input.
    const q = ((i + 0.5) / participants) * src.length - 0.5;
    const lo = Math.max(0, Math.floor(q));
    const hi = Math.min(src.length - 1, lo + 1);
    const f = q - lo;
    out.push((src[lo] as number) * (1 - f) + (src[hi] as number) * f);
  }
  const sum = out.reduce((a, b) => a + b, 0);
  return sum > 0 ? out.map((x) => (x * totalTickets) / sum) : out;
}
