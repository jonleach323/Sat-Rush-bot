/**
 * PDA derivation. Seed prefixes come from the IDL (via pdaConstSeed), never
 * from memory. Round-scoped seeds use u32 little-endian round ids, matching
 * the IDL's `account: round.id` / `arg` seed encodings.
 */
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { pdaConstSeed, PROGRAM_ID } from "./idl.js";

const SEED_SATRUSH_CONFIG = pdaConstSeed("satrush_config");
const SEED_BOARD = pdaConstSeed("board");
const SEED_ROUND = pdaConstSeed("round");
const SEED_MINER = pdaConstSeed("miner");
const SEED_PUBLIC_DEPLOYMENT = pdaConstSeed("public_deployment");
const SEED_PUBLIC_AUTOMATION = pdaConstSeed("public_automation");
const SEED_SATS_VAULT = pdaConstSeed("sats_vault");

function u32Le(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`round id must be a u32, got ${value}`);
  }
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

function derive(seeds: (Uint8Array | Buffer)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

export function satrushConfigPda(programId: PublicKey = PROGRAM_ID): PublicKey {
  return derive([SEED_SATRUSH_CONFIG], programId);
}

export function boardPda(programId: PublicKey = PROGRAM_ID): PublicKey {
  return derive([SEED_BOARD], programId);
}

export function roundPda(roundId: number, programId: PublicKey = PROGRAM_ID): PublicKey {
  return derive([SEED_ROUND, u32Le(roundId)], programId);
}

export function minerPda(
  authority: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return derive([SEED_MINER, authority.toBuffer()], programId);
}

export function publicDeploymentPda(
  authority: PublicKey,
  roundId: number,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return derive([SEED_PUBLIC_DEPLOYMENT, authority.toBuffer(), u32Le(roundId)], programId);
}

export function publicAutomationPda(
  authority: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return derive([SEED_PUBLIC_AUTOMATION, authority.toBuffer()], programId);
}

export function satsVaultPda(programId: PublicKey = PROGRAM_ID): PublicKey {
  return derive([SEED_SATS_VAULT], programId);
}

// ── program-owned ATAs (owner is a PDA → allowOwnerOffCurve) ────────────────

export function boardUsdAta(
  usdMint: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return getAssociatedTokenAddressSync(usdMint, boardPda(programId), true);
}

export function boardBtcAta(
  btcMint: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return getAssociatedTokenAddressSync(btcMint, boardPda(programId), true);
}

export function satsVaultBtcAta(
  btcMint: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return getAssociatedTokenAddressSync(btcMint, satsVaultPda(programId), true);
}
