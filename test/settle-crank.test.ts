import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  DEFAULT_PACKING,
  SettleRegistry,
  batchClearsCost,
  expectedRentSol,
  planBatches,
  settlesPerTx,
  type SettleTarget,
} from "../src/exec/settle-crank.js";

const key = (): PublicKey => Keypair.generate().publicKey;
const target = (seenSlot: number, roundId = 1): SettleTarget => ({
  authority: key(),
  roundId,
  seenSlot,
});

describe("settlesPerTx", () => {
  it("beats the incumbent's measured 2.86 per transaction", () => {
    expect(settlesPerTx(DEFAULT_PACKING)).toBeGreaterThan(3);
  });

  it("is bound by compute when compute is the tightest constraint", () => {
    expect(settlesPerTx({ ...DEFAULT_PACKING, cuPerSettle: 400_000, maxPerTx: 99 })).toBe(3);
  });

  it("is bound by account slots when those bind first", () => {
    // (60 - 17) / 20 = 2
    expect(settlesPerTx({ ...DEFAULT_PACKING, accountsPerSettle: 20, maxPerTx: 99 })).toBe(2);
  });

  it("respects the collision ceiling even when the protocol allows more", () => {
    expect(settlesPerTx({ ...DEFAULT_PACKING, maxPerTx: 2 })).toBe(2);
  });

  it("never returns zero, however tight the limits", () => {
    expect(
      settlesPerTx({ ...DEFAULT_PACKING, cuPerSettle: 10_000_000, accountsPerSettle: 1_000 }),
    ).toBe(1);
  });
});

describe("planBatches", () => {
  it("packs to the computed size and leaves the remainder in a short batch", () => {
    const per = settlesPerTx(DEFAULT_PACKING);
    const targets = Array.from({ length: per * 2 + 1 }, (_, i) => target(i));
    const batches = planBatches(targets);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(per);
    expect(batches[1]).toHaveLength(per);
    expect(batches[2]).toHaveLength(1);
  });

  it("loses nothing and duplicates nothing", () => {
    const targets = Array.from({ length: 37 }, (_, i) => target(i));
    const flat = planBatches(targets).flat();
    expect(flat).toHaveLength(37);
    expect(new Set(flat.map((t) => t.authority.toBase58())).size).toBe(37);
  });

  it("orders oldest-first so collision risk lands in the earliest batch", () => {
    const targets = [target(50), target(10), target(30)];
    const flat = planBatches(targets, { ...DEFAULT_PACKING, maxPerTx: 1 }).flat();
    expect(flat.map((t) => t.seenSlot)).toEqual([10, 30, 50]);
  });

  it("returns nothing for nothing", () => {
    expect(planBatches([])).toEqual([]);
  });
});

describe("SettleRegistry", () => {
  it("keeps the first sighting so a reload cannot reorder a target", () => {
    const reg = new SettleRegistry();
    const a = key();
    reg.add({ authority: a, roundId: 5, seenSlot: 100 });
    reg.add({ authority: a, roundId: 5, seenSlot: 140 });
    expect(reg.size(5)).toBe(1);
    expect(reg.targets(5)[0]?.seenSlot).toBe(100);
  });

  it("separates rounds", () => {
    const reg = new SettleRegistry();
    reg.add({ authority: key(), roundId: 1, seenSlot: 1 });
    reg.add({ authority: key(), roundId: 2, seenSlot: 2 });
    expect(reg.size(1)).toBe(1);
    expect(reg.size(2)).toBe(1);
    expect(reg.rounds()).toEqual([1, 2]);
  });

  it("drops targets another cranker took", () => {
    const reg = new SettleRegistry();
    const a = key();
    reg.add({ authority: a, roundId: 3, seenSlot: 1 });
    reg.remove(3, a);
    expect(reg.size(3)).toBe(0);
  });

  it("prunes old rounds so it cannot grow without bound", () => {
    const reg = new SettleRegistry();
    for (let r = 1; r <= 40; r++) reg.add({ authority: key(), roundId: r, seenSlot: r });
    reg.prune(40, 8);
    expect(reg.rounds()[0]).toBeGreaterThanOrEqual(32);
    expect(reg.rounds().length).toBeLessThanOrEqual(9);
  });
});

describe("economics", () => {
  it("values a plan at the measured rent per settle", () => {
    const batches = planBatches(Array.from({ length: 10 }, (_, i) => target(i)));
    expect(expectedRentSol(batches, 0.00173)).toBeCloseTo(0.0173, 6);
  });

  it("clears cost easily at measured rent and fees", () => {
    expect(batchClearsCost(1, 0.00173, 0.000015)).toBe(true);
  });

  it("refuses when rent collapses or fees spike", () => {
    expect(batchClearsCost(1, 0.00001, 0.000015)).toBe(false);
    expect(batchClearsCost(4, 0.00173, 0.005)).toBe(false);
  });

  it("refuses an empty batch", () => {
    expect(batchClearsCost(0, 0.00173, 0.000015)).toBe(false);
  });
});
