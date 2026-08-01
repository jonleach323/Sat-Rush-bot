/**
 * Selection-mask helpers. deploy_public takes a u32 bitmask selecting 1–21
 * tiles (bit i = tile i, tiles 0..20). The program rejects anything outside
 * that with error 6007 InvalidSelectionMask — these helpers mirror it
 * client-side so bad masks never reach the wire.
 */

export const TILES_COUNT = 21;
/** All 21 tile bits set — the maximum valid mask (0x1fffff). */
export const FULL_MASK = (1 << TILES_COUNT) - 1;

/** Mirror of program error 6007 InvalidSelectionMask. */
export class InvalidSelectionMaskError extends RangeError {
  readonly code = 6007;
  constructor(message: string) {
    super(`InvalidSelectionMask (6007): ${message}`);
    this.name = "InvalidSelectionMaskError";
  }
}

/** Number of set bits in a u32. */
export function popcount(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`popcount expects a u32, got ${value}`);
  }
  let v = value;
  v -= (v >>> 1) & 0x5555_5555;
  v = (v & 0x3333_3333) + ((v >>> 2) & 0x3333_3333);
  v = (v + (v >>> 4)) & 0x0f0f_0f0f;
  return (v * 0x0101_0101) >>> 24;
}

/** Throws InvalidSelectionMaskError unless mask selects 1–21 valid tiles. */
export function validateMask(mask: number): void {
  if (!Number.isInteger(mask)) {
    throw new InvalidSelectionMaskError(`mask must be an integer, got ${mask}`);
  }
  if (mask <= 0) {
    throw new InvalidSelectionMaskError("mask selects no tiles");
  }
  if (mask > FULL_MASK) {
    throw new InvalidSelectionMaskError(
      `mask 0x${mask.toString(16)} has bits outside the 21-tile range`,
    );
  }
}

/** Tile indices (0-based, unique) → selection mask. */
export function tilesToMask(tiles: number[]): number {
  if (tiles.length === 0) {
    throw new InvalidSelectionMaskError("no tiles given");
  }
  if (tiles.length > TILES_COUNT) {
    throw new InvalidSelectionMaskError(`${tiles.length} tiles exceeds ${TILES_COUNT}`);
  }
  let mask = 0;
  for (const tile of tiles) {
    if (!Number.isInteger(tile) || tile < 0 || tile >= TILES_COUNT) {
      throw new InvalidSelectionMaskError(`tile ${tile} outside 0..${TILES_COUNT - 1}`);
    }
    const bit = 1 << tile;
    if (mask & bit) {
      throw new InvalidSelectionMaskError(`duplicate tile ${tile}`);
    }
    mask |= bit;
  }
  return mask;
}

/** Selection mask → sorted tile indices. Validates like the program does. */
export function maskToTiles(mask: number): number[] {
  validateMask(mask);
  const tiles: number[] = [];
  for (let tile = 0; tile < TILES_COUNT; tile++) {
    if (mask & (1 << tile)) tiles.push(tile);
  }
  return tiles;
}
