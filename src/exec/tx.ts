/**
 * Transaction assembly: instructions → signed VersionedTransaction with
 * compute-budget + priority-fee instructions in front. The fee value is
 * always injected by the caller (fees.ts owns fee policy, a later stage).
 * Assembly is mode-agnostic; the EXECUTION_MODE gate lives in the sender.
 */
import { readFileSync } from "node:fs";
import {
  ComputeBudgetProgram,
  Keypair,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";

/** Load a JSON-array keypair file (solana-keygen format). Never log this. */
export function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(raw) || raw.some((b) => typeof b !== "number")) {
    throw new Error(`keypair file ${path} is not a JSON byte array`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
}

export interface AssembleTxParams {
  payer: Keypair;
  instructions: TransactionInstruction[];
  /** Compute unit ceiling for the whole tx. */
  computeUnitLimit: number;
  /** Priority fee in micro-lamports per CU — decided by the caller. */
  priorityFeeMicroLamports: number;
  /** Reuse a pre-fetched blockhash instead of fetching one. */
  blockhash?: { blockhash: string; lastValidBlockHeight: number } | undefined;
}

export interface AssembledTx {
  tx: VersionedTransaction;
  blockhash: string;
  lastValidBlockHeight: number;
}

/**
 * ix → [setComputeUnitLimit, setComputeUnitPrice, ...ix] → v0 message →
 * signed VersionedTransaction. Both budget instructions are always present
 * (price 0 is valid) so position and fee are deterministic and auditable.
 */
export async function assembleTx(
  connection: Connection,
  params: AssembleTxParams,
): Promise<AssembledTx> {
  if (params.instructions.length === 0) {
    throw new Error("assembleTx: no instructions given");
  }
  if (!Number.isInteger(params.computeUnitLimit) || params.computeUnitLimit <= 0) {
    throw new RangeError(`invalid computeUnitLimit: ${params.computeUnitLimit}`);
  }
  if (
    !Number.isInteger(params.priorityFeeMicroLamports) ||
    params.priorityFeeMicroLamports < 0
  ) {
    throw new RangeError(
      `invalid priorityFeeMicroLamports: ${params.priorityFeeMicroLamports}`,
    );
  }

  const { blockhash, lastValidBlockHeight } =
    params.blockhash ?? (await connection.getLatestBlockhash("confirmed"));

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: params.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: params.priorityFeeMicroLamports,
    }),
    ...params.instructions,
  ];

  const message = new TransactionMessage({
    payerKey: params.payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([params.payer]);
  return { tx, blockhash, lastValidBlockHeight };
}
