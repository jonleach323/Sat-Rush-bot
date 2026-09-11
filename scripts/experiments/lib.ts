/**
 * Shared harness for devnet experiments. Each experiment is a standalone
 * script that sends real transactions from the funded test wallet
 * (EXECUTION_MODE=devnet required) and appends its findings — with raw tx
 * signatures as evidence — to FINDINGS.md.
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  BN,
  decodeAccount,
  instructionCoder,
  PROGRAM_ID,
  SATRUSH_IDL,
  type Board,
  type Miner,
  type PublicAutomation,
  type PublicDeployment,
  type Round,
  type SatrushConfig,
  type SatsVault,
} from "../../src/adapter/idl.js";
import { buildDeployPublic, type InstructionContext } from "../../src/adapter/instructions.js";
import { tilesToMask } from "../../src/adapter/mask.js";
import {
  boardPda,
  minerPda,
  publicAutomationPda,
  publicDeploymentPda,
  roundPda,
  satrushConfigPda,
  satsVaultPda,
} from "../../src/adapter/pdas.js";
import { loadConfig } from "../../src/config.js";
import { confirmSignature } from "../../src/exec/confirm.js";
import { assembleTx, loadKeypair } from "../../src/exec/tx.js";
import { parseTransactionEvents, type DecodedEvent } from "../../src/ingest/events.js";
import { usdToBase } from "../../src/units.js";

export const FINDINGS_PATH = "FINDINGS.md";
export const U64_MAX = 0xffff_ffff_ffff_ffffn;

export interface Experiment {
  name: string;
  conn: Connection;
  payer: Keypair;
  programId: PublicKey;
  ixCtx: InstructionContext;
  satrushConfig: SatrushConfig;
  log: (msg: string) => void;
}

export async function setupExperiment(name: string): Promise<Experiment> {
  const cfg = loadConfig();
  if (cfg.EXECUTION_MODE !== "devnet") {
    throw new Error(`experiments send real devnet txs — run with EXECUTION_MODE=devnet`);
  }
  const conn = new Connection(cfg.RPC_HTTP_URL, "confirmed");
  const payer = loadKeypair(cfg.KEYPAIR_PATH);
  const programId = new PublicKey(cfg.PROGRAM_ID);
  const info = await conn.getAccountInfo(satrushConfigPda(programId));
  if (!info) throw new Error("satrush_config not found");
  const satrushConfig = decodeAccount<SatrushConfig>("SatrushConfig", info.data);
  const log = (msg: string) => console.log(`[${name}] ${msg}`);
  log(`wallet ${payer.publicKey.toBase58()}`);
  return {
    name,
    conn,
    payer,
    programId,
    ixCtx: {
      usdMint: satrushConfig.usd_mint,
      btcMint: satrushConfig.btc_mint,
      tokenMint: satrushConfig.token_mint,
    },
    satrushConfig,
    log,
  };
}

export const explorer = (sig: string) =>
  `[\`${sig.slice(0, 12)}…\`](https://explorer.solana.com/tx/${sig}?cluster=devnet)`;

export function appendFindings(markdown: string): void {
  if (!existsSync(FINDINGS_PATH)) {
    writeFileSync(
      FINDINGS_PATH,
      "# Devnet experiment findings\n\nEach section is appended by a standalone script in `scripts/experiments/` — raw transaction signatures are the evidence.\n",
    );
  }
  appendFileSync(FINDINGS_PATH, `\n${markdown.trim()}\n`);
}

export const nowIso = () => new Date().toISOString().slice(0, 19) + "Z";

// ── account fetchers ─────────────────────────────────────────────────────────

export async function getBoard(x: Experiment): Promise<Board> {
  const info = await x.conn.getAccountInfo(boardPda(x.programId), "confirmed");
  if (!info) throw new Error("board missing");
  return decodeAccount<Board>("Board", info.data);
}

export async function getRound(x: Experiment, roundId: number): Promise<Round | null> {
  const info = await x.conn.getAccountInfo(roundPda(roundId, x.programId), "confirmed");
  return info ? decodeAccount<Round>("Round", info.data) : null;
}

export async function getDeployment(
  x: Experiment,
  authority: PublicKey,
  roundId: number,
): Promise<PublicDeployment | null> {
  const info = await x.conn.getAccountInfo(
    publicDeploymentPda(authority, roundId, x.programId),
    "confirmed",
  );
  return info ? decodeAccount<PublicDeployment>("PublicDeployment", info.data) : null;
}

export async function getMiner(
  x: Experiment,
  authority: PublicKey,
): Promise<Miner | null> {
  const info = await x.conn.getAccountInfo(minerPda(authority, x.programId), "confirmed");
  return info ? decodeAccount<Miner>("Miner", info.data) : null;
}

export async function getAutomation(
  x: Experiment,
  authority: PublicKey,
): Promise<PublicAutomation | null> {
  const info = await x.conn.getAccountInfo(
    publicAutomationPda(authority, x.programId),
    "confirmed",
  );
  return info ? decodeAccount<PublicAutomation>("PublicAutomation", info.data) : null;
}

export async function getVault(x: Experiment): Promise<SatsVault> {
  const info = await x.conn.getAccountInfo(satsVaultPda(x.programId), "confirmed");
  if (!info) throw new Error("sats_vault missing");
  return decodeAccount<SatsVault>("SatsVault", info.data);
}

// ── transaction helpers ──────────────────────────────────────────────────────

export interface SentTx {
  sig: string;
  landed: boolean;
  slot: number | null;
  err: string | null;
  logs: string[];
}

/** Assemble, sign, send (skipPreflight so on-chain errors are captured), confirm. */
export async function sendIxs(
  x: Experiment,
  signer: Keypair,
  ixs: TransactionInstruction[],
  opts: { cuLimit?: number; presigned?: { serialized: Buffer; sig: string } } = {},
): Promise<SentTx> {
  let serialized: Buffer;
  let sig: string;
  let lastValidBlockHeight: number | undefined;
  if (opts.presigned) {
    ({ serialized, sig } = opts.presigned);
  } else {
    const assembled = await assembleTx(x.conn, {
      payer: signer,
      instructions: ixs,
      computeUnitLimit: opts.cuLimit ?? 400_000,
      priorityFeeMicroLamports: 1_000,
    });
    serialized = Buffer.from(assembled.tx.serialize());
    sig = bs58.encode(assembled.tx.signatures[0]!);
    lastValidBlockHeight = assembled.lastValidBlockHeight;
  }
  await x.conn.sendRawTransaction(serialized, { skipPreflight: true, maxRetries: 0 });
  const outcome = await confirmSignature(x.conn, sig, {
    timeoutMs: 20_000,
    lastValidBlockHeight,
  });
  let logs: string[] = [];
  let err: string | null = null;
  let slot: number | null = null;
  if (outcome.status === "landed") {
    slot = outcome.slot;
  } else {
    err = outcome.status === "failed" ? outcome.error : outcome.status;
    if (outcome.status === "missed_round") err = `missed_round:${outcome.reason}`;
  }
  // fetch logs either way (failed txs carry the program error logs)
  try {
    const tx = await x.conn.getTransaction(sig, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    logs = tx?.meta?.logMessages ?? [];
    if (tx?.meta?.err && !err) err = JSON.stringify(tx.meta.err);
    if (tx && slot === null) slot = tx.slot;
  } catch {
    /* not found */
  }
  return { sig, landed: err === null && slot !== null, slot, err, logs };
}

export async function deploy(
  x: Experiment,
  signer: Keypair,
  tiles: number[],
  grossUsd: number,
  roundId: number,
): Promise<SentTx> {
  const ix = buildDeployPublic(x.ixCtx, {
    authority: signer.publicKey,
    roundId,
    selectionMask: tilesToMask(tiles),
    amountBaseUnits: usdToBase(grossUsd),
  });
  return sendIxs(x, signer, [ix]);
}

// ── round-cycle helpers (HTTP polling is fine for standalone experiments) ────

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait until the board shows a round we haven't deployed into. */
export async function waitFreshRound(
  x: Experiment,
  authority: PublicKey,
  timeoutMs = 120_000,
): Promise<{ board: Board; roundId: number }> {
  const started = Date.now();
  for (;;) {
    const board = await getBoard(x);
    const deployment = await getDeployment(x, authority, board.round_id);
    if (!deployment) return { board, roundId: board.round_id };
    if (Date.now() - started > timeoutMs) {
      throw new Error(`no fresh round within ${timeoutMs}ms (round ${board.round_id} already played; is the rotation crank alive?)`);
    }
    await sleep(1_500);
  }
}

/** Wait for the board to rotate past `roundId`. */
export async function waitRotation(
  x: Experiment,
  roundId: number,
  timeoutMs = 90_000,
): Promise<Board> {
  const started = Date.now();
  for (;;) {
    const board = await getBoard(x);
    if (board.round_id > roundId) return board;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`round ${roundId} did not rotate within ${timeoutMs}ms`);
    }
    await sleep(1_200);
  }
}

