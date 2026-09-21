import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { createHash } from "node:crypto";
import {
  PYTH_FEED_IDS,
  PYTH_RECEIVER_PROGRAM_ID,
  PriceFeed,
  acceptQuote,
  decodePriceUpdateV2,
} from "../src/ingest/prices.js";

const DISC = createHash("sha256").update("account:PriceUpdateV2").digest().subarray(0, 8);
const RECEIVER = new PublicKey(PYTH_RECEIVER_PROGRAM_ID);

/**
 * Build a synthetic PriceUpdateV2 account. Layout mirrors the on-chain accounts
 * probed on mainnet: 8 disc | 32 write_authority | verification_level | message.
 */
function priceUpdate(opts: {
  feedId: string;
  price: bigint;
  conf: bigint;
  expo: number;
  postedSlot: bigint;
  publishTime?: bigint;
  level?: number;
  disc?: Buffer;
}): Buffer {
  const level = opts.level ?? 1;
  const msg = level === 1 ? 41 : 42;
  const b = Buffer.alloc(msg + 93);
  (opts.disc ?? DISC).copy(b, 0);
  b.writeUInt8(level, 40);
  Buffer.from(opts.feedId, "hex").copy(b, msg);
  b.writeBigInt64LE(opts.price, msg + 32);
  b.writeBigUInt64LE(opts.conf, msg + 40);
  b.writeInt32LE(opts.expo, msg + 48);
  b.writeBigInt64LE(opts.publishTime ?? 1_786_506_155n, msg + 52);
  b.writeBigUInt64LE(opts.postedSlot, msg + 84);
  return b;
}

const BTC = {
  feedId: PYTH_FEED_IDS.btc,
  price: 6_376_995_800n, // 63_769.958 at expo -5
  conf: 1_992_800n, // ~$19.93
  expo: -5,
  postedSlot: 1000n,
};
const SOL = {
  feedId: PYTH_FEED_IDS.sol,
  price: 7_637_650_000n, // 76.3765 at expo -8
  conf: 4_214_528n,
  expo: -8,
  postedSlot: 1000n,
};

const GATE = {
  headSlot: 1010,
  maxStaleSlots: 150,
  maxConfidenceRatio: 0.02,
  bounds: { min: 1_000, max: 10_000_000 },
  expectedFeedId: PYTH_FEED_IDS.btc,
  owner: PYTH_RECEIVER_PROGRAM_ID,
};

describe("decodePriceUpdateV2", () => {
  it("applies the exponent to price and confidence", () => {
    const q = decodePriceUpdateV2(priceUpdate(BTC));
    expect(q).not.toBeNull();
    expect(q!.feedId).toBe(PYTH_FEED_IDS.btc);
    expect(q!.price).toBeCloseTo(63_769.958, 3);
    expect(q!.confidence).toBeCloseTo(19.928, 3);
    expect(q!.postedSlot).toBe(1000);
    expect(q!.fullyVerified).toBe(true);
  });

  it("handles the Partial verification variant's extra payload byte", () => {
    // Partial shifts the message by one byte; misreading it would garble price.
    const q = decodePriceUpdateV2(priceUpdate({ ...BTC, level: 0 }));
    expect(q).not.toBeNull();
    expect(q!.feedId).toBe(PYTH_FEED_IDS.btc);
    expect(q!.price).toBeCloseTo(63_769.958, 3);
    expect(q!.fullyVerified).toBe(false);
  });

  it("returns null (never throws) on a bad discriminator, short buffer, or unknown variant", () => {
    expect(decodePriceUpdateV2(priceUpdate({ ...BTC, disc: Buffer.alloc(8, 7) }))).toBeNull();
    expect(decodePriceUpdateV2(Buffer.alloc(64))).toBeNull();
    const legacyish = Buffer.alloc(3312);
    legacyish.writeUInt32LE(0xa1b2c3d4, 0);
    expect(decodePriceUpdateV2(legacyish)).toBeNull(); // frozen legacy v2 account
    expect(decodePriceUpdateV2(priceUpdate({ ...BTC, level: 9 }))).toBeNull();
  });
});

describe("acceptQuote", () => {
  const gate = (data: Buffer, over: Partial<typeof GATE> = {}) =>
    acceptQuote(decodePriceUpdateV2(data), { ...GATE, ...over });

  it("accepts a healthy, fresh, fully-verified quote", () => {
    const res = gate(priceUpdate(BTC));
    expect(res.ok).toBe(true);
    expect(res.ok && res.price).toBeCloseTo(63_769.958, 3);
  });

  it("rejects an account owned by anything but the receiver program", () => {
    expect(gate(priceUpdate(BTC), { owner: Keypair.generate().publicKey.toBase58() })).toEqual({
      ok: false,
      reason: "wrong_owner",
    });
  });

  it("rejects a different feed — a misconfigured address cannot misprice", () => {
    // A SOL update read through the BTC gate: caught by feed ID, not by bounds.
    expect(gate(priceUpdate(SOL))).toEqual({ ok: false, reason: "feed_id_mismatch" });
  });

  it("rejects a partially-verified update", () => {
    expect(gate(priceUpdate({ ...BTC, level: 0 }))).toEqual({
      ok: false,
      reason: "partially_verified",
    });
  });

  it("rejects a stale posted slot but hands the verified price back for holding", () => {
    const res = gate(priceUpdate(BTC), { headSlot: 1000 + 151 });
    expect(res).toMatchObject({ ok: false, reason: "stale_151_slots" });
    expect((res as { price?: number }).price).toBeCloseTo(63_769.958, 3);
  });

  it("rejects a quote whose confidence band is too wide", () => {
    // conf = 5% of price, above the 2% ceiling.
    expect(gate(priceUpdate({ ...BTC, conf: 318_849_790n }))).toEqual({
      ok: false,
      reason: "confidence_too_wide",
    });
  });

  it("rejects out-of-bounds and non-positive prices — the layout tripwire", () => {
    expect(gate(priceUpdate({ ...BTC, price: 100n }))).toEqual({
      ok: false,
      reason: "out_of_bounds",
    });
    expect(gate(priceUpdate({ ...BTC, price: -100n }))).toEqual({
      ok: false,
      reason: "non_positive",
    });
  });

  it("rejects a missing account", () => {
    expect(acceptQuote(null, GATE)).toEqual({ ok: false, reason: "undecodable" });
  });
});

