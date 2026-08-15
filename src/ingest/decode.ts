/**
 * Raw account bytes → typed objects, validated hard. Anything inconsistent
 * throws HaltError: the orchestrator must stop and alert rather than act on
 * garbage state.
 */
import type { Round } from "../adapter/idl.js";
import { ACCOUNT_DISCRIMINATORS, decodeAccount } from "../adapter/idl.js";

export const TILES_COUNT = 21;

/** Unrecoverable data-integrity failure — stop the bot, don't trade on it. */
export class HaltError extends Error {
  constructor(
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HaltError";
  }
}

/** Match a raw account buffer to its IDL account name by 8-byte prefix. */
export function classifyAccount(data: Buffer): string | null {
  if (data.length < 8) return null;
  for (const [name, disc] of Object.entries(ACCOUNT_DISCRIMINATORS)) {
    if (data.subarray(0, 8).equals(disc)) return name;
  }
  return null;
}

export function decodeAccountOrHalt<T>(name: string, data: Buffer): T {
  try {
    return decodeAccount<T>(name, data);
  } catch (err) {
    throw new HaltError(`failed to decode ${name} account`, {
      account: name,
      byteLength: data.length,
      cause: String(err),
    });
  }
}

/** Structural validation of a decoded Round. */
export function validateRoundShape(round: Round): void {
  if (round.public_tile_stakes.length !== TILES_COUNT) {
    throw new HaltError("round has wrong tile count", {
      roundId: round.id,
      tiles: round.public_tile_stakes.length,
      expected: TILES_COUNT,
    });
  }
  for (const [i, tile] of round.public_tile_stakes.entries()) {
    if (tile.stake.isNeg()) {
      throw new HaltError("negative tile stake", {
        roundId: round.id,
        tile: i,
        stake: tile.stake.toString(),
      });
    }
    if (tile.deploy_count < 0) {
      throw new HaltError("negative tile deploy_count", {
        roundId: round.id,
        tile: i,
        deployCount: tile.deploy_count,
      });
    }
  }
}

export function decodeRoundStrict(data: Buffer): Round {
  const round = decodeAccountOrHalt<Round>("Round", data);
  validateRoundShape(round);
  return round;
}

interface RoundBaseline {
  stakes: bigint[];
  deployCounts: number[];
  /** Slot this baseline was observed at; undefined when the source omits it. */
  slot?: number | undefined;
}

/**
 * Within one round, each tile's stake and deploy_count only ever grow.
 * A decrease means we decoded garbage (or the layout changed) → HaltError.
 * Tracks several round ids at once because current and next round updates
 * interleave around rotation.
 */
/** A fork rollback: the canonical chain came back with less than we had seen. */
export interface RoundRollback {
  roundId: number;
  tile: number;
  /** Largest per-tile decrease, in base units. */
  droppedBase: string;
  slot?: number | undefined;
}

export class RoundMonotonicityGuard {
  private readonly baselines = new Map<number, RoundBaseline>();
  private rollbackCount = 0;

  constructor(private readonly onRollback?: (r: RoundRollback) => void) {}

  /** How many fork rollbacks have been absorbed since start. */
  rollbacks(): number {
    return this.rollbackCount;
  }

  /**
   * Validate an update for `round`, observed at `slot` (when known).
   *
   * Returns false when the update is STALE — an account state from a slot at or
   * before one already applied for this round. Yellowstone delivers account
   * updates at `processed`, which can arrive out of order (and a re-subscribe or
   * bootstrap can replay an older snapshot), so an older payload legitimately
   * shows smaller stakes. Without slot ordering that reads as a decrease and
   * false-halts the bot. Stale updates are ignored, not treated as corruption.
   *
   * A decrease at a NEWER slot is a FORK ROLLBACK, not corruption. We subscribe
   * at `processed`, which is explicitly pre-consensus: a deploy can land on a
   * fork that is then abandoned, and the canonical chain legitimately shows a
   * smaller stake at a later slot. This was observed in production (round
   * 15661, tile 0, −$0.448 — one small deploy unwound) and halting the bot for
   * it is a severe overreaction to a normal chain event.
   *
   * Rollbacks are therefore accepted: the newer value IS the current truth, so
   * the baseline moves down and the caller applies it. `onRollback` fires so
   * the event is still visible.
   *
   * Real decode corruption is caught elsewhere and still halts —
   * validateRoundShape() runs on every check (tile count, negative stakes,
   * negative counts), and a board total collapsing by more than half cannot
   * come from unwinding a couple of slots, so that remains a HaltError.
   */
  check(round: Round, slot?: number): boolean {
    validateRoundShape(round);
    const next: RoundBaseline = {
      stakes: round.public_tile_stakes.map((t) => BigInt(t.stake.toString())),
      deployCounts: round.public_tile_stakes.map((t) => t.deploy_count),
      slot,
    };
    const prev = this.baselines.get(round.id);
    if (
      prev &&
      slot !== undefined &&
      prev.slot !== undefined &&
      slot <= prev.slot
    ) {
      return false; // stale/out-of-order replay — ignore
    }
    if (prev) {
      let worstTile = -1;
      let worstDrop = 0n;
      for (let i = 0; i < TILES_COUNT; i++) {
        const drop = (prev.stakes[i] ?? 0n) - (next.stakes[i] ?? 0n);
        if (drop > worstDrop) {
          worstDrop = drop;
          worstTile = i;
        }
        if ((next.deployCounts[i] ?? 0) < (prev.deployCounts[i] ?? 0) && worstTile < 0) {
          worstTile = i; // count unwound even though stake did not
        }
      }
      if (worstTile >= 0) {
        const sum = (xs: bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);
        const prevTotal = sum(prev.stakes);
        const nextTotal = sum(next.stakes);
        // A fork unwinds a couple of slots of deploys. Losing over half the
        // board is not that — it is a decode or layout failure.
        if (prevTotal > 0n && nextTotal * 2n < prevTotal) {
          throw new HaltError("board stake collapsed within a round", {
            roundId: round.id,
            previousTotal: prevTotal.toString(),
            currentTotal: nextTotal.toString(),
          });
        }
        this.rollbackCount++;
        this.onRollback?.({
          roundId: round.id,
          tile: worstTile,
          droppedBase: worstDrop.toString(),
          slot,
        });
      }
    }
    this.baselines.set(round.id, next);
    this.prune(round.id);
    return true;
  }

  private prune(latestId: number): void {
    for (const id of this.baselines.keys()) {
      if (id < latestId - 4) this.baselines.delete(id);
    }
  }
}
