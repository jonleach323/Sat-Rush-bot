import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { tileLegs } from "../src/exec/candidates.js";
import { WalletSet, type FundingFloor, type WalletState } from "../src/exec/wallets.js";
import { TILES_COUNT } from "../src/strategy/ev.js";
import { hashrateRebateUsd } from "../src/strategy/hashrate.js";
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
