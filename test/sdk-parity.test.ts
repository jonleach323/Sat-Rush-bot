import { describe, expect, it } from "vitest";
import {
  HASHRATE_PER_TICKET,
  LOYALTY_WEIGHT,
  REWARD_MAX_STREAK as SDK_REWARD_MAX_STREAK,
  SKILL_WEIGHT,
  STRIKE_BOOST_HASHRATE_MULTIPLIER,
  STRIKE_BOOST_ROUNDS,
  TILE_COUNT,
  getHashrateTicketsCount,
  hashrateReward,
  satsToBtc,
} from "@satrush/client";
import { hashrateRawPerUsd, REWARD_MAX_STREAK } from "../src/strategy/hashrate.js";
import { TILES_COUNT } from "../src/strategy/ev.js";
import { VAULT_HASHRATE_PER_TICKET } from "../src/strategy/facts.js";

/**
 * Differential tests against the official @satrush/client.
 *
 * Everything in this repo's strategy layer was reverse-engineered from the IDL
 * and from on-chain observation, and several of the resulting constants were
 * assumptions wearing a measurement's clothes. The SDK ships the program's real
 * formulas, so these tests replace inference with the source of truth AND catch
 * drift if the program changes under us.
 *
 * Where a value here disagrees with `facts.ts`, facts.ts is wrong.
 */
const USD_UNIT = 1_000_000n;

describe("program constants match the SDK", () => {
  it("board width", () => {
    expect(TILES_COUNT).toBe(TILE_COUNT);
  });

  it("streak cap — previously an ASSUMED fact in facts.ts", () => {
    // FINDINGS had this as unverified with the highest observed streak at 28.
    // The SDK exports it, so farming EV is no longer scaled by a guess.
    expect(REWARD_MAX_STREAK).toBe(SDK_REWARD_MAX_STREAK);
    expect(SDK_REWARD_MAX_STREAK).toBe(100);
  });

  it("hashrate per ticket — was a DEVNET measurement used for mainnet math", () => {
    expect(BigInt(VAULT_HASHRATE_PER_TICKET.value)).toBe(HASHRATE_PER_TICKET);
  });

  it("both reward weights are 1, which is what makes m + N/n the whole formula", () => {
    expect(SKILL_WEIGHT).toBe(1n);
    expect(LOYALTY_WEIGHT).toBe(1n);
  });

  it("strike boost multiplier and window", () => {
    expect(STRIKE_BOOST_HASHRATE_MULTIPLIER).toBe(2n);
    // Measured against the public API as 241 rounds INCLUSIVE of the strike
    // round; the SDK's 240 is the exclusive count, so the two agree.
    expect(STRIKE_BOOST_ROUNDS).toBe(240);
  });
});

describe("hashrateRawPerUsd matches the SDK reward formula", () => {
  /** What the SDK says a deploy earns, in raw units. */
  const sdkRaw = (usd: number, streak: number, covered: number, mult = 1n): bigint =>
    hashrateReward(
      BigInt(Math.round(usd * 1e6)), streak, covered, TILE_COUNT, USD_UNIT, mult,
    ).total;

  it("agrees across the whole streak x coverage grid", () => {
    for (const usd of [1, 2, 5, 21, 100]) {
      for (const streak of [1, 2, 7, 28, 50, 100]) {
        for (const covered of [1, 2, 3, 7, 11, 21]) {
          const mine = usd * hashrateRawPerUsd(streak, covered);
          const sdk = Number(sdkRaw(usd, streak, covered));
          // The program floors once, at (loyalty+skill)/denom; allow that.
          expect(Math.abs(mine - sdk), `$${usd} s=${streak} n=${covered}`)
            .toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("reproduces the two anchor cases quoted throughout FINDINGS", () => {
    expect(Number(sdkRaw(1, 100, 21))).toBe(101);   // blanket at streak 100
    expect(Number(sdkRaw(1, 100, 1))).toBe(121);    // single tile at streak 100
  });

  it("confirms concentration is worth 21x on the skill leg", () => {
    const one = hashrateReward(1_000_000n, 0, 1, TILE_COUNT, USD_UNIT);
    const all = hashrateReward(1_000_000n, 0, TILE_COUNT, TILE_COUNT, USD_UNIT);
    expect(one.skillPoints).toBe(21n);
    expect(all.skillPoints).toBe(1n);
  });

  it("the promo multiplier scales the whole reward", () => {
    expect(sdkRaw(10, 50, 3, 2n)).toBe(sdkRaw(10, 50, 3, 1n) * 2n);
  });

  it("does NOT clamp the streak itself — the caller must", () => {
    // REWARD_MAX_STREAK is exported but not applied inside hashrateReward, so
    // any model feeding a raw streak past 100 will overstate. Ours clamps.
    expect(Number(sdkRaw(1, 200, 21))).toBeGreaterThan(Number(sdkRaw(1, 100, 21)));
    expect(hashrateRawPerUsd(200, 21)).toBe(hashrateRawPerUsd(100, 21));
  });
});

describe("share valuation matches satsToBtc", () => {
  // Live vault state at the time of writing.
  const VAULT_BTC = 15_745_754n;      // vault btc_amount, 8dp
  const VAULT_SHARES = 948_807_134n * 10n;
  const CLAIM_BPS = 1000;

  it("our naive ratio is within a rounding unit of the SDK", () => {
    // We priced shares as shares * amount / totalShares * (1 - fee). The SDK
    // adds SHARE_OFFSET=1000 to the denominator and 1 to the numerator, which
    // against ~9.5e9 shares is a ~1e-7 effect — so the $893 figure stands.
    const shares = 948_807_134n;
    const { gross, fee } = satsToBtc(shares, VAULT_BTC, VAULT_SHARES, CLAIM_BPS);
    const naive = Number(shares) * (Number(VAULT_BTC) / Number(VAULT_SHARES));
    expect(Math.abs(Number(gross) - naive) / naive).toBeLessThan(1e-5);
    expect(Number(fee) / Number(gross)).toBeCloseTo(0.10, 6);
  });

  it("the claim fee is taken off the gross, not the shares", () => {
    const { gross, fee } = satsToBtc(1_000_000n, VAULT_BTC, VAULT_SHARES, CLAIM_BPS);
    expect(fee).toBe((gross * 1000n) / 10_000n);
  });

  it("a zero claim fee returns the full gross", () => {
    expect(satsToBtc(1_000_000n, VAULT_BTC, VAULT_SHARES, 0).fee).toBe(0n);
  });

  it("refuses to value more shares than the vault issued", () => {
    expect(() => satsToBtc(VAULT_SHARES + 1n, VAULT_BTC, VAULT_SHARES, CLAIM_BPS)).toThrow();
  });
});

describe("ticket conversion matches the SDK", () => {
  it("floors raw hashrate to whole tickets", () => {
    for (const raw of [0n, 99n, 100n, 5_638n, 135_208n]) {
      expect(getHashrateTicketsCount(raw))
        .toBe(raw / BigInt(VAULT_HASHRATE_PER_TICKET.value));
    }
  });

  it("the operator wallet's 5,638 raw is 56 tickets, as the dashboard reports", () => {
    expect(getHashrateTicketsCount(5_638n)).toBe(56n);
  });
});