/** Fixed program address declared for an instruction account in the IDL. */
export function idlDeclaredAddress(ixName: string, accountName: string): PublicKey {
  const idl = SATRUSH_IDL as unknown as {
    instructions: { name: string; accounts: { name: string; address?: string }[] }[];
  };
  const account = idl.instructions
    .find((i) => i.name === ixName)
    ?.accounts.find((a) => a.name === accountName);
  if (!account?.address) throw new Error(`no address for ${ixName}.${accountName}`);
  return new PublicKey(account.address);
}

// ── automation instruction builders (experiment-scope; IDL account order) ────

const meta = (pubkey: PublicKey, writable = false, signer = false): AccountMeta => ({
  pubkey,
  isWritable: writable,
  isSigner: signer,
});

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { eventAuthorityPda } from "../../src/adapter/instructions.js";

export function buildCreateAutomation(
  x: Experiment,
  authority: PublicKey,
  args: {
    strategy: "Static" | "Random" | "Discretionary";
    selectionMask: number;
    perRoundUsd: bigint;
    reload: boolean;
    depositUsd: bigint;
  },
): TransactionInstruction {
  const automation = publicAutomationPda(authority, x.programId);
  return new TransactionInstruction({
    programId: x.programId,
    keys: [
      meta(authority, true, true),
      meta(satrushConfigPda(x.programId)),
      meta(automation, true),
      meta(x.ixCtx.usdMint),
      meta(getAssociatedTokenAddressSync(x.ixCtx.usdMint, authority), true),
      meta(getAssociatedTokenAddressSync(x.ixCtx.usdMint, automation, true), true),
      meta(minerPda(authority, x.programId), true),
      meta(TOKEN_PROGRAM_ID),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    data: instructionCoder.encode("create_public_automation", {
      strategy: { [args.strategy]: {} },
      selection_mask: args.selectionMask,
      per_round_usd_amount: new BN(args.perRoundUsd.toString()),
      reload: args.reload,
      deposit_usd_amount: new BN(args.depositUsd.toString()),
    }),
  });
}

export function buildTopUpAutomation(
  x: Experiment,
  authority: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const automation = publicAutomationPda(authority, x.programId);
  return new TransactionInstruction({
    programId: x.programId,
    keys: [
      meta(authority, true, true),
      meta(satrushConfigPda(x.programId)),
      meta(automation, true),
      meta(x.ixCtx.usdMint),
      meta(getAssociatedTokenAddressSync(x.ixCtx.usdMint, authority), true),
      meta(getAssociatedTokenAddressSync(x.ixCtx.usdMint, automation, true), true),
      meta(TOKEN_PROGRAM_ID),
    ],
    data: instructionCoder.encode("top_up_public_automation", {
      amount: new BN(amount.toString()),
    }),
  });
}

export function buildExecuteAutomation(
  x: Experiment,
  executor: PublicKey,
  automationAuthority: PublicKey,
  roundId: number,
  selectionMask: number | null,
): TransactionInstruction {
  const automation = publicAutomationPda(automationAuthority, x.programId);
  const board = boardPda(x.programId);
  return new TransactionInstruction({
    programId: x.programId,
    keys: [
      meta(executor, true, true),
      meta(satrushConfigPda(x.programId)),
      meta(board, true),
      meta(roundPda(roundId, x.programId), true),
      meta(automation, true),
      meta(x.ixCtx.usdMint),
      meta(getAssociatedTokenAddressSync(x.ixCtx.usdMint, automation, true), true),
      meta(getAssociatedTokenAddressSync(x.ixCtx.usdMint, board, true), true),
      meta(publicDeploymentPda(automationAuthority, roundId, x.programId), true),
      meta(minerPda(automationAuthority, x.programId), true),
      meta(idlDeclaredAddress("execute_public_automation", "slot_hashes")),
      meta(TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
      meta(eventAuthorityPda(x.programId)),
      meta(x.programId),
    ],
    data: instructionCoder.encode("execute_public_automation", {
      selection_mask: selectionMask,
    }),
  });
}

export function buildCancelAutomation(
  x: Experiment,
  authority: PublicKey,
): TransactionInstruction {
  const automation = publicAutomationPda(authority, x.programId);
  return new TransactionInstruction({
    programId: x.programId,
    keys: [
      meta(authority, true, true),
      meta(satrushConfigPda(x.programId)),
      meta(automation, true),
      meta(x.ixCtx.usdMint),
      meta(getAssociatedTokenAddressSync(x.ixCtx.usdMint, automation, true), true),
      meta(getAssociatedTokenAddressSync(x.ixCtx.usdMint, authority), true),
      meta(TOKEN_PROGRAM_ID),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    data: instructionCoder.encode("cancel_public_automation", {}),
  });
}

// ── event scanning (poll-based, standalone) ──────────────────────────────────

export async function recentProgramEvents(
  x: Experiment,
  limit = 15,
): Promise<DecodedEvent[]> {
  const sigs = await x.conn.getSignaturesForAddress(x.programId, { limit }, "confirmed");
  const out: DecodedEvent[] = [];
  for (const info of sigs) {
    if (info.err) continue;
    const tx = await x.conn.getTransaction(info.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx?.meta) continue;
    const innerIxDatas = (tx.meta.innerInstructions ?? []).flatMap((g) =>
      g.instructions.map((ix) => Uint8Array.from(bs58.decode(ix.data))),
    );
    out.push(
      ...parseTransactionEvents({
        logs: tx.meta.logMessages ?? [],
        innerIxDatas,
        slot: tx.slot,
        signature: info.signature,
      }),
    );
  }
  return out;
}

export const fmtUsd = (v: bigint | { toString(): string }) =>
  `$${(Number(v.toString()) / 1e6).toFixed(4)}`;
