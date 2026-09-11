import { describe, expect, it } from "vitest";
import { Keypair, VersionedTransaction, type Connection } from "@solana/web3.js";
import bs58 from "bs58";
import {
  CandidateSet,
  computeCandidateSelections,
} from "../src/exec/candidates.js";
import { FeeEstimator } from "../src/exec/fees.js";
import { TILES_COUNT, type EvContext } from "../src/strategy/ev.js";
import { v2Model } from "../src/strategy/ev-v2.js";
import type { SelectorConfig } from "../src/strategy/selector.js";
import { usdToBase } from "../src/units.js";
import { seededRng } from "./helpers.js";

const FEES = { deployFeeBps: 800, satsVaultRoundBps: 1200, satsVaultClaimBps: 1000 };

function chaseCtx(): EvContext {
  const stakes = new Array<bigint>(TILES_COUNT).fill(0n);
  for (let i = 3; i < TILES_COUNT; i++) stakes[i] = usdToBase(10);
  return { predictedStakes: stakes, fees: FEES, multiplier: 1, semantics: "raw" };
}

/** The same chase board through the V2 economics, as a model factory. */
function chaseV2Source() {
  const stakes = chaseCtx().predictedStakes;
  return {
    predictedStakes: stakes,
    model: (predictedStakes: bigint[]) =>
      v2Model({
        predictedStakes,
        econ: { feeLayerBps: 600, losingRefundBps: 8900, vaultExitFeeBps: 1000 },
        mintedTokenValueBase: 0,
        tokenYieldPerVolume: 0.015,
      }),
  };
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
      tokenMint: Keypair.generate().publicKey,
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

describe("CandidateSet — Jito tip", () => {
  it("embeds an EV-scaled tip to one of the rotation accounts", async () => {
    const a1 = Keypair.generate().publicKey;
    const a2 = Keypair.generate().publicKey;
    const { conn } = mockConnection();
    const set = new CandidateSet({
      connection: conn,
      payer: Keypair.generate(),
      ixCtx: { usdMint: Keypair.generate().publicKey, btcMint: Keypair.generate().publicKey, tokenMint: Keypair.generate().publicKey },
      feeEstimator,
      computeUnitLimit: 400_000,
      jitoTip: {
        accounts: [a1, a2],
        baseLamports: 1_000_000,
        maxLamports: 5_000_000,
        evFraction: 0, // flat base tip
        solUsd: () => 150,
      },
      rng: seededRng(1),
    });
    const built = await set.refresh(42, chaseCtx(), selCfg());
    expect(built.length).toBeGreaterThan(0);
    const c = built[0]!;
    expect(c.tipLamports).toBe(1_000_000); // base, since evFraction = 0
    // The tip transfer targets one of the rotation accounts (present in keys).
    const tx = VersionedTransaction.deserialize(c.serialized);
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    expect(keys.includes(a1.toBase58()) || keys.includes(a2.toBase58())).toBe(true);
  });

  it("carries no tip when Jito is unconfigured", async () => {
    const { conn } = mockConnection();
    const built = await candidateSet(conn).refresh(42, chaseCtx(), selCfg());
    expect(built[0]!.tipLamports).toBe(0);
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
        tokenMint: Keypair.generate().publicKey,
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

  // Mainnet rounds are 150 slots and a Solana blockhash expires after exactly
  // 150 blocks. On a quiet round no occupancy update arrives, so nothing calls
  // refresh() and the candidate built at open is fired at the expiry boundary.
  // The slot tick uses this to drive the rebuild instead.
  describe("needsBlockhashRefresh", () => {
    it("is false while the cached blockhash is inside its reuse window", async () => {
      const { conn } = mockConnection();
      let t = 0;
      const set = new CandidateSet({
        connection: conn,
        payer: Keypair.generate(),
        ixCtx: { usdMint: Keypair.generate().publicKey, btcMint: Keypair.generate().publicKey, tokenMint: Keypair.generate().publicKey },
        feeEstimator,
        computeUnitLimit: 400_000,
        blockhashMaxAgeMs: 15_000,
        now: () => t,
      });
      await set.refresh(1, chaseCtx(), selCfg());
      expect(set.needsBlockhashRefresh()).toBe(false);
      t += 14_999;
      expect(set.needsBlockhashRefresh()).toBe(false);
    });

    it("goes true once the blockhash ages out, and clears after a refresh", async () => {
      const { conn, blockhashCalls } = mockConnection();
      let t = 0;
      const set = new CandidateSet({
        connection: conn,
        payer: Keypair.generate(),
        ixCtx: { usdMint: Keypair.generate().publicKey, btcMint: Keypair.generate().publicKey, tokenMint: Keypair.generate().publicKey },
        feeEstimator,
        computeUnitLimit: 400_000,
        blockhashMaxAgeMs: 15_000,
        now: () => t,
      });
      await set.refresh(1, chaseCtx(), selCfg());
      t += 15_001;
      expect(set.needsBlockhashRefresh()).toBe(true);

      await set.refresh(1, chaseCtx(), selCfg());
      expect(blockhashCalls()).toBe(2); // actually re-fetched and re-signed
      expect(set.needsBlockhashRefresh()).toBe(false);
    });

    it("is false before anything is built — nothing to keep warm", () => {
      const { conn } = mockConnection();
      expect(candidateSet(conn).needsBlockhashRefresh()).toBe(false);
    });
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

describe("computeCandidateSelections with a V2 model factory", () => {
  it("rebuilds the model per excluded-tile variant and yields distinct masks", () => {
    const src = chaseV2Source();
    const built: bigint[][] = [];
    const spied = {
      predictedStakes: src.predictedStakes,
      model: (stakes: bigint[]) => {
        built.push(stakes);
        return src.model(stakes);
      },
    };
    const picks = computeCandidateSelections(spied, selCfg());
    expect(picks.length).toBeGreaterThan(0);
    expect(new Set(picks.map((p) => p.mask)).size).toBe(picks.length);
    // first build sees the raw prediction; later ones carry the exclusion sentinel
    expect(built[0]).toEqual(src.predictedStakes);
    if (built.length > 1) expect(built[1]!.some((s) => s >= 10n ** 15n)).toBe(true);
    // the V2 chase and the V1 chase agree on the emptiest tiles
    const v1 = computeCandidateSelections(chaseCtx(), selCfg());
    expect(picks[0]!.tiles.every((t) => t < 3)).toBe(true);
    expect(v1[0]!.tiles.every((t) => t < 3)).toBe(true);
  });
});
