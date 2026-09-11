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
  /** Miner's current_streak_count at deploy time — instrumentation so the
   * streak's effect on the claim reward can be measured (its value is not yet
   * quantifiable: it scales the hashrate/BTC-shares reward, price TBD). */
  streak?: number | null;
  /** Signing wallet (base58); null = the primary / single-wallet era. */
  wallet?: string | null;
}

export interface SettlementRecord {
  roundId: number;
  winningStake: bigint;
  wonUsd: bigint;
  wonShares: bigint;
  hashrateEarned: bigint;
  /** V2 RUSH leg: tokens credited (base units, 9 dec) and the vault shares they became. */
  wonTokenAmount?: bigint | undefined;
  wonTokenShares?: bigint | undefined;
  /** Deployer wallet (base58) the settlement belongs to; null = primary. */
  wallet?: string | null;
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
  streak INTEGER,
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
  won_token_amount TEXT NOT NULL DEFAULT '0',
  won_token_shares TEXT NOT NULL DEFAULT '0',
  wallet TEXT,
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
-- Why a round was NOT played. Skip reasons only ever went to the log, so
-- "the bot has been silent for 2,000 rounds" was not answerable from data —
-- exactly the question an operator asks first. One row per round per reason.
CREATE TABLE IF NOT EXISTS skips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(round_id, reason)
);
CREATE INDEX IF NOT EXISTS idx_skips_round ON skips(round_id);
CREATE TABLE IF NOT EXISTS pnl_daily (
  date TEXT PRIMARY KEY,
  deployed TEXT NOT NULL DEFAULT '0',
  returned TEXT NOT NULL DEFAULT '0',
  net TEXT NOT NULL DEFAULT '0',
  fees_paid TEXT NOT NULL DEFAULT '0',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS vault_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,          -- 'epoch' | 'one_btc'
  iteration_id INTEGER NOT NULL,
  tickets INTEGER NOT NULL,
  ticket_pubkey TEXT,          -- 1-BTC entry account (needed to claim); null for epoch
  wallet TEXT,                 -- buying wallet (base58); null = primary
  sig TEXT NOT NULL UNIQUE,
  claimed INTEGER NOT NULL DEFAULT 0,  -- 1 once the iteration is resolved for us
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vault_tickets_iter ON vault_tickets(kind, iteration_id);
-- Vault claim PROCEEDS. The claim instructions emit no event, so the only way to
-- learn what a claim actually paid is to diff our token balances around it. This
-- is the receipts side of the vault ledger: without it, vault_tickets records
-- what we spend and nothing records what we get, so a hashrate unit can never
-- be priced (HASHRATE_VALUE_USD stays 0 and the whole hashrate credit is inert).
CREATE TABLE IF NOT EXISTS vault_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,           -- 'epoch' | 'one_btc'
  iteration_id INTEGER NOT NULL,
  usd_base TEXT NOT NULL DEFAULT '0',   -- USDC delta observed on our ATA
  btc_base TEXT NOT NULL DEFAULT '0',   -- BTC delta observed on our ATA
  sig TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(kind, iteration_id)
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
    this.migrate();
  }

  /** Additive, idempotent migrations for DBs created before a column existed. */
  private migrate(): void {
    const cols = this.db
      .prepare(`SELECT name FROM pragma_table_info('my_deploys')`)
      .all() as { name: string }[];
    if (!cols.some((c) => c.name === "streak")) {
      this.db.exec(`ALTER TABLE my_deploys ADD COLUMN streak INTEGER`);
    }
    if (!cols.some((c) => c.name === "wallet")) {
      // Per-wallet attribution. Without it a fleet's rows are indistinguishable,
      // so per-wallet streak reconstruction and P&L both silently merge.
      this.db.exec(`ALTER TABLE my_deploys ADD COLUMN wallet TEXT`);
    }
    // V2 settlements carry a RUSH leg; V1-era rows read 0.
    const scols = this.db
      .prepare(`SELECT name FROM pragma_table_info('settlements')`)
      .all() as { name: string }[];
    for (const col of ["won_token_amount", "won_token_shares"]) {
      if (!scols.some((c) => c.name === col)) {
        this.db.exec(`ALTER TABLE settlements ADD COLUMN ${col} TEXT NOT NULL DEFAULT '0'`);
      }
    }
    // Wallet-set attribution on settlements and vault tickets.
    if (!scols.some((c) => c.name === "wallet")) {
      this.db.exec(`ALTER TABLE settlements ADD COLUMN wallet TEXT`);
    }
    const vcols = this.db
      .prepare(`SELECT name FROM pragma_table_info('vault_tickets')`)
      .all() as { name: string }[];
    if (!vcols.some((c) => c.name === "wallet")) {
      this.db.exec(`ALTER TABLE vault_tickets ADD COLUMN wallet TEXT`);
    }
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

  /** Record why a round was skipped; idempotent per (round, reason). */
  recordSkip(roundId: number, reason: string, detail: Record<string, unknown>): void {
    this.write(() =>
      this.db
        .prepare(
          `INSERT OR IGNORE INTO skips (round_id, reason, detail_json)
           VALUES (?, ?, ?)`,
        )
        .run(roundId, reason, JSON.stringify(detail).slice(0, 2000)),
    );
  }

  recordMyDeploy(d: MyDeployRecord): void {
    this.write(() =>
      this.db
        .prepare(
          `INSERT INTO my_deploys (round_id, mask, amount, ev_expected, fired_slot, sig, status, streak, wallet)
           VALUES (@roundId, @mask, @amount, @evExpected, @firedSlot, @sig, @status, @streak, @wallet)
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
          streak: d.streak ?? null,
          wallet: d.wallet ?? null,
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
  /** Mark the round's fired row(s) landed — only `wallet`'s when given (fleet). */
  markDeployLandedByRound(roundId: number, landedSlot: number, wallet?: string | null): void {
    this.write(() =>
      this.db
        .prepare(
          `UPDATE my_deploys SET status = 'landed', landed_slot = COALESCE(landed_slot, ?)
           WHERE round_id = ? AND status IN ('fired') AND (? IS NULL OR wallet IS NULL OR wallet = ?)`,
        )
        .run(landedSlot, roundId, wallet ?? null, wallet ?? null),
    );
  }

  /** Wallets whose deploy landed in `roundId` (null entries = the primary). */
  landedWallets(roundId: number): (string | null)[] {
    return this.query<{ wallet: string | null }>(
      `SELECT DISTINCT wallet FROM my_deploys WHERE round_id = ? AND status = 'landed'`,
      roundId,
    ).map((r) => r.wallet);
  }

  recordSettlement(s: SettlementRecord): void {
    this.write(() =>
      this.db
        .prepare(
          `INSERT OR IGNORE INTO settlements
             (round_id, winning_stake, won_usd, won_shares, hashrate_earned,
              won_token_amount, won_token_shares, wallet, sig)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          s.roundId,
          s.winningStake.toString(),
          s.wonUsd.toString(),
          s.wonShares.toString(),
          s.hashrateEarned.toString(),
          (s.wonTokenAmount ?? 0n).toString(),
          (s.wonTokenShares ?? 0n).toString(),
          s.wallet ?? null,
          s.sig,
        ),
    );
  }

  /** Record a vault ticket buy (kind+iteration, ticket account for 1-BTC claims). */
  recordVaultTicket(v: {
    kind: "epoch" | "one_btc";
    iterationId: number;
    tickets: number;
    ticketPubkey: string | null;
    sig: string;
    /** Buying wallet (base58); omit for the primary. */
    wallet?: string | null;
  }): void {
    this.write(() =>
      this.db
        .prepare(
          `INSERT OR IGNORE INTO vault_tickets (kind, iteration_id, tickets, ticket_pubkey, wallet, sig)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(v.kind, v.iterationId, v.tickets, v.ticketPubkey, v.wallet ?? null, v.sig),
    );
  }

  /** Total tickets we hold in a given vault iteration (0 if none). */
  /** Tickets held in (kind, iteration) — by `wallet` when given, else fleet-wide. */
  vaultTicketsHeld(kind: "epoch" | "one_btc", iterationId: number, wallet?: string | null): number {
    const row = this.queryOne<{ total: number | null }>(
      `SELECT COALESCE(SUM(tickets), 0) AS total FROM vault_tickets
       WHERE kind = ? AND iteration_id = ? AND (? IS NULL OR wallet IS ? OR wallet = ?)`,
      kind,
      iterationId,
      wallet ?? null,
      wallet ?? null,
      wallet ?? null,
    );
    return row?.total ?? 0;
  }

  /** 1-BTC ticket accounts we hold for an iteration, with the buying wallet. */
  oneBtcTickets(iterationId: number): { ticketPubkey: string; wallet: string | null }[] {
    return this.query<{ ticket_pubkey: string; wallet: string | null }>(
      `SELECT ticket_pubkey, wallet FROM vault_tickets
       WHERE kind = 'one_btc' AND iteration_id = ? AND ticket_pubkey IS NOT NULL`,
      iterationId,
    ).map((r) => ({ ticketPubkey: r.ticket_pubkey, wallet: r.wallet }));
  }

  /** Distinct (kind, iteration_id) we hold unresolved tickets in (for claim/crank). */
  unclaimedVaultIterations(): { kind: "epoch" | "one_btc"; iteration_id: number }[] {
    return this.query<{ kind: "epoch" | "one_btc"; iteration_id: number }>(
      `SELECT DISTINCT kind, iteration_id FROM vault_tickets
       WHERE claimed = 0 ORDER BY iteration_id ASC`,
    );
  }

  /** Our 1-BTC ticket account pubkeys for an iteration (to check the win + claim). */
  oneBtcTicketPubkeys(iterationId: number): string[] {
    return this.query<{ ticket_pubkey: string }>(
      `SELECT ticket_pubkey FROM vault_tickets
       WHERE kind = 'one_btc' AND iteration_id = ? AND ticket_pubkey IS NOT NULL`,
      iterationId,
    ).map((r) => r.ticket_pubkey);
  }

  /** Record what a vault claim actually paid (token-balance deltas). */
  /**
   * Did farming clear its cost, for one completed epoch iteration?
   *
   * This is the evidence the HASHRATE_DEPLOY_CREDIT_ENABLED gate is waiting
   * on, and it is deliberately backward-looking: it compares what an epoch
   * claim ACTUALLY paid against the board result of the deploys made while
   * that iteration was open. Every mistake in this project's history came from
   * projecting one side of that comparison mid-iteration, so this refuses to
   * do arithmetic on an iteration that has not paid out yet.
   *
   * Board result is settlements less deploys — the realised thing, not the
   * modelled one. Shares are returned separately rather than valued here,
   * because their price moves and the caller has the live vault ratio.
   */
  farmingVerdict(iterationId: number, fromRound: number, toRound: number): {
    claimed: boolean;
    epochUsd: bigint;
    epochBtc: bigint;
    deployedUsd: bigint;
    wonUsd: bigint;
    wonShares: bigint;
    deploys: number;
  } {
    const claim = this.queryOne<{ usd_base: string; btc_base: string }>(
      `SELECT usd_base, btc_base FROM vault_claims WHERE kind = 'epoch' AND iteration_id = ?`,
      iterationId,
    );
    const spent = this.queryOne<{ n: number; amt: string | null }>(
      `SELECT COUNT(*) AS n, CAST(COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS TEXT) AS amt
         FROM my_deploys WHERE round_id BETWEEN ? AND ? AND status = 'landed'`,
      fromRound,
      toRound,
    );
    const won = this.queryOne<{ usd: string | null; shares: string | null }>(
      `SELECT CAST(COALESCE(SUM(CAST(won_usd AS INTEGER)), 0) AS TEXT) AS usd,
              CAST(COALESCE(SUM(CAST(won_shares AS INTEGER)), 0) AS TEXT) AS shares
         FROM settlements WHERE round_id BETWEEN ? AND ?`,
      fromRound,
      toRound,
    );
    return {
      claimed: claim !== undefined,
      epochUsd: BigInt(claim?.usd_base ?? "0"),
      epochBtc: BigInt(claim?.btc_base ?? "0"),
      deployedUsd: BigInt(spent?.amt ?? "0"),
      wonUsd: BigInt(won?.usd ?? "0"),
      wonShares: BigInt(won?.shares ?? "0"),
      deploys: spent?.n ?? 0,
    };
  }

  recordVaultClaim(c: {
    kind: "epoch" | "one_btc";
    iterationId: number;
    usdBase: bigint;
    btcBase: bigint;
    sig: string;
  }): void {
    this.write(() =>
      this.db
        .prepare(
          `INSERT OR IGNORE INTO vault_claims (kind, iteration_id, usd_base, btc_base, sig)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(c.kind, c.iterationId, c.usdBase.toString(), c.btcBase.toString(), c.sig),
    );
  }

  /**
   * Realized vault economics: hashrate spent on tickets vs value received.
   * This is what prices a raw hashrate unit (HASHRATE_VALUE_USD) empirically —
   * value ÷ spend — once enough iterations have resolved.
   */
  vaultEconomics(): {
    ticketsBought: number;
    iterationsResolved: number;
    iterationsPaid: number;
    usdClaimed: bigint;
    btcClaimed: bigint;
  } {
    const t = this.queryOne<{ tickets: number | null }>(
      `SELECT COALESCE(SUM(tickets), 0) AS tickets FROM vault_tickets`,
    );
    const resolved = this.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (SELECT DISTINCT kind, iteration_id FROM vault_tickets WHERE claimed = 1)`,
    );
    const c = this.queryOne<{ n: number; usd: string | null; btc: string | null }>(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CAST(usd_base AS INTEGER)), 0) AS usd,
              COALESCE(SUM(CAST(btc_base AS INTEGER)), 0) AS btc
       FROM vault_claims`,
    );
    return {
      ticketsBought: t?.tickets ?? 0,
      iterationsResolved: resolved?.n ?? 0,
      iterationsPaid: c?.n ?? 0,
      usdClaimed: BigInt(c?.usd ?? "0"),
      btcClaimed: BigInt(c?.btc ?? "0"),
    };
  }

  /** Mark an iteration resolved for us (claimed a win, or confirmed a loss). */
  markVaultClaimed(kind: "epoch" | "one_btc", iterationId: number): void {
    this.write(() =>
      this.db
        .prepare(`UPDATE vault_tickets SET claimed = 1 WHERE kind = ? AND iteration_id = ?`)
        .run(kind, iterationId),
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

  /**
   * Run `fn` inside a single SQLite transaction (all-or-nothing). Used to
   * make each round's multi-row writes (deploy record, settlement,
   * pnl_daily) atomic — a crash mid-sequence leaves no partial round.
   * Write failures are recorded for the health monitor and rethrown.
   */
  transaction<T>(fn: () => T): T {
    return this.write(() => this.db.transaction(fn)());
  }

  close(): void {
    this.db.close();
  }
}
