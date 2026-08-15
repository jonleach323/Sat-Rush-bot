import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { WalletSet, type FundingFloor, type WalletState } from "../src/exec/wallets.js";

const FLOOR: FundingFloor = { minDeployBase: 1_000_000n, minLamports: 5_000_000 };

/** Build a set without touching disk (load() reads keypair files). */
function makeSet(n: number): WalletSet {
  const set = Object.create(WalletSet.prototype) as WalletSet;
  const wallets: WalletState[] = Array.from({ length: n }, () => ({
    keypair: Keypair.generate(),
    streak: 1,
    hashrate: 0,
    tickets: 0,
    usdcBase: 1_000_000_000n,
    lamports: 100_000_000,
    disabledReason: null,
  }));
  (set as unknown as { wallets: WalletState[] }).wallets = wallets;
  return set;
}

describe("WalletSet.allocate", () => {
  it("splits the TOTAL budget, never per wallet — the cap is aggregate", () => {
    const set = makeSet(5);
    const allocs = set.allocate(50_000_000n, FLOOR);
    expect(allocs).toHaveLength(5);
    const total = allocs.reduce((a, x) => a + x.grossBase, 0n);
    expect(total).toBe(50_000_000n);
  });

  it("gives integer-division dust to the last wallet rather than losing it", () => {
    const set = makeSet(3);
    const allocs = set.allocate(10_000_000n, FLOOR);
    expect(allocs.reduce((a, x) => a + x.grossBase, 0n)).toBe(10_000_000n);
    expect(allocs[0]?.grossBase).toBe(3_333_333n);
    expect(allocs[2]?.grossBase).toBe(3_333_334n);
  });

  it("drops wallets that cannot clear the on-chain minimum and re-divides", () => {
    const set = makeSet(10);
    // $4 across 10 wallets is $0.40 each — below the $1 floor. Expect 4 funded.
    const allocs = set.allocate(4_000_000n, FLOOR);
    expect(allocs).toHaveLength(4);
    for (const a of allocs) expect(a.grossBase).toBeGreaterThanOrEqual(FLOOR.minDeployBase);
    expect(allocs.reduce((a, x) => a + x.grossBase, 0n)).toBe(4_000_000n);
  });

  it("returns nothing when the budget cannot fund even one wallet", () => {
    const set = makeSet(4);
    expect(set.allocate(500_000n, FLOOR)).toEqual([]);
    expect(set.allocate(0n, FLOOR)).toEqual([]);
  });

  it("skips unfunded and disabled wallets", () => {
    const set = makeSet(4);
    const all = set.all() as WalletState[];
    (all[0] as WalletState).usdcBase = 0n;
    (all[1] as WalletState).lamports = 0;
    (all[2] as WalletState).disabledReason = "halted";
    const allocs = set.allocate(10_000_000n, FLOOR);
    expect(allocs).toHaveLength(1);
    expect(allocs[0]?.wallet).toBe(all[3]);
  });

  it("never allocates a wallet more USDC than it holds", () => {
    const set = makeSet(2);
    const all = set.all() as WalletState[];
    (all[0] as WalletState).usdcBase = 2_000_000n;
    const allocs = set.allocate(20_000_000n, FLOOR);
    const first = allocs.find((a) => a.wallet === all[0]);
    expect(first?.grossBase).toBeLessThanOrEqual(2_000_000n);
  });
});

describe("WalletSet basics", () => {
  it("aggregates balances across the fleet", () => {
    const set = makeSet(3);
    const all = set.all() as WalletState[];
    all.forEach((w, i) => {
      w.tickets = (i + 1) * 100;
      w.hashrate = (i + 1) * 10;
    });
    const t = set.totals();
    expect(t.tickets).toBe(600);
    expect(t.hashrate).toBe(60);
    expect(t.usdcBase).toBe(3_000_000_000n);
  });

  it("snapshot carries public keys only — no secret material", () => {
    const set = makeSet(2);
    const snap = set.snapshot();
    const text = JSON.stringify(snap);
    expect(snap).toHaveLength(2);
    for (const w of set.all()) {
      expect(text).toContain(w.keypair.publicKey.toBase58());
      // The secret key must not appear in any encoding.
      expect(text).not.toContain(Buffer.from(w.keypair.secretKey).toString("base64"));
      expect(text).not.toContain(w.keypair.secretKey.join(","));
    }
  });

  it("primary() is stable — cranks and claims always bill the same wallet", () => {
    const set = makeSet(3);
    expect(set.primary()).toBe(set.all()[0]);
    expect(set.primary()).toBe(set.primary());
  });

  it("finds a wallet by public key", () => {
    const set = makeSet(3);
    const target = set.all()[1] as WalletState;
    expect(set.byPubkey(target.keypair.publicKey.toBase58())).toBe(target);
    expect(set.byPubkey("nope")).toBeUndefined();
  });
});
