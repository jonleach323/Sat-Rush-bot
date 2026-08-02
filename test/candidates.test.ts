import { describe, expect, it } from "vitest";
import { Keypair, VersionedTransaction, type Connection } from "@solana/web3.js";
import bs58 from "bs58";
import {
  CandidateSet,
  computeCandidateSelections,
} from "../src/exec/candidates.js";
import { FeeEstimator } from "../src/exec/fees.js";
import { TILES_COUNT, type EvContext } from "../src/strategy/ev.js";
import type { SelectorConfig } from "../src/strategy/selector.js";
import { usdToBase } from "../src/units.js";
import { seededRng } from "./helpers.js";

const FEES = { deployFeeBps: 800, satsVaultRoundBps: 1200 };

function chaseCtx(): EvContext {
  const stakes = new Array<bigint>(TILES_COUNT).fill(0n);
  for (let i = 3; i < TILES_COUNT; i++) stakes[i] = usdToBase(10);
  return { predictedStakes: stakes, fees: FEES, multiplier: 1, semantics: "raw" };
}

function selCfg(): SelectorConfig {
  return {
    strategy: "water_filling",
    ladder: [usdToBase(1)],
    maxPerRound: usdToBase(5),
    minDeploy: usdToBase(1),
    kEmptiest: 3,
    rng: seededRng(3),
  };
}

function mockConnection(): { conn: Connection; blockhashCalls: () => number } {
  let calls = 0;
  const conn = {
    getLatestBlockhash: async () => {
      calls++;
      const raw = new Uint8Array(32).fill(calls);
      return { blockhash: bs58.encode(raw), lastValidBlockHeight: 1000 + calls };
    },
  } as unknown as Connection;
  return { conn, blockhashCalls: () => calls };
}

const feeEstimator = new FeeEstimator({ minMicroLamports: 1234, maxMicroLamports: 9999 });

function candidateSet(conn: Connection, now?: () => number) {
  return new CandidateSet({
    connection: conn,
    payer: Keypair.generate(),
    ixCtx: {
      usdMint: Keypair.generate().publicKey,
      btcMint: Keypair.generate().publicKey,
    },
    feeEstimator,
    computeUnitLimit: 400_000,
    now,
  });
}

describe("computeCandidateSelections", () => {
  it("produces the best plus up to 2 next-best masks, all distinct", () => {
    const selections = computeCandidateSelections(chaseCtx(), selCfg());
    expect(selections.length).toBeGreaterThanOrEqual(2);
    expect(selections.length).toBeLessThanOrEqual(3);
    const masks = selections.map((s) => s.mask);
    expect(new Set(masks).size).toBe(masks.length);
    // Best pick covers the empty tiles 0..2.
    expect(selections[0]!.tiles).toEqual([0, 1, 2]);
  });

  it("returns empty when the board offers no positive EV", () => {
    const emptyBoard: EvContext = {
      predictedStakes: new Array<bigint>(TILES_COUNT).fill(0n),
      fees: FEES,
      multiplier: 1,
      semantics: "raw",
    };
    expect(computeCandidateSelections(emptyBoard, selCfg())).toEqual([]);
  });
});

describe("CandidateSet", () => {
  it("builds signed, serialized candidates tagged to the round", async () => {
    const { conn } = mockConnection();
    const set = candidateSet(conn);
    const built = await set.refresh(42, chaseCtx(), selCfg());
    expect(built.length).toBeGreaterThanOrEqual(2);
    for (const candidate of built) {
      expect(candidate.roundId).toBe(42);
      expect(candidate.feeMicroLamports).toBe(1234);
      const tx = VersionedTransaction.deserialize(candidate.serialized);
      expect(bs58.encode(tx.signatures[0]!)).toBe(candidate.signature);
      expect(tx.signatures[0]!.some((b) => b !== 0)).toBe(true); // actually signed
    }
    expect(set.best(42)).toBe(built[0]);
    expect(set.current(43)).toEqual([]); // other round → cold
  });

  it("reuses the blockhash within 15s and refetches after", async () => {
    const { conn, blockhashCalls } = mockConnection();
    let t = 0;
    const set = new CandidateSet({
      connection: conn,
      payer: Keypair.generate(),
      ixCtx: {
        usdMint: Keypair.generate().publicKey,
        btcMint: Keypair.generate().publicKey,
      },
      feeEstimator,
      computeUnitLimit: 400_000,
      blockhashMaxAgeMs: 15_000,
      now: () => t,
    });
    await set.refresh(1, chaseCtx(), selCfg());
    t += 5_000;
    await set.refresh(1, chaseCtx(), selCfg());
    expect(blockhashCalls()).toBe(1); // reused within max age
    t += 15_001;
    const rebuilt = await set.refresh(1, chaseCtx(), selCfg());
    expect(blockhashCalls()).toBe(2); // refreshed and re-signed
    expect(rebuilt[0]!.blockhash).not.toBe("");
  });

  it("clears on round rotation", async () => {
    const { conn } = mockConnection();
    const set = candidateSet(conn);
    await set.refresh(1, chaseCtx(), selCfg());
    expect(set.current(1).length).toBeGreaterThan(0);
    await set.refresh(2, chaseCtx(), selCfg());
    expect(set.current(1)).toEqual([]);
    expect(set.current(2).length).toBeGreaterThan(0);
  });
});
