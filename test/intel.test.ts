import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  FULL_BOARD_MASK,
  buildIntel,
  coefficientOfVariation,
  tileChiSquare,
} from "../src/ops/intel.js";
import { StateDb } from "../src/state/db.js";
import { usdToBase } from "../src/units.js";

let lastDbPath = "";

function freshDb(): StateDb {
  lastDbPath = join(mkdtempSync(join(tmpdir(), "satrush-intel-")), "test.db");
  return new StateDb(lastDbPath);
}

/** Raw handle for writes StateDb deliberately cannot make (corrupt rows). */
function raw(): Database.Database {
  return new Database(lastDbPath);
}

// One share ≈ 1.6e-11 BTC at ~$63k, net of the 10% claim fee ≈ $9.3e-7.
const SHARE_USD = 9.3e-7;
const OPTS = { windowRounds: 500, fireOffsetSlots: 4, shareValueUsd: SHARE_USD };

function seedRound(db: StateDb, id: number, over: Partial<{ winningTile: number | null; strike: boolean }> = {}) {
  db.recordRound({
    id,
    startSlot: id * 100,
    endSlot: id * 100 + 50,
    winningTile: over.winningTile === undefined ? id % 21 : over.winningTile,
    deployedUsd: usdToBase(200),
    winningTileUsd: usdToBase(10),
    minersCount: 30,
    strikeTriggered: over.strike ?? false,
    feesJson: "{}",
  });
}

describe("coefficientOfVariation", () => {
  it("is 0 for a perfectly flat board and grows with spread", () => {
    expect(coefficientOfVariation([10, 10, 10, 10])).toBeCloseTo(0, 10);
    const spread = coefficientOfVariation([1, 5, 20, 60]);
    expect(spread).toBeGreaterThan(0.9);
  });
  it("returns null when there is nothing on the board", () => {
    expect(coefficientOfVariation([])).toBeNull();
    expect(coefficientOfVariation([0, 0, 0])).toBeNull();
  });
});

describe("tileChiSquare", () => {
  it("is ~0 for perfectly uniform counts", () => {
    const r = tileChiSquare(new Array(21).fill(50));
    expect(r?.chiSquare).toBeCloseTo(0, 10);
    expect(r?.expected).toBe(50);
  });
  it("grows sharply when one tile dominates", () => {
    const counts = new Array(21).fill(1);
    counts[0] = 500;
    expect(tileChiSquare(counts)!.chiSquare).toBeGreaterThan(31.41);
  });
  it("returns null with no observations", () => {
    expect(tileChiSquare(new Array(21).fill(0))).toBeNull();
  });
});

