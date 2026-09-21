/**
 * Wallet-set wiring: the candidate set splits a round across the fleet and
 * signs one leg per wallet; the game state tracks every wallet's Miner; the
 * balance refresh holds last values on RPC failure.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, VersionedTransaction, type Connection } from "@solana/web3.js";
import bs58 from "bs58";
import { CandidateSet } from "../src/exec/candidates.js";
import { FeeEstimator } from "../src/exec/fees.js";
import { WalletSet, type WalletState } from "../src/exec/wallets.js";
import { GameState } from "../src/ingest/snapshot.js";
import { accountsCoder, BN, SATRUSH_IDL } from "../src/adapter/idl.js";
import { minerPda, publicDeploymentPda } from "../src/adapter/pdas.js";
import { TILES_COUNT, type EvContext } from "../src/strategy/ev.js";
import type { SelectorConfig } from "../src/strategy/selector.js";
import { usdToBase } from "../src/units.js";
import { seededRng } from "./helpers.js";

function makeSet(n: number, usdcBase = 1_000_000_000n): WalletSet {
  const set = Object.create(WalletSet.prototype) as WalletSet;
  const wallets: WalletState[] = Array.from({ length: n }, () => ({
    keypair: Keypair.generate(),
    streak: 1,
    hashrate: 0,
    tickets: 0,
    usdcBase,
    lamports: 100_000_000,
    disabledReason: null,
  }));
  (set as unknown as { wallets: WalletState[] }).wallets = wallets;
  return set;
}

const FEES = { deployFeeBps: 800, satsVaultRoundBps: 1200, satsVaultClaimBps: 1000 };
function chaseCtx(): EvContext {
  const stakes = new Array<bigint>(TILES_COUNT).fill(0n);
  for (let i = 3; i < TILES_COUNT; i++) stakes[i] = usdToBase(10);
  return { predictedStakes: stakes, fees: FEES, multiplier: 1, semantics: "raw" };
}
function selCfg(maxUsd: number): SelectorConfig {
  return {
    strategy: "water_filling",
    ladder: [usdToBase(1)],
    maxPerRound: usdToBase(maxUsd),
    minDeploy: usdToBase(1),
    kEmptiest: 3,
    rng: seededRng(3),
  };
}
const conn = {
  getLatestBlockhash: async () => ({ blockhash: bs58.encode(new Uint8Array(32).fill(7)), lastValidBlockHeight: 1000 }),
} as unknown as Connection;
const feeEstimator = new FeeEstimator({ minMicroLamports: 1234, maxMicroLamports: 9999 });
const ixCtx = {
  usdMint: Keypair.generate().publicKey,
  btcMint: Keypair.generate().publicKey,
  tokenMint: Keypair.generate().publicKey,
};

describe("CandidateSet with a wallet set", () => {
  it("signs one leg per wallet, same mask, legs summing to the authorized total", async () => {
    const set = makeSet(3);
    const primary = set.primary().keypair;
    const affiliate = primary.publicKey;
    const bound: string[] = [];
    const cs = new CandidateSet({
      connection: conn,
      payer: primary,
      wallets: set,
      fundingFloor: { minDeployBase: usdToBase(1), minLamports: 0 },
      affiliateFor: (w) => {
        if (w.equals(affiliate)) return undefined;
        bound.push(w.toBase58());
        return affiliate;
      },
      ixCtx,
      feeEstimator,
      computeUnitLimit: 400_000,
    });
    const built = await cs.refresh(42, chaseCtx(), selCfg(6));
    expect(built.length).toBeGreaterThan(0);
    const best = built[0]!;
    expect(best.legs).toHaveLength(3);
    expect(best.legs.reduce((a, l) => a + l.amountGross, 0n)).toBe(best.selection.totalGross);
    expect(new Set(best.legs.map((l) => l.wallet)).size).toBe(3);
    expect(best.signature).toBe(best.legs[0]!.signature);
    expect(best.legs.every((l) => l.grubstake === false)).toBe(true);
    // Every leg is signed by its own wallet and deploys under its own PDAs.
    for (const leg of best.legs) {
      const tx = VersionedTransaction.deserialize(leg.serialized);
      const signer = tx.message.staticAccountKeys[0]!;
      expect(signer.toBase58()).toBe(leg.wallet);
      const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
      expect(keys).toContain(publicDeploymentPda(new PublicKey(leg.wallet), 42).toBase58());
      expect(keys).toContain(minerPda(new PublicKey(leg.wallet)).toBase58());
    }
    // The extras were offered the affiliate (once per candidate built); the primary never.
    expect([...new Set(bound)].sort()).toEqual(set.pubkeys().slice(1).map((k) => k.toBase58()).sort());
  });

  it("drops a candidate the fleet cannot fully fund rather than sending a partial deploy", async () => {
    const set = makeSet(2, usdToBase(1)); // $1 each, $2 total
    const cs = new CandidateSet({
      connection: conn,
      payer: set.primary().keypair,
      wallets: set,
      fundingFloor: { minDeployBase: usdToBase(1), minLamports: 0 },
      ixCtx,
      feeEstimator,
      computeUnitLimit: 400_000,
    });
    const built = await cs.refresh(43, chaseCtx(), selCfg(6)); // selector wants more than $2
    for (const c of built) {
      expect(c.legs.reduce((a, l) => a + l.amountGross, 0n)).toBe(c.selection.totalGross);
    }
  });

  it("a single-wallet set is exactly the old single-signer path", async () => {
    const set = makeSet(1);
    const cs = new CandidateSet({
      connection: conn,
      payer: set.primary().keypair,
      wallets: set,
      ixCtx,
      feeEstimator,
      computeUnitLimit: 400_000,
    });
    const built = await cs.refresh(44, chaseCtx(), selCfg(3));
    expect(built[0]!.legs).toHaveLength(1);
    expect(built[0]!.legs[0]!.amountGross).toBe(built[0]!.selection.totalGross);
  });
});

describe("GameState tracks every fleet wallet's Miner", () => {
  function minerBytes(authority: PublicKey, streak: number, hashrate: number): Buffer {
    const reserved = (SATRUSH_IDL.types!.find((t) => t.name === "Miner")!.type as { fields: { name: string; type: { array?: [string, number] } }[] })
      .fields.find((f) => f.name === "reserved")!.type.array![1];
    return accountsCoder.encode("Miner", {
      version: 2,
      bump: 255,
      authority,
      unclaimed_usd_amount: new BN(0),
      unclaimed_btc_shares: new BN(0),
      hashrate_amount: new BN(hashrate),
      current_streak_count: streak,
      last_mined_round_id: 10,
      unclaimed_hashrate: new BN(0),
      grubstake_usd_amount: new BN(0),
      grubstake_expiration_timestamp: new BN(0),
      affiliate: PublicKey.default,
      unclaimed_token_shares: new BN(0),
      reserved: new Array<number>(reserved).fill(0),
    }) as unknown as Buffer;
  }

  it("keeps a Miner per watched wallet, the first being the primary", async () => {
    const [a, b, stranger] = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
    const state = new GameState([minerPda(a), minerPda(b)]);
    expect(state.applyAccount(minerPda(b), await minerBytes(b, 5, 500))).toEqual({ kind: "Miner" });
    expect(state.applyAccount(minerPda(a), await minerBytes(a, 9, 900))).toEqual({ kind: "Miner" });
    expect(state.applyAccount(minerPda(stranger), await minerBytes(stranger, 1, 1))).toBeNull();
    expect(state.miner?.current_streak_count).toBe(9); // primary
    expect(state.minerAt(minerPda(b))?.hashrate_amount.toString()).toBe("500");
    expect(state.minerAt(minerPda(stranger))).toBeNull();
    expect(state.miners.size).toBe(2);
  });

  it("a single PublicKey still selects one wallet (the old call)", async () => {
    const a = Keypair.generate().publicKey;
    const state = new GameState(minerPda(a));
    state.applyAccount(minerPda(a), await minerBytes(a, 3, 30));
    expect(state.miner?.current_streak_count).toBe(3);
  });
});

describe("WalletSet.refreshBalances", () => {
  it("reads USDC + SOL per wallet, treats a missing ATA as 0, and holds values on failure", async () => {
    const set = makeSet(2, 0n);
    const [w1, w2] = set.all();
    let fail = false;
    const connection = {
      getBalance: async (pk: PublicKey) => {
        if (fail) throw new Error("rpc down");
        return pk.equals(w1!.keypair.publicKey) ? 50_000_000 : 1_000;
      },
      getTokenAccountBalance: async (ata: PublicKey) => {
        if (fail) throw new Error("rpc down");
        // w1 has an ATA holding $12; w2 has none
        const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
        if (ata.equals(getAssociatedTokenAddressSync(ixCtx.usdMint, w1!.keypair.publicKey))) {
          return { value: { amount: usdToBase(12).toString() } };
        }
        throw new Error("could not find account");
      },
    } as unknown as Connection;
    expect(await set.refreshBalances(connection, ixCtx.usdMint)).toBe(true);
    expect(w1!.usdcBase).toBe(usdToBase(12));
    expect(w1!.lamports).toBe(50_000_000);
    expect(w2!.usdcBase).toBe(0n);
    fail = true;
    expect(await set.refreshBalances(connection, ixCtx.usdMint)).toBe(false);
    expect(w1!.usdcBase).toBe(usdToBase(12)); // held
    expect(set.eligible({ minDeployBase: usdToBase(1), minLamports: 5_000_000 }).map((w) => w.keypair.publicKey)).toEqual([
      w1!.keypair.publicKey,
    ]);
  });
});

describe("WalletSet.refreshBalances — a transient token-balance error is not an empty wallet", () => {
  it("holds the last USDC value (never zeroes it) and reports the read as not fresh", async () => {
    const set = makeSet(1, 0n);
    const [w1] = set.all();
    let tokenErr: string | null = null;
    const connection = {
      getBalance: async () => 10_000_000,
      getTokenAccountBalance: async () => {
        if (tokenErr) throw new Error(tokenErr);
        return { value: { amount: usdToBase(20).toString() } };
      },
    } as unknown as Connection;
    expect(await set.refreshBalances(connection, ixCtx.usdMint)).toBe(true);
    expect(w1!.usdcBase).toBe(usdToBase(20));
    tokenErr = "429 Too Many Requests";
    expect(await set.refreshBalances(connection, ixCtx.usdMint)).toBe(false);
    expect(w1!.usdcBase).toBe(usdToBase(20)); // a $20 top-up must not vanish into a re-top-up or a drift halt
    tokenErr = "failed to get token account balance: Invalid param: could not find account";
    expect(await set.refreshBalances(connection, ixCtx.usdMint)).toBe(true);
    expect(w1!.usdcBase).toBe(0n); // a genuinely missing ATA is 0
  });
});

describe("grubstake-funded legs", () => {
  it("pays a leg from the Miner grubstake when the callback says so, and flags it", async () => {
    const set = makeSet(2);
    const [a] = set.pubkeys();
    const cs = new CandidateSet({
      connection: conn,
      payer: set.primary().keypair,
      wallets: set,
      fundingFloor: { minDeployBase: usdToBase(1), minLamports: 0 },
      grubstakeFor: (w) => w.equals(a!),
      ixCtx,
      feeEstimator,
      computeUnitLimit: 400_000,
    });
    const built = await cs.refresh(45, chaseCtx(), selCfg(4));
    const legs = built[0]!.legs;
    const legA = legs.find((l) => l.wallet === a!.toBase58())!;
    const legB = legs.find((l) => l.wallet !== a!.toBase58())!;
    expect(legA.grubstake).toBe(true);
    expect(legB.grubstake).toBe(false);
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const txA = VersionedTransaction.deserialize(legA.serialized);
    const keysA = txA.message.staticAccountKeys.map((k) => k.toBase58());
    // grubstake leg: the funding ATA is the Miner PDA's, not the wallet's
    expect(keysA).toContain(getAssociatedTokenAddressSync(ixCtx.usdMint, minerPda(a!), true).toBase58());
    expect(keysA).not.toContain(getAssociatedTokenAddressSync(ixCtx.usdMint, a!).toBase58());
  });
});

