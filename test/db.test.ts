import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