function accountInfo(data: Buffer, owner = RECEIVER): AccountInfo<Buffer> {
  return { data, owner, lamports: 1, executable: false, rentEpoch: 0 };
}

function makeFeed(opts: {
  infos: (AccountInfo<Buffer> | null)[];
  slot?: number;
  sol?: boolean;
  log?: (o: Record<string, unknown>, m: string) => void;
  throws?: () => boolean;
}) {
  const connection = {
    getSlot: async () => {
      if (opts.throws?.()) throw new Error("rpc down");
      return opts.slot ?? 1010;
    },
    getMultipleAccountsInfo: async () => opts.infos,
  } as unknown as Connection;
  return new PriceFeed({
    connection,
    accounts: {
      btc: Keypair.generate().publicKey,
      ...(opts.sol === false ? {} : { sol: Keypair.generate().publicKey }),
    },
    fallback: { btc: 65_000, sol: 75 },
    ...(opts.log ? { log: opts.log } : {}),
  });
}

describe("PriceFeed", () => {
  it("starts on the cold-start seed and adopts live quotes on refresh", async () => {
    const f = makeFeed({
      infos: [accountInfo(priceUpdate(BTC)), accountInfo(priceUpdate(SOL))],
    });
    expect(f.btcUsd()).toBe(65_000);
    expect(f.status().btc.live).toBe(false);

    await f.refresh();
    expect(f.btcUsd()).toBeCloseTo(63_769.958, 3);
    expect(f.solUsd()).toBeCloseTo(76.3765, 4);
    expect(f.status()).toEqual({
      btc: { usd: f.btcUsd(), live: true },
      sol: { usd: f.solUsd(), live: true },
    });
  });

  it("marks a rejected symbol not-live without disturbing its sibling, and warns once", async () => {
    const warnings: string[] = [];
    const f = makeFeed({
      infos: [accountInfo(priceUpdate({ ...BTC, level: 0 })), accountInfo(priceUpdate(SOL))],
      log: (_o, m) => warnings.push(m),
    });

    await f.refresh();
    expect(f.status().btc.live).toBe(false);
    expect(f.btcUsd()).toBe(65_000); // nothing better has been seen
    expect(f.solUsd()).toBeCloseTo(76.3765, 4);
    expect(f.status().sol.live).toBe(true);

    await f.refresh();
    expect(warnings.length).toBe(1); // de-duplicated, not one per poll
  });

  it("holds the last good price when a later quote is rejected", async () => {
    let stale = false;
    const connection = {
      getSlot: async () => (stale ? 100_000 : 1010),
      getMultipleAccountsInfo: async () => [accountInfo(priceUpdate(BTC))],
    } as unknown as Connection;
    const f = new PriceFeed({
      connection,
      accounts: { btc: Keypair.generate().publicKey },
      fallback: { btc: 65_000, sol: 75 },
    });
    await f.refresh();
    const good = f.btcUsd();
    expect(good).toBeCloseTo(63_769.958, 3);

    stale = true; // same account, now far behind head
    await f.refresh();
    expect(f.btcUsd()).toBe(good); // held, not snapped back to 65_000
    expect(f.status().btc.live).toBe(false);
  });

  it("cold start on a stale-but-verified quote holds THAT quote, not the .env seed", async () => {
    // 2026-09-21 boot: the sponsored feed was 173 slots old at the first poll
    // and the bot priced BTC at the $65,000 seed for as long as it stayed so.
    const connection = {
      getSlot: async () => 1000 + 173,
      getMultipleAccountsInfo: async () => [accountInfo(priceUpdate(BTC))],
    } as unknown as Connection;
    const f = new PriceFeed({
      connection,
      accounts: { btc: Keypair.generate().publicKey },
      fallback: { btc: 65_000, sol: 75 },
      maxStaleSlots: 150,
    });
    await f.refresh();
    expect(f.btcUsd()).toBeCloseTo(63_769.958, 3); // the quote, flagged not live
    expect(f.status().btc.live).toBe(false);
  });

  it("keeps the last good price when the RPC read throws", async () => {
    let fail = false;
    const f = makeFeed({
      infos: [accountInfo(priceUpdate(BTC)), null],
      throws: () => fail,
    });
    await f.refresh();
    const live = f.btcUsd();
    expect(live).toBeCloseTo(63_769.958, 3);

    fail = true;
    await f.refresh();
    expect(f.btcUsd()).toBe(live);
  });

  it("pins a symbol to its fallback when no account is configured", async () => {
    const f = makeFeed({ infos: [accountInfo(priceUpdate(BTC))], sol: false });
    await f.refresh();
    expect(f.btcUsd()).toBeCloseTo(63_769.958, 3);
    expect(f.solUsd()).toBe(75);
    expect(f.status().sol.live).toBe(false);
  });
});
