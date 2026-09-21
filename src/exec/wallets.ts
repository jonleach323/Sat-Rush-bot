/**
 * The wallet set — one orchestrator driving N signers.
 *
 * Epoch rewards dedup by wallet, so a holding split across several wallets
 * captures more of the pool than the same holding in one. Hashrate cannot be
 * moved between wallets (it lives in a per-authority Miner PDA), so each wallet
 * has to earn its own: its own deploys, its own streak, its own tickets.
 *
 * Deliberately ONE orchestrator rather than N bot processes. The alternative
 * multiplies the gRPC subscription and RPC load by N, fragments the kill
 * switch, and — the part that actually matters — makes the risk limits
 * per-process, so MAX_PER_ROUND and DAILY_LOSS_CAP would each be enforced N
 * times over and the real exposure would be N× what the operator configured.
 * Those limits are load-bearing, so they stay aggregate and live here.
 *
 * Never logs or serialises secret keys; only public keys leave this module.
 */
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadKeypair } from "./tx.js";

export interface WalletState {
  keypair: Keypair;
  /** Cached Miner PDA fields; null until the first read. */
  streak: number;
  hashrate: number;
  /** Epoch tickets held in the current iteration. */
  tickets: number;
  /** USDC available, base units. */
  usdcBase: bigint;
  /** SOL available, lamports. */
  lamports: number;
  /** Set when the wallet cannot act this round (unfunded, failed, disabled). */
  disabledReason: string | null;
}

export interface WalletSnapshot {
  pubkey: string;
  streak: number;
  hashrate: number;
  tickets: number;
  usdc: number;
  sol: number;
  disabled: string | null;
}

export interface WalletAllocation {
  wallet: WalletState;
  /** Gross USDC to deploy this round, base units. */
  grossBase: bigint;
}

/** A wallet is only useful if it can pay rent+fees and meet the deploy floor. */
export interface FundingFloor {
  minDeployBase: bigint;
  /** Lamports a wallet must retain to sign a round's transactions. */
  minLamports: number;
}

export class WalletSet {
  private readonly wallets: WalletState[];

  private constructor(keypairs: Keypair[]) {
    this.wallets = keypairs.map((keypair) => ({
      keypair,
      streak: 1,
      hashrate: 0,
      tickets: 0,
      usdcBase: 0n,
      lamports: 0,
      disabledReason: null,
    }));
  }

  /**
   * Load from explicit paths, else fall back to the single configured keypair.
   * Duplicate paths are rejected: the same signer twice is not two wallets, and
   * silently deduping would make the fleet quietly smaller than configured
   * while the risk maths still divided by N.
   */
  static load(paths: readonly string[], fallbackPath: string, fleet?: { dir: string; size: number }): WalletSet {
    const list = paths.length > 0 ? paths : [fallbackPath, ...WalletSet.fleetPaths(fleet)];
    const seen = new Set<string>();
    const keypairs: Keypair[] = [];
    for (const p of list) {
      const kp = loadKeypair(p);
      const id = kp.publicKey.toBase58();
      if (seen.has(id)) {
        throw new Error(`duplicate wallet in set: ${id} (check WALLET_PATHS)`);
      }
      seen.add(id);
      keypairs.push(kp);
    }
    return new WalletSet(keypairs);
  }

  /** Create the primary keypair file if it does not exist (0600). Returns true when created. */
  static ensurePrimary(path: string): boolean {
    if (existsSync(path)) return false;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
    return true;
  }

