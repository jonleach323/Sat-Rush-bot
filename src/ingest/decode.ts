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
export class RoundMonotonicityGuard {
  private readonly baselines = new Map<number, RoundBaseline>();

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
   * A decrease at a NEWER slot is still a genuine integrity violation (bad
   * decode / layout change) and throws. Caveat: a deep fork rollback at
   * `processed` could also surface that way; it has not been observed, and
   * halting is the safe response to an unexplained decrease.
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
      for (let i = 0; i < TILES_COUNT; i++) {
        const prevStake = prev.stakes[i] ?? 0n;
        const nextStake = next.stakes[i] ?? 0n;
        if (nextStake < prevStake) {
          throw new HaltError("tile stake decreased within a round", {
            roundId: round.id,
            tile: i,
            previous: prevStake.toString(),
            current: nextStake.toString(),
          });
        }
        const prevCount = prev.deployCounts[i] ?? 0;
        const nextCount = next.deployCounts[i] ?? 0;
        if (nextCount < prevCount) {
          throw new HaltError("tile deploy_count decreased within a round", {
            roundId: round.id,
            tile: i,
            previous: prevCount,
            current: nextCount,
          });
        }
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
