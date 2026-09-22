import { describe, expect, it } from "vitest";
import { BN } from "../src/adapter/idl.js";
import type { Miner, SatsVault, TokenVault } from "../src/adapter/generated-types.js";
import { Keypair } from "@solana/web3.js";
import { fleetPosition, projectHolding } from "../src/state/position.js";

function miner(over: Partial<Miner>): Miner {
  return {
    version: 2, bump: 255, authority: Keypair.generate().publicKey,
    unclaimed_usd_amount: new BN(0), unclaimed_btc_shares: new BN(0), hashrate_amount: new BN(0),
    current_streak_count: 1, last_mined_round_id: 0, unclaimed_hashrate: new BN(0),
    grubstake_usd_amount: new BN(0), grubstake_expiration_timestamp: new BN(0),
    affiliate: Keypair.generate().publicKey, unclaimed_token_shares: new BN(0), reserved: [],
    ...over,
  } as Miner;
}
const sats: SatsVault = { version: 2, bump: 255, btc_amount: new BN(50_000_000), btc_shares: new BN(100_000_000), leftovers: new BN(0), reserved: [] } as SatsVault; // 0.5 BTC / 100M shares
const token: TokenVault = { version: 2, bump: 255, token_amount: new BN(2_000_000_000_000), token_shares: new BN(1_000_000_000_000), leftovers: new BN(0), reserved: [] } as TokenVault; // 2 RUSH per 1e9 shares

describe("fleetPosition — sums every wallet's Miner at the vault rate", () => {
  it("values shares at the vault rate and prices, and turns hashrate into tickets", () => {
    const pos = fleetPosition({
      miners: [
        miner({ unclaimed_usd_amount: new BN(5_000_000), unclaimed_btc_shares: new BN(1_000_000), unclaimed_token_shares: new BN(500_000_000), hashrate_amount: new BN(1_300), unclaimed_hashrate: new BN(700) }),
        miner({ unclaimed_btc_shares: new BN(1_000_000), hashrate_amount: new BN(500) }),
      ],
      satsVault: sats, tokenVault: token, btcUsd: 100_000, rushUsd: 40, rawPerTicket: 100,
    });
    expect(pos.wallets).toBe(2);
    expect(pos.usdcUnclaimedBase).toBe(5_000_000n);
    expect(pos.satsShares).toBe(2_000_000n);
    expect(pos.btc).toBeCloseTo(0.01, 9); // 2M shares × 0.5 BTC / 100M
    expect(pos.btcUsd).toBeCloseTo(1_000, 6);
    expect(pos.rush).toBeCloseTo(1, 9); // 0.5e9 shares × 2 RUSH per 1e9
    expect(pos.rushUsd).toBeCloseTo(40, 6);
    expect(pos.tickets).toBeCloseTo(25, 9); // (1300+700+500)/100
    expect(pos.totalUnclaimedUsd).toBeCloseTo(5 + 1_000 + 40, 6);
  });
});

describe("projectHolding — carry on what is held, accrual compounding from the day it lands", () => {
  it("matches the closed form and reports the carry separately", () => {
    const pos = fleetPosition({ miners: [miner({ unclaimed_btc_shares: new BN(2_000_000), unclaimed_token_shares: new BN(500_000_000) })], satsVault: sats, tokenVault: token, btcUsd: 100_000, rushUsd: 40, rawPerTicket: 100 });
    const rate = { sampleHours: 24, btcPerDay: 0.0001, rushPerDay: 0.1, hashratePerDay: 1_000, usdNetPerDay: -1, grossPerDay: 500 };
    const p = projectHolding({ position: pos, rate, days: 30, carry: { sats: 0.003, token: 0.0024 }, btcUsd: 100_000, rushUsd: 40, rawPerTicket: 100 });
    const g = Math.pow(1.003, 30);
    expect(p.btc).toBeCloseTo(0.01 * g + 0.0001 * ((g - 1) / 0.003), 9);
    const gt = Math.pow(1.0024, 30);
    expect(p.rush).toBeCloseTo(1 * gt + 0.1 * ((gt - 1) / 0.0024), 9);
    expect(p.tickets).toBeCloseTo(300, 9);
    expect(p.usdNet).toBe(-30);
    expect(p.carryUsd).toBeGreaterThan(0);
    expect(p.gainUsd).toBeCloseTo(p.btcUsd - 1_000 + (p.rushUsd - 40) - 30, 6);
    // No carry: linear.
    const lin = projectHolding({ position: pos, rate, days: 30, carry: { sats: 0, token: 0 }, btcUsd: 100_000, rushUsd: 40, rawPerTicket: 100 });
    expect(lin.btc).toBeCloseTo(0.01 + 0.003, 9);
    expect(lin.carryUsd).toBe(0);
  });
});
