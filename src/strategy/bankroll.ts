/**
 * Bankroll discipline — the load-bearing risk limits (CLAUDE.md ground
 * rules). Everything here is enforced in the execution path via
 * authorize(): ladder quantization, MAX_PER_ROUND, DAILY_LOSS_CAP (from
 * state/pnl, injected), a one-deployment-per-round idempotency latch, and
 * the kill switch (in-memory trip OR presence of KILL_SWITCH_FILE),
 * re-checked immediately before any send. Block reasons are explicit for
 * logging/alerting.
 */
import { existsSync } from "node:fs";

export type BlockReason =
  | "kill_switch_engaged"
  | "already_deployed_this_round"
  | "amount_not_positive"
  | "below_min_deploy"
  | "daily_loss_cap_reached";

export type Authorization =
  | { ok: true; amountGross: bigint }
  | { ok: false; reason: BlockReason; detail?: string | undefined };

export interface BankrollConfig {
  /** Stake ladder (base units). The smallest entry is the quantization unit. */
  ladder: bigint[];
  maxPerRound: bigint;
  dailyLossCap: bigint;
  /**
   * Fraction of a prospective stake the daily-loss check counts as at risk.
   * 1 (default, V1): a losing deploy loses everything. V2: the board can take
   * at most the toll — 1 − refund (11%) — so the check uses that; MAX_PER_ROUND
   * stays on gross either way. Clamped to (0, 1]; never an economic input to
   * the EV, only to how many rounds a day the cap permits.
   */
  lossFractionAtRisk?: number | undefined;
  /** On-chain SatrushConfig.min_deploy_usd_amount (base units). */
  minDeploy: bigint;
  /** Kill switch file path; existence halts sending. */
  killSwitchFile?: string | undefined;
}

export interface BankrollDeps {
  /** Realized loss so far today (base units, ≥ 0) — wired to state/pnl. */
  realizedLossToday: () => bigint;
}

export class Bankroll {
  private readonly quantum: bigint;
  private readonly deployedRounds = new Set<number>();
  private tripped: string | null = null;

  constructor(
    private readonly cfg: BankrollConfig,
    private readonly deps: BankrollDeps,
  ) {
    if (cfg.ladder.length === 0 || cfg.ladder.some((l) => l <= 0n)) {
      throw new RangeError("ladder must be non-empty positive amounts");
    }
    if (cfg.maxPerRound <= 0n) throw new RangeError("maxPerRound must be positive");
    if (cfg.dailyLossCap <= 0n) throw new RangeError("dailyLossCap must be positive");
    const f = cfg.lossFractionAtRisk ?? 1;
    if (!Number.isFinite(f) || f <= 0 || f > 1) {
      throw new RangeError(`lossFractionAtRisk must be in (0, 1], got ${f}`);
    }
    this.quantum = cfg.ladder.reduce((a, b) => (b < a ? b : a));
  }

  // Accessors so the pre-send invariant guard can re-verify against the SAME
  // limits the bankroll enforces (never a separately-configured copy).
  get maxPerRoundBase(): bigint {
    return this.cfg.maxPerRound;
  }
  get dailyLossCapBase(): bigint {
    return this.cfg.dailyLossCap;
  }
  get lossFractionAtRisk(): number {
    return this.cfg.lossFractionAtRisk ?? 1;
  }
  get minDeployBase(): bigint {
    return this.cfg.minDeploy;
  }
  get quantumBase(): bigint {
    return this.quantum;
  }
  realizedLossToday(): bigint {
    return this.deps.realizedLossToday();
  }

  /** Floor to a ladder-quantum multiple, clamped to MAX_PER_ROUND. */
  quantize(amountGross: bigint): bigint {
    if (amountGross <= 0n) return 0n;
    const clamped = amountGross > this.cfg.maxPerRound ? this.cfg.maxPerRound : amountGross;
    return (clamped / this.quantum) * this.quantum;
  }

  /** Trip the kill switch programmatically (e.g. on HaltError). One-way. */
  tripKillSwitch(reason: string): void {
    this.tripped = reason;
  }

  /** True if tripped in-memory or the kill file exists. Check before EVERY send. */
  killSwitchEngaged(): boolean {
    if (this.tripped !== null) return true;
    const file = this.cfg.killSwitchFile;
    return file !== undefined && file !== "" && existsSync(file);
  }

