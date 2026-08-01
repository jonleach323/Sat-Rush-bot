/**
 * IDL loader + coders. Everything layout-related (discriminators, account
 * shapes, PDA seed constants) is read from the IDL file at runtime — never
 * hardcoded (see CLAUDE.md ground rules).
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  BN,
  BorshAccountsCoder,
  BorshCoder,
  BorshEventCoder,
  BorshInstructionCoder,
  type Idl,
} from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

// ── raw IDL structural types (only the parts we read directly) ──────────────

interface RawIdlSeed {
  kind: "const" | "account" | "arg";
  value?: number[];
  path?: string;
}

interface RawIdlInstructionAccount {
  name: string;
  pda?: { seeds: RawIdlSeed[] };
  accounts?: RawIdlInstructionAccount[];
}

interface RawIdl {
  address: string;
  accounts: { name: string; discriminator: number[] }[];
  events: { name: string; discriminator: number[] }[];
  instructions: { name: string; accounts: RawIdlInstructionAccount[] }[];
}

// ── load ─────────────────────────────────────────────────────────────────────

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// CLAUDE.md names the file satrush-idl.json; the owner delivered it as
// satrush.json — accept either.
const IDL_CANDIDATES = ["satrush-idl.json", "satrush.json"] as const;

const idlPath = IDL_CANDIDATES.map((f) => join(repoRoot, f)).find(existsSync);
if (!idlPath) {
  throw new Error(`IDL not found at repo root (looked for ${IDL_CANDIDATES.join(", ")})`);
}

const raw = JSON.parse(readFileSync(idlPath, "utf8")) as RawIdl;

export const SATRUSH_IDL = raw as unknown as Idl;
export const IDL_PATH = idlPath;
export const PROGRAM_ADDRESS: string = raw.address;
export const PROGRAM_ID = new PublicKey(raw.address);

// ── coders ───────────────────────────────────────────────────────────────────

export const coder = new BorshCoder(SATRUSH_IDL);
export const accountsCoder = new BorshAccountsCoder(SATRUSH_IDL);
export const instructionCoder = new BorshInstructionCoder(SATRUSH_IDL);
export const eventCoder = new BorshEventCoder(SATRUSH_IDL);

// ── discriminators (read from the IDL, keyed by IDL name) ───────────────────

function discriminatorMap(entries: { name: string; discriminator: number[] }[]) {
  return Object.freeze(
    Object.fromEntries(entries.map((e) => [e.name, Uint8Array.from(e.discriminator)])),
  ) as Readonly<Record<string, Uint8Array>>;
}

export const ACCOUNT_DISCRIMINATORS = discriminatorMap(raw.accounts);
export const EVENT_DISCRIMINATORS = discriminatorMap(raw.events);

/** Decode an account buffer (discriminator-checked) into its typed shape. */
export function decodeAccount<T>(accountName: string, data: Buffer): T {
  return accountsCoder.decode<T>(accountName, data);
}

/**
 * First const seed of the given instruction-account's PDA definition, e.g.
 * pdaConstSeed("board") → bytes of "board". This is how PDA seed prefixes are
 * sourced from the IDL instead of being hardcoded.
 */
export function pdaConstSeed(accountName: string): Uint8Array {
  for (const ix of raw.instructions) {
    for (const acc of walkAccounts(ix.accounts)) {
      if (acc.name !== accountName || !acc.pda) continue;
      const first = acc.pda.seeds[0];
      if (first?.kind === "const" && first.value) return Uint8Array.from(first.value);
    }
  }
  throw new Error(`no const PDA seed found for account "${accountName}" in IDL`);
}

function* walkAccounts(
  items: RawIdlInstructionAccount[],
): Generator<RawIdlInstructionAccount> {
  for (const item of items) {
    yield item;
    if (item.accounts) yield* walkAccounts(item.accounts);
  }
}

// ── decoded account shapes ───────────────────────────────────────────────────
// Field names match the IDL verbatim (snake_case): the coders above are built
// from the raw IDL, so decoded objects carry these exact keys. u64 → BN,
// u32/u16/u8 → number, pubkey → PublicKey, option<T> → T | null.

export type RoundState =
  | { active: Record<string, never> }
  | { revealed: Record<string, never> }
  | { settled: Record<string, never> }
  | { finished: Record<string, never> };

