/**
 * Encode each hashrate-vault account with the IDL coder, decode it back through
 * decodeAccount, and assert the TS interfaces match the on-chain layout (field
 * fidelity, BN round-trips, enum variants, fixed-array lengths).
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  ACCOUNT_DISCRIMINATORS,
  accountsCoder,
  decodeAccount,
  type EpochVault,
  type EpochVaultEntry,
  type EpochVaultIteration,
  type EpochVaultPage,
  type OneBtcVault,
  type OneBtcVaultEntry,
  type OneBtcVaultIteration,
} from "../src/adapter/idl.js";

const pk = () => Keypair.generate().publicKey;
const bytes32 = () => new Array<number>(32).fill(0);

/**
 * Decode a zero-valued body with the correct discriminator. Used for accounts
 * larger than BorshAccountsCoder.encode's fixed 1000-byte scratch buffer: these
 * layouts are fully fixed-size (no vecs/strings), so a zero body is a valid
 * encoding and Borsh reads the layout from the front, ignoring trailing padding.
 * A wrong interface (mismatched field count/sizes) would over/under-run.
 */
function decodeZeroed<T>(name: string): T {
  const disc = Buffer.from(ACCOUNT_DISCRIMINATORS[name]!);
  return decodeAccount<T>(name, Buffer.concat([disc, Buffer.alloc(4096)]));
}

describe("1-BTC vault accounts round-trip", () => {
  it("OneBtcVault", async () => {
    const v: OneBtcVault = {
      version: 1,
      bump: 254,
      iteration_id: 9,
      pending_usd_amount: new BN(1_234_567),
      btc_amount: new BN(87_654_321),
      reserved_btc_amount: new BN(100_000_000),
      last_trigger_slot: new BN(436_000_000),
      reserved: bytes32(),
    };
    const buf = await accountsCoder.encode("OneBtcVault", v);
    const d = decodeAccount<OneBtcVault>("OneBtcVault", buf);
    expect(d.iteration_id).toBe(9);
    expect(d.btc_amount.toString()).toBe("87654321");
    expect(d.last_trigger_slot.toString()).toBe("436000000");
  });

  it("OneBtcVaultIteration (winner-take-all: single winning_ticket)", async () => {
    const it: OneBtcVaultIteration = {
      version: 1,
      bump: 253,
      iteration_id: 9,
      state: { Open: {} },
      total_tickets: new BN(5000),
      entropy: bytes32(),
      winning_ticket: new BN(0),
      prize_btc: new BN(100_000_000),
      reserved: bytes32(),
    };
    const buf = await accountsCoder.encode("OneBtcVaultIteration", it);
    const d = decodeAccount<OneBtcVaultIteration>("OneBtcVaultIteration", buf);
    expect(d.total_tickets.toString()).toBe("5000");
    expect(d.prize_btc.toString()).toBe("100000000");
    expect(Object.keys(d.state)[0]).toBe("Open");
  });

  it("OneBtcVaultEntry (contiguous ticket range)", async () => {
    const e: OneBtcVaultEntry = {
      version: 1,
      iteration_id: 9,
      authority: pk(),
      start_ticket_id: new BN(4975),
      tickets_count: new BN(25),
      reserved: bytes32(),
    };
    const buf = await accountsCoder.encode("OneBtcVaultEntry", e);
    const d = decodeAccount<OneBtcVaultEntry>("OneBtcVaultEntry", buf);
    expect(d.start_ticket_id.toString()).toBe("4975");
    expect(d.tickets_count.toString()).toBe("25");
    expect(d.authority.toBase58()).toBe(e.authority.toBase58());
  });
});

describe("epoch vault accounts round-trip", () => {
  it("EpochVault", async () => {
    const v: EpochVault = {
      version: 1,
      bump: 252,
      iteration_id: 3,
      last_trigger_slot: new BN(435_000_000),
      pending_usd_amount: new BN(50_000),
      pool_usd_amount: new BN(2_000_000),
      pool_btc_amount: new BN(1_500_000),
      reserved_usd_amount: new BN(0),
      reserved_btc_amount: new BN(0),
      reserved: bytes32(),
    };
    const buf = await accountsCoder.encode("EpochVault", v);
    const d = decodeAccount<EpochVault>("EpochVault", buf);
    expect(d.iteration_id).toBe(3);
    expect(d.pool_usd_amount.toString()).toBe("2000000");
    expect(d.pool_btc_amount.toString()).toBe("1500000");
  });

  it("EpochVaultIteration (up to 21 winners) — layout decodes", () => {
    // Larger than encode()'s 1000-byte scratch buffer; validate via zero-body decode.
    const d = decodeZeroed<EpochVaultIteration>("EpochVaultIteration");
    expect(d.winners).toHaveLength(21);
    expect(d.total_tickets.toString()).toBe("0");
    expect(d.participants_count).toBe(0);
    expect(Object.keys(d.state)[0]).toBe("Open"); // discriminant 0 → first variant
    expect(d.winners[0]).toMatchObject({ page_index: 0, claimed: false });
  });

  it("EpochVaultEntry", async () => {
    const e: EpochVaultEntry = {
      version: 1,
      bump: 250,
      iteration_id: 3,
      authority: pk(),
      page_index: 1,
      tickets: new BN(300),
      reserved: bytes32(),
    };
    const buf = await accountsCoder.encode("EpochVaultEntry", e);
    const d = decodeAccount<EpochVaultEntry>("EpochVaultEntry", buf);
    expect(d.tickets.toString()).toBe("300");
    expect(d.page_index).toBe(1);
  });

  it("EpochVaultPage (32-entry page) — layout decodes", () => {
    const d = decodeZeroed<EpochVaultPage>("EpochVaultPage");
    expect(d.entries).toHaveLength(32);
    expect(d.sealed).toBe(false);
    expect(d.total_tickets.toString()).toBe("0");
  });
});
