/**
 * The board, read before it exists.
 *
 * PublicAutomation accounts are public state carrying a Static strategy's
 * selection_mask and per_round_usd_amount. The owner's crank executes them at
 * round open, so a funded Static automation is a deploy that WILL happen, on
 * tiles that are already known. This is not prediction — it is reading the
 * order book.
 *
 * Measured on mainnet: all 201 automation accounts are Static, 36 are funded,
 * and they commit $115.67 per round against a board of roughly $135 gross. So
 * about 86% of the field's inflow is knowable before the round opens, and the
 * client was estimating it statistically from historical rival profiles
 * instead.
 *
 * Most of that money is uninformative — 33 of the 36 run the full 21-tile
 * blanket, which lifts every tile equally and changes no relative price. The
 * value is in the handful that do not: one 18-tile mask, one 16, one 7. Those
 * are what make specific tiles cheap, and knowing them in advance is the
 * difference between picking the emptiest tile and guessing at it.
 *
 * Two honest limits. A funded automation is not a guaranteed deploy — the
 * crank has to execute it, and it can be topped up or drained between reads —
 * so `fireRate` calibrates intent against what actually landed. And Random or
 * Discretionary strategies would be unreadable; none exist today, but the
 * decoder must not silently treat them as Static if that changes.
 */
import type { PublicKey } from "@solana/web3.js";
import type { PublicAutomation } from "../adapter/idl.js";
import { TILES_COUNT } from "../strategy/ev.js";

export interface AutomationCommitment {
  authority: PublicKey;
  /** Tiles the mask covers. */
  tiles: number[];
  /** Gross USD it deploys per round, base units. */
  perRoundBase: bigint;
  /** Funding left; below perRoundBase it cannot fire again. */
  remainingBase: bigint;
  /** Winnings recycle into the escrow, so remaining is not a countdown. */
  reload: boolean;
}

/** Bit positions set in a selection mask, as tile indices. */
export function maskTiles(mask: number): number[] {
  const out: number[] = [];
  for (let t = 0; t < TILES_COUNT; t++) if (mask & (1 << t)) out.push(t);
  return out;
}

/**
 * Keep only automations that can actually fire this round. A Static strategy
 * is the only readable one: Random and Discretionary leave the mask to the
 * crank, so their money is real but their SHAPE is not knowable, and treating
 * them as known would put confident numbers on a guess.
 */
export function readableCommitments(
  entries: readonly { authority: PublicKey; account: PublicAutomation }[],
): AutomationCommitment[] {
  const out: AutomationCommitment[] = [];
  for (const { authority, account } of entries) {
    if (!("Static" in account.strategy)) continue;
    const perRoundBase = BigInt(account.per_round_usd_amount.toString());
    const remainingBase = BigInt(account.remaining_usd_amount.toString());
    if (perRoundBase <= 0n || remainingBase < perRoundBase) continue;
    const tiles = maskTiles(account.selection_mask);
    if (tiles.length === 0) continue;
    out.push({ authority, tiles, perRoundBase, remainingBase, reload: account.reload });
  }
  return out;
}

export interface InflowOptions {
  /** Fraction of a gross deploy that reaches the tiles (1 - deployFeeBps). */
  netFactor: number;
  /**
   * Share of funded automations that actually fire in a round, learned from
   * observation. Intent is not execution: the crank must run, and funding can
   * move between our read and the round. Starts at 1 and should be calibrated
   * down — over-predicting rival inflow makes every tile look more crowded
   * than it is and suppresses deploys we should be making.
   */
  fireRate: number;
}

/**
 * Per-tile stake these automations will add, in base units.
 *
 * The program splits a deploy evenly across its masked tiles, so a blanket
 * lifts all 21 equally and shifts no relative price. Only uneven masks change
 * which tile is cheap, which is the entire reason to read these.
 */
export function automationInflow(
  commitments: readonly AutomationCommitment[],
  opts: InflowOptions,
): bigint[] {
  const rate = Math.max(0, Math.min(1, opts.fireRate));
  const net = Math.max(0, opts.netFactor);
  const stakes = new Array<bigint>(TILES_COUNT).fill(0n);
  if (rate === 0 || net === 0) return stakes;
  for (const c of commitments) {
    const perTile = BigInt(
      Math.floor((Number(c.perRoundBase) * net * rate) / c.tiles.length),
    );
    if (perTile <= 0n) continue;
    for (const t of c.tiles) stakes[t] = (stakes[t] ?? 0n) + perTile;
  }
  return stakes;
}

/**
 * How lopsided the automation book is. Zero means every tile gets the same
 * committed inflow — the blanket case, where reading the book buys nothing.
 * The larger this is, the more the book alone tells you which tile to take.
 */
export function inflowSkew(stakes: readonly bigint[]): number {
  const vals = stakes.map(Number);
  const total = vals.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  const mean = total / vals.length;
  const spread = Math.max(...vals) - Math.min(...vals);
  return spread / mean;
}
