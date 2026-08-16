/**
 * Shared monitoring data layer. The read-only HTTP API, the dashboard, and
 * the Telegram commands all read through MonitorData so there is one source
 * of truth. Everything returned is JSON-safe (bigints → decimal strings,
 * USD as numbers) — nothing here can mutate bot state.
 */
import type { Miner, Round, SatrushConfig, SatsVault } from "../adapter/idl.js";
import { TILES_COUNT } from "../ingest/decode.js";
import type { PriceStatus } from "../ingest/prices.js";
import { buildIntel, type IntelJson } from "./intel.js";
import type { GameState } from "../ingest/snapshot.js";
import type { StateDb } from "../state/db.js";
import type { Pnl } from "../state/pnl.js";
import { baseToUsd } from "../units.js";

export interface StatusJson {
  ts: string;
  mode: string;
  paused: boolean;
  killSwitch: boolean;
  ingest: {
    fresh: boolean;
    slotAgeMs: number;
    source: string;
    /** Snapshot-vs-head lag in slots; null if not measured recently. */
    lagSlots: number | null;
    /** True when lag alone is blocking fires (stream alive but behind). */
    lagBlocking: boolean;
  };
  round: {
    id: number | null;
    state: string | null;
    slotsToCutoff: number | null;
    currentSlot: number;
  };
  board: { tileStakesUsd: number[]; totalUsd: number; strikePoolUsd: number };
  me: { streak: number | null; tiles: number[]; stakeUsd: number };
  pnl: { todayNetUsd: number; deployedTodayUsd: number; returnedTodayUsd: number };
  /**
   * `sharesUsd` is the BTC-share position valued NET of the claim fee. Roughly
   * 12% of every deploy comes back this way rather than as USDC, so a P&L that
   * reports only `usd` understates the position by that much — the single
   * easiest way to mistake a profitable bot for a losing one.
   */
  unclaimed: { usd: number; shares: string; sharesUsd: number };
  caps: { maxPerRoundUsd: number; dailyLossCapUsd: number; dailyLossLeftUsd: number };
  /** Oracle prices actually in force; `live: false` means a fallback is in use. */
  prices: PriceStatus;
}

export interface HealthJson {
  ingestFresh: boolean;
  ingestSlotAgeMs: number;
  solBalance: number | null;
  usdcBalance: number | null;
  dbError: string | null;
}

/**
 * Live on-chain vault state. These accounts are read only by the vault manager's
 * poll loop, so it caches them here — otherwise pool size, field size and what a
 * ticket is currently worth are invisible to monitoring, and entry decisions
 * happen against data nobody can see.
 */
export interface VaultPoolsJson {
  slot: number;
  epoch: {
    iterationId: number;
    open: boolean;
    totalTickets: number;
    myTickets: number;
    poolUsd: number;
    slotsToClose: number;
    /** Marginal USD value of the next ticket, at our current holding. */
    ticketEvUsd: number;
  } | null;
  oneBtc: {
    iterationId: number;
    open: boolean;
    totalTickets: number;
    prizeUsd: number;
    /** Vault fill toward the 1-BTC trigger, in bps. */
    fillBps: number;
    ticketEvUsd: number;
  } | null;
}

export interface VaultJson {
  enabled: boolean;
  hashrate: number;
  unclaimedHashrate: number;
  epoch: { ticketsBought: number; iterationsPlayed: number; iterationsClaimed: number };
  oneBtc: { ticketsBought: number; iterationsPlayed: number; iterationsClaimed: number };
  /**
   * Realized economics — what tickets cost in hashrate vs what claims paid.
   * `usdPerRawUnit` is the empirical price of a hashrate unit: the value that
   * belongs in HASHRATE_VALUE_USD once enough iterations have resolved. Null
   * until at least one claim has been measured.
   */
  economics: {
    hashrateSpentRaw: number;
    usdClaimed: number;
    btcClaimedUsd: number;
    iterationsResolved: number;
    iterationsPaid: number;
    usdPerRawUnit: number | null;
  };
  /** Live on-chain pool state; null until the vault manager's first poll. */
  pools: VaultPoolsJson | null;
  /**
   * What a raw hashrate unit is worth right now, and where that came from.
   * `derived` = priced off live vault pools; `config` = operator override;
   * `none` = no open vault, so earned hashrate is currently credited at zero.
   */
  hashrateValue: { usdPerRawUnit: number; source: "derived" | "config" | "none" };
  recent: Record<string, unknown>[];
}

export interface MonitorData {
  status(): StatusJson;
  /** Day-by-day PnL history, newest first (up to `limit` rows). */
  pnlDaily(limit: number): Record<string, unknown>[];
  recentRounds(limit: number): Record<string, unknown>[];
  recentDeploys(limit: number): Record<string, unknown>[];
  recentCompetitors(limit: number): Record<string, unknown>[];
  vault(): VaultJson;
  /** Derived strategy intelligence over the last `windowRounds` rounds. */
  intel(windowRounds: number): IntelJson;
  health(): Promise<HealthJson>;
}

