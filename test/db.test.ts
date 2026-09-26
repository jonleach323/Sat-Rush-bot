import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { StateDb } from "../src/state/db.js";
import { usdToBase } from "../src/units.js";

function freshDb(): StateDb {
  return new StateDb(join(mkdtempSync(join(tmpdir(), "satrush-db-")), "test.db"));
}

describe("StateDb", () => {
  it("opens in WAL mode and creates all tables", () => {
    const db = freshDb();
    const mode = db.queryOne<{ journal_mode: string }>("PRAGMA journal_mode");
    expect(mode?.journal_mode).toBe("wal");
    expect(Object.keys(db.tableCounts())).toHaveLength(6);
    db.close();
  });

  it("rounds upsert: reveal data fills in later without duplicating", () => {
    const db = freshDb();
    db.recordRound({
      id: 1798,
      startSlot: 100,
      endSlot: 150,
      winningTile: null,
      deployedUsd: usdToBase(4.6),
      winningTileUsd: 0n,
      minersCount: 1,
      strikeTriggered: false,
      feesJson: "{}",
    });
    db.recordRound({
      id: 1798,
      startSlot: null,
      endSlot: null,
      winningTile: 10,
      deployedUsd: usdToBase(4.048),
      winningTileUsd: usdToBase(0.306666),
      minersCount: 1,
      strikeTriggered: false,
      feesJson: JSON.stringify({ epoch: "131000" }),
    });
    const rows = db.query<{ id: number; winning_tile: number; start_slot: number }>(
      "SELECT id, winning_tile, start_slot FROM rounds",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.winning_tile).toBe(10);
    expect(rows[0]!.start_slot).toBe(100); // COALESCE kept the armed value
    db.close();
  });

  it("stores amounts as lossless strings", () => {
    const db = freshDb();
    const big = 18_446_744_073_709_551_615n; // u64::MAX
    db.recordOccupancySnapshot(1, 42, [big, 0n], "test");
    const row = db.queryOne<{ stakes_json: string }>(
      "SELECT stakes_json FROM occupancy_snapshots",
    );
    expect(JSON.parse(row!.stakes_json)[0]).toBe(big.toString());
    db.close();
  });

  it("my_deploys lifecycle: fired → landed", () => {
    const db = freshDb();
    db.recordMyDeploy({
      roundId: 5,
      mask: 1,
      amount: usdToBase(1),
      evExpected: 0.25,
      firedSlot: 1000,
      sig: "sigA",
      status: "fired",
    });
    db.updateMyDeployStatus("sigA", "landed", 1002);
    const row = db.queryOne<{ status: string; landed_slot: number }>(
      "SELECT status, landed_slot FROM my_deploys WHERE sig = 'sigA'",
    );
    expect(row).toEqual({ status: "landed", landed_slot: 1002 });
    db.close();
  });

  it("records the streak snapshot on a deploy (instrumentation)", () => {
    const db = freshDb();
    db.recordMyDeploy({
      roundId: 5,
      mask: 1,
      amount: usdToBase(1),
      evExpected: 0.25,
      firedSlot: 1000,
      sig: "sigStreak",
      status: "fired",
      streak: 12,
    });
    const row = db.queryOne<{ streak: number }>(
      "SELECT streak FROM my_deploys WHERE sig = 'sigStreak'",
    );
    expect(row?.streak).toBe(12);
    db.close();
  });

  it("migrates an old my_deploys table missing the streak column", () => {
    const path = join(mkdtempSync(join(tmpdir(), "satrush-mig-")), "old.db");
    // Simulate a pre-migration DB: create my_deploys WITHOUT the streak column.
    const raw = new Database(path);
    raw.exec(`CREATE TABLE my_deploys (
      id INTEGER PRIMARY KEY AUTOINCREMENT, round_id INTEGER NOT NULL, mask INTEGER NOT NULL,
      amount TEXT NOT NULL, ev_expected REAL, fired_slot INTEGER, landed_slot INTEGER,
      sig TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    raw.close();
    // Opening via StateDb must add the column idempotently and accept a streak.
    const db = new StateDb(path);
    db.recordMyDeploy({
      roundId: 1, mask: 1, amount: usdToBase(1), evExpected: null,
      firedSlot: 1, sig: "m1", status: "fired", streak: 7,
    });
    expect(
      db.queryOne<{ streak: number }>("SELECT streak FROM my_deploys WHERE sig='m1'")?.streak,
    ).toBe(7);
    db.close();
    // Reopening (column already present) must not error — idempotent migration.
    const db2 = new StateDb(path);
    db2.close();
  });

  it("records vault claim proceeds and derives realized economics", () => {
    const db = freshDb();
    db.recordVaultTicket({
      kind: "epoch", iterationId: 7, tickets: 5, ticketPubkey: null, sig: "buy1",
    });
    db.recordVaultTicket({
      kind: "one_btc", iterationId: 3, tickets: 2, ticketPubkey: "TicketPk", sig: "buy2",
    });
    // Only the epoch iteration paid out.
    db.recordVaultClaim({
      kind: "epoch", iterationId: 7, usdBase: usdToBase(12), btcBase: 50_000n, sig: "claim1",
    });
    const e = db.vaultEconomics();
    expect(e.ticketsBought).toBe(7);
    expect(e.iterationsPaid).toBe(1);
    expect(e.usdClaimed).toBe(usdToBase(12));
    expect(e.btcClaimed).toBe(50_000n);

    // Resolved counts only iterations we've marked done.
    expect(e.iterationsResolved).toBe(0);
    db.markVaultClaimed("epoch", 7);
    expect(db.vaultEconomics().iterationsResolved).toBe(1);
    db.close();
  });

  it("vault claims dedupe on (kind, iteration) so a retry can't double-count", () => {
    const db = freshDb();
    db.recordVaultClaim({ kind: "epoch", iterationId: 1, usdBase: 100n, btcBase: 0n, sig: "a" });
    db.recordVaultClaim({ kind: "epoch", iterationId: 1, usdBase: 999n, btcBase: 0n, sig: "b" });
    expect(db.vaultEconomics().usdClaimed).toBe(100n);
    db.close();
  });

  it("competitor deploys dedupe on (round, authority)", () => {
    const db = freshDb();
    const record = {
      roundId: 9,
      authority: "AuthX",
      mask: 7,
      amount: usdToBase(5),
      totalStake: usdToBase(4.6),
      isAutomation: true,
      reload: false,
      slot: 123,
      sig: "s1",
    };
    db.recordCompetitorDeploy(record);
    db.recordCompetitorDeploy({ ...record, sig: "s1-duplicate-event" });
    expect(db.tableCounts()["competitor_deploys"]).toBe(1);
    db.close();
  });

  it("settlements dedupe on sig; pnl_daily upserts", () => {
    const db = freshDb();
    const s = {
      roundId: 9,
      winningStake: usdToBase(0.3),
      wonUsd: usdToBase(4.048),
      wonShares: 70692n,
      hashrateEarned: 17n,
      sig: "settleSig",
    };
    db.recordSettlement(s);
    db.recordSettlement(s);
    expect(db.tableCounts()["settlements"]).toBe(1);
    db.upsertPnlDaily("2026-08-01", {
      deployed: usdToBase(10),
      returned: usdToBase(4),
      net: usdToBase(-6),
      feesPaid: usdToBase(0.8),
    });
    db.upsertPnlDaily("2026-08-01", {
      deployed: usdToBase(15),
      returned: usdToBase(9),
      net: usdToBase(-6),
      feesPaid: usdToBase(1.2),
    });
    const row = db.queryOne<{ deployed: string }>(
      "SELECT deployed FROM pnl_daily WHERE date = '2026-08-01'",
    );
    expect(row!.deployed).toBe(usdToBase(15).toString());
    expect(db.tableCounts()["pnl_daily"]).toBe(1);
    db.close();
  });

  it("transaction() is atomic: a throw mid-sequence rolls back all writes", () => {
    const db = freshDb();
    expect(() =>
      db.transaction(() => {
        db.recordMyDeploy({
          roundId: 1,
          mask: 1,
          amount: usdToBase(1),
          evExpected: 0,
          firedSlot: 1,
          sig: "txn-sig",
          status: "fired",
        });
        throw new Error("boom mid-round");
      }),
    ).toThrow("boom");
    // the deploy write must have rolled back
    expect(db.tableCounts()["my_deploys"]).toBe(0);
    db.close();
  });

  it("transaction() commits all writes on success", () => {
    const db = freshDb();
    db.transaction(() => {
      db.recordSettlement({
        roundId: 9,
        winningStake: 0n,
        wonUsd: 0n,
        wonShares: 0n,
        hashrateEarned: 5n,
        sig: "s",
      });
      db.upsertPnlDaily("2026-08-02", { deployed: usdToBase(1), returned: 0n, net: -usdToBase(1), feesPaid: 0n });
    });
    expect(db.tableCounts()["settlements"]).toBe(1);
    expect(db.tableCounts()["pnl_daily"]).toBe(1);
    db.close();
  });

  it("records write errors for the health monitor", () => {
    const db = freshDb();
    expect(db.lastWriteError()).toBeNull();
    expect(() =>
      db.recordOccupancySnapshot(
        null as unknown as number, // NOT NULL violation
        1,
        [0n],
        "x",
      ),
    ).toThrow();
    expect(db.lastWriteError()).toContain("NOT NULL");
    db.close();
  });
});

describe("wallet-set attribution", () => {
  it("deploys, settlements and tickets carry the wallet; landed marks are per wallet", () => {
    const db = freshDb();
    const A = "walletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const B = "walletBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    for (const [w, sig] of [[A, "sigA"], [B, "sigB"]] as const) {
      db.recordMyDeploy({ roundId: 7, mask: 1, amount: usdToBase(1), evExpected: 0, firedSlot: 1, sig, status: "fired", wallet: w });
    }
    db.markDeployLandedByRound(7, 100, A);
    expect(db.landedWallets(7)).toEqual([A]);
    db.markDeployLandedByRound(7, 101, B);
    expect(db.landedWallets(7).sort()).toEqual([A, B]);
    db.recordSettlement({ roundId: 7, winningStake: 0n, wonUsd: usdToBase(0.89), wonShares: 0n, hashrateEarned: 1n, wallet: B, sig: "settleB" });
    expect(db.queryOne<{ wallet: string }>(`SELECT wallet FROM settlements WHERE sig = 'settleB'`)?.wallet).toBe(B);
    db.recordVaultTicket({ kind: "one_btc", iterationId: 3, tickets: 5, ticketPubkey: "tkt1", wallet: A, sig: "t1" });
    db.recordVaultTicket({ kind: "one_btc", iterationId: 3, tickets: 2, ticketPubkey: "tkt2", wallet: B, sig: "t2" });
    expect(db.vaultTicketsHeld("one_btc", 3)).toBe(7); // fleet-wide
    expect(db.vaultTicketsHeld("one_btc", 3, A)).toBe(5);
    expect(db.oneBtcTickets(3)).toEqual([
      { ticketPubkey: "tkt1", wallet: A },
      { ticketPubkey: "tkt2", wallet: B },
    ]);
    // Legacy rows (no wallet) still match a wallet-scoped landed mark.
    db.recordMyDeploy({ roundId: 8, mask: 1, amount: usdToBase(1), evExpected: 0, firedSlot: 1, sig: "legacy", status: "fired" });
    db.markDeployLandedByRound(8, 100, A);
    expect(db.landedWallets(8)).toEqual([null]);
    db.close();
  });
});


describe("pruneObservations — history is bounded, the ledger is not", () => {
  it("drops snapshots, competitor deploys and skips older than keepRounds and leaves my_deploys alone", () => {
    const db = freshDb();
    const comp = (roundId: number) => ({ roundId, authority: `A${roundId}`, mask: 7, amount: usdToBase(5), totalStake: usdToBase(4.6), isAutomation: true, reload: false, slot: roundId * 10, sig: `s${roundId}` });
    for (const r of [1, 2, 3, 50, 51]) {
      db.recordOccupancySnapshot(r, r * 10, new Array<bigint>(21).fill(0n), "grpc");
      db.recordCompetitorDeploy(comp(r));
      db.recordSkip(r, "paused", {});
    }
    db.recordMyDeploy({ roundId: 1, mask: 1, amount: usdToBase(1), evExpected: 0.1, firedSlot: 10, sig: "mine-1", status: "fired" });
    const removed = db.pruneObservations(51, 10); // keep rounds > 41
    expect(removed).toEqual({ occupancy_snapshots: 3, competitor_deploys: 3, skips: 3 });
    const counts = db.tableCounts();
    expect(counts["occupancy_snapshots"]).toBe(2);
    expect(counts["competitor_deploys"]).toBe(2);
    expect(counts["my_deploys"]).toBe(1); // the ledger is never pruned
    expect(db.pruneObservations(51, 10)).toEqual({ occupancy_snapshots: 0, competitor_deploys: 0, skips: 0 });
    db.close();
  });
});

describe("unsettled legs — the ledger's blind spot under V2", () => {
  it("lists landed legs with no settlement for (round, wallet), oldest first, and counts today's", () => {
    const db = freshDb();
    const leg = (roundId: number, wallet: string, sig: string) =>
      db.recordMyDeploy({ roundId, mask: 1, amount: usdToBase(1), evExpected: 0, firedSlot: 1, sig, status: "landed", wallet });
    leg(10, "A", "a10"); leg(10, "B", "b10"); leg(11, "A", "a11"); leg(12, "A", "a12");
    db.recordSettlement({ roundId: 10, winningStake: 0n, wonUsd: usdToBase(0.89), wonShares: 0n, hashrateEarned: 0n, wonTokenAmount: 0n, wonTokenShares: 0n, wallet: "A", sig: "s-a10" });
    const legs = db.unsettledLegs(12); // strictly before round 12
    expect(legs.map((l) => `${l.roundId}:${l.wallet}`)).toEqual(["10:B", "11:A"]);
    expect(legs[0]!.amount).toBe(usdToBase(1));
    const today = db.unsettledToday(new Date().toISOString().slice(0, 10));
    expect(today).toEqual({ legs: 3, grossBase: usdToBase(3), rounds: 3 });
    db.close();
  });
});

describe("accrualSince — the run rate behind the projection", () => {
  it("sums settled shares, hashrate and USD, and gross deployed, since a timestamp", () => {
    const db = freshDb();
    db.recordMyDeploy({ roundId: 1, mask: 1, amount: usdToBase(21), evExpected: 0, firedSlot: 1, sig: "d1", status: "landed", wallet: "A" });
    db.recordSettlement({ roundId: 1, winningStake: 0n, wonUsd: usdToBase(18.69), wonShares: 1_234n, hashrateEarned: 2_541n, wonTokenAmount: 0n, wonTokenShares: 99n, wallet: "A", sig: "s1" });
    db.recordSettlement({ roundId: 1, winningStake: 0n, wonUsd: usdToBase(0.89), wonShares: 0n, hashrateEarned: 121n, wonTokenAmount: 0n, wonTokenShares: 1n, wallet: "B", sig: "s2" });
    const a = db.accrualSince("2000-01-01 00:00:00");
    expect(a.settlements).toBe(2);
    expect(a.wonShares).toBe(1_234n);
    expect(a.wonTokenShares).toBe(100n);
    expect(a.hashrateEarned).toBe(2_662);
    expect(a.wonUsdBase).toBe(usdToBase(19.58));
    expect(a.grossBase).toBe(usdToBase(21));
    expect(a.firstAt).not.toBeNull();
    expect(db.accrualSince("2999-01-01 00:00:00").settlements).toBe(0);
    db.close();
  });
});
