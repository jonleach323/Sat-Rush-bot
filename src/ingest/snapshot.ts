/**
 * In-memory GameState assembled from the streams. Occupancy is modeled as
 * partial-observable from day one (CLAUDE.md roadmap): visibleStakes come
 * from the round account, hiddenPoolEstimate stays 0 in the public-only era.
 */
import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import type {
  Board,
  Miner,
  Round,
  SatrushConfig,
  SatsVault,
  TokenVault,
} from "../adapter/idl.js";
import { PROGRAM_ID } from "../adapter/idl.js";
import {
  boardPda,
  minerPda,
  roundPda,
  satrushConfigPda,
  satsVaultPda,
  tokenVaultPda,
} from "../adapter/pdas.js";
import {
  HaltError,
  RoundMonotonicityGuard,
  type RoundRollback,
  TILES_COUNT,
  classifyAccount,
  decodeAccountOrHalt,
  decodeRoundStrict,
} from "./decode.js";

const toBig = (bn: { toString(): string }) => BigInt(bn.toString());

export type AppliedKind =
  | "Board"
  | "Round"
  | "Miner"
  | "TokenVault"
  | "SatsVault"
  | "SatrushConfig";

export interface AppliedAccount {
  kind: AppliedKind;
  roundId?: number;
}

export class GameState {
  board: Board | null = null;
  satrushConfig: SatrushConfig | null = null;
  satsVault: SatsVault | null = null;
  /** V2 RUSH vault (token_amount / token_shares marks unclaimed token shares). */
  tokenVault: TokenVault | null = null;
  /** The primary wallet's Miner (first authority given), for single-wallet code paths. */
  miner: Miner | null = null;
  /** Every watched wallet's Miner, keyed by Miner PDA address (base58). */
  readonly miners = new Map<string, Miner>();
  currentSlot = 0;
  /** 0 for now — becomes a live estimate in the private-deployment era. */
  hiddenPoolEstimate = 0n;

  private readonly rounds = new Map<number, Round>();
  private readonly guard: RoundMonotonicityGuard;

  private readonly minerAddresses: PublicKey[];

  constructor(
    /**
     * Wallet Miner PDAs that may populate `miners`; the first is the primary
     * and also fills `miner`. A single PublicKey keeps the old one-wallet call.
     */
    minerAddress: PublicKey | PublicKey[] | null = null,
    /** Notified when a fork rollback is absorbed (visibility, not an error). */
    onRollback?: (r: RoundRollback) => void,
  ) {
    this.minerAddresses = minerAddress === null ? [] : Array.isArray(minerAddress) ? minerAddress : [minerAddress];
    this.guard = new RoundMonotonicityGuard(onRollback);
  }

  /** Miner of the wallet whose Miner PDA is `minerAddress`, if watched and seen. */
  minerAt(minerAddress: PublicKey): Miner | null {
    return this.miners.get(minerAddress.toBase58()) ?? null;
  }

  /** Fork rollbacks absorbed since start — expected to be small but non-zero. */
  rollbacks(): number {
    return this.guard.rollbacks();
  }

  applySlot(slot: number): void {
    if (slot > this.currentSlot) this.currentSlot = slot;
  }

  /**
   * Route a raw account update by discriminator, decode strictly, store.
   * Returns what was applied, or null for account types we don't track.
   * Throws HaltError on any integrity violation.
   */
  applyAccount(pubkey: PublicKey, data: Buffer, slot?: number): AppliedAccount | null {
    switch (classifyAccount(data)) {
      case "Board":
        this.board = decodeAccountOrHalt<Board>("Board", data);
        return { kind: "Board" };
      case "Round": {
        const round = decodeRoundStrict(data);
        // Stale/out-of-order replay (older slot than one already applied) —
        // drop it rather than regressing round state.
        if (!this.guard.check(round, slot)) return null;
        this.rounds.set(round.id, round);
        this.pruneRounds();
        return { kind: "Round", roundId: round.id };
      }
      case "Miner": {
        const idx = this.minerAddresses.findIndex((a) => a.equals(pubkey));
        if (this.minerAddresses.length > 0 && idx < 0) return null;
        const miner = decodeAccountOrHalt<Miner>("Miner", data);
        this.miners.set(pubkey.toBase58(), miner);
        if (idx <= 0) this.miner = miner; // primary, or the only wallet when unfiltered
        return { kind: "Miner" };
      }
      case "SatsVault":
        this.satsVault = decodeAccountOrHalt<SatsVault>("SatsVault", data);
        return { kind: "SatsVault" };
      case "TokenVault":
        this.tokenVault = decodeAccountOrHalt<TokenVault>("TokenVault", data);
        return { kind: "TokenVault" };
      case "SatrushConfig":
        this.satrushConfig = decodeAccountOrHalt<SatrushConfig>("SatrushConfig", data);
        return { kind: "SatrushConfig" };
      default:
        return null;
    }
  }

  /** The round the board points at (rotation-safe: keyed by board.round_id). */
  currentRound(): Round | null {
    if (!this.board) return null;
    return this.rounds.get(this.board.round_id) ?? null;
  }

  round(id: number): Round | null {
    return this.rounds.get(id) ?? null;
  }

  /** Per-tile visible stakes (base units) for the current round; zeros if unknown. */
  visibleStakes(): bigint[] {
    const round = this.currentRound();
    if (!round) return new Array<bigint>(TILES_COUNT).fill(0n);
    return round.public_tile_stakes.map((t) => toBig(t.stake));
  }