export interface MonitorContext {
  db: StateDb;
  pnl: Pnl;
  state: GameState;
  mode: string;
  source: { stale(): boolean; lastUpdateAgeMs(s: "slots"): number };
  ingestSourceName: string;
  isPaused: () => boolean;
  killSwitchEngaged: () => boolean;
  maxPerRoundBase: bigint;
  dailyLossCapBase: bigint;
  myAuthority: string;
  solBalanceLamports: () => Promise<number>;
  usdcBalanceBaseUnits: () => Promise<bigint>;
  /** Live BTC/USD (oracle-backed); a getter so it isn't frozen at boot. */
  btcUsdEstimate: () => number;
  /** Full oracle status (both symbols + live flags) for the status payload. */
  priceStatus: () => PriceStatus;
  /** Snapshot-vs-head lag, and whether it is currently gating fires. */
  slotLag: () => { lagSlots: number | null; blocking: boolean };
  vaultEnabled: boolean;
  /** Raw hashrate units per vault ticket — converts tickets bought into spend. */
  ticketPriceHashrate: number;
  /** Latest on-chain vault pool state, cached by the vault manager poll. */
  vaultPools: () => VaultPoolsJson | null;
  /** Live price of a raw hashrate unit, as fed to the deploy EV. */
  hashrateValue: () => VaultJson["hashrateValue"];
  /** Fire offset in force, for the "which rivals fire after us" split. */
  fireOffsetSlots: () => number;
  /** USD value of ONE sats-vault BTC share, net of the claim fee. 0 if unknown. */
  shareValueUsd: () => number;
}

const big = (v: { toString(): string } | null | undefined): bigint =>
  BigInt((v ?? "0").toString());

