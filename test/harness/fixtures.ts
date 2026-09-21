/**
 * On-chain account fixtures for the orchestrator harness: full V2 structs
 * encoded through the IDL coder (the same coder the bot decodes with), so a
 * layout drift breaks these tests before it breaks the bot.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { accountsCoder, BN, SATRUSH_IDL, type Round } from "../../src/adapter/idl.js";
import type { Board, SatrushConfig, SatsVault, TokenVault } from "../../src/adapter/generated-types.js";
import { TILES_COUNT } from "../../src/strategy/ev.js";

/** Length of a struct's `reserved` array, read from the IDL. */
export function reservedLen(typeName: string): number {
  const t = SATRUSH_IDL.types!.find((x) => x.name === typeName);
  if (!t) throw new Error(`no IDL type ${typeName}`);
  const fields = (t.type as { fields: { name: string; type: { array?: [unknown, number] } }[] }).fields;
  const f = fields.find((x) => x.name === "reserved");
  if (!f?.type.array) throw new Error(`${typeName} has no reserved array`);
  return f.type.array[1];
}

export const MINTS = {
  usd: Keypair.generate().publicKey,
  btc: Keypair.generate().publicKey,
  token: Keypair.generate().publicKey,
};

export function makeConfig(over: Partial<SatrushConfig> = {}): SatrushConfig {
  const pk = () => Keypair.generate().publicKey;
  return {
    version: 2,
    bump: 255,
    owner_authority: pk(),
    admin_authority: pk(),
    game_authority: pk(),
    fee_recipient: pk(),
    usd_mint: MINTS.usd,
    btc_mint: MINTS.btc,
    strike_fee_bps: 240,
    epoch_fee_bps: 104,
    one_btc_fee_bps: 48,
    sats_vault_round_fee_bps: 500,
    vault_exit_fee_bps: 1000,
    protocol_fee_bps: 100,
    unclaimed_hashrate_bps: 3500,
    min_deploy_usd_amount: new BN(1_000_000),
    epoch_vault_iteration_duration: new BN(2_318_400),
    deployment_settle_grace_duration: new BN(0),
    strike_trigger_modulus: 1097,
    buybacks_fee_bps: 108,
    token_mint: MINTS.token,
    reserved: new Array<number>(reservedLen("SatrushConfig")).fill(0),
    ...over,
  };
}

export function makeBoard(over: Partial<Board> = {}): Board {
  return {
    version: 2,
    bump: 255,
    round_id: 100,
    round_duration: 230,
    start_slot: new BN(1_000),
    end_slot: new BN(1_230),
    strike_pending_usd_amount: new BN(0),
    strike_usd_amount: new BN(3_000_000_000),
    strike_btc_amount: new BN(1_000_000),
    strike_last_trigger_round_id: 50,
    strike_reserve_usd_amount: new BN(200_000_000),
    strike_reserve_btc_amount: new BN(0),
    rotor_arm_counter: new BN(0),
    strike_token_amount: new BN(0),
    strike_reserve_token_amount: new BN(0),
    reserved: new Array<number>(reservedLen("Board")).fill(0),
    ...over,
  };
}

export function makeRound(id: number, stakes: number[], over: Partial<Round> = {}): Round {
  return {
    version: 1, bump: 255, id, state: { Active: {} },
    blockhash_entropy: new Array<number>(32).fill(0), winning_tile: null,
    deployed_pending_usd_amount: new BN(0), deployed_usd_amount: new BN(stakes.reduce((a, b) => a + b, 0)),
    deployed_btc_amount: new BN(0), deployed_usd_on_winning_tile_amount: new BN(0),
    miners_count: 0, revealed_miners_count: 0, winners_count: 0, settled_miners_count: 0,
    strike_bonus_usd: new BN(0), strike_bonus_btc: new BN(0),
    public_tile_stakes: stakes.map((s) => ({ stake: new BN(s), deploy_count: s > 0 ? 1 : 0 })),
    minted_token_amount: new BN(0), strike_bonus_token: new BN(0),
    reserved_entropy: new Array<number>(16).fill(0), settled_at_slot: new BN(0),
    pending_epoch_fee_usd_amount: new BN(0), pending_one_btc_fee_usd_amount: new BN(0),
    pending_protocol_fee_usd_amount: new BN(0), is_hashrate_boosted: false,
    pending_affiliate_fee_usd_amount: new BN(0), pending_buybacks_fee_usd_amount: new BN(0),
    deployed_gross_usd_amount: new BN(0), reserved: new Array<number>(15).fill(0),
    ...over,
  };
}

export function makeSatsVault(): SatsVault {
  return { version: 2, bump: 255, btc_amount: new BN(50_000_000), btc_shares: new BN(50_000_000), leftovers: new BN(0), reserved: new Array<number>(reservedLen("SatsVault")).fill(0) };
}
export function makeTokenVault(): TokenVault {
  return { version: 2, bump: 255, token_amount: new BN(1_000_000_000_000), token_shares: new BN(1_000_000_000_000), leftovers: new BN(0), reserved: new Array<number>(reservedLen("TokenVault")).fill(0) };
}

/** Two empty tiles, the rest at $10 each: the chase board every selector test uses. */
export function chaseStakes(): number[] {
  const s = new Array<number>(TILES_COUNT).fill(10_000_000);
  s[0] = 0;
  s[1] = 0;
  return s;
}

export const encode = {
  config: (c: SatrushConfig) => accountsCoder.encode("SatrushConfig", c),
  board: (b: Board) => accountsCoder.encode("Board", b),
  round: (r: Round) => accountsCoder.encode("Round", r),
  satsVault: (v: SatsVault) => accountsCoder.encode("SatsVault", v),
  tokenVault: (v: TokenVault) => accountsCoder.encode("TokenVault", v),
};

export type { PublicKey };
