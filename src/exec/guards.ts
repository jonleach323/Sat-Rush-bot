/**
 * Pre-send invariant chokepoint. The LAST synchronous line before the wire.
 * Every money-moving send (deploy, settle, claim) passes through here; any
 * violation throws HaltError — never log-and-continue. This exists because
 * the guards it re-checks are otherwise spread across the selector, the
 * bankroll, and the instruction builders, computed at different times from
 * possibly-divergent config (e.g. the strike-boost cap divergence, AUDIT.md
 * F1): a single chokepoint on the ACTUAL amount/mask/fee about to be signed
 * is the only place that cannot drift.
 */
import { HaltError } from "../ingest/decode.js";
import { maskToTiles } from "../adapter/mask.js";

const U64_MAX = 0xffff_ffff_ffff_ffffn;

export interface DeploySendInvariants {
  roundId: number;
  amountBaseUnits: bigint;
  mask: number;
  quantumBase: bigint;
  minDeployBase: bigint;
  maxPerRoundBase: bigint;
  dailyLossCapBase: bigint;
  realizedLossTodayBase: bigint;
  priorityFeeMicroLamports: number;
  maxPriorityFeeMicroLamports: number;
  tipLamports: number;
  maxTipLamports: number;
  /** bankroll latch must already be held for this round (we committed). */
  latchHeld: boolean;
  killSwitchEngaged: boolean;
}

function halt(message: string, context: Record<string, unknown>): never {
  throw new HaltError(`send invariant violated: ${message}`, context);
}

/**
 * Re-verify every money-path invariant on the ACTUAL deploy about to be
 * signed/sent. Throws HaltError on any violation.
 */
export function assertDeployInvariants(inv: DeploySendInvariants): void {
  if (inv.killSwitchEngaged) halt("kill switch engaged", { roundId: inv.roundId });
  if (!inv.latchHeld) halt("one-deploy latch not held", { roundId: inv.roundId });

  const a = inv.amountBaseUnits;
  if (typeof a !== "bigint" || a <= 0n) halt("amount not a positive integer", { amount: String(a) });
  if (a > U64_MAX) halt("amount exceeds u64", { amount: a.toString() });
  if (inv.quantumBase <= 0n || a % inv.quantumBase !== 0n) {
    halt("amount not a whole ladder-quantum multiple", {
      amount: a.toString(),
      quantum: inv.quantumBase.toString(),
    });
  }
  if (a < inv.minDeployBase) {
    halt("amount below on-chain min deploy", {
      amount: a.toString(),
      minDeploy: inv.minDeployBase.toString(),
    });
  }
  if (a > inv.maxPerRoundBase) {
    halt("amount exceeds MAX_PER_ROUND", {
      amount: a.toString(),
      maxPerRound: inv.maxPerRoundBase.toString(),
    });
  }
  // Daily loss cap re-checked here on the ACTUAL amount, at the last line.
  if (inv.realizedLossTodayBase + a > inv.dailyLossCapBase) {
    halt("daily loss cap would be exceeded", {
      amount: a.toString(),
      lossToday: inv.realizedLossTodayBase.toString(),
      cap: inv.dailyLossCapBase.toString(),
    });
  }
  // Mask: mirror program error 6007 (1–21 tiles, 21-bit range).
  try {
    maskToTiles(inv.mask);
  } catch (err) {
    halt("invalid selection mask", { mask: inv.mask, cause: String(err) });
  }
  // Fee + tip clamped to config maxima.
  if (
    !Number.isInteger(inv.priorityFeeMicroLamports) ||
    inv.priorityFeeMicroLamports < 0 ||
    inv.priorityFeeMicroLamports > inv.maxPriorityFeeMicroLamports
  ) {
    halt("priority fee outside clamp", {
      fee: inv.priorityFeeMicroLamports,
      max: inv.maxPriorityFeeMicroLamports,
    });
  }
  if (
    !Number.isInteger(inv.tipLamports) ||
    inv.tipLamports < 0 ||
    inv.tipLamports > inv.maxTipLamports
  ) {
    halt("jito tip outside clamp", { tip: inv.tipLamports, max: inv.maxTipLamports });
  }
}

export interface FeeBearingSendInvariants {
  kind: "settle" | "claim";
  priorityFeeMicroLamports: number;
  maxPriorityFeeMicroLamports: number;
  killSwitchEngaged: boolean;
}

/** Guard for settle/claim sends (no stake amount, but fee-clamped + kill-gated). */
export function assertFeeBearingInvariants(inv: FeeBearingSendInvariants): void {
  if (inv.killSwitchEngaged) halt(`${inv.kind} while kill switch engaged`, {});
  if (
    !Number.isInteger(inv.priorityFeeMicroLamports) ||
    inv.priorityFeeMicroLamports < 0 ||
    inv.priorityFeeMicroLamports > inv.maxPriorityFeeMicroLamports
  ) {
    halt(`${inv.kind} priority fee outside clamp`, {
      fee: inv.priorityFeeMicroLamports,
      max: inv.maxPriorityFeeMicroLamports,
    });
  }
}