export function createMonitorData(ctx: MonitorContext): MonitorData {
  const roundStateName = (round: Round | null): string | null =>
    round ? (Object.keys(round.state)[0] ?? null) : null;

  const myTilesThisRound = (roundId: number | null): { tiles: number[]; stakeUsd: number } => {
    if (roundId === null) return { tiles: [], stakeUsd: 0 };
    const row = ctx.db.queryOne<{ mask: number; amount: string }>(
      "SELECT mask, amount FROM my_deploys WHERE round_id = ? ORDER BY id DESC LIMIT 1",
      roundId,
    );
    if (!row) return { tiles: [], stakeUsd: 0 };
    const tiles: number[] = [];
    for (let i = 0; i < TILES_COUNT; i++) if (row.mask & (1 << i)) tiles.push(i);
    return { tiles, stakeUsd: baseToUsd(BigInt(row.amount)) };
  };

  return {
    status(): StatusJson {
      const round = ctx.state.currentRound();
      const roundId = ctx.state.board?.round_id ?? null;
      const stakes = ctx.state.visibleStakes();
      const miner = ctx.state.miner;
      const mine = myTilesThisRound(roundId);
      const dailyLoss = ctx.pnl.realizedLossToday();
      const lag = ctx.slotLag();
      return {
        ts: new Date().toISOString(),
        mode: ctx.mode,
        paused: ctx.isPaused(),
        killSwitch: ctx.killSwitchEngaged(),
        ingest: {
          fresh: !ctx.source.stale(),
          slotAgeMs: Math.round(ctx.source.lastUpdateAgeMs("slots")),
          source: ctx.ingestSourceName,
          lagSlots: lag.lagSlots,
          lagBlocking: lag.blocking,
        },
        round: {
          id: roundId,
          state: roundStateName(round),
          slotsToCutoff: ctx.state.slotsToCutoff(),
          currentSlot: ctx.state.currentSlot,
        },
        board: {
          tileStakesUsd: stakes.map(baseToUsd),
          totalUsd: baseToUsd(stakes.reduce((a, b) => a + b, 0n)),
          strikePoolUsd: baseToUsd(ctx.state.strikePoolUsd()),
        },
        me: {
          streak: miner?.current_streak_count ?? null,
          tiles: mine.tiles,
          stakeUsd: mine.stakeUsd,
        },
        pnl: {
          todayNetUsd: baseToUsd(ctx.pnl.todayNet()),
          deployedTodayUsd: baseToUsd(ctx.pnl.deployedToday()),
          returnedTodayUsd: baseToUsd(ctx.pnl.returnedToday()),
        },
        unclaimed: {
          usd: baseToUsd(big(miner?.unclaimed_usd_amount)),
          shares: big(miner?.unclaimed_btc_shares).toString(),
          sharesUsd: Number(big(miner?.unclaimed_btc_shares)) * ctx.shareValueUsd(),
        },
        caps: {
          maxPerRoundUsd: baseToUsd(ctx.maxPerRoundBase),
          dailyLossCapUsd: baseToUsd(ctx.dailyLossCapBase),
          dailyLossLeftUsd: baseToUsd(
            ctx.dailyLossCapBase > dailyLoss ? ctx.dailyLossCapBase - dailyLoss : 0n,
          ),
        },
        prices: ctx.priceStatus(),
      };
    },

    pnlDaily(limit) {
      return ctx.db.query<Record<string, unknown>>(
        "SELECT date, deployed, returned, net, fees_paid FROM pnl_daily ORDER BY date DESC LIMIT ?",
        Math.min(Math.max(1, limit), 365),
      );
    },

    recentRounds(limit) {
      return ctx.db.query(
        "SELECT id, winning_tile, deployed_usd, winning_tile_usd, miners_count, strike_triggered, created_at FROM rounds ORDER BY id DESC LIMIT ?",
        Math.min(Math.max(1, limit), 200),
      );
    },

    recentDeploys(limit) {
      return ctx.db.query(
        "SELECT round_id, mask, amount, ev_expected, fired_slot, landed_slot, status, created_at FROM my_deploys ORDER BY id DESC LIMIT ?",
        Math.min(Math.max(1, limit), 200),
      );
    },

    recentCompetitors(limit) {
      return ctx.db.query(
        "SELECT round_id, authority, mask, amount, total_stake, is_automation, reload, slot, created_at FROM competitor_deploys ORDER BY id DESC LIMIT ?",
        Math.min(Math.max(1, limit), 200),
      );
    },

    vault(): VaultJson {
      // Realized vault economics. usdPerRawUnit is the empirical price of a
      // hashrate unit — the figure that belongs in HASHRATE_VALUE_USD, and the
      // input the whole hashrate credit is currently waiting on.
      const economics = (): VaultJson["economics"] => {
        const v = ctx.db.vaultEconomics();
        const hashrateSpentRaw = v.ticketsBought * ctx.ticketPriceHashrate;
        const usdClaimed = baseToUsd(v.usdClaimed);
        const btcClaimedUsd = (Number(v.btcClaimed) / 1e8) * ctx.btcUsdEstimate();
        return {
          hashrateSpentRaw,
          usdClaimed,
          btcClaimedUsd,
          iterationsResolved: v.iterationsResolved,
          iterationsPaid: v.iterationsPaid,
          // Only meaningful once something has actually been claimed AND spent.
          usdPerRawUnit:
            v.iterationsPaid > 0 && hashrateSpentRaw > 0
              ? (usdClaimed + btcClaimedUsd) / hashrateSpentRaw
              : null,
        };
      };
      const agg = (kind: "epoch" | "one_btc") =>
        ctx.db.queryOne<{ tickets: number; iters: number; claimed: number }>(
          `SELECT COALESCE(SUM(tickets),0) AS tickets,
                  COUNT(DISTINCT iteration_id) AS iters,
                  COUNT(DISTINCT CASE WHEN claimed=1 THEN iteration_id END) AS claimed
           FROM vault_tickets WHERE kind = ?`,
          kind,
        ) ?? { tickets: 0, iters: 0, claimed: 0 };
      const e = agg("epoch");
      const o = agg("one_btc");
      const miner = ctx.state.miner;
      return {
        enabled: ctx.vaultEnabled,
        hashrate: Number(big(miner?.hashrate_amount).toString()),
        unclaimedHashrate: Number(big(miner?.unclaimed_hashrate).toString()),
        epoch: { ticketsBought: e.tickets, iterationsPlayed: e.iters, iterationsClaimed: e.claimed },
        oneBtc: { ticketsBought: o.tickets, iterationsPlayed: o.iters, iterationsClaimed: o.claimed },
        economics: economics(),
        pools: ctx.vaultPools(),
        hashrateValue: ctx.hashrateValue(),
        recent: ctx.db.query(
          "SELECT kind, iteration_id, tickets, ticket_pubkey, claimed, sig, created_at FROM vault_tickets ORDER BY id DESC LIMIT 15",
        ),
      };
    },

    intel(windowRounds) {
      return buildIntel(ctx.db, {
        windowRounds: Math.min(Math.max(1, windowRounds), 5000),
        fireOffsetSlots: ctx.fireOffsetSlots(),
        shareValueUsd: ctx.shareValueUsd(),
      });
    },

    async health(): Promise<HealthJson> {
      let sol: number | null = null;
      let usdc: number | null = null;
      try {
        sol = (await ctx.solBalanceLamports()) / 1e9;
      } catch {
        /* transient */
      }
      try {
        usdc = baseToUsd(await ctx.usdcBalanceBaseUnits());
      } catch {
        /* transient */
      }
      return {
        ingestFresh: !ctx.source.stale(),
        ingestSlotAgeMs: Math.round(ctx.source.lastUpdateAgeMs("slots")),
        solBalance: sol,
        usdcBalance: usdc,
        dbError: ctx.db.lastWriteError(),
      };
    },
  };
}

// (kept for callers that value miner/vault directly)
export type { Miner, SatrushConfig, SatsVault };
