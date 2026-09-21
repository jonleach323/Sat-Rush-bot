import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ComputeBudgetProgram,
  Keypair,
  type Connection,
} from "@solana/web3.js";
import bs58 from "bs58";
import { buildClaimUsd } from "../src/adapter/instructions.js";
import { assembleTx, loadKeypair } from "../src/exec/tx.js";

const payer = Keypair.generate();
const fakeBlockhash = bs58.encode(new Uint8Array(32).fill(7));
const connection = {
  getLatestBlockhash: async () => ({
    blockhash: fakeBlockhash,
    lastValidBlockHeight: 4242,
  }),
} as unknown as Connection;

const someIx = buildClaimUsd(
  { usdMint: Keypair.generate().publicKey, btcMint: Keypair.generate().publicKey, tokenMint: Keypair.generate().publicKey },
  { authority: payer.publicKey, amount: 1n },
);

describe("assembleTx", () => {
  it("prepends compute budget + priority fee and signs a v0 tx", async () => {
    const { tx, blockhash, lastValidBlockHeight } = await assembleTx(connection, {
      payer,
      instructions: [someIx],
      computeUnitLimit: 250_000,
      priorityFeeMicroLamports: 1234,
    });

    expect(blockhash).toBe(fakeBlockhash);
    expect(lastValidBlockHeight).toBe(4242);
    expect(tx.version).toBe(0);
    expect(tx.message.compiledInstructions).toHaveLength(3);

    const keys = tx.message.staticAccountKeys;
    expect(keys[0]!.equals(payer.publicKey)).toBe(true); // payer first

    const [limitIx, priceIx] = tx.message.compiledInstructions;
    const budgetProgram = ComputeBudgetProgram.programId;
    expect(keys[limitIx!.programIdIndex]!.equals(budgetProgram)).toBe(true);
    expect(keys[priceIx!.programIdIndex]!.equals(budgetProgram)).toBe(true);
    // ComputeBudget layouts: [2, u32 units] and [3, u64 microLamports]
    const limitData = Buffer.from(limitIx!.data);
    expect(limitData[0]).toBe(2);
    expect(limitData.readUInt32LE(1)).toBe(250_000);
    const priceData = Buffer.from(priceIx!.data);
    expect(priceData[0]).toBe(3);
    expect(priceData.readBigUInt64LE(1)).toBe(1234n);

    // signed by the payer
    expect(tx.signatures).toHaveLength(1);
    expect(tx.signatures[0]!.some((b) => b !== 0)).toBe(true);
  });

  it("accepts a pre-fetched blockhash without calling the connection", async () => {
    const neverCall = {
      getLatestBlockhash: async () => {
        throw new Error("should not be called");
      },
    } as unknown as Connection;
    const { blockhash } = await assembleTx(neverCall, {
      payer,
      instructions: [someIx],
      computeUnitLimit: 100_000,
      priorityFeeMicroLamports: 0,
      blockhash: { blockhash: fakeBlockhash, lastValidBlockHeight: 1 },
    });
    expect(blockhash).toBe(fakeBlockhash);
  });

  it("rejects empty instruction lists and bad budget values", async () => {
    await expect(
      assembleTx(connection, {
        payer,
        instructions: [],
        computeUnitLimit: 1,
        priorityFeeMicroLamports: 0,
      }),
    ).rejects.toThrow(/no instructions/);
    await expect(
      assembleTx(connection, {
        payer,
        instructions: [someIx],
        computeUnitLimit: 0,
        priorityFeeMicroLamports: 0,
      }),
    ).rejects.toThrow(/computeUnitLimit/);
    await expect(
      assembleTx(connection, {
        payer,
        instructions: [someIx],
        computeUnitLimit: 1,
        priorityFeeMicroLamports: -1,
      }),
    ).rejects.toThrow(/priorityFee/);
  });
});

describe("loadKeypair", () => {
  it("round-trips a solana-keygen JSON file", () => {
    const dir = mkdtempSync(join(tmpdir(), "satrush-test-"));
    const path = join(dir, "kp.json");
    writeFileSync(path, JSON.stringify([...payer.secretKey]));
    expect(loadKeypair(path).publicKey.equals(payer.publicKey)).toBe(true);
  });

  it("rejects non-array files", () => {
    const dir = mkdtempSync(join(tmpdir(), "satrush-test-"));
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify({ not: "a keypair" }));
    expect(() => loadKeypair(path)).toThrow(/byte array/);
  });
});
