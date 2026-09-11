/**
 * Rolling pre-built candidate set. On every occupancy update while a round
 * is Active, the caller invokes refresh(): the current best allocation plus
 * up to 2 fallback allocations (next-best masks) are computed, built into
 * transactions, signed, and kept hot with a current blockhash and fee.
 * Blockhashes refresh every 15s. Firing writes pre-signed bytes to the
 * wire — nothing is built at decision time.
 */
import {
  Keypair,
  PublicKey,
  SystemProgram,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  buildDeployPublic,
  type InstructionContext,
} from "../adapter/instructions.js";
import { TILES_COUNT, type EvContext, type EvModel } from "../strategy/ev.js";
import {
  selectAllocation,
  type Selection,
  type SelectorConfig,
} from "../strategy/selector.js";
import { assembleTx } from "./tx.js";
import type { FeeEstimator } from "./fees.js";
import type { FundingFloor, WalletSet } from "./wallets.js";
import { scaledTipLamports } from "./tip.js";

export type DeploySelection = Extract<Selection, { kind: "deploy" }>;

export interface BuiltCandidate {
  rank: number;
  selection: DeploySelection;
  /** The first leg's signature / bytes — the single-wallet view. */
  signature: string;
  /** Pre-signed wire bytes — what fire() writes. */
  serialized: Buffer;
  blockhash: string;
  lastValidBlockHeight: number;
  feeMicroLamports: number;
  /** Jito tip embedded across the legs (lamports); 0 when no tip. */
  tipLamports: number;
  /**
   * One signed transaction per fleet wallet, same mask, the round's total
   * gross split across them (WalletSet.allocate). Exactly one leg for a
   * single wallet. Σ amountGross == selection.totalGross.
   */
  legs: CandidateLeg[];
  roundId: number;
  builtAtMs: number;
}

/** One signed deploy for one wallet of the fleet (a single-wallet set has one leg). */
export interface CandidateLeg {
  /** Signing wallet, base58. */
  wallet: string;
  amountGross: bigint;
  signature: string;
  serialized: Buffer;
  lastValidBlockHeight: number;
  tipLamports: number;
}

export interface CandidateSetOptions {
  connection: Connection;
  /** The primary signer (single-wallet mode signs everything with it). */
  payer: Keypair;
  /**
   * Fleet mode: the round's gross is split across these wallets and each leg
   * is signed by its own keypair. Omit for the single-wallet path.
   */
  wallets?: WalletSet | undefined;
  /** Funding floor for `wallets.allocate` (on-chain min deploy + lamports). */
  fundingFloor?: FundingFloor | undefined;
  /**
   * Affiliate authority to bind a wallet to at its FIRST deploy (V2). Called
   * per wallet; return undefined to pass none (the primary must: self-referral
   * is refused on chain).
   */
  affiliateFor?: ((wallet: PublicKey) => PublicKey | undefined) | undefined;
  ixCtx: InstructionContext;
  feeEstimator: FeeEstimator;
  computeUnitLimit: number;
  /** Embed a Jito tip transfer in every candidate (bundle path). The tip is
   * EV-scaled per candidate (see scaledTipLamports); evFraction 0 = flat base.
   * One `account` is chosen at random per fire to avoid write-lock contention. */
  jitoTip?:
    | { accounts: PublicKey[]; baseLamports: number; maxLamports: number; evFraction: number; solUsd: () => number }
    | undefined;
  blockhashMaxAgeMs?: number | undefined;
  now?: (() => number) | undefined;
  /** Injectable randomness for the tip-account pick (deterministic in tests). */
  rng?: (() => number) | undefined;
}

const BLOCKHASH_MAX_AGE_MS = 15_000;
/** Sentinel stake that makes a tile strictly unattractive to the selector. */
const EXCLUDE_STAKE = 10n ** 15n; // $1B in base units

/**
 * What the selector prices against: the V1 context, or a model factory (V2)
 * that rebuilds the economics for a modified stake vector — the fallback
 * variants below need to re-run the selector with tiles excluded.
 */
export type EvSource =
  | EvContext
  | { predictedStakes: bigint[]; model: (predictedStakes: bigint[]) => EvModel };

function isModelSource(
  src: EvSource,
): src is { predictedStakes: bigint[]; model: (predictedStakes: bigint[]) => EvModel } {
  return typeof (src as { model?: unknown }).model === "function";
}

