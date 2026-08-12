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

/** Devnet-measured deploy legs (strike+epoch+one_btc+protocol) — the fallback
 * used only before the on-chain SatrushConfig has been read. */
export const DEFAULT_DEPLOY_FEE_BPS = 800;

export interface PnlDeps {
  /** Live deploy-fee bps from the on-chain SatrushConfig. */
  deployFeeBps?: () => number;
}

export class Pnl {
  constructor(
    private readonly db: StateDb,
    private readonly deps: PnlDeps = {},
  ) {}

  /** Deploy-fee bps to attribute, from chain when available. */
  private deployFeeBps(): number {
    const bps = this.deps.deployFeeBps?.();
    return Number.isFinite(bps) && (bps as number) >= 0
      ? (bps as number)
      : DEFAULT_DEPLOY_FEE_BPS;
  }

  /** Gross USD deployed today (fired/landed/dry excluded: dry costs nothing). */
  deployedToday(date = utcDate()): bigint {
    const row = this.db.queryOne<{ total: string | null }>(
      `SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS total
       FROM my_deploys WHERE date(created_at) = ? AND status IN ('fired','landed')`,
      date,
    );
    return toBig(row?.total ?? "0");
  }

  /**
   * USD returned for deploys made on `date`, attributed to the DEPLOY's day
   * rather than the settlement's.
   *
   * Rounds are ~70s, so a deploy at 23:59:5x settles into the next UTC day.
   * Filtering settlements by their own timestamp splits a round across two days:
   * the cost lands on day 1 and the return on day 2. That makes day 2 open with
   * a phantom credit, so realizedLossToday() under-reports and the daily loss
   * cap silently permits an overshoot equal to the carryover. (Same
   * midnight-boundary class of bug as the false wallet-drift halt.)
   *
   * Settlements with no matching deploy row fall back to their own date so
   * nothing is silently dropped from every day.
   */
  returnedToday(date = utcDate()): bigint {
    const row = this.db.queryOne<{ total: string | null }>(
      `SELECT COALESCE(SUM(CAST(s.won_usd AS INTEGER)), 0) AS total
       FROM settlements s
       WHERE COALESCE(
               (SELECT date(MIN(d.created_at)) FROM my_deploys d
                 WHERE d.round_id = s.round_id AND d.status IN ('fired','landed')),
               date(s.created_at)
             ) = ?`,
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
   * Recompute and persist today's pnl_daily row. fees_paid applies the LIVE
   * deploy-leg bps read from the on-chain SatrushConfig (falling back to the
   * devnet-measured 800 only before that config has loaded) — hardcoding 800
   * would silently misreport the fee column if mainnet legs differ.
   */
  refreshDaily(date = utcDate()): void {
    const deployed = this.deployedToday(date);
    const returned = this.returnedToday(date);
    this.db.upsertPnlDaily(date, {
      deployed,
      returned,
      net: returned - deployed,
      feesPaid: (deployed * BigInt(Math.round(this.deployFeeBps()))) / 10_000n,
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
