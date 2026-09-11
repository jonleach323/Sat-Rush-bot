import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { BN } from "../src/adapter/idl.js";
import type { Miner, SatsVault, TokenVault } from "../src/adapter/idl.js";
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

describe("Pnl — UTC-midnight carryover (audit finding #5)", () => {
  it("attributes a settlement to the day its DEPLOY was made", () => {
    const path = join(mkdtempSync(join(tmpdir(), "satrush-mid-")), "t.db");
    const db = new StateDb(path);
    const pnl = new Pnl(db);
    const raw = new Database(path);
    const setTime = (table: string, sig: string, ts: string) =>
      raw.prepare(`UPDATE ${table} SET created_at = ? WHERE sig = ?`).run(ts, sig);
    // A round deployed at 23:59:55 on day 1 that settles at 00:00:05 on day 2.
    // Filtering settlements by their own timestamp would credit day 2 with a
    // return it never paid for, masking real losses against the daily cap.
    db.recordMyDeploy({
      roundId: 900, mask: 1, amount: usdToBase(100), evExpected: null,
      firedSlot: 1, sig: "late-night", status: "landed",
    });
    setTime("my_deploys", "late-night", "2026-08-01 23:59:55");
    db.recordSettlement({
      roundId: 900, winningStake: 0n, wonUsd: usdToBase(40),
      wonShares: 0n, hashrateEarned: 0n, sig: "late-settle",
    });
    setTime("settlements", "late-settle", "2026-08-02 00:00:05");

    // Day 1 owns both the cost and the return.
    expect(pnl.deployedToday("2026-08-01")).toBe(usdToBase(100));
    expect(pnl.returnedToday("2026-08-01")).toBe(usdToBase(40));
    expect(pnl.realizedLossToday("2026-08-01")).toBe(usdToBase(60));

    // Day 2 gets no phantom credit — so the loss cap can't be inflated by it.
    expect(pnl.returnedToday("2026-08-02")).toBe(0n);
    expect(pnl.realizedLossToday("2026-08-02")).toBe(0n);
    raw.close();
    db.close();
  });

  it("falls back to the settlement's own date when no deploy row exists", () => {
    const { db, pnl } = setup();
    db.recordSettlement({
      roundId: 901, winningStake: 0n, wonUsd: usdToBase(7),
      wonShares: 0n, hashrateEarned: 0n, sig: "orphan",
    });
    expect(pnl.returnedToday()).toBe(usdToBase(7)); // not silently dropped
    db.close();
  });
});

describe("Pnl — fee attribution (audit finding #6)", () => {
  it("uses the live on-chain deploy bps, not a hardcoded 800", () => {
    const db = new StateDb(join(mkdtempSync(join(tmpdir(), "satrush-fee-")), "t.db"));
    let bps = 800;
    const pnl = new Pnl(db, { deployFeeBps: () => bps });
    seedDeploy(db, 10, 100, null, "landed");

    pnl.refreshDaily();
    const read = () =>
      BigInt(
        (db.queryOne<{ fees_paid: string }>("SELECT fees_paid FROM pnl_daily")?.fees_paid) ?? "0",
      );
    expect(read()).toBe(usdToBase(8)); // 800 bps of $100

    bps = 1200; // chain config updated
    pnl.refreshDaily();
    expect(read()).toBe(usdToBase(12));
    db.close();
  });

  it("falls back to the devnet default before the chain config loads", () => {
    const db = new StateDb(join(mkdtempSync(join(tmpdir(), "satrush-fee2-")), "t.db"));
    const pnl = new Pnl(db); // no deps
    seedDeploy(db, 11, 100, null, "landed");
    pnl.refreshDaily();
    expect(
      BigInt(db.queryOne<{ fees_paid: string }>("SELECT fees_paid FROM pnl_daily")!.fees_paid),
    ).toBe(usdToBase(8));
    db.close();
  });
});

describe("Pnl — V2 share marking", () => {
  it("a winning V2 day is not a loss once the won shares are marked", () => {
    const { db } = setup();
    // Marker (USD base units): $0.50 per 1000 sats shares, $0.10 per 1000 token shares.
    const pnl = new Pnl(db, {
      markShares: (sats, token) => (sats * 500_000n) / 1000n + (token * 100_000n) / 1000n,
    });
    seedDeploy(db, 1, 10, 0.1, "landed");
    // Won the tile: nothing back in USD, everything in shares.
    db.recordSettlement({
      roundId: 1,
      winningStake: usdToBase(10),
      wonUsd: 0n,
      wonShares: 30_000n, // → $15
      hashrateEarned: 1n,
      wonTokenAmount: 5n,
      wonTokenShares: 10_000n, // → $1
      sig: "win",
    });
    expect(pnl.todayNet()).toBe(usdToBase(-10)); // the USD-only view
    expect(pnl.sharesWonToday()).toEqual({ satsShares: 30_000n, tokenShares: 10_000n });
    expect(pnl.markedNetToday()).toBe(usdToBase(6)); // −10 + 15 + 1
    expect(pnl.realizedLossToday()).toBe(0n); // the cap sees no loss
    expect(pnl.reconcileRound(1).wonTokenShares).toBe(10_000n);
    db.close();
  });

  it("without a marker (V1) the USD net stands; a marker can never hide a USD loss", () => {
    const { db } = setup();
    const unmarked = new Pnl(db);
    const marked = new Pnl(db, { markShares: () => -1_000_000n }); // hostile marker
    seedDeploy(db, 2, 4, null, "landed");
    db.recordSettlement({ roundId: 2, winningStake: 0n, wonUsd: usdToBase(3.56), wonShares: 0n, hashrateEarned: 0n, sig: "lose" });
    expect(unmarked.realizedLossToday()).toBe(usdToBase(0.44)); // the 11% toll
    expect(marked.realizedLossToday()).toBe(usdToBase(0.44));
    db.close();
  });

  it("values unclaimed RUSH shares at the token-vault rate, and at nothing when unpriced", () => {
    const { pnl, db } = setup();
    const miner = {
      unclaimed_usd_amount: new BN(0),
      unclaimed_btc_shares: new BN(0),
      unclaimed_token_shares: new BN(2_000_000_000), // 2e9 shares
    } as unknown as Miner;
    const satsVault = { btc_amount: new BN(0), btc_shares: new BN(0) } as unknown as SatsVault;
    const tokenVault = {
      token_amount: new BN("4000000000000"), // 4,000 RUSH (9 dec)
      token_shares: new BN("8000000000000"), // 0.5 RUSH per share
    } as unknown as TokenVault;
    const v = pnl.unclaimedValue({ miner, satsVault, btcUsdPrice: 100_000, btcDecimals: 8, tokenVault, tokenUsdPrice: 50 });
    expect(v.tokenShares).toBe(2_000_000_000n);
    expect(v.tokenBaseUnits).toBe(1_000_000_000n); // 1 RUSH
    expect(v.tokenUsd).toBe(usdToBase(50));
    expect(v.totalUsd).toBe(usdToBase(50));
    const unpriced = pnl.unclaimedValue({ miner, satsVault, btcUsdPrice: 100_000, btcDecimals: 8, tokenVault });
    expect(unpriced.tokenUsd).toBe(0n);
    db.close();
  });
});

