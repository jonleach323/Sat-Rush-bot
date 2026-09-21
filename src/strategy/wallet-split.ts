/**
 * The epoch draw with our tickets split across several wallets.
 *
 * Under V2 every one of the 21 winners takes the same fixed share, and a
 * wallet can be drawn at most once. So a single wallet's take is capped at one
 * slot — 1/21 of the payout — however many tickets it holds, and a holder big
 * enough to dominate the field only collects the rest of the pool it funded by
 * holding it across several wallets. The owner has confirmed extra wallets
 * under the operator's own affiliate tag are acceptable, so this is now a
 * sizing question rather than a design hole to report.
 *
 * The draw is the program's: 21 selections, ticket-weighted, without
 * replacement, a drawn wallet's whole block leaving the pool. When there are
 * 21 or fewer participants every wallet is drawn and tickets stop mattering
 * — a regime the live field has been in early in iterations, and one a
 * one-ticket wallet exploits for a full slot.
 *
 * Simulated rather than closed-form because the without-replacement dedup
 * has no clean expression for a dominant holder, and every number comes back
 * as an `Estimate` with its standard error.
 */
import type { Estimate } from "./facts.js";
import { EPOCH_EQUAL_CURVE_BPS } from "./vault.js";

export interface SplitTakeInput {
  /** Our tickets per wallet (one entry per wallet we run). Zero entries are skipped. */
  myWallets: number[];
  /** The field's tickets per wallet, ours excluded. */
  field: readonly number[];
  /** Reward curve, bps of the pool by draw rank; defaults to V2's flat curve. */
  curve?: readonly number[] | undefined;
  trials?: number | undefined;
  rng?: (() => number) | undefined;
}

/**
 * Expected fraction of the pool our wallets take together, with its standard
 * error over the simulated draws.
 */
export function simulateSplitTake(input: SplitTakeInput): Estimate {
  const curve = input.curve ?? EPOCH_EQUAL_CURVE_BPS;
  const trials = input.trials ?? 5_000;
  const rng = input.rng ?? Math.random;
  const mine = input.myWallets.filter((t) => t > 0);
  const arr = [...input.field.filter((t) => t > 0), ...mine];
  const mineFrom = arr.length - mine.length;
  const total = arr.reduce((a, b) => a + b, 0);
  if (total <= 0 || mine.length === 0) return { value: 0, stderr: 0, n: trials };

  let sum = 0;
  let sumSq = 0;
  for (let t = 0; t < trials; t++) {
    const dead = new Uint8Array(arr.length);
    let remaining = total;
    let won = 0;
    for (let rank = 0; rank < curve.length && remaining > 0; rank++) {
      let x = rng() * remaining;
      let pick = -1;
      for (let i = 0; i < arr.length; i++) {
        if (dead[i]) continue;
        x -= arr[i] as number;
        if (x < 0) {
          pick = i;
          break;
        }
      }
      if (pick < 0) break;
      dead[pick] = 1;
      remaining -= arr[pick] as number;
      if (pick >= mineFrom) won += (curve[rank] ?? 0) / 10_000;
    }
    sum += won;
    sumSq += won * won;
  }
  const mean = sum / trials;
  const variance = Math.max(0, sumSq / trials - mean * mean);
  return { value: mean, stderr: Math.sqrt(variance / trials), n: trials };
}

/**
 * With at most as many participants as winner slots, every wallet is drawn and
 * the flat curve pays each exactly one slot, tickets notwithstanding.
 */
export function everyoneDrawn(participants: number, slots = EPOCH_EQUAL_CURVE_BPS.length): boolean {
  return participants > 0 && participants <= slots;
}

/** Split `total` tickets as evenly as whole tickets allow across `k` wallets. */
export function evenSplit(total: number, k: number): number[] {
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`invalid wallet count: ${k}`);
  const base = Math.floor(total / k);
  const extra = total - base * k;
  return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
}
