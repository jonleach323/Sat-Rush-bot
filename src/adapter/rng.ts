/**
 * V2 randomness rotor accounts. Every instruction that ARMs a rotor by CPI
 * (deploy_public for the round rotor; the vault draw triggers for the epoch
 * and 1-BTC rotors) expects four remaining accounts appended after the IDL
 * list: `[rotor (writable), rng config, rng program, SlotHashes sysvar]`.
 *
 * Program id and rotor tags come from the SDK; the seed strings mirror the
 * SDK's `rng.ts` and are pinned against `getRngRemainingAccountsFor` in
 * test/sdk-parity.test.ts so a drift there fails loudly here.
 */
import { PublicKey, SYSVAR_SLOT_HASHES_PUBKEY, type AccountMeta } from "@solana/web3.js";
import {
  BTC_ROTOR_TAG,
  EPOCH_ROTOR_TAG,
  RNG_PROGRAM_ADDRESS,
  ROUND_ROTOR_TAG,
} from "@satrush/client";

export const RNG_PROGRAM_ID = new PublicKey(RNG_PROGRAM_ADDRESS);

export type RotorTag = typeof ROUND_ROTOR_TAG | typeof EPOCH_ROTOR_TAG | typeof BTC_ROTOR_TAG;
export const ROTOR_TAGS = {
  round: ROUND_ROTOR_TAG,
  epoch: EPOCH_ROTOR_TAG,
  btc: BTC_ROTOR_TAG,
} as const satisfies Record<string, RotorTag>;

export function rngConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], RNG_PROGRAM_ID)[0];
}

export function rotorPda(tag: RotorTag): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("rotor"), Buffer.from(tag)], RNG_PROGRAM_ID)[0];
}

/** The four remaining accounts an arming instruction must append. */
export function rngRemainingAccounts(tag: RotorTag): AccountMeta[] {
  return [
    { pubkey: rotorPda(tag), isWritable: true, isSigner: false },
    { pubkey: rngConfigPda(), isWritable: false, isSigner: false },
    { pubkey: RNG_PROGRAM_ID, isWritable: false, isSigner: false },
    { pubkey: SYSVAR_SLOT_HASHES_PUBKEY, isWritable: false, isSigner: false },
  ];
}
