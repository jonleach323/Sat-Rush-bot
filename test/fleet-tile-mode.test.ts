import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { tileLegs } from "../src/exec/candidates.js";
import { WalletSet, type FundingFloor, type WalletState } from "../src/exec/wallets.js";
import { TILES_COUNT } from "../src/strategy/ev.js";
import { dilutedHashrateValueUsd, hashrateRebateUsd } from "../src/strategy/hashrate.js";
import { EPOCH_EQUAL_CURVE_BPS } from "../src/strategy/vault.js";
import { maskToTiles } from "../src/adapter/mask.js";

const FLOOR: FundingFloor = { minDeployBase: 1_000_000n, minLamports: 5_000_000 };
function makeSet(n: number, usdc = 1_000_000_000n): WalletSet {
  const set = Object.create(WalletSet.prototype) as WalletSet;
  const wallets: WalletState[] = Array.from({ length: n }, () => ({
    keypair: Keypair.generate(), streak: 1, hashrate: 0, tickets: 0, usdcBase: usdc, lamports: 100_000_000, disabledReason: null,
  }));
  (set as unknown as { wallets: WalletState[] }).wallets = wallets;
  return set;
}
const blanket = (perTile: bigint) => new Array<bigint>(TILES_COUNT).fill(perTile);

describe("tile mode — wallet i deploys tile i of a blanket", () => {
  it("21 wallets → 21 single-tile legs carrying the blanket's per-tile gross", () => {
    const set = makeSet(21);
    const legs = tileLegs(set, blanket(2_000_000n), FLOOR);
    expect(legs).toHaveLength(21);
    legs.forEach((l, i) => {
      expect(maskToTiles(l.mask)).toEqual([i]);
      expect(l.amountGross).toBe(2_000_000n);
      expect(l.signer.publicKey.equals(set.all()[i]!.keypair.publicKey)).toBe(true);
    });
    expect(legs.reduce((a, l) => a + l.amountGross, 0n)).toBe(42_000_000n);
  });

  it("a wallet that cannot fund its tile drops out; the others are untouched", () => {
    const set = makeSet(21);
    (set.all()[7] as WalletState).usdcBase = 500_000n;
    (set.all()[12] as WalletState).lamports = 0;
    const legs = tileLegs(set, blanket(2_000_000n), FLOOR);
    expect(legs).toHaveLength(19);
    expect(legs.map((l) => maskToTiles(l.mask)[0])).not.toContain(7);
    expect(legs.map((l) => maskToTiles(l.mask)[0])).not.toContain(12);
  });

  it("a fleet larger than 21 wraps onto the tiles; smaller covers only its tiles", () => {
    expect(tileLegs(makeSet(23), blanket(2_000_000n), FLOOR).map((l) => maskToTiles(l.mask)[0])).toEqual([...Array.from({ length: 21 }, (_, i) => i), 0, 1]);
    expect(tileLegs(makeSet(5), blanket(2_000_000n), FLOOR)).toHaveLength(5);
  });

  it("a partial blanket sends legs only for the tiles the selection funded", () => {
    const alloc = blanket(2_000_000n); alloc[4] = 0n; alloc[9] = 0n;
    const legs = tileLegs(makeSet(21), alloc, FLOOR);
    expect(legs).toHaveLength(19);
    expect(legs.map((l) => maskToTiles(l.mask)[0])).toEqual(Array.from({ length: 21 }, (_, i) => i).filter((i) => i !== 4 && i !== 9));
  });

  it("a per-tile amount under the on-chain minimum yields no legs", () => {
    expect(tileLegs(makeSet(21), blanket(900_000n), FLOOR)).toEqual([]);
  });
});

describe("single-tile hashrate pricing for the fleet", () => {
  it("coveredOverride = 1 values a 21-tile allocation at 121 raw/$ instead of 101 at the cap", () => {
    const base = { streak: 100, valueUsdPerRawUnit: 1e-4, multiplier: 1 };
    const blanketValue = hashrateRebateUsd(base, 21, 100);
    const tileValue = hashrateRebateUsd({ ...base, coveredOverride: 1 }, 21, 100);
    expect(blanketValue).toBeCloseTo(101 * 100 * 1e-4, 9);
    expect(tileValue).toBeCloseTo(121 * 100 * 1e-4, 9);
  });
});

