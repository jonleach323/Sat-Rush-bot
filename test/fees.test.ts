import { describe, expect, it } from "vitest";
import type { Connection } from "@solana/web3.js";
import { cuPriceFromInstructionDatas, FeeEstimator } from "../src/exec/fees.js";

const cfg = { minMicroLamports: 1_000, maxMicroLamports: 50_000 };

function mockRpc(fees: number[]): Connection {
  return {
    getRecentPrioritizationFees: async () =>
      fees.map((prioritizationFee, i) => ({ slot: i, prioritizationFee })),
  } as unknown as Connection;
}

describe("FeeEstimator", () => {
  it("returns the clamp floor with no data", () => {
    expect(new FeeEstimator(cfg).currentMicroLamportsPerCu()).toBe(1_000);
  });

  it("EMA of observed landed fees", () => {
    const est = new FeeEstimator({ ...cfg, emaAlpha: 0.5 });
    est.observeLandedCuPrice(10_000);
    est.observeLandedCuPrice(20_000);
    expect(est.currentMicroLamportsPerCu()).toBe(15_000);
  });

  it("blends RPC p75 with the EMA and clamps to [MIN, MAX]", async () => {
    const est = new FeeEstimator(cfg);
    await est.refreshFromRpc(mockRpc([0, 2_000, 4_000, 8_000])); // p75 of nonzero → 8000
    expect(est.currentMicroLamportsPerCu()).toBe(8_000);
    est.observeLandedCuPrice(2_000);
    expect(est.currentMicroLamportsPerCu()).toBe(5_000); // (8000+2000)/2
    est.observeLandedCuPrice(10_000_000); // ema jumps → clamp at max
    expect(est.currentMicroLamportsPerCu()).toBe(50_000);
  });

  it("clamps to the floor and survives RPC failure", async () => {
    const est = new FeeEstimator(cfg);
    est.observeLandedCuPrice(0);
    expect(est.currentMicroLamportsPerCu()).toBe(1_000);
    await est.refreshFromRpc({
      getRecentPrioritizationFees: async () => {
        throw new Error("no such method");
      },
    } as unknown as Connection);
    expect(est.currentMicroLamportsPerCu()).toBe(1_000);
  });

  it("rejects invalid clamp/alpha", () => {
    expect(() => new FeeEstimator({ minMicroLamports: 10, maxMicroLamports: 5 })).toThrow();
    expect(() => new FeeEstimator({ ...cfg, emaAlpha: 0 })).toThrow();
  });
});

describe("cuPriceFromInstructionDatas", () => {
  it("parses a setComputeUnitPrice instruction", () => {
    const data = Buffer.alloc(9);
    data[0] = 3;
    data.writeBigUInt64LE(1234n, 1);
    expect(cuPriceFromInstructionDatas([Uint8Array.from([2, 0, 0, 0, 0]), data])).toBe(
      1234,
    );
  });

  it("returns null when absent", () => {
    expect(cuPriceFromInstructionDatas([Uint8Array.from([2, 1, 2, 3, 4])])).toBeNull();
    expect(cuPriceFromInstructionDatas([])).toBeNull();
  });
});