export type AutomationStrategy =
  | { static: Record<string, never> }
  | { random: Record<string, never> }
  | { discretionary: Record<string, never> };

export interface TileStake {
  stake: BN;
  deploy_count: number;
}

export interface Board {
  version: number;
  bump: number;
  round_id: number;
  round_duration: number;
  start_slot: BN;
  end_slot: BN;
  strike_pending_usd_amount: BN;
  strike_usd_amount: BN;
  strike_btc_amount: BN;
  strike_last_trigger_round_id: number;
  reserved: number[];
}

export interface Round {
  version: number;
  bump: number;
  id: number;
  state: RoundState;
  blockhash_entropy: number[];
  winning_tile: number | null;
  deployed_pending_usd_amount: BN;
  deployed_usd_amount: BN;
  deployed_btc_amount: BN;
  deployed_usd_on_winning_tile_amount: BN;
  miners_count: number;
  revealed_miners_count: number;
  winners_count: number;
  settled_miners_count: number;
  strike_bonus_usd: BN;
  strike_bonus_btc: BN;
  public_tile_stakes: TileStake[];
  deploy_entropy_acc: number[];
  settled_at_slot: BN;
  pending_epoch_fee_usd_amount: BN;
  pending_one_btc_fee_usd_amount: BN;
  pending_protocol_fee_usd_amount: BN;
  reserved: number[];
}

export interface Miner {
  version: number;
  bump: number;
  authority: PublicKey;
  unclaimed_usd_amount: BN;
  unclaimed_btc_shares: BN;
  hashrate_amount: BN;
  current_streak_count: number;
  last_mined_round_id: number;
  unclaimed_hashrate: BN;
  reserved: number[];
}

export interface PublicDeployment {
  version: number;
  bump: number;
  authority: PublicKey;
  round_id: number;
  deployed_usd_amount: BN;
  total_stake_usd_amount: BN;
  selection_mask: number;
  streak_multiplier: number;
  automation: PublicKey | null;
  reserved: number[];
}

export interface PublicAutomation {
  version: number;
  bump: number;
  authority: PublicKey;
  strategy: AutomationStrategy;
  selection_mask: number;
  reload: boolean;
  per_round_usd_amount: BN;
  remaining_usd_amount: BN;
  total_spent_usd_amount: BN;
  reserved: number[];
}

export interface SatrushConfig {
  version: number;
  bump: number;
  owner_authority: PublicKey;
  admin_authority: PublicKey;
  round_authority: PublicKey;
  fee_recipient: PublicKey;
  usd_mint: PublicKey;
  btc_mint: PublicKey;
  strike_fee_bps: number;
  epoch_fee_bps: number;
  one_btc_fee_bps: number;
  sats_vault_round_fee_bps: number;
  sats_vault_claim_fee_bps: number;
  protocol_fee_bps: number;
  unclaimed_hashrate_bps: number;
  min_deploy_usd_amount: BN;
  epoch_vault_iteration_duration: BN;
  deployment_settle_grace_duration: BN;
  reserved: number[];
}

export interface SatsVault {
  version: number;
  bump: number;
  btc_amount: BN;
  btc_shares: BN;
  leftovers: BN;
  reserved: number[];
}

// ── event shapes ─────────────────────────────────────────────────────────────

export interface PublicDeployCreated {
  authority: PublicKey;
  round_id: number;
  deployed_usd_amount: BN;
  total_stake_usd_amount: BN;
  selection_mask: number;
  is_automation: boolean;
  reload: boolean;
}

export interface RoundRevealed {
  round_id: number;
  winning_tile: number;
  is_strike_triggered: boolean;
  strike_bonus_usd: BN;
  strike_bonus_btc: BN;
  epoch_fee_usd_amount: BN;
  one_btc_fee_usd_amount: BN;
  protocol_fee_usd_amount: BN;
}

export interface PublicDeploySettled {
  authority: PublicKey;
  round_id: number;
  winning_stake: BN;
  won_usd_amount: BN;
  won_shares_amount: BN;
  hashrate_earned: BN;
  unclaimed_hashrate_earned: BN;
  is_automation: boolean;
  reload: boolean;
}

export interface SatsClaimed {
  authority: PublicKey;
  claimed_shares: BN;
  btc_received: BN;
  claimed_hashrate: BN;
}
