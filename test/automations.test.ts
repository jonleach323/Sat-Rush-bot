import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  automationInflow,
  inflowSkew,
  maskTiles,
  readableCommitments,
  type AutomationCommitment,
} from "../src/ingest/automations.js";
import { TILES_COUNT } from "../src/strategy/ev.js";
import type { PublicAutomation } from "../src/adapter/idl.js";

const ALL = (1 << TILES_COUNT) - 1;
const auto = (over: Partial<PublicAutomation> = {}): { authority: ReturnType<typeof Keypair.generate>["publicKey"]; account: PublicAutomation } => ({
  authority: Keypair.generate().publicKey,
  account: {
    version: 1,
    bump: 255,
    authority: Keypair.generate().publicKey,
    strategy: { Static: {} },
    selection_mask: ALL,
    reload: true,
    per_round_usd_amount: new BN(1_000_000),
    remaining_usd_amount: new BN(100_000_000),
    total_spent_usd_amount: new BN(0),
    reserved: [],
    ...over,
  } as PublicAutomation,
});

describe("maskTiles", () => {
  it("expands a blanket to every tile", () => {
    expect(maskTiles(ALL)).toHaveLength(TILES_COUNT);
  });
  it("reads the measured 7-tile mask", () => {
    expect(maskTiles(0x5b420)).toEqual([5, 10, 12, 13, 15, 16, 18]);
  });
  it("is empty for an empty mask", () => {
    expect(maskTiles(0)).toEqual([]);
  });
});

describe("readableCommitments", () => {
  it("keeps a funded Static automation", () => {
    expect(readableCommitments([auto()])).toHaveLength(1);
  });

  it("drops one that cannot afford another round", () => {
    expect(readableCommitments([auto({
      per_round_usd_amount: new BN(5_000_000),
      remaining_usd_amount: new BN(4_999_999),
    })])).toHaveLength(0);
  });

  it("keeps one funded for exactly one more round", () => {
    expect(readableCommitments([auto({
      per_round_usd_amount: new BN(5_000_000),
      remaining_usd_amount: new BN(5_000_000),
    })])).toHaveLength(1);
  });

  it("refuses non-Static strategies rather than assuming their shape", () => {
    // None exist today. If they appear, their money is real but their mask is
    // the crank's choice — treating them as readable would be a guess wearing
    // a measurement's clothes.
    expect(readableCommitments([auto({ strategy: { Random: {} } as never })])).toHaveLength(0);
    expect(readableCommitments([auto({ strategy: { Discretionary: {} } as never })])).toHaveLength(0);
  });

  it("drops zero-amount and empty-mask entries", () => {
    expect(readableCommitments([auto({ per_round_usd_amount: new BN(0) })])).toHaveLength(0);
    expect(readableCommitments([auto({ selection_mask: 0 })])).toHaveLength(0);
  });
});

describe("automationInflow", () => {
  const opts = { netFactor: 0.92, fireRate: 1 };
  const commit = (mask: number, perRound: bigint): AutomationCommitment => ({
    authority: Keypair.generate().publicKey,
    tiles: maskTiles(mask),
    perRoundBase: perRound,
    remainingBase: perRound * 100n,
    reload: true,
  });

  it("splits a deploy evenly across its masked tiles", () => {
    const s = automationInflow([commit(0b111, 3_000_000n)], opts);
    expect(s[0]).toBe(920_000n);
    expect(s[1]).toBe(920_000n);
    expect(s[2]).toBe(920_000n);
    expect(s[3]).toBe(0n);
  });

  it("a blanket lifts every tile equally — no relative price moves", () => {
    const s = automationInflow([commit(ALL, 21_000_000n)], opts);
    expect(new Set(s.map(String)).size).toBe(1);
    expect(inflowSkew(s)).toBe(0);
  });

  it("an uneven mask is what actually creates a cheap tile", () => {
    const s = automationInflow([commit(ALL, 21_000_000n), commit(0b1111111, 7_000_000n)], opts);
    expect(inflowSkew(s)).toBeGreaterThan(0);
    // The uncovered tiles are strictly cheaper than the covered ones.
    expect(s[20]!).toBeLessThan(s[0]!);
  });

  it("scales with the fire rate, and stops at zero", () => {
    const full = automationInflow([commit(ALL, 21_000_000n)], opts);
    const half = automationInflow([commit(ALL, 21_000_000n)], { ...opts, fireRate: 0.5 });
    expect(Number(half[0])).toBeCloseTo(Number(full[0]) / 2, -1);
    expect(automationInflow([commit(ALL, 21_000_000n)], { ...opts, fireRate: 0 })[0]).toBe(0n);
  });

  it("clamps a nonsense fire rate rather than inventing inflow", () => {
    const over = automationInflow([commit(ALL, 21_000_000n)], { ...opts, fireRate: 5 });
    const one = automationInflow([commit(ALL, 21_000_000n)], opts);
    expect(over[0]).toBe(one[0]);
  });

  it("is all zeroes with nothing committed", () => {
    expect(automationInflow([], opts).every((x) => x === 0n)).toBe(true);
  });
});

describe("inflowSkew", () => {
  it("is zero for a flat book and rises with lopsidedness", () => {
    expect(inflowSkew(new Array<bigint>(TILES_COUNT).fill(100n))).toBe(0);
    const lop = new Array<bigint>(TILES_COUNT).fill(100n);
    lop[0] = 300n;
    expect(inflowSkew(lop)).toBeGreaterThan(0);
  });
  it("is zero when nothing is committed", () => {
    expect(inflowSkew(new Array<bigint>(TILES_COUNT).fill(0n))).toBe(0);
  });
});
