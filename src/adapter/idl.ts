/**
 * IDL loader + coders. Everything layout-related (discriminators, account
 * shapes, PDA seed constants) is read from the IDL file at runtime — never
 * hardcoded (see CLAUDE.md ground rules).
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as anchorNs from "@coral-xyz/anchor";
import type { BN as BNType, Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

// Anchor is a CJS package whose named exports Node's ESM lexer only partially
// detects (BN in particular is missed). Import the namespace and normalize
// the interop shape once; consumers import anchor values from THIS module.
const anchor = ((anchorNs as { default?: unknown }).default ??
  anchorNs) as typeof anchorNs;

export const BN = anchor.BN;
export type BN = BNType;

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

export const coder = new anchor.BorshCoder(SATRUSH_IDL);
export const accountsCoder = new anchor.BorshAccountsCoder(SATRUSH_IDL);
export const instructionCoder = new anchor.BorshInstructionCoder(SATRUSH_IDL);
export const eventCoder = new anchor.BorshEventCoder(SATRUSH_IDL);

// ── discriminators (read from the IDL, keyed by IDL name) ───────────────────

function discriminatorMap(entries: { name: string; discriminator: number[] }[]) {
  return Object.freeze(
    Object.fromEntries(entries.map((e) => [e.name, Uint8Array.from(e.discriminator)])),
  ) as Readonly<Record<string, Uint8Array>>;
}

export const ACCOUNT_DISCRIMINATORS = discriminatorMap(raw.accounts);
export const EVENT_DISCRIMINATORS = discriminatorMap(raw.events);

/** Discriminator for a named account; throws if the IDL doesn't define it. */
export function accountDiscriminator(name: string): Uint8Array {
  const disc = ACCOUNT_DISCRIMINATORS[name];
  if (!disc) throw new Error(`no discriminator for account "${name}" in IDL`);
  return disc;
}

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
// Generated from the same SDK codecs as satrush.json (scripts/idl/gen-idl-from-sdk.ts),
// so the interfaces and the coder can never disagree. Field and enum-variant
// names match the IDL verbatim (snake_case fields, PascalCase variants):
// u64 → BN, u32/u16/u8 → number, pubkey → PublicKey, option<T> → T | null.
export * from "./generated-types.js";
