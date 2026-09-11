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
import { scaledTipLamports } from "./tip.js";

export type DeploySelection = Extract<Selection, { kind: "deploy" }>;

export interface BuiltCandidate {
  rank: number;
  selection: DeploySelection;
  signature: string;
  /** Pre-signed wire bytes — what fire() writes. */
  serialized: Buffer;
  blockhash: string;
  lastValidBlockHeight: number;
  feeMicroLamports: number;
  /** Jito tip embedded in this candidate (lamports); 0 when no tip. */
  tipLamports: number;
  roundId: number;
  builtAtMs: number;
}

export interface CandidateSetOptions {
  connection: Connection;
  payer: Keypair;
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
): DeploySelection[] {
  const out: DeploySelection[] = [];
  const seenMasks = new Set<number>();
  let stakes = src.predictedStakes;

  for (let attempt = 0; attempt < 3; attempt++) {
    const selection = selectAllocation(
      isModelSource(src) ? src.model(stakes) : { ...src, predictedStakes: stakes },
      cfg,
    );
    if (selection.kind !== "deploy") break;
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

  constructor(private readonly opts: CandidateSetOptions) {}

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

    const selections = computeCandidateSelections(ctx, selectorCfg);
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
      const instructions: TransactionInstruction[] = [
        buildDeployPublic(this.opts.ixCtx, {
          authority: this.opts.payer.publicKey,
          roundId,
          selectionMask: selection.mask,
          amountBaseUnits: selection.totalGross,
        }),
      ];
      let tipLamports = 0;
      if (this.opts.jitoTip && this.opts.jitoTip.accounts.length > 0) {
        const accts = this.opts.jitoTip.accounts;
        const rng = this.opts.rng ?? Math.random;
        const account = accts[Math.min(accts.length - 1, Math.floor(rng() * accts.length))]!;
        tipLamports = scaledTipLamports(Number(selection.ev), {
          baseLamports: this.opts.jitoTip.baseLamports,
          maxLamports: this.opts.jitoTip.maxLamports,
          evFraction: this.opts.jitoTip.evFraction,
          solUsd: this.opts.jitoTip.solUsd(),
        });
        instructions.push(
          SystemProgram.transfer({
            fromPubkey: this.opts.payer.publicKey,
            toPubkey: account,
            lamports: tipLamports,
          }),
        );
      }
      const { tx } = await assembleTx(this.opts.connection, {
        payer: this.opts.payer,
        instructions,
        computeUnitLimit: this.opts.computeUnitLimit,
        priorityFeeMicroLamports: fee,
        blockhash: { blockhash, lastValidBlockHeight },
      });
      built.push({
        rank,
        selection,
        signature: bs58.encode(tx.signatures[0]!),
        serialized: Buffer.from(tx.serialize()),
        blockhash,
        lastValidBlockHeight,
        feeMicroLamports: fee,
        tipLamports,
        roundId,
        builtAtMs: now(),
      });
    }
    this.candidates = built;
    this.roundId = roundId;
    return built;
  }
}

export const CANDIDATE_TILES_COUNT = TILES_COUNT;
