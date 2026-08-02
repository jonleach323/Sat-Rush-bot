/**
 * PnL accounting on top of StateDb: expected-vs-realized reconciliation per
 * round, todayNet() feeding the daily loss cap, and unclaimed-position
 * valuation for the sweep policy.
 */
import type { Miner, SatsVault } from "../adapter/idl.js";
import type { StateDb } from "./db.js";

const toBig = (v: { toString(): string } | string | null | undefined): bigint =>
  BigInt((v ?? "0").toString());

/** UTC YYYY-MM-DD (matches sqlite datetime('now')). */
export function utcDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface RoundReconciliation {
  roundId: number;
  deployed: bigint;
  returnedUsd: bigint;
  wonShares: bigint;
  expectedEv: number | null;
  /** realized USD profit (returned − deployed); shares valued separately. */
  realizedUsd: bigint;
}

export class Pnl {
  constructor(private readonly db: StateDb) {}

  /** Gross USD deployed today (fired/landed/dry excluded: dry costs nothing). */
  deployedToday(date = utcDate()): bigint {
    const row = this.db.queryOne<{ total: string | null }>(
      `SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS total
       FROM my_deploys WHERE date(created_at) = ? AND status IN ('fired','landed')`,
      date,
    );
    return toBig(row?.total ?? "0");
  }

  returnedToday(date = utcDate()): bigint {
    const row = this.db.queryOne<{ total: string | null }>(
      `SELECT COALESCE(SUM(CAST(won_usd AS INTEGER)), 0) AS total
       FROM settlements WHERE date(created_at) = ?`,
      date,
    );
    return toBig(row?.total ?? "0");
  }

  /** Net USD today (negative = losing). Shares are valued by the sweep policy. */
  todayNet(date = utcDate()): bigint {
    return this.returnedToday(date) - this.deployedToday(date);
  }

  /** Positive loss figure for Bankroll.realizedLossToday. */
  realizedLossToday(date = utcDate()): bigint {
    const net = this.todayNet(date);
    return net < 0n ? -net : 0n;
  }

  /** Expected EV (model, at fire time) vs realized, per round. */
  reconcileRound(roundId: number): RoundReconciliation {
    const deploys = this.db.query<{ amount: string; ev_expected: number | null; status: string }>(
      `SELECT amount, ev_expected, status FROM my_deploys
       WHERE round_id = ? AND status IN ('fired','landed')`,
      roundId,
    );
    const settles = this.db.query<{ won_usd: string; won_shares: string }>(
      `SELECT won_usd, won_shares FROM settlements WHERE round_id = ?`,
      roundId,
    );
    const deployed = deploys.reduce((a, d) => a + toBig(d.amount), 0n);
    const returnedUsd = settles.reduce((a, s) => a + toBig(s.won_usd), 0n);
    const wonShares = settles.reduce((a, s) => a + toBig(s.won_shares), 0n);
    const evs = deploys.map((d) => d.ev_expected).filter((v): v is number => v !== null);
    return {
      roundId,
      deployed,
      returnedUsd,
      wonShares,
      expectedEv: evs.length > 0 ? evs.reduce((a, b) => a + b, 0) : null,
      realizedUsd: returnedUsd - deployed,
    };
  }

  /**
   * Recompute and persist today's pnl_daily row. fees_paid is the deploy-leg
   * estimate (800 bps of gross — see docs/devnet-findings.md); exact per-leg
   * accounting can replace it once fee sweeps are attributed per deploy.
   */
  refreshDaily(date = utcDate()): void {
    const deployed = this.deployedToday(date);
    const returned = this.returnedToday(date);
    this.db.upsertPnlDaily(date, {
      deployed,
      returned,
      net: returned - deployed,
      feesPaid: (deployed * 800n) / 10_000n,
    });
  }

  /**
   * Unclaimed position value. Shares are redeemed at the vault rate
   * (btc_amount / btc_shares); BTC is converted at the supplied price.
   */
  unclaimedValue(opts: {
    miner: Miner;
    satsVault: SatsVault;
    btcUsdPrice: number;
    btcDecimals: number;
  }): { usd: bigint; shares: bigint; btcBaseUnits: bigint; totalUsd: bigint } {
    const usd = toBig(opts.miner.unclaimed_usd_amount);
    const shares = toBig(opts.miner.unclaimed_btc_shares);
    const vaultBtc = toBig(opts.satsVault.btc_amount);
    const vaultShares = toBig(opts.satsVault.btc_shares);
    const btcBaseUnits = vaultShares > 0n ? (shares * vaultBtc) / vaultShares : 0n;
    const btcUsd = BigInt(
      Math.round(
        (Number(btcBaseUnits) / 10 ** opts.btcDecimals) * opts.btcUsdPrice * 1e6,
      ),
    );
    return { usd, shares, btcBaseUnits, totalUsd: usd + btcUsd };
  }
}