  killSwitchReason(): string | null {
    if (this.tripped) return this.tripped;
    if (this.killSwitchEngaged()) return `kill file present: ${this.cfg.killSwitchFile}`;
    return null;
  }

  /**
   * Gate a prospective deployment. Returns the quantized amount or an
   * explicit block reason. Does NOT latch — call commit(roundId) at send
   * time so a pre-send failure can retry.
   */
  authorize(
    roundId: number,
    amountGross: bigint,
    maxPerRoundOverride?: bigint,
  ): Authorization {
    if (this.killSwitchEngaged()) {
      return {
        ok: false,
        reason: "kill_switch_engaged",
        detail: this.killSwitchReason() ?? undefined,
      };
    }
    if (this.deployedRounds.has(roundId)) {
      return { ok: false, reason: "already_deployed_this_round" };
    }
    // The cap the caller actually deployed against (strike-boost aware). The
    // daily-loss check below uses this same amount, so authorize can never
    // approve a smaller figure than what gets sent (closes AUDIT F1).
    const cap = maxPerRoundOverride ?? this.cfg.maxPerRound;
    const clamped = amountGross > cap ? cap : amountGross;
    const amount = amountGross <= 0n ? 0n : (clamped / this.quantum) * this.quantum;
    if (amount <= 0n) {
      return { ok: false, reason: "amount_not_positive", detail: `raw=${amountGross}` };
    }
    if (amount < this.cfg.minDeploy) {
      return {
        ok: false,
        reason: "below_min_deploy",
        detail: `${amount} < ${this.cfg.minDeploy}`,
      };
    }
    const lossToday = this.deps.realizedLossToday();
    // V1: the full stake is the potential loss. V2: the toll (rounded up).
    const atRisk = stakeAtRisk(amount, this.lossFractionAtRisk);
    if (lossToday + atRisk > this.cfg.dailyLossCap) {
      return {
        ok: false,
        reason: "daily_loss_cap_reached",
        detail: `loss=${lossToday} + at_risk=${atRisk} (stake=${amount} × ${this.lossFractionAtRisk}) > cap=${this.cfg.dailyLossCap}`,
      };
    }
    return { ok: true, amountGross: amount };
  }

  /** Latch the round IMMEDIATELY before sending (idempotency). */
  commit(roundId: number): void {
    this.deployedRounds.add(roundId);
  }

  /**
   * Atomic check-and-set of the one-deploy latch: returns true only for the
   * FIRST caller in a round, false thereafter. Single synchronous op, so
   * correctness does not depend on the absence of awaits between an
   * authorize() check and commit() (defends double-fire even if the fire
   * path is later refactored to be async before the latch).
   */
  tryCommit(roundId: number): boolean {
    if (this.deployedRounds.has(roundId)) return false;
    this.deployedRounds.add(roundId);
    return true;
  }

  /** Release a latch when the tx verifiably never reached the chain. */
  release(roundId: number): void {
    this.deployedRounds.delete(roundId);
  }

  hasDeployed(roundId: number): boolean {
    return this.deployedRounds.has(roundId);
  }
}

/**
 * Strike conditioning hook: scale stake when the strike pool exceeds the
 * threshold. boost=1.0 disables (default until trigger mechanics are
 * understood — see CLAUDE.md open questions).
 */
/** Base units of `amount` counted against the daily cap: ceil(amount × fraction). */
export function stakeAtRisk(amount: bigint, fraction: number): bigint {
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    throw new RangeError(`fraction must be in (0, 1], got ${fraction}`);
  }
  if (fraction === 1) return amount;
  const bps = BigInt(Math.ceil(fraction * 10_000));
  return (amount * bps + 9_999n) / 10_000n;
}

export function strikeSizeMultiplier(
  strikePoolUsd: bigint,
  opts: { thresholdBaseUnits: bigint; boost: number },
): number {
  if (!Number.isFinite(opts.boost) || opts.boost <= 0) {
    throw new RangeError(`invalid strike boost: ${opts.boost}`);
  }
  return strikePoolUsd > opts.thresholdBaseUnits ? opts.boost : 1;
}
