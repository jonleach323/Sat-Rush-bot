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
const SEED_ONE_BTC_VAULT = pdaConstSeed("one_btc_vault");
const SEED_ONE_BTC_VAULT_ITERATION = pdaConstSeed("one_btc_vault_iteration");
const SEED_EPOCH_VAULT = pdaConstSeed("epoch_vault");
const SEED_EPOCH_VAULT_ITERATION = pdaConstSeed("epoch_vault_iteration");
const SEED_EPOCH_VAULT_PAGE = pdaConstSeed("epoch_vault_page");
const SEED_EPOCH_VAULT_ENTRY = pdaConstSeed("epoch_vault_entry");

function u32Le(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`u32 seed out of range, got ${value}`);
  }
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

function u16Le(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`u16 seed out of range, got ${value}`);
  }
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value);
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

// ── hashrate-funded raffle vaults (1-BTC winner-take-all; epoch 21-winner) ──
// Iteration/page/entry PDAs are scoped by the vault's CURRENT iteration_id,
// which the caller reads from the decoded vault account (never assumed).

export function oneBtcVaultPda(programId: PublicKey = PROGRAM_ID): PublicKey {
  return derive([SEED_ONE_BTC_VAULT], programId);
}

export function oneBtcVaultIterationPda(
  iterationId: number,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return derive([SEED_ONE_BTC_VAULT_ITERATION, u32Le(iterationId)], programId);
}

export function epochVaultPda(programId: PublicKey = PROGRAM_ID): PublicKey {
  return derive([SEED_EPOCH_VAULT], programId);
}

export function epochVaultIterationPda(
  iterationId: number,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return derive([SEED_EPOCH_VAULT_ITERATION, u32Le(iterationId)], programId);
}

export function epochVaultPagePda(
  iterationId: number,
  pageIndex: number,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return derive(
    [SEED_EPOCH_VAULT_PAGE, u32Le(iterationId), u16Le(pageIndex)],
    programId,
  );
}

export function epochVaultEntryPda(
  iterationId: number,
  authority: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return derive(
    [SEED_EPOCH_VAULT_ENTRY, u32Le(iterationId), authority.toBuffer()],
    programId,
  );
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