describe("hashrate dilution curve", () => {
  const d = { roundsHeld: 1000, rawPerTicket: 100, epoch: { othersTickets: 900_000, poolUsd: 28_200, wallets: 21, curve: EPOCH_EQUAL_CURVE_BPS, uplift: 1.37 }, oneBtc: { othersTickets: 2_500_000, prizeUsd: 81_000 } };
  it("a small pile is worth about the flat small-block price per ticket; a big pile is worth less per ticket", () => {
    const small = dilutedHashrateValueUsd(100 * 1_000, d) / 1_000; // 1,000 tickets: the 1-BTC leg at $0.032 wins
    const big = dilutedHashrateValueUsd(100 * 900_000, d) / 900_000; // half the epoch field
    expect(small).toBeCloseTo(0.0324, 3);
    expect(big).toBeLessThan(0.8 * small);
    // epoch-only, the dedup closed form: ~$0.028 per ticket at a small pile, ~$0.011 at half the field
    const epochOnly = { ...d, oneBtc: undefined };
    expect(dilutedHashrateValueUsd(100 * 1_000, epochOnly) / 1_000).toBeCloseTo(0.0282, 3);
    expect(dilutedHashrateValueUsd(100 * 900_000, epochOnly) / 900_000).toBeCloseTo(0.0112, 3);
  });
  it("the per-round credit bends the marginal EV down as the stake grows", () => {
    const base = { streak: 100, valueUsdPerRawUnit: 2.4e-4, multiplier: 1, coveredOverride: 1, dilution: d };
    const at = (g: number) => hashrateRebateUsd(base, 21, g);
    const m1 = at(2) - at(1), m50 = at(51) - at(50), m200 = at(201) - at(200);
    expect(m1).toBeGreaterThan(m50);
    expect(m50).toBeGreaterThan(m200);
    // and it never exceeds the flat valuation at the small-pile price for the same raw
    expect(at(10)).toBeLessThanOrEqual(hashrateRebateUsd({ ...base, valueUsdPerRawUnit: 3.24e-4, dilution: undefined }, 21, 10) + 1e-9);
  });
  it("the 1-BTC leg floors the value when the epoch pile is saturated", () => {
    const epochOnly = dilutedHashrateValueUsd(100 * 900_000, { ...d, oneBtc: undefined });
    const both = dilutedHashrateValueUsd(100 * 900_000, d);
    expect(both).toBeGreaterThanOrEqual(epochOnly);
  });
});

describe("fleet directory loading", () => {
  it("picks up wallet-NN.json files in order, at most size − 1, and indexes them after the primary", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-"));
    const primary = join(dir, "operator.json");
    writeFileSync(primary, JSON.stringify(Array.from(Keypair.generate().secretKey)));
    for (const n of [2, 3, 4]) writeFileSync(join(dir, `wallet-0${n}.json`), JSON.stringify(Array.from(Keypair.generate().secretKey)));
    writeFileSync(join(dir, "notes.txt"), "ignored");
    expect(WalletSet.fleetPaths({ dir, size: 3 })).toEqual([join(dir, "wallet-02.json"), join(dir, "wallet-03.json")]);
    const set = WalletSet.load([], primary, { dir, size: 4 });
    expect(set.size).toBe(4);
    expect(set.indexOf(set.all()[2]!.keypair.publicKey.toBase58())).toBe(2);
    expect(WalletSet.fleetPaths({ dir: join(dir, "missing"), size: 21 })).toEqual([]);
    expect(WalletSet.load([], primary, { dir, size: 1 }).size).toBe(1);
  });

  it("ensureFleet creates only the missing keypairs and never rewrites an existing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-"));
    expect(WalletSet.ensureFleet({ dir, size: 4 })).toBe(3);
    const before = readFileSync(join(dir, "wallet-03.json"), "utf8");
    expect(WalletSet.ensureFleet({ dir, size: 6 })).toBe(2);
    expect(readFileSync(join(dir, "wallet-03.json"), "utf8")).toBe(before);
    expect(WalletSet.fleetPaths({ dir, size: 6 })).toHaveLength(5);
    expect(WalletSet.ensureFleet({ dir, size: 1 })).toBe(0);
    expect((statSync(join(dir, "wallet-02.json")).mode & 0o777)).toBe(0o600);
  });
});