  /**
   * Create the fleet's missing keypairs so that `dir` holds wallet-02 …
   * wallet-<size>. Existing files are never touched; new ones are written 0600
   * and nothing secret is returned or logged. Returns the number created.
   */
  static ensureFleet(fleet: { dir: string; size: number }): number {
    if (fleet.size <= 1) return 0;
    mkdirSync(fleet.dir, { recursive: true, mode: 0o700 });
    let created = 0;
    for (let i = 2; i <= fleet.size; i++) {
      const file = join(fleet.dir, `wallet-${String(i).padStart(2, "0")}.json`);
      if (existsSync(file)) continue;
      writeFileSync(file, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
      created++;
    }
    return created;
  }

  /**
   * The fleet directory's keypairs (`wallet-02.json` … in name order), at most
   * `size - 1` of them: the primary (KEYPAIR_PATH) is wallet 1. `pnpm fleet:init`
   * creates them; a missing directory or size ≤ 1 is the single-wallet case.
   */
  static fleetPaths(fleet?: { dir: string; size: number }): string[] {
    if (!fleet || fleet.size <= 1 || !existsSync(fleet.dir)) return [];
    return readdirSync(fleet.dir)
      .filter((f) => /^wallet-\d{2,}\.json$/.test(f))
      .sort()
      .slice(0, fleet.size - 1)
      .map((f) => join(fleet.dir, f));
  }

  get size(): number {
    return this.wallets.length;
  }

  all(): readonly WalletState[] {
    return this.wallets;
  }

  /** The first wallet — the one that pays for fleet-wide cranks and claims. */
  primary(): WalletState {
    const first = this.wallets[0];
    if (!first) throw new Error("wallet set is empty");
    return first;
  }

  pubkeys(): PublicKey[] {
    return this.wallets.map((w) => w.keypair.publicKey);
  }

  /** Index of a wallet in the set (0 = primary), or -1. */
  indexOf(key: string): number {
    return this.wallets.findIndex((w) => w.keypair.publicKey.toBase58() === key);
  }

  byPubkey(key: string): WalletState | undefined {
    return this.wallets.find((w) => w.keypair.publicKey.toBase58() === key);
  }

  /** Wallets that can act this round. */
  eligible(floor: FundingFloor): WalletState[] {
    return this.wallets.filter(
      (w) =>
        w.disabledReason === null &&
        w.usdcBase >= floor.minDeployBase &&
        w.lamports >= floor.minLamports,
    );
  }

  /**
   * Split a round's TOTAL budget across eligible wallets.
   *
   * The total is the aggregate cap, never per wallet — that is the whole reason
   * the fleet lives behind one orchestrator. Wallets that cannot be given at
   * least the on-chain minimum are dropped rather than sent a doomed
   * transaction, and the budget is re-divided over those that remain, so a
   * partially-funded fleet still deploys the full budget instead of silently
   * shrinking it.
   *
   * Equal split, not proportional: every wallet needs its own streak alive, and
   * a wallet's streak does not care how much it deployed, only that it did.
   */
  allocate(totalGrossBase: bigint, floor: FundingFloor): WalletAllocation[] {
    if (totalGrossBase <= 0n) return [];
    let pool = this.eligible(floor);
    if (pool.length === 0) return [];

    // Drop the wallets that cannot clear the floor at an equal share, then
    // re-divide; repeat until the split is feasible for everyone left.
    let share = totalGrossBase / BigInt(pool.length);
    while (pool.length > 1 && share < floor.minDeployBase) {
      pool = pool.slice(0, Number(totalGrossBase / floor.minDeployBase));
      if (pool.length === 0) return [];
      share = totalGrossBase / BigInt(pool.length);
    }
    if (share < floor.minDeployBase) return [];

    const out: WalletAllocation[] = [];
    let remaining = totalGrossBase;
    for (let i = 0; i < pool.length; i++) {
      const w = pool[i] as WalletState;
      // Give the remainder to the last wallet so the fleet deploys the whole
      // budget rather than losing the integer-division dust every round.
      const grossBase = i === pool.length - 1 ? remaining : share;
      const capped = grossBase > w.usdcBase ? w.usdcBase : grossBase;
      if (capped < floor.minDeployBase) continue;
      out.push({ wallet: w, grossBase: capped });
      remaining -= capped;
    }
    return out;
  }

  /**
   * Refresh every wallet's USDC + SOL from chain. A wallet whose read fails
   * keeps its last balances (a flaky RPC must not disable the fleet); a
   * missing USDC ATA reads as 0, which `eligible()` then excludes.
   */
  /**
   * Re-read every wallet's SOL and USDC. A wallet whose read fails keeps its
   * last values (never zeroed: a transient RPC error must not read as an
   * empty wallet — the treasury would top it up again and the drift
   * tripwire would see a drain). Only a genuinely missing ATA reads as 0.
   * Returns true when every wallet was read fresh.
   */
  async refreshBalances(connection: Connection, usdMint: PublicKey): Promise<boolean> {
    let allFresh = true;
    await Promise.all(
      this.wallets.map(async (w) => {
        try {
          const ata = getAssociatedTokenAddressSync(usdMint, w.keypair.publicKey);
          const [lamports, usdc] = await Promise.all([
            connection.getBalance(w.keypair.publicKey, "processed"),
            connection.getTokenAccountBalance(ata, "processed").then(
              (b) => BigInt(b.value.amount),
              (err: unknown) => {
                if (/could not find account|Invalid param/i.test(String(err))) return 0n; // no ATA yet
                throw err;
              },
            ),
          ]);
          w.lamports = lamports;
          w.usdcBase = usdc;
        } catch {
          allFresh = false; // hold last values
        }
      }),
    );
    return allFresh;
  }

  /** Aggregate balances, for risk reporting. */
  totals(): { usdcBase: bigint; lamports: number; tickets: number; hashrate: number } {
    return this.wallets.reduce(
      (acc, w) => ({
        usdcBase: acc.usdcBase + w.usdcBase,
        lamports: acc.lamports + w.lamports,
        tickets: acc.tickets + w.tickets,
        hashrate: acc.hashrate + w.hashrate,
      }),
      { usdcBase: 0n, lamports: 0, tickets: 0, hashrate: 0 },
    );
  }

  /** Public snapshot for the dashboard — never includes secret material. */
  snapshot(): WalletSnapshot[] {
    return this.wallets.map((w) => ({
      pubkey: w.keypair.publicKey.toBase58(),
      streak: w.streak,
      hashrate: w.hashrate,
      tickets: w.tickets,
      usdc: Number(w.usdcBase) / 1e6,
      sol: w.lamports / 1e9,
      disabled: w.disabledReason,
    }));
  }
}
