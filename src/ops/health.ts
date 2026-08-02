/**
 * Health monitoring: ingest staleness, snapshot-vs-RPC slot lag, wallet SOL
 * floor, and DB write failures. Issues are pushed through the injected
 * alert() (Telegram + log) with per-key debounce so a persistent condition
 * alerts once per window, not once per check.
 */

export type HealthIssueKey = "ingest_stale" | "slot_lag" | "sol_low" | "db_write_error";

export interface HealthIssue {
  key: HealthIssueKey;
  message: string;
}

export interface HealthDeps {
  ingestStale(): boolean;
  ingestSlotAgeMs(): number;
  snapshotSlot(): number;
  rpcSlot(): Promise<number>;
  solBalanceLamports(): Promise<number>;
  dbLastWriteError(): string | null;
  alert(message: string): void | Promise<void>;
}

export interface HealthMonitorOptions {
  solFloorLamports: number;
  /** Alert when the snapshot slot trails the RPC slot by more than this. */
  slotLagThreshold?: number | undefined;
  /** Re-alert window per issue key (default 5 min). */
  debounceMs?: number | undefined;
  now?: (() => number) | undefined;
}

export class HealthMonitor {
  private readonly lastAlerted = new Map<HealthIssueKey, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: HealthDeps,
    private readonly opts: HealthMonitorOptions,
  ) {}

  /** Run all checks; alert (debounced) on each active issue. */
  async check(): Promise<HealthIssue[]> {
    const issues: HealthIssue[] = [];

    if (this.deps.ingestStale()) {
      issues.push({
        key: "ingest_stale",
        message: `ingest stale — slot stream quiet for ${Math.round(this.deps.ingestSlotAgeMs())}ms`,
      });
    }

    try {
      const rpcSlot = await this.deps.rpcSlot();
      const lag = rpcSlot - this.deps.snapshotSlot();
      const threshold = this.opts.slotLagThreshold ?? 30;
      if (lag > threshold) {
        issues.push({
          key: "slot_lag",
          message: `snapshot lags RPC by ${lag} slots (threshold ${threshold})`,
        });
      }
    } catch {
      /* RPC check failure is itself covered by staleness */
    }

    try {
      const lamports = await this.deps.solBalanceLamports();
      if (lamports < this.opts.solFloorLamports) {
        issues.push({
          key: "sol_low",
          message: `wallet SOL ${(lamports / 1e9).toFixed(4)} below floor ${(this.opts.solFloorLamports / 1e9).toFixed(4)}`,
        });
      }
    } catch {
      /* transient */
    }

    const dbError = this.deps.dbLastWriteError();
    if (dbError !== null) {
      issues.push({ key: "db_write_error", message: `DB write failure: ${dbError}` });
    }

    const now = this.opts.now ?? Date.now;
    const debounce = this.opts.debounceMs ?? 5 * 60_000;
    for (const issue of issues) {
      const last = this.lastAlerted.get(issue.key);
      if (last === undefined || now() - last > debounce) {
        this.lastAlerted.set(issue.key, now());
        await this.deps.alert(issue.message);
      }
    }
    return issues;
  }

  start(intervalMs = 10_000): void {
    this.timer = setInterval(() => void this.check().catch(() => undefined), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