describe("buildIntel", () => {
  it("returns safe empties on a virgin database", () => {
    const db = freshDb();
    const intel = buildIntel(db, OPTS);
    expect(intel.field.deploys).toBe(0);
    expect(intel.field.avgDeploysPerRound).toBe(0); // no divide-by-zero
    expect(intel.fairness).toBeNull();
    expect(intel.rivalTiming).toBeNull();
    expect(intel.uniformity.medianCov).toBeNull();
    expect(intel.calibration.realizedBps).toBeNull();
    expect(intel.calibration.benchmarkBps).toBeGreaterThan(0);
    db.close();
  });

  it("characterises a field of all-21 automations as offering no tile edge", () => {
    const db = freshDb();
    for (let r = 1; r <= 10; r++) {
      seedRound(db, r);
      // A near-flat board, which is what ~30 automations spreading evenly produce.
      db.recordOccupancySnapshot(
        r,
        r * 100 + 49,
        new Array(21).fill(0).map(() => usdToBase(14)),
        "test",
      );
      for (let w = 0; w < 5; w++) {
        db.recordCompetitorDeploy({
          roundId: r,
          authority: "rival" + w,
          mask: FULL_BOARD_MASK,
          amount: usdToBase(10),
          totalStake: usdToBase(9),
          isAutomation: true,
          reload: false,
          slot: r * 100 + 20, // 30 slots before cutoff
          sig: "sig-" + r + "-" + w,
        });
      }
    }
    const intel = buildIntel(db, OPTS);

    expect(intel.field.distinctRivals).toBe(5);
    expect(intel.field.deploys).toBe(50);
    expect(intel.field.avgDeploysPerRound).toBe(5);
    expect(intel.field.automationShare).toBe(1);
    expect(intel.field.fullBoardShare).toBe(1);
    expect(intel.field.avgRivalStakeUsd).toBeCloseTo(10, 6);

    // Flat board → CoV 0 → every round counts as uniform.
    expect(intel.uniformity.samples).toBe(10);
    expect(intel.uniformity.medianCov).toBeCloseTo(0, 10);
    expect(intel.uniformity.uniformShare).toBe(1);

    // 30 slots of lead, and our fire offset is 4 → nobody fires after us.
    expect(intel.rivalTiming).not.toBeNull();
    expect(intel.rivalTiming!.p50).toBe(30);
    expect(intel.rivalTiming!.afterUsShare).toBe(0);
    db.close();
  });

  it("counts rivals that commit later than our fire offset", () => {
    const db = freshDb();
    seedRound(db, 1); // end_slot 150
    const leads = [40, 30, 20, 2, 1]; // last two land after we fire at offset 4
    leads.forEach((lead, i) => {
      db.recordCompetitorDeploy({
        roundId: 1,
        authority: "r" + i,
        mask: 1,
        amount: usdToBase(5),
        totalStake: usdToBase(5),
        isAutomation: false,
        reload: false,
        slot: 150 - lead,
        sig: "s" + i,
      });
    });
    const intel = buildIntel(db, OPTS);
    expect(intel.rivalTiming!.samples).toBe(5);
    expect(intel.rivalTiming!.afterUsShare).toBeCloseTo(0.4, 10);
    expect(intel.field.automationShare).toBe(0);
    db.close();
  });

  it("detects a non-uniform board and reports the spread", () => {
    const db = freshDb();
    seedRound(db, 1);
    const stakes = new Array(21).fill(usdToBase(20));
    stakes[3] = 0n; // one genuinely empty tile
    db.recordOccupancySnapshot(1, 149, stakes, "test");
    const intel = buildIntel(db, OPTS);
    expect(intel.uniformity.medianCov).toBeGreaterThan(0.05);
    expect(intel.uniformity.uniformShare).toBe(0);
    db.close();
  });

  it("uses only the final snapshot of each round", () => {
    const db = freshDb();
    seedRound(db, 1);
    const lumpy = new Array(21).fill(0n);
    lumpy[0] = usdToBase(100);
    db.recordOccupancySnapshot(1, 110, lumpy, "early"); // mid-round, very lumpy
    db.recordOccupancySnapshot(1, 149, new Array(21).fill(usdToBase(14)), "final");
    const intel = buildIntel(db, OPTS);
    expect(intel.uniformity.samples).toBe(1);
    expect(intel.uniformity.medianCov).toBeCloseTo(0, 10);
    db.close();
  });

  it("computes fairness over resolved rounds and flags uniform draws", () => {
    const db = freshDb();
    for (let r = 1; r <= 105; r++) seedRound(db, r); // r % 21 → 5 of each tile
    const intel = buildIntel(db, OPTS);
    expect(intel.fairness).not.toBeNull();
    expect(intel.fairness!.samples).toBe(105);
    expect(intel.fairness!.chiSquare).toBeCloseTo(0, 10);
    expect(intel.fairness!.looksUniform).toBe(true);
    expect(intel.fairness!.degreesOfFreedom).toBe(20);
    db.close();
  });

  it("measures modeled vs realized edge on landed deploys only", () => {
    const db = freshDb();
    seedRound(db, 1);
    seedRound(db, 2);
    // Landed: staked $100, won $110 → +1000 bps realized. ev_expected is stored
    // in BASE units (Selection.ev), so $5 of modeled edge on $100 = 500 bps.
    db.recordMyDeploy({
      roundId: 1,
      mask: 7,
      amount: usdToBase(100),
      evExpected: Number(usdToBase(5)),
      firedSlot: 146,
      sig: "mine-1",
      status: "landed",
    });
    db.recordSettlement({
      roundId: 1,
      winningStake: usdToBase(10),
      wonUsd: usdToBase(110),
      wonShares: 0n,
      hashrateEarned: 0n,
      sig: "settle-1",
    });
    // A missed deploy with a wild EV must not pollute calibration.
    db.recordMyDeploy({
      roundId: 2,
      mask: 3,
      amount: usdToBase(100),
      evExpected: Number(usdToBase(999)),
      firedSlot: 246,
      sig: "mine-2",
      status: "missed",
    });
    db.recordSettlement({
      roundId: 2,
      winningStake: 0n,
      wonUsd: 0n,
      wonShares: 0n,
      hashrateEarned: 0n,
      sig: "settle-2",
    });

    const intel = buildIntel(db, OPTS);
    expect(intel.calibration.landed).toBe(1);
    expect(intel.calibration.modeledBps).toBeCloseTo(500, 6);
    expect(intel.calibration.realizedUsdBps).toBeCloseTo(1000, 6);
    expect(intel.calibration.realizedSharesBps).toBe(0); // no shares won here
    expect(intel.calibration.realizedBps).toBeCloseTo(1000, 6);
    db.close();
  });

  // The sats vault takes ~12% of every deploy and returns it as BTC shares, not
  // USDC. Omitting that leg is what made a profitable position read as a heavy
  // loss, so it has to be counted and it has to be counted separately.
  it("values won BTC shares into realized edge alongside the USD leg", () => {
    const db = freshDb();
    seedRound(db, 1);
    db.recordMyDeploy({
      roundId: 1,
      mask: 7,
      amount: usdToBase(100),
      evExpected: Number(usdToBase(5)),
      firedSlot: 146,
      sig: "mine-1",
      status: "landed",
    });
    // $80 back in USD (−2000 bps) but 16M shares ≈ $14.88 at SHARE_USD.
    db.recordSettlement({
      roundId: 1,
      winningStake: usdToBase(10),
      wonUsd: usdToBase(80),
      wonShares: 16_000_000n,
      hashrateEarned: 0n,
      sig: "settle-1",
    });

    const c = buildIntel(db, OPTS).calibration;
    expect(c.realizedUsdBps).toBeCloseTo(-2000, 6);
    // 16e6 * 9.3e-7 = $14.88 on a $100 deploy = 1488 bps.
    expect(c.realizedSharesBps).toBeCloseTo(1488, 3);
    // USD-only says a heavy loss; the full picture is barely negative.
    expect(c.realizedBps).toBeCloseTo(-512, 3);
    db.close();
  });

  it("degrades the share leg to zero when the vault price is unknown", () => {
    const db = freshDb();
    seedRound(db, 1);
    db.recordMyDeploy({
      roundId: 1,
      mask: 7,
      amount: usdToBase(100),
      evExpected: 0,
      firedSlot: 146,
      sig: "mine-1",
      status: "landed",
    });
    db.recordSettlement({
      roundId: 1,
      winningStake: usdToBase(10),
      wonUsd: usdToBase(80),
      wonShares: 16_000_000n,
      hashrateEarned: 0n,
      sig: "settle-1",
    });
    const c = buildIntel(db, { ...OPTS, shareValueUsd: 0 }).calibration;
    expect(c.realizedSharesBps).toBe(0);
    expect(c.realizedBps).toBeCloseTo(-2000, 6); // never invents a value
    db.close();
  });

  it("tracks strike cadence and distance since the last one", () => {
    const db = freshDb();
    for (let r = 1; r <= 50; r++) seedRound(db, r, { strike: r === 12 });
    const intel = buildIntel(db, OPTS);
    expect(intel.strike.rounds).toBe(50);
    expect(intel.strike.strikes).toBe(1);
    expect(intel.strike.roundsSinceLast).toBe(38);
    db.close();
  });

  it("honours the round window", () => {
    const db = freshDb();
    for (let r = 1; r <= 30; r++) {
      seedRound(db, r);
      db.recordCompetitorDeploy({
        roundId: r,
        authority: "solo",
        mask: 1,
        amount: usdToBase(5),
        totalStake: usdToBase(5),
        isAutomation: false,
        reload: false,
        slot: r * 100 + 10,
        sig: "s" + r,
      });
    }
    // Latest round is 30, so a window of 10 covers rounds 21..30.
    const intel = buildIntel(db, { ...OPTS, windowRounds: 10 });
    expect(intel.field.rounds).toBe(10);
    expect(intel.field.deploys).toBe(10);
    // Fairness is deliberately NOT windowed — more samples is a better test.
    expect(intel.fairness!.samples).toBe(30);
    db.close();
  });

  it("survives a malformed occupancy snapshot", () => {
    const db = freshDb();
    seedRound(db, 1);
    seedRound(db, 2);
    db.recordOccupancySnapshot(1, 149, new Array(21).fill(usdToBase(14)), "ok");
    const conn = raw();
    conn
      .prepare(
        "INSERT INTO occupancy_snapshots (round_id, slot, stakes_json, source) VALUES (2, 249, 'not json', 'bad')",
      )
      .run();
    conn.close();
    const intel = buildIntel(db, OPTS);
    expect(intel.uniformity.samples).toBe(1); // the good one still counted
    db.close();
  });
});
