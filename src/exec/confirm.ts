/**
 * Signature confirmation + failure classification. RoundNotActive (6005)
 * and blockhash expiry classify as missed_round: report and move on — a
 * stale candidate is NEVER re-fired into the next round (the bankroll
 * idempotency latch gates that upstream).
 */
import type { Connection } from "@solana/web3.js";

export type ConfirmOutcome =
  | { status: "landed"; slot: number }
  | {
      status: "missed_round";
      reason: "round_not_active" | "blockhash_expired" | "cutoff_passed";
    }
  | { status: "failed"; error: string }
  | { status: "timeout" };

/** True when a TransactionError is the program's 6005 RoundNotActive. */
export function isRoundNotActive(err: unknown): boolean {
  try {
    return JSON.stringify(err).includes('"Custom":6005');
  } catch {
    return false;
  }
}

export interface ConfirmOptions {
  timeoutMs?: number | undefined;
  pollMs?: number | undefined;
  /** Classify as missed_round once the blockhash can no longer land. */
  lastValidBlockHeight?: number | undefined;
  /** Round cutoff check; once true (and one grace poll later), missed_round. */
  isPastCutoff?: (() => boolean) | undefined;
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll a signature to processed/confirmed and classify the terminal state. */
export async function confirmSignature(
  connection: Connection,
  signature: string,
  opts: ConfirmOptions = {},
): Promise<ConfirmOutcome> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pollMs = opts.pollMs ?? 250;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const startedAt = now();
  let cutoffGraceUsed = false;
  let lastBlockHeightCheck = 0;

  for (;;) {
    let status = null;
    try {
      const res = await connection.getSignatureStatuses([signature]);
      status = res.value[0] ?? null;
    } catch {
      /* transient RPC failure — next poll retries */
    }

    if (status) {
      if (status.err) {
        return isRoundNotActive(status.err)
          ? { status: "missed_round", reason: "round_not_active" }
          : { status: "failed", error: JSON.stringify(status.err) };
      }
      return { status: "landed", slot: status.slot };
    }

    if (opts.isPastCutoff?.()) {
      // One grace poll: the landing status may lag the slot stream.
      if (cutoffGraceUsed) return { status: "missed_round", reason: "cutoff_passed" };
      cutoffGraceUsed = true;
    }

    if (
      opts.lastValidBlockHeight !== undefined &&
      now() - lastBlockHeightCheck > 1_000
    ) {
      lastBlockHeightCheck = now();
      try {
        const height = await connection.getBlockHeight("processed");
        if (height > opts.lastValidBlockHeight) {
          return { status: "missed_round", reason: "blockhash_expired" };
        }
      } catch {
        /* ignore */
      }
    }

    if (now() - startedAt > timeoutMs) return { status: "timeout" };
    await sleep(pollMs);
  }
}
