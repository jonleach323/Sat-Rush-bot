import { describe, expect, it } from "vitest";
import {
  FULL_MASK,
  InvalidSelectionMaskError,
  maskToTiles,
  popcount,
  tilesToMask,
  TILES_COUNT,
  validateMask,
} from "../src/adapter/mask.js";

describe("popcount", () => {
  it("counts bits", () => {
    expect(popcount(0)).toBe(0);
    expect(popcount(1)).toBe(1);
    expect(popcount(0b1011)).toBe(3);
    expect(popcount(FULL_MASK)).toBe(21);
    expect(popcount(0xffff_ffff)).toBe(32);
  });

  it("rejects non-u32 input", () => {
    expect(() => popcount(-1)).toThrow(RangeError);
    expect(() => popcount(2 ** 32)).toThrow(RangeError);
    expect(() => popcount(1.5)).toThrow(RangeError);
  });
});

describe("tilesToMask", () => {
  it("maps tile indices to bits", () => {
    expect(tilesToMask([0])).toBe(1);
    expect(tilesToMask([0, 1, 2])).toBe(0b111);
    expect(tilesToMask([20])).toBe(1 << 20);
    expect(tilesToMask([...Array(TILES_COUNT).keys()])).toBe(FULL_MASK);
    expect(tilesToMask([2, 0, 7])).toBe(tilesToMask([0, 2, 7])); // order-free
  });

  it("rejects invalid tile sets (mirrors program error 6007)", () => {
    expect(() => tilesToMask([])).toThrow(InvalidSelectionMaskError);
    expect(() => tilesToMask([21])).toThrow(InvalidSelectionMaskError);
    expect(() => tilesToMask([-1])).toThrow(InvalidSelectionMaskError);
    expect(() => tilesToMask([0.5])).toThrow(InvalidSelectionMaskError);
    expect(() => tilesToMask([3, 3])).toThrow(/duplicate/);
    expect(() => tilesToMask(new Array<number>(22).fill(0))).toThrow(
      InvalidSelectionMaskError,
    );
    try {
      tilesToMask([]);
    } catch (err) {
      expect((err as InvalidSelectionMaskError).code).toBe(6007);
    }
  });
});

describe("maskToTiles / validateMask", () => {
  it("round-trips with tilesToMask", () => {
    for (const tiles of [[0], [20], [0, 10, 20], [...Array(TILES_COUNT).keys()]]) {
      expect(maskToTiles(tilesToMask(tiles))).toEqual(tiles);
    }
  });

  it("returns sorted tiles", () => {
    expect(maskToTiles(0b10101)).toEqual([0, 2, 4]);
  });

  it("rejects out-of-range masks (mirrors program error 6007)", () => {
    expect(() => maskToTiles(0)).toThrow(InvalidSelectionMaskError);
    expect(() => maskToTiles(-1)).toThrow(InvalidSelectionMaskError);
    expect(() => maskToTiles(FULL_MASK + 1)).toThrow(InvalidSelectionMaskError);
    expect(() => maskToTiles(1 << 21)).toThrow(InvalidSelectionMaskError);
    expect(() => maskToTiles(1.5)).toThrow(InvalidSelectionMaskError);
    expect(() => validateMask(0)).toThrow(/no tiles/);
    expect(() => validateMask(FULL_MASK + 1)).toThrow(/21-tile range/);
    validateMask(1); // 1 tile ok
    validateMask(FULL_MASK); // all 21 ok
  });
});
