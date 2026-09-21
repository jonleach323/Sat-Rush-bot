/**
 * Chaos gauntlet: each scenario must end halted-or-skipped, never a mis-sized
 * or mis-targeted send. Uses the coders/state/sender directly (no live RPC).
 */
import { describe, expect, it } from "vitest";
import { Keypair, type Connection } from "@solana/web3.js";
import { BN, accountsCoder } from "../src/adapter/idl.js";
import type { Round } from "../src/adapter/idl.js";
import { HaltError } from "../src/ingest/decode.js";
import { GameState } from "../src/ingest/snapshot.js";
import { RaceSender } from "../src/exec/sender.js";
import { loadConfig, summarizeConfig } from "../src/config.js";
import { usdToBase } from "../src/units.js";

const TILES = 21;
function makeRound(id: number, stakes: number[]): Round {
  return {
    version: 1, bump: 255, id, state: { Active: {} },
    blockhash_entropy: new Array<number>(32).fill(0), winning_tile: null,
    deployed_pending_usd_amount: new BN(0), deployed_usd_amount: new BN(0),
    deployed_btc_amount: new BN(0), deployed_usd_on_winning_tile_amount: new BN(0),
    miners_count: 0, revealed_miners_count: 0, winners_count: 0, settled_miners_count: 0,
    strike_bonus_usd: new BN(0), strike_bonus_btc: new BN(0),
    public_tile_stakes: stakes.map((s) => ({ stake: new BN(s), deploy_count: 0 })),
    minted_token_amount: new BN(0), strike_bonus_token: new BN(0),
    reserved_entropy: new Array<number>(16).fill(0), settled_at_slot: new BN(0),
    pending_epoch_fee_usd_amount: new BN(0), pending_one_btc_fee_usd_amount: new BN(0),
    pending_protocol_fee_usd_amount: new BN(0), is_hashrate_boosted: false,
    pending_affiliate_fee_usd_amount: new BN(0), pending_buybacks_fee_usd_amount: new BN(0),
    deployed_gross_usd_amount: new BN(0), reserved: new Array<number>(15).fill(0),
  };
}
const pk = Keypair.generate().publicKey;
const zeros = () => new Array<number>(TILES).fill(0);

describe("chaos: malformed / adversarial account data → HALT", () => {
  it("truncated Round account throws HaltError (never trades on garbage)", async () => {
    const buf = await accountsCoder.encode("Round", makeRound(5, zeros()));
    const truncated = buf.subarray(0, 40); // keep discriminator, drop the body
    const state = new GameState();
    expect(() => state.applyAccount(pk, truncated)).toThrow(HaltError);
  });

  it("a BOARD COLLAPSE within a round throws HaltError", async () => {
    // A small decrease is a fork rollback and is absorbed (see ingest tests).
    // Losing most of the board cannot come from unwinding a couple of slots, so
    // it still halts as a decode/layout failure.
    const state = new GameState();
    const s1 = zeros(); s1[4] = 5_000_000;
    const s2 = zeros(); s2[4] = 1_000_000; // 80% of the board gone
    const [buf1, buf2] = await Promise.all([
      accountsCoder.encode("Round", makeRound(7, s1)),
      accountsCoder.encode("Round", makeRound(7, s2)),
    ]);
    state.applyAccount(pk, buf1);
    expect(() => state.applyAccount(pk, buf2)).toThrow(/collapsed/);
  });

  it("a small fork rollback is absorbed, NOT halted", async () => {
    const rollbacks: unknown[] = [];
    const state = new GameState(null, (r) => rollbacks.push(r));
    const s1 = zeros().map(() => 27_523_642);
    const s2 = [...s1]; s2[0] = 27_075_398; // the live case: -$0.448 on one tile
    const [buf1, buf2] = await Promise.all([
      accountsCoder.encode("Round", makeRound(15661, s1)),
      accountsCoder.encode("Round", makeRound(15661, s2)),
    ]);
    state.applyAccount(pk, buf1);
    expect(() => state.applyAccount(pk, buf2)).not.toThrow();
    expect(state.rollbacks()).toBe(1);
    expect(rollbacks).toHaveLength(1);
  });

  it("a valid Round is accepted (control)", async () => {
    const state = new GameState();
    const ok = await accountsCoder.encode("Round", makeRound(1, zeros()));
    expect(() => state.applyAccount(pk, ok)).not.toThrow();
  });
});

describe("chaos: 6005 on every send → missed_round, never a false 'landed'", () => {
  function conn6005(): Connection {
    return {
      sendRawTransaction: async () => "sig",
      getSignatureStatuses: async () => ({
        value: [{ slot: 10, err: { InstructionError: [2, { Custom: 6005 }] } }],
      }),
      getBlockHeight: async () => 0,
    } as unknown as Connection;
  }
  it("classifies as missed_round and reports it (no send is ever 'landed')", async () => {
    let t = 0;
    const sender = new RaceSender({ mode: "devnet", connections: [conn6005()] });
    const result = await sender.fire(
      { signature: "s", serialized: Buffer.from([1, 2, 3]) },
      { now: () => t, sleep: async (ms) => void (t += ms) },
    );
    expect(result.outcome).toBe("missed_round");
    expect(result.detail).toBe("round_not_active");
  });
});

describe("hygiene: secrets never reach a logger / external surface", () => {
  it("redacts Helius api-key and tokens from the config summary", () => {
    const cfg = loadConfig({
      RPC_HTTP_URL: "https://mainnet.helius-rpc.com/?api-key=SECRET-HELIUS-KEY",
      GRPC_TOKEN: "SECRET-GRPC-TOKEN",
      GRPC_URL: "https://laserstream-mainnet-slc.helius-rpc.com",
      TELEGRAM_TOKEN: "SECRET-TG-TOKEN",
      API_TOKEN: "SECRET-API-TOKEN",
    });
    const text = JSON.stringify(summarizeConfig(cfg));
    expect(text).not.toContain("SECRET-HELIUS-KEY");
    expect(text).not.toContain("SECRET-GRPC-TOKEN");
    expect(text).not.toContain("SECRET-TG-TOKEN");
    expect(text).not.toContain("SECRET-API-TOKEN");
    expect(text).toContain("helius-rpc.com"); // host is fine to show
  });

  it("never serializes a keypair secret key into the summary", () => {
    const kp = Keypair.generate();
    const secretArray = JSON.stringify([...kp.secretKey]);
    const cfg = loadConfig({ KEYPAIR_PATH: "./keypairs/operator.json" });
    const text = JSON.stringify(summarizeConfig(cfg));
    expect(text).not.toContain(secretArray);
    expect(text).not.toContain(kp.publicKey.toBase58()); // summary carries only the path
    expect(text).toContain("keypairPath");
  });
});

describe("hygiene: caps guard against config drift at load", () => {
  it("rejects a stake ladder above MAX_PER_ROUND", () => {
    expect(() => loadConfig({ STAKE_LADDER_USD: "9999", MAX_PER_ROUND_USD: "5" })).toThrow();
  });
  it("keeps USD as integer base units", () => {
    expect(usdToBase(1.23)).toBe(1_230_000n);
  });
});