/**
 * Best allocation + up to 2 next-best mask variants. Fallbacks re-run the
 * selector with the strongest tile(s) of the previous pick made
 * unattractive, yielding genuinely different masks (deduped).
 */
export function computeCandidateSelections(
  src: EvSource,
  cfg: SelectorConfig,
  onSkip?: (reason: string) => void,
): DeploySelection[] {
  const out: DeploySelection[] = [];
  const seenMasks = new Set<number>();
  let stakes = src.predictedStakes;

  for (let attempt = 0; attempt < 3; attempt++) {
    const selection = selectAllocation(
      isModelSource(src) ? src.model(stakes) : { ...src, predictedStakes: stakes },
      cfg,
    );
    if (selection.kind !== "deploy") {
      if (attempt === 0) onSkip?.(selection.reason);
      break;
    }
    if (!seenMasks.has(selection.mask)) {
      seenMasks.add(selection.mask);
      out.push(selection);
    }
    // Next variant: exclude the heaviest tile of the last pick.
    let heaviest = selection.tiles[0] ?? 0;
    for (const tile of selection.tiles) {
      if ((selection.allocation[tile] ?? 0n) > (selection.allocation[heaviest] ?? 0n)) {
        heaviest = tile;
      }
    }
    const next = [...stakes];
    next[heaviest] = EXCLUDE_STAKE;
    stakes = next;
  }
  return out;
}

export class CandidateSet {
  private candidates: BuiltCandidate[] = [];
  private roundId: number | null = null;
  private cachedBlockhash: {
    blockhash: string;
    lastValidBlockHeight: number;
    fetchedAtMs: number;
  } | null = null;

  /** Why the selector produced nothing for the current round (diagnostic). */
  private skipReason: string | null = null;

  constructor(private readonly opts: CandidateSetOptions) {}

  /** The selector's skip reason for `roundId`, or null when it built candidates. */
  lastSkipReason(roundId: number): string | null {
    return roundId === this.roundId ? this.skipReason : null;
  }

  /** The current hot set (empty if none built or round rotated). */
  current(roundId?: number): BuiltCandidate[] {
    if (roundId !== undefined && roundId !== this.roundId) return [];
    return this.candidates;
  }

  best(roundId: number): BuiltCandidate | null {
    return this.current(roundId)[0] ?? null;
  }

  /** Drop everything (round rotated or halted). */
  clear(): void {
    this.candidates = [];
    this.roundId = null;
    this.skipReason = null;
  }

  /**
   * True when the cached blockhash has aged past its reuse window, so the next
   * refresh() will fetch a new one and re-sign.
   *
   * Callers need this because refresh() is otherwise driven by occupancy
   * updates, and a quiet board produces none: mainnet rounds are 150 slots and
   * a Solana blockhash expires after exactly 150 blocks, so a candidate built
   * at round open and held to the cutoff is right at the expiry boundary. The
   * slot tick has to drive the rebuild when the field doesn't.
   */
  needsBlockhashRefresh(nowMs?: number): boolean {
    if (!this.cachedBlockhash) return this.candidates.length > 0;
    const now = nowMs ?? (this.opts.now ?? Date.now)();
    const maxAge = this.opts.blockhashMaxAgeMs ?? BLOCKHASH_MAX_AGE_MS;
    return now - this.cachedBlockhash.fetchedAtMs > maxAge;
  }

  /**
   * Recompute selections and rebuild signed transactions. Reuses the cached
   * blockhash until it ages past 15s (a fresh fetch re-signs everything).
   */
  async refresh(
    roundId: number,
    ctx: EvSource,
    selectorCfg: SelectorConfig,
  ): Promise<BuiltCandidate[]> {
    const now = this.opts.now ?? Date.now;
    if (roundId !== this.roundId) this.clear();

    this.skipReason = null;
    const selections = computeCandidateSelections(ctx, selectorCfg, (r) => {
      this.skipReason = r;
    });
    if (selections.length === 0) {
      this.candidates = [];
      this.roundId = roundId;
      return [];
    }

    const maxAge = this.opts.blockhashMaxAgeMs ?? BLOCKHASH_MAX_AGE_MS;
    if (!this.cachedBlockhash || now() - this.cachedBlockhash.fetchedAtMs > maxAge) {
      const fresh = await this.opts.connection.getLatestBlockhash("confirmed");
      this.cachedBlockhash = { ...fresh, fetchedAtMs: now() };
    }
    const { blockhash, lastValidBlockHeight } = this.cachedBlockhash;
    const fee = this.opts.feeEstimator.currentMicroLamportsPerCu();

    const built: BuiltCandidate[] = [];
    for (const [rank, selection] of selections.entries()) {
      const legs = await this.buildLegs(roundId, selection, fee, blockhash, lastValidBlockHeight);
      if (legs.length === 0) continue; // fleet cannot fund this selection this round
      const first = legs[0]!;
      built.push({
        rank,
        selection,
        signature: first.signature,
        serialized: first.serialized,
        blockhash,
        lastValidBlockHeight,
        feeMicroLamports: fee,
        tipLamports: legs.reduce((a, l) => a + l.tipLamports, 0),
        legs,
        roundId,
        builtAtMs: now(),
      });
    }
    this.candidates = built;
    this.roundId = roundId;
    return built;
  }

