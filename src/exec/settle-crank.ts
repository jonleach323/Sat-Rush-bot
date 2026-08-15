/**
 * Settle cranking — the rent bounty, planned for throughput.
 *
 * settle_deploy_public is permissionless and pays its rent to whoever cranks
 * (measured: +0.001730 SOL per deployment, net of fees). Across the field that
 * is ~116 SOL/day, and deployment_settle_grace_duration is 0 on mainnet, so
 * eligibility opens the instant a round resolves and it is a pure
 * first-to-land race.
 *
 * The lever is NOT latency alone. The incumbent crank packs 2.86 settles per
 * transaction while already using lookup tables — far below what the compute
 * budget allows. In a race where both sides see the same eligible set at the
 * same moment, the winner is whoever claims more of it per landed transaction,
 * so packing is worth at least as much as shaving slots.
 *
 * Racing cuts both ways and the planner is built around that: a settle whose
 * account another cranker already closed fails, and it takes the whole
 * transaction's batch down with it. So batches are sized to a configured
 * ceiling rather than maximised blindly — a failed 20-pack wastes twenty
 * chances, while four 5-packs lose only the one that collided.
 */
import { PublicKey } from "@solana/web3.js";

/** A deployment we saw created this round and can settle once it resolves. */
export interface SettleTarget {
  /** The deploying wallet — seeds the deployment, miner and automation PDAs. */
  authority: PublicKey;
  roundId: number;
  /** Slot we learned of it; used only for stable ordering. */
  seenSlot: number;
}

export interface PackingLimits {
  /**
   * Compute units one settle consumes. The batch is capped so the whole
   * transaction stays inside maxComputeUnits.
   */
  cuPerSettle: number;
  maxComputeUnits: number;
  /**
   * Account slots one settle adds beyond the shared base. Measured against the
   * incumbent's transactions: 21 accounts for one settle, 24 for two, 28 for
   * three — about 3.5 marginal each on top of a ~17-account base.
   */
  accountsPerSettle: number;
  baseAccounts: number;
  maxAccounts: number;
  /**
   * Hard ceiling on settles per transaction, independent of the limits above.
   * This is the collision bound, not a protocol one: everything in a batch
   * shares one fate, so it caps what a single lost race can cost.
   */
  maxPerTx: number;
}

export const DEFAULT_PACKING: PackingLimits = {
  cuPerSettle: 60_000,
  maxComputeUnits: 1_400_000,
  accountsPerSettle: 4,
  baseAccounts: 17,
  maxAccounts: 60,
  maxPerTx: 8,
};

/** How many settles fit in one transaction under these limits. */
export function settlesPerTx(limits: PackingLimits): number {
  const byCu = Math.floor(limits.maxComputeUnits / Math.max(1, limits.cuPerSettle));
  const byAccounts = Math.floor(
    (limits.maxAccounts - limits.baseAccounts) / Math.max(1, limits.accountsPerSettle),
  );
  return Math.max(1, Math.min(byCu, byAccounts, limits.maxPerTx));
}

/**
 * Split targets into transaction-sized batches.
 *
 * Order is by the slot we first saw each deployment. That is deliberate:
 * deployments created early are the ones a rival crank is most likely to have
 * already taken, so putting them first concentrates collision risk in the
 * batches we send first — where we find out soonest and can drop the rest.
 */
export function planBatches(
  targets: readonly SettleTarget[],
  limits: PackingLimits = DEFAULT_PACKING,
): SettleTarget[][] {
  const per = settlesPerTx(limits);
  const sorted = [...targets].sort(
    (a, b) => a.seenSlot - b.seenSlot || a.authority.toBase58().localeCompare(b.authority.toBase58()),
  );
  const out: SettleTarget[][] = [];
  for (let i = 0; i < sorted.length; i += per) out.push(sorted.slice(i, i + per));
  return out;
}

/**
 * Tracks which deployments exist per round, fed by PublicDeployCreated as the
 * round runs so the batch list is ready the moment settling opens rather than
 * being discovered afterwards. Discovering them after the fact is the whole
 * race, lost.
 */
export class SettleRegistry {
  private readonly byRound = new Map<number, Map<string, SettleTarget>>();

  add(target: SettleTarget): void {
    const key = target.authority.toBase58();
    let round = this.byRound.get(target.roundId);
    if (!round) {
      round = new Map();
      this.byRound.set(target.roundId, round);
    }
    // First sighting wins — a reload or top-up must not reorder the target.
    if (!round.has(key)) round.set(key, target);
  }

  /** Everything we know of for a round, ready to plan. */
  targets(roundId: number): SettleTarget[] {
    return [...(this.byRound.get(roundId)?.values() ?? [])];
  }

  /** Drop a target we saw settled — by us or by anyone else. */
  remove(roundId: number, authority: PublicKey): void {
    this.byRound.get(roundId)?.delete(authority.toBase58());
  }

  /** Forget rounds older than `keep` behind the head, so this cannot grow. */
  prune(headRoundId: number, keep = 8): void {
    for (const id of this.byRound.keys()) {
      if (id < headRoundId - keep) this.byRound.delete(id);
    }
  }

  size(roundId: number): number {
    return this.byRound.get(roundId)?.size ?? 0;
  }

  rounds(): number[] {
    return [...this.byRound.keys()].sort((a, b) => a - b);
  }
}

/** Expected rent from a batch plan, in SOL — for logging and gating. */
export function expectedRentSol(
  batches: readonly SettleTarget[][],
  rentPerSettleSol: number,
): number {
  return batches.reduce((a, b) => a + b.length, 0) * rentPerSettleSol;
}

/**
 * Is a batch worth sending? Rent is ~0.00173 SOL a settle against a ~0.000015
 * SOL fee, so the margin is enormous and this will almost always pass — but a
 * fee spike or a collapsed rent value should stop the crank rather than have
 * it quietly run at a loss.
 */
export function batchClearsCost(
  batchSize: number,
  rentPerSettleSol: number,
  txCostSol: number,
  minMarginRatio = 2,
): boolean {
  if (batchSize <= 0) return false;
  return batchSize * rentPerSettleSol >= txCostSol * minMarginRatio;
}