  /**
   * Slots until the deploy cutoff (board.end_slot); negative once past it.
   * Null when unknown OR when the round clock is disarmed: on devnet an idle
   * round carries start/end_slot = u64::MAX until the first deploy arms it.
   */
  slotsToCutoff(): number | null {
    if (!this.board || this.currentSlot === 0) return null;
    const end = BigInt(this.board.end_slot.toString());
    if (end === 0xffff_ffff_ffff_ffffn) return null;
    return Number(end) - this.currentSlot;
  }

  /**
   * The k emptiest tiles of the current round, by (stake, deploy_count, index)
   * ascending — ties resolve to the lowest tile index.
   */
  emptiestTiles(k = 3): number[] {
    const round = this.currentRound();
    const stakes = this.visibleStakes();
    const counts = round
      ? round.public_tile_stakes.map((t) => t.deploy_count)
      : new Array<number>(TILES_COUNT).fill(0);
    return [...Array(TILES_COUNT).keys()]
      .sort((a, b) => {
        const sa = stakes[a] ?? 0n;
        const sb = stakes[b] ?? 0n;
        if (sa !== sb) return sa < sb ? -1 : 1;
        const ca = counts[a] ?? 0;
        const cb = counts[b] ?? 0;
        if (ca !== cb) return ca - cb;
        return a - b;
      })
      .slice(0, Math.max(0, Math.min(k, TILES_COUNT)));
  }

  /** Strike jackpot USD side: swapped + pending amounts (base units). */
  /**
   * The Sat Strike pool as it stands on chain — the FULL amount, of which the
   * operator has confirmed only 70% is delivered on trigger (see
   * STRIKE_PAYOUT_FRACTION; the remaining 30% splits between a rolling reserve
   * and straight rollover, deliberately, to seed the next pool).
   *
   * OPEN: this sums the armed pool and the pending accrual. If pending is
   * queued for a LATER round rather than included in the next trigger, the sum
   * overstates this round's strike EV and only strike_usd_amount belongs here.
   * Unresolved — ask the operator before relying on the strike leg for sizing.
   */
  strikePoolUsd(): bigint {
    if (!this.board) return 0n;
    return toBig(this.board.strike_usd_amount) + toBig(this.board.strike_pending_usd_amount);
  }

  private pruneRounds(): void {
    const currentId = this.board?.round_id ?? Math.max(...this.rounds.keys());
    for (const id of this.rounds.keys()) {
      if (id < currentId - 4) this.rounds.delete(id);
    }
  }
}

export interface BootstrapOptions {
  /** The wallet(s) whose Miner PDAs are watched; the first is the primary. */
  minerAuthority?: PublicKey | PublicKey[] | undefined;
  programId?: PublicKey | undefined;
  /** Notified when a fork rollback is absorbed rather than halted on. */
  onRollback?: ((r: RoundRollback) => void) | undefined;
}

/**
 * One-time HTTP RPC bootstrap: satrush config, board, current round, sats
 * vault, and (if an authority is known) this wallet's miner. Everything is
 * kept fresh by the streams afterwards.
 */
export async function bootstrapGameState(
  connection: Connection,
  opts: BootstrapOptions = {},
): Promise<GameState> {
  const programId = opts.programId ?? PROGRAM_ID;
  const authorities =
    opts.minerAuthority === undefined
      ? []
      : Array.isArray(opts.minerAuthority)
        ? opts.minerAuthority
        : [opts.minerAuthority];
  const minerAddresses = authorities.map((a) => minerPda(a, programId));
  const state = new GameState(minerAddresses.length > 0 ? minerAddresses : null, opts.onRollback);

  const staticKeys = [
    satrushConfigPda(programId),
    boardPda(programId),
    satsVaultPda(programId),
    tokenVaultPda(programId),
    ...minerAddresses,
  ];
  const infos = await connection.getMultipleAccountsInfo(staticKeys, "processed");

  const configInfo = infos[0];
  const boardInfo = infos[1];
  if (!configInfo) throw new HaltError("satrush_config account not found on chain");
  if (!boardInfo) throw new HaltError("board account not found on chain");
  state.applyAccount(staticKeys[0] as PublicKey, configInfo.data);
  state.applyAccount(staticKeys[1] as PublicKey, boardInfo.data);
  const vaultInfo = infos[2];
  if (vaultInfo) state.applyAccount(staticKeys[2] as PublicKey, vaultInfo.data);
  const tokenVaultInfo = infos[3]; // absent on a V1 chain — fine, stays null
  if (tokenVaultInfo) state.applyAccount(staticKeys[3] as PublicKey, tokenVaultInfo.data);
  minerAddresses.forEach((addr, i) => {
    const info = infos[4 + i];
    if (info) state.applyAccount(addr, info.data); // a wallet with no Miner yet stays absent
  });

  const bootSlot = await connection.getSlot("processed");
  state.applySlot(bootSlot);

  const roundId = state.board?.round_id;
  if (roundId !== undefined) {
    const roundAddress = roundPda(roundId, programId);
    const roundInfo = await connection.getAccountInfo(roundAddress, "processed");
    // Stamp the boot slot so later stream updates are ordered against this
    // snapshot — an unstamped baseline would compare against older replays.
    if (roundInfo) state.applyAccount(roundAddress, roundInfo.data, bootSlot);
  }
  return state;
}
