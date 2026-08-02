import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BN } from "../src/adapter/idl.js";
import type { Miner, SatsVault } from "../src/adapter/idl.js";
import { StateDb } from "../src/state/db.js";
import { Pnl, utcDate } from "../src/state/pnl.js";
import { usdToBase } from "../src/units.js";

function setup(): { db: StateDb; pnl: Pnl } {
  const db = new StateDb(join(mkdtempSync(join(tmpdir(), "satrush-pnl-")), "t.db"));
  return { db, pnl: new Pnl(db) };
}

function seedDeploy(db: StateDb, roundId: number, usd: number, ev: number | null, status = "fired") {
  db.recordMyDeploy({
    roundId,
    mask: 1,
    amount: usdToBase(usd),
    evExpected: ev,
    firedSlot: 1,
    sig: `sig-${roundId}-${usd}-${Math.random()}`,
    status: status as "fired",
  });
}

describe("Pnl", () => {
  it("todayNet and realizedLossToday from deploys vs settlements", () => {
    const { db, pnl } = setup();
    seedDeploy(db, 1, 5, 0.2);
    seedDeploy(db, 2, 5, 0.1);
    db.recordSettlement({
      roundId: 1,
      winningStake: usdToBase(0.3),
      wonUsd: usdToBase(4),
      wonShares: 100n,
      hashrateEarned: 10n,
      sig: "st1",
    });
    expect(pnl.deployedToday()).toBe(usdToBase(10));
    expect(pnl.returnedToday()).toBe(usdToBase(4));
    expect(pnl.todayNet()).toBe(usdToBase(-6));
    expect(pnl.realizedLossToday()).toBe(usdToBase(6));
    db.close();
  });

  it("dry deploys cost nothing", () => {
    const { db, pnl } = setup();
    seedDeploy(db, 1, 5, 0.2, "dry");
    expect(pnl.deployedToday()).toBe(0n);
    expect(pnl.realizedLossToday()).toBe(0n);
    db.close();
  });

  it("winning day → zero realized loss (cap unaffected)", () => {
    const { db, pnl } = setup();
    seedDeploy(db, 1, 5, 0.3);
    db.recordSettlement({
      roundId: 1,
      winningStake: usdToBase(4.6),
      wonUsd: usdToBase(40),
      wonShares: 0n,
      hashrateEarned: 1n,
      sig: "stw",
    });
    expect(pnl.todayNet()).toBe(usdToBase(35));
    expect(pnl.realizedLossToday()).toBe(0n);
    db.close();
  });

  it("reconciles expected EV vs realized per round", () => {
    const { db, pnl } = setup();
    seedDeploy(db, 7, 5, 1.25);
    db.recordSettlement({
      roundId: 7,
      winningStake: usdToBase(0.3),
      wonUsd: usdToBase(4.048),
      wonShares: 70692n,
      hashrateEarned: 17n,
      sig: "st7",
    });
    const r = pnl.reconcileRound(7);
    expect(r.deployed).toBe(usdToBase(5));
    expect(r.returnedUsd).toBe(usdToBase(4.048));
    expect(r.wonShares).toBe(70692n);
    expect(r.expectedEv).toBeCloseTo(1.25);
    expect(r.realizedUsd).toBe(usdToBase(-0.952));
    db.close();
  });

  it("refreshDaily persists the aggregate row", () => {
    const { db, pnl } = setup();
    seedDeploy(db, 1, 10, null);
    pnl.refreshDaily();
    const row = db.queryOne<{ deployed: string; fees_paid: string }>(
      "SELECT deployed, fees_paid FROM pnl_daily WHERE date = ?",
      utcDate(),
    );
    expect(row!.deployed).toBe(usdToBase(10).toString());
    expect(row!.fees_paid).toBe(usdToBase(0.8).toString()); // 800 bps deploy legs
    db.close();
  });

  it("values the unclaimed position at the vault share rate", () => {
    const { pnl, db } = setup();
    const miner = {
      unclaimed_usd_amount: new BN(2_000_000), // $2
      unclaimed_btc_shares: new BN(50_000),
    } as unknown as Miner;
    const satsVault = {
      btc_amount: new BN(1_000_000), // vault: 1e6 BTC base units
      btc_shares: new BN(100_000), // 10 base units per share
    } as unknown as SatsVault;
    const v = pnl.unclaimedValue({
      miner,
      satsVault,
      btcUsdPrice: 100_000,
      btcDecimals: 8,
    });
    expect(v.usd).toBe(2_000_000n);
    expect(v.btcBaseUnits).toBe(500_000n); // 50k shares × 10
    // 0.005 BTC × $100k = $500 → 500_000_000 base units + $2
    expect(v.totalUsd).toBe(502_000_000n);
    db.close();
  });
});
