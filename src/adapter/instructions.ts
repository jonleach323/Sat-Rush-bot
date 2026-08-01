/**
 * Instruction builders. Account lists mirror the IDL's account order and
 * writable/signer flags exactly (round-trip-tested against the IDL); all
 * addresses are derived — PDAs via pdas.ts, ATAs via the associated-token
 * program, fixed programs from the IDL's declared addresses.
 */
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { BN, instructionCoder, PROGRAM_ID } from "./idl.js";
import { validateMask } from "./mask.js";
import {
  boardBtcAta,
  boardPda,
  boardUsdAta,
  minerPda,
  publicAutomationPda,
  publicDeploymentPda,
  roundPda,
  satrushConfigPda,
  satsVaultBtcAta,
  satsVaultPda,
} from "./pdas.js";

/**
 * Anchor's emit_cpi! event authority: PDA of the framework-constant seed
 * "__event_authority" under the program (the IDL lists the account without
 * seeds because it's an Anchor convention; verified against live devnet
 * transactions).
 */
export function eventAuthorityPda(programId: PublicKey = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    programId,
  )[0];
}

/** Mints (from the on-chain SatrushConfig) + optional program override. */
export interface InstructionContext {
  usdMint: PublicKey;
  btcMint: PublicKey;
  programId?: PublicKey | undefined;
}

const meta = (pubkey: PublicKey, writable = false, signer = false): AccountMeta => ({
  pubkey,
  isWritable: writable,
  isSigner: signer,
});

function toBn(value: bigint, label: string): BN {
  if (value <= 0n) throw new RangeError(`${label} must be positive, got ${value}`);
  if (value > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`${label} exceeds u64: ${value}`);
  }
  return new BN(value.toString());
}

export interface DeployPublicParams {
  authority: PublicKey;
  roundId: number;
  selectionMask: number;
  amountBaseUnits: bigint;
}

export function buildDeployPublic(
  ctx: InstructionContext,
  params: DeployPublicParams,
): TransactionInstruction {
  validateMask(params.selectionMask);
  const programId = ctx.programId ?? PROGRAM_ID;
  const { authority, roundId } = params;
  const board = boardPda(programId);

  return new TransactionInstruction({
    programId,
    keys: [
      meta(authority, true, true),
      meta(satrushConfigPda(programId)),
      meta(board, true),
      meta(roundPda(roundId, programId), true),
      meta(ctx.usdMint),
      meta(getAssociatedTokenAddressSync(ctx.usdMint, authority), true),
      meta(boardUsdAta(ctx.usdMint, programId), true),
      meta(publicDeploymentPda(authority, roundId, programId), true),
      meta(minerPda(authority, programId), true),
      meta(TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
      meta(eventAuthorityPda(programId)),
      meta(programId),
    ],
    data: instructionCoder.encode("deploy_public", {
      selection_mask: params.selectionMask,
      amount: toBn(params.amountBaseUnits, "amount"),
    }),
  });
}

export interface SettleDeployPublicParams {
  /** The cranking signer (our wallet) — pays the tx, may be anyone. */
  authority: PublicKey;
  /** The deployment being settled (seeds the deployment/miner/automation PDAs). */
  deploymentAuthority: PublicKey;
  roundId: number;
  /** Defaults to the cranking signer — rent goes to whoever cranks. */
  rentRecipient?: PublicKey | undefined;
}

export function buildSettleDeployPublic(
  ctx: InstructionContext,
  params: SettleDeployPublicParams,
): TransactionInstruction {
  const programId = ctx.programId ?? PROGRAM_ID;
  const { authority, deploymentAuthority, roundId } = params;
  const rentRecipient = params.rentRecipient ?? authority;
  // Not optional accounts: the program derives these addresses so settlement
  // can't dodge automation reload routing; they may be closed/empty on chain.
  const automation = publicAutomationPda(deploymentAuthority, programId);
  const automationUsdAta = getAssociatedTokenAddressSync(ctx.usdMint, automation, true);

  return new TransactionInstruction({
    programId,
    keys: [
      meta(authority, true, true),
      meta(satrushConfigPda(programId)),
      meta(roundPda(roundId, programId), true),
      meta(boardPda(programId)),
      meta(rentRecipient, true),
      meta(publicDeploymentPda(deploymentAuthority, roundId, programId), true),
      meta(minerPda(deploymentAuthority, programId), true),
      meta(automation, true),
      meta(automationUsdAta, true),
      meta(satsVaultPda(programId), true),
      meta(ctx.btcMint),
      meta(ctx.usdMint),
      meta(boardUsdAta(ctx.usdMint, programId), true),
      meta(boardBtcAta(ctx.btcMint, programId), true),
      meta(satsVaultBtcAta(ctx.btcMint, programId), true),
      meta(TOKEN_PROGRAM_ID),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
      meta(eventAuthorityPda(programId)),
      meta(programId),
    ],
    data: instructionCoder.encode("settle_deploy_public", {}),
  });
}

export interface ClaimSatsParams {
  authority: PublicKey;
  shares: bigint;
}

export function buildClaimSats(
  ctx: InstructionContext,
  params: ClaimSatsParams,
): TransactionInstruction {
  const programId = ctx.programId ?? PROGRAM_ID;
  const { authority } = params;

  return new TransactionInstruction({
    programId,
    keys: [
      meta(authority, true, true),
      meta(satrushConfigPda(programId)),
      meta(satsVaultPda(programId), true),
      meta(minerPda(authority, programId), true),
      meta(ctx.btcMint),
      meta(satsVaultBtcAta(ctx.btcMint, programId), true),
      meta(getAssociatedTokenAddressSync(ctx.btcMint, authority), true),
      meta(TOKEN_PROGRAM_ID),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
      meta(eventAuthorityPda(programId)),
      meta(programId),
    ],
    data: instructionCoder.encode("claim_sats", {
      shares: toBn(params.shares, "shares"),
    }),
  });
}

export interface ClaimUsdParams {
  authority: PublicKey;
  amount: bigint;
}

export function buildClaimUsd(
  ctx: InstructionContext,
  params: ClaimUsdParams,
): TransactionInstruction {
  const programId = ctx.programId ?? PROGRAM_ID;
  const { authority } = params;

  // claim_usd emits no event — the IDL lists no event_authority/program here.
  return new TransactionInstruction({
    programId,
    keys: [
      meta(authority, true, true),
      meta(satrushConfigPda(programId)),
      meta(boardPda(programId)),
      meta(minerPda(authority, programId), true),
      meta(ctx.usdMint),
      meta(boardUsdAta(ctx.usdMint, programId), true),
      meta(getAssociatedTokenAddressSync(ctx.usdMint, authority), true),
      meta(TOKEN_PROGRAM_ID),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    data: instructionCoder.encode("claim_usd", {
      amount: toBn(params.amount, "amount"),
    }),
  });
}
