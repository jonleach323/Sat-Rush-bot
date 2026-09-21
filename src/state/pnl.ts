/**
 * PnL accounting on top of StateDb: expected-vs-realized reconciliation per
 * round, todayNet() feeding the daily loss cap, and unclaimed-position
 * valuation for the sweep policy.
 */
import type { Miner, SatsVault, TokenVault } from "../adapter/idl.js";
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
  /** V2 RUSH vault shares credited (0 under V1). */
  wonTokenShares: bigint;
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
  /**
   * USD value (base units) of vault shares, for marking the day's wins. Under
   * V2 a WINNING deploy returns nothing in USD — the whole win is BTC shares
   * (and RUSH shares) — so a USD-only ledger books every win as a 100% loss
   * and the daily loss cap trips on a good day. Mark conservatively: at the
   * vault rate, NET of the exit fee, and at 0 for anything without a live
   * price. Absent (V1) → shares are not marked and the USD net stands.
   */
  markShares?: (satsShares: bigint, tokenShares: bigint) => bigint;
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

  /** Vault shares won by deploys made on `date` (same day attribution as returnedToday). */
  sharesWonToday(date = utcDate()): { satsShares: bigint; tokenShares: bigint } {
    const row = this.db.queryOne<{ sats: string | null; token: string | null }>(
      `SELECT COALESCE(SUM(CAST(s.won_shares AS INTEGER)), 0) AS sats,
              COALESCE(SUM(CAST(s.won_token_shares AS INTEGER)), 0) AS token
       FROM settlements s
       WHERE COALESCE(
               (SELECT date(MIN(d.created_at)) FROM my_deploys d
                 WHERE d.round_id = s.round_id AND d.status IN ('fired','landed')),
               date(s.created_at)
             ) = ?`,
      date,
    );
    return { satsShares: toBig(row?.sats ?? "0"), tokenShares: toBig(row?.token ?? "0") };
  }

  /**
   * Net today with the day's won shares marked (USD base units). Equals
   * todayNet() when no marker is wired (V1) — the marker is the only thing
   * that can lift the figure, never a way to hide a USD loss.
   */
  markedNetToday(date = utcDate()): bigint {
    const net = this.todayNet(date);
    if (!this.deps.markShares) return net;
    const won = this.sharesWonToday(date);
    if (won.satsShares === 0n && won.tokenShares === 0n) return net;
    const marked = this.deps.markShares(won.satsShares, won.tokenShares);
    return net + (marked > 0n ? marked : 0n);
  }

  /** Positive loss figure for Bankroll.realizedLossToday (shares marked when wired). */
  realizedLossToday(date = utcDate()): bigint {
    const net = this.markedNetToday(date);
    return net < 0n ? -net : 0n;
  }

  /** Expected EV (model, at fire time) vs realized, per round. */
  reconcileRound(roundId: number): RoundReconciliation {
    const deploys = this.db.query<{ amount: string; ev_expected: number | null; status: string }>(
      `SELECT amount, ev_expected, status FROM my_deploys
       WHERE round_id = ? AND status IN ('fired','landed')`,
      roundId,
    );
    const settles = this.db.query<{ won_usd: string; won_shares: string; won_token_shares: string }>(
      `SELECT won_usd, won_shares, won_token_shares FROM settlements WHERE round_id = ?`,
      roundId,
    );
    const deployed = deploys.reduce((a, d) => a + toBig(d.amount), 0n);
    const returnedUsd = settles.reduce((a, s) => a + toBig(s.won_usd), 0n);
    const wonShares = settles.reduce((a, s) => a + toBig(s.won_shares), 0n);
    const wonTokenShares = settles.reduce((a, s) => a + toBig(s.won_token_shares), 0n);
    const evs = deploys.map((d) => d.ev_expected).filter((v): v is number => v !== null);
    return {
      roundId,
      deployed,
      returnedUsd,
      wonShares,
      wonTokenShares,
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
    /** V2 RUSH leg; omit (or price 0) to value token shares at nothing. */
    tokenVault?: TokenVault | null | undefined;
    tokenUsdPrice?: number | undefined;
    tokenDecimals?: number | undefined;
  }): {
    usd: bigint;
    shares: bigint;
    btcBaseUnits: bigint;
    btcUsd: bigint;
    tokenShares: bigint;
    tokenBaseUnits: bigint;
    tokenUsd: bigint;
    totalUsd: bigint;
  } {
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
    const tokenShares = toBig(opts.miner.unclaimed_token_shares);
    const tv = opts.tokenVault;
    const vaultToken = tv ? toBig(tv.token_amount) : 0n;
    const vaultTokenShares = tv ? toBig(tv.token_shares) : 0n;
    const tokenBaseUnits = vaultTokenShares > 0n ? (tokenShares * vaultToken) / vaultTokenShares : 0n;
    const tokenPx = opts.tokenUsdPrice ?? 0;
    const tokenUsd = BigInt(
      Math.round((Number(tokenBaseUnits) / 10 ** (opts.tokenDecimals ?? 9)) * tokenPx * 1e6),
    );
    return {
      usd, shares, btcBaseUnits, btcUsd, tokenShares, tokenBaseUnits, tokenUsd,
      totalUsd: usd + btcUsd + tokenUsd,
    };
  }
}