  /**
   * The wallet split for a selection: `[{payer, amount}]` for one wallet, else
   * WalletSet.allocate over the fleet. The selection's total is what the
   * bankroll authorizes; the legs must sum to it or the candidate is dropped —
   * a fleet that can only fund part of the budget would otherwise send less
   * than the guards checked, and a partial fleet deploy is not the plan the
   * selector priced.
   */
  private splitAcrossWallets(
    selection: DeploySelection,
  ): { signer: Keypair; amountGross: bigint }[] {
    const set = this.opts.wallets;
    if (!set || set.size <= 1) {
      return [{ signer: this.opts.payer, amountGross: selection.totalGross }];
    }
    const floor = this.opts.fundingFloor ?? { minDeployBase: 1_000_000n, minLamports: 0 };
    const allocs = set.allocate(selection.totalGross, floor);
    const sum = allocs.reduce((a, x) => a + x.grossBase, 0n);
    if (allocs.length === 0 || sum !== selection.totalGross) return [];
    return allocs.map((a) => ({ signer: a.wallet.keypair, amountGross: a.grossBase }));
  }

  private async buildLegs(
    roundId: number,
    selection: DeploySelection,
    fee: number,
    blockhash: string,
    lastValidBlockHeight: number,
  ): Promise<CandidateLeg[]> {
    const split = this.splitAcrossWallets(selection);
    const legs: CandidateLeg[] = [];
    for (const { signer, amountGross } of split) {
      const affiliateAuthority = this.opts.affiliateFor?.(signer.publicKey);
      const instructions: TransactionInstruction[] = [
        buildDeployPublic(this.opts.ixCtx, {
          authority: signer.publicKey,
          roundId,
          selectionMask: selection.mask,
          amountBaseUnits: amountGross,
          ...(affiliateAuthority ? { affiliateAuthority } : {}),
        }),
      ];
      let tipLamports = 0;
      if (this.opts.jitoTip && this.opts.jitoTip.accounts.length > 0) {
        const accts = this.opts.jitoTip.accounts;
        const rng = this.opts.rng ?? Math.random;
        const account = accts[Math.min(accts.length - 1, Math.floor(rng() * accts.length))]!;
        // EV-scale the tip on this leg's share of the round's EV.
        const share = Number(amountGross) / Number(selection.totalGross);
        tipLamports = scaledTipLamports(Number(selection.ev) * share, {
          baseLamports: this.opts.jitoTip.baseLamports,
          maxLamports: this.opts.jitoTip.maxLamports,
          evFraction: this.opts.jitoTip.evFraction,
          solUsd: this.opts.jitoTip.solUsd(),
        });
        instructions.push(
          SystemProgram.transfer({
            fromPubkey: signer.publicKey,
            toPubkey: account,
            lamports: tipLamports,
          }),
        );
      }
      const { tx } = await assembleTx(this.opts.connection, {
        payer: signer,
        instructions,
        computeUnitLimit: this.opts.computeUnitLimit,
        priorityFeeMicroLamports: fee,
        blockhash: { blockhash, lastValidBlockHeight },
      });
      legs.push({
        wallet: signer.publicKey.toBase58(),
        amountGross,
        signature: bs58.encode(tx.signatures[0]!),
        serialized: Buffer.from(tx.serialize()),
        lastValidBlockHeight,
        tipLamports,
      });
    }
    return legs;
  }
}

export const CANDIDATE_TILES_COUNT = TILES_COUNT;
