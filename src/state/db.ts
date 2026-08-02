/**
 * SQLite persistence (better-sqlite3, WAL). Append-only event log of what
 * the bot saw and did; amounts are stored as TEXT base-unit strings so u64
 * values never hit JS float precision. Write failures are recorded for the
 * health monitor and rethrown.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export interface RoundRecord {
  id: number;
  startSlot: number | null;
  endSlot: number | null;
  winningTile: number | null;
  deployedUsd: bigint;
  winningTileUsd: bigint;
  minersCount: number;
  strikeTriggered: boolean;
  /** All fee legs observed at reveal, JSON. */
  feesJson: string;
}

export interface MyDeployRecord {
  roundId: number;
  mask: number;
  amount: bigint;
  evExpected: number | null;
  firedSlot: number | null;
  sig: string;
  status: "fired" | "landed" | "missed" | "failed" | "dry";
}

export interface SettlementRecord {
  roundId: number;
  winningStake: bigint;
  wonUsd: bigint;
  wonShares: bigint;
  hashrateEarned: bigint;
  sig: string;
}

export interface CompetitorDeployRecord {
  roundId: number;
  authority: string;
  mask: number;
  amount: bigint;
  totalStake: bigint;
  isAutomation: boolean;
  reload: boolean;
  slot: number;
  sig: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY,
  start_slot INTEGER,
  end_slot INTEGER,
  winning_tile INTEGER,
  deployed_usd TEXT NOT NULL DEFAULT '0',
  winning_tile_usd TEXT NOT NULL DEFAULT '0',
  miners_count INTEGER NOT NULL DEFAULT 0,
  strike_triggered INTEGER NOT NULL DEFAULT 0,
  fees_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS occupancy_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  stakes_json TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_snapshots_round ON occupancy_snapshots(round_id);
CREATE TABLE IF NOT EXISTS my_deploys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL,
  mask INTEGER NOT NULL,
  amount TEXT NOT NULL,
  ev_expected REAL,
  fired_slot INTEGER,
  landed_slot INTEGER,
  sig TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_my_deploys_round ON my_deploys(round_id);
CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL,
  winning_stake TEXT NOT NULL,
  won_usd TEXT NOT NULL,
  won_shares TEXT NOT NULL,
  hashrate_earned TEXT NOT NULL,
  sig TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_settlements_round ON settlements(round_id);
CREATE TABLE IF NOT EXISTS competitor_deploys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL,
  authority TEXT NOT NULL,
  mask INTEGER NOT NULL,
  amount TEXT NOT NULL,
  total_stake TEXT NOT NULL,
  is_automation INTEGER NOT NULL,
  reload INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  sig TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(round_id, authority)
);
CREATE INDEX IF NOT EXISTS idx_competitor_round ON competitor_deploys(round_id);
CREATE TABLE IF NOT EXISTS pnl_daily (
  date TEXT PRIMARY KEY,
  deployed TEXT NOT NULL DEFAULT '0',
  returned TEXT NOT NULL DEFAULT '0',
  net TEXT NOT NULL DEFAULT '0',
  fees_paid TEXT NOT NULL DEFAULT '0',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export class StateDb {
  private readonly db: Database.Database;
  private writeError: string | null = null;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
  }

  /** Last write failure (message), for the health monitor. */
  lastWriteError(): string | null {
    return this.writeError;
  }

  private write<T>(fn: () => T): T {
    try {
      const result = fn();
      this.writeError = null;
      return result;
    } catch (err) {
      this.writeError = String(err);
      throw err;
    }
  }

  /** Insert-or-update by round id (fills reveal data when it arrives). */
  recordRound(r: RoundRecord): void {
    this.write(() =>
      this.db
        .prepare(
          `INSERT INTO rounds (id, start_slot, end_slot, winning_tile, deployed_usd,
             winning_tile_usd, miners_count, strike_triggered, fees_json)
           VALUES (@id, @startSlot, @endSlot, @winningTile, @deployedUsd,
             @winningTileUsd, @minersCount, @strikeTriggered, @feesJson)
           ON CONFLICT(id) DO UPDATE SET
             start_slot = COALESCE(excluded.start_slot, start_slot),
             end_slot = COALESCE(excluded.end_slot, end_slot),
             winning_tile = COALESCE(excluded.winning_tile, winning_tile),
             deployed_usd = excluded.deployed_usd,
             winning_tile_usd = excluded.winning_tile_usd,
             miners_count = excluded.miners_count,
             strike_triggered = excluded.strike_triggered,
             fees_json = excluded.fees_json`,
        )
        .run({
          id: r.id,
          startSlot: r.startSlot,
          endSlot: r.endSlot,
          winningTile: r.winningTile,
          deployedUsd: r.deployedUsd.toString(),
          winningTileUsd: r.winningTileUsd.toString(),
          minersCount: r.minersCount,
          strikeTriggered: r.strikeTriggered ? 1 : 0,
          feesJson: r.feesJson,
        }),
    );
  }

  recordOccupancySnapshot(
    roundId: number,
    slot: number,
    stakes: bigint[],
    source: string,
  ): void {
    this.write(() =>
      this.db
        .prepare(
          `INSERT INTO occupancy_snapshots (round_id, slot, stakes_json, source)
           VALUES (?, ?, ?, ?)`,
        )
        .run(roundId, slot, JSON.stringify(stakes.map(String)), source),
    );
  }

  recordMyDeploy(d: MyDeployRecord): void {
    this.write(() =>
      this.db
        .prepare(
          `INSERT INTO my_deploys (round_id, mask, amount, ev_expected, fired_slot, sig, status)
           VALUES (@roundId, @mask, @amount, @evExpected, @firedSlot, @sig, @status)
           ON CONFLICT(sig) DO UPDATE SET status = excluded.status`,
        )
        .run({
          roundId: d.roundId,
          mask: d.mask,
          amount: d.amount.toString(),
          evExpected: d.evExpected,
          firedSlot: d.firedSlot,
          sig: d.sig,
          status: d.status,
        }),
    );
  }

  updateMyDeployStatus(
    sig: string,
    status: MyDeployRecord["status"],
    landedSlot?: number,
  ): void {
    this.write(() =>
      this.db
        .prepare(
          `UPDATE my_deploys SET status = ?, landed_slot = COALESCE(?, landed_slot)
           WHERE sig = ?`,
        )
        .run(status, landedSlot ?? null, sig),
    );
  }

  /** Mark landed by (round, authority-implied) when the sig isn't known (event path). */
  markDeployLandedByRound(roundId: number, landedSlot: number): void {
    this.write(() =>
      this.db
        .prepare(
          `UPDATE my_deploys SET status = 'landed', landed_slot = COALESCE(landed_slot, ?)
           WHERE round_id = ? AND status IN ('fired')`,
        )
        .run(landedSlot, roundId),
    );
  }

  recordSettlement(s: SettlementRecord): void {
    this.write(() =>
      this.db
        .prepare(
          `INSERT OR IGNORE INTO settlements
             (round_id, winning_stake, won_usd, won_shares, hashrate_earned, sig)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          s.roundId,
          s.winningStake.toString(),
          s.wonUsd.toString(),
          s.wonShares.toString(),
          s.hashrateEarned.toString(),
          s.sig,
        ),
    );
  }

  recordCompetitorDeploy(c: CompetitorDeployRecord): void {
    this.write(() =>
      this.db
        .prepare(
          `INSERT OR IGNORE INTO competitor_deploys
             (round_id, authority, mask, amount, total_stake, is_automation, reload, slot, sig)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          c.roundId,
          c.authority,
          c.mask,
          c.amount.toString(),
          c.totalStake.toString(),
          c.isAutomation ? 1 : 0,
          c.reload ? 1 : 0,
          c.slot,
          c.sig,
        ),
    );
  }

  upsertPnlDaily(
    date: string,
    v: { deployed: bigint; returned: bigint; net: bigint; feesPaid: bigint },
  ): void {
    this.write(() =>
      this.db
        .prepare(
          `INSERT INTO pnl_daily (date, deployed, returned, net, fees_paid, updated_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(date) DO UPDATE SET
             deployed = excluded.deployed, returned = excluded.returned,
             net = excluded.net, fees_paid = excluded.fees_paid,
             updated_at = excluded.updated_at`,
        )
        .run(date, v.deployed.toString(), v.returned.toString(), v.net.toString(), v.feesPaid.toString()),
    );
  }

  // ── queries ────────────────────────────────────────────────────────────────

  query<T>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  queryOne<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  tableCounts(): Record<string, number> {
    const tables = [
      "rounds",
      "occupancy_snapshots",
      "my_deploys",
      "settlements",
      "competitor_deploys",
      "pnl_daily",
    ];
    return Object.fromEntries(
      tables.map((t) => [
        t,
        (this.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`) ?? { n: 0 }).n,
      ]),
    );
  }

  close(): void {
    this.db.close();
  }
}
