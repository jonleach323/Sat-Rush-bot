/**
 * Live USD price feed, read from Pyth over the RPC we already hold. Replaces
 * the hardcoded BTC/SOL estimates, which silently scaled every BTC-denominated
 * figure in the bot — vault pool values, unclaimed-position value, the hashrate
 * price derived from them — and sized Jito tips.
 *
 * Pyth rather than an HTTP API because it needs no key, no extra network
 * dependency, and no rate limit: it is an account read on the same connection
 * as everything else, and it is the same data the on-chain ecosystem prices
 * against.
 *
 * Specifically the *Pyth Solana Receiver* push accounts (`PriceUpdateV2`), not
 * the legacy v2 oracle accounts — those still exist on mainnet but are frozen
 * at status 0 (not trading) since Pyth moved to the pull model, so reading them
 * yields a permanently rejected quote.
 *
 * Every read is validated before it is trusted: account owner, Anchor
 * discriminator, the embedded feed ID, publish staleness, confidence width, and
 * absolute sanity bounds. The feed-ID check is what makes a misconfigured
 * account address safe — a BTC price can never be read out of a SOL account.
 * Anything that fails keeps the last good value (or the cold-start fallback)
 * and warns. A wrong price is worse than a stale one here: it feeds tip sizing
 * and, via the vault, the hashrate credit that Kelly sizes against.
 */
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { createHash } from "node:crypto";

/** Pyth Solana Receiver program — the only valid owner of a price update. */
export const PYTH_RECEIVER_PROGRAM_ID = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";

/** Anchor account discriminator, derived rather than transcribed. */
const PRICE_UPDATE_V2_DISCRIMINATOR = createHash("sha256")
  .update("account:PriceUpdateV2")
  .digest()
  .subarray(0, 8);

/**
 * Canonical Pyth feed IDs. These identify the *feed*, independent of which
 * account it was posted to, and are embedded in the account itself — so they
 * are the check that the configured address really is the symbol we think.
 */
export const PYTH_FEED_IDS = {
  btc: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  sol: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
} as const;

export type Symbol_ = keyof typeof PYTH_FEED_IDS;

/** VerificationLevel is an Anchor enum: 0 = Partial(u8), 1 = Full (no payload). */
const VERIFICATION_PARTIAL = 0;
const VERIFICATION_FULL = 1;

export interface PythPrice {
  /** Hex feed ID embedded in the update. */
  feedId: string;
  price: number;
  /** Confidence interval, same units as `price`. */
  confidence: number;
  /** Unix seconds the price was published. */
  publishTime: number;
  /** Solana slot the update was posted in — the staleness clock. */
  postedSlot: number;
  /** True only for fully-verified (all-signature) Wormhole attestations. */
  fullyVerified: boolean;
}

/**
 * Decode a Pyth Solana Receiver `PriceUpdateV2` account. Returns null when the
 * buffer isn't one (bad discriminator / short / unknown verification variant)
 * rather than throwing — a decode failure must degrade to the fallback, never
 * take the bot down.
 */
export function decodePriceUpdateV2(data: Buffer): PythPrice | null {
  // 8 discriminator + 32 write_authority + verification_level + message + slot.
  if (data.length < 133) return null;
  if (!data.subarray(0, 8).equals(PRICE_UPDATE_V2_DISCRIMINATOR)) return null;

  const level = data.readUInt8(40);
  // Full carries no payload byte; Partial carries num_signatures.
  const msg = level === VERIFICATION_FULL ? 41 : level === VERIFICATION_PARTIAL ? 42 : -1;
  if (msg < 0 || data.length < msg + 92) return null;

  const exponent = data.readInt32LE(msg + 48);
  const scale = Math.pow(10, exponent);
  return {
    feedId: data.subarray(msg, msg + 32).toString("hex"),
    price: Number(data.readBigInt64LE(msg + 32)) * scale,
    confidence: Number(data.readBigUInt64LE(msg + 40)) * scale,
    publishTime: Number(data.readBigInt64LE(msg + 52)),
    postedSlot: Number(data.readBigUInt64LE(msg + 84)),
    fullyVerified: level === VERIFICATION_FULL,
  };
}

export interface PriceBounds {
  /** Reject quotes outside [min, max] — catches decode/layout errors. */
  min: number;
  max: number;
}

/**
 * Wide sanity rails. These exist to catch a layout or unit error, not to
 * second-guess the market, so they are set far outside any plausible price.
 */
const BOUNDS: Record<Symbol_, PriceBounds> = {
  btc: { min: 1_000, max: 10_000_000 },
  sol: { min: 1, max: 100_000 },
};

export interface QuoteGate {
  headSlot: number;
  maxStaleSlots: number;
  maxConfidenceRatio: number;
  bounds: PriceBounds;
  /** Hex feed ID this account is required to carry. */
  expectedFeedId: string;
  /** Owner reported by the RPC; must be the receiver program. */
  owner?: string | undefined;
}

/**
 * Validate a decoded quote. Exported for testing: this is the gate that decides
 * whether real money is priced off the oracle or off the fallback.
 */
export function acceptQuote(
  q: PythPrice | null,
  gate: QuoteGate,
): { ok: true; price: number } | { ok: false; reason: string } {
  if (!q) return { ok: false, reason: "undecodable" };
  if (gate.owner !== undefined && gate.owner !== PYTH_RECEIVER_PROGRAM_ID) {
    return { ok: false, reason: "wrong_owner" };
  }
  if (q.feedId !== gate.expectedFeedId) return { ok: false, reason: "feed_id_mismatch" };
  if (!q.fullyVerified) return { ok: false, reason: "partially_verified" };
  if (!Number.isFinite(q.price) || q.price <= 0) return { ok: false, reason: "non_positive" };
  if (q.price < gate.bounds.min || q.price > gate.bounds.max) {
    return { ok: false, reason: "out_of_bounds" };
  }
  const age = gate.headSlot - q.postedSlot;
  if (age > gate.maxStaleSlots) return { ok: false, reason: `stale_${age}_slots` };
  if (q.confidence / q.price > gate.maxConfidenceRatio) {
    return { ok: false, reason: "confidence_too_wide" };
  }
  return { ok: true, price: q.price };
}

export interface PriceFeedOptions {
  connection: Connection;
  /** Receiver price account per symbol; omit a symbol to pin it to its fallback. */
  accounts: { btc?: PublicKey | undefined; sol?: PublicKey | undefined };
  /** Cold-start seed, and the value used if the very first read fails. */
  fallback: { btc: number; sol: number };
  /** Max slots between the update's posted slot and chain head. */
  maxStaleSlots?: number | undefined;
  /** Reject when confidence/price exceeds this (wide market = untrustworthy). */
  maxConfidenceRatio?: number | undefined;
  pollMs?: number | undefined;
  log?: ((obj: Record<string, unknown>, msg: string) => void) | undefined;
}

/** `live` distinguishes an oracle quote from the fallback / last-good value. */
export interface PriceStatus {
  btc: { usd: number; live: boolean };
  sol: { usd: number; live: boolean };
}

export class PriceFeed {
  private px: Record<Symbol_, number>;
  private live: Record<Symbol_, boolean> = { btc: false, sol: false };
  private timer: NodeJS.Timeout | null = null;
  private lastWarn = "";

  constructor(private readonly opts: PriceFeedOptions) {
    this.px = { btc: opts.fallback.btc, sol: opts.fallback.sol };
  }

  /** BTC/USD — the oracle quote when healthy, else the last good value. */
  btcUsd(): number {
    return this.px.btc;
  }
  solUsd(): number {
    return this.px.sol;
  }
  status(): PriceStatus {
    return {
      btc: { usd: this.px.btc, live: this.live.btc },
      sol: { usd: this.px.sol, live: this.live.sol },
    };
  }

  async refresh(): Promise<void> {
    const order: Symbol_[] = [];
    const keys: PublicKey[] = [];
    for (const sym of ["btc", "sol"] as const) {
      const key = this.opts.accounts[sym];
      if (key) {
        order.push(sym);
        keys.push(key);
      }
    }
    if (keys.length === 0) return;

    let headSlot: number;
    let infos: (AccountInfo<Buffer> | null)[];
    try {
      [headSlot, infos] = await Promise.all([
        this.opts.connection.getSlot("processed"),
        this.opts.connection.getMultipleAccountsInfo(keys, "processed"),
      ]);
    } catch (err) {
      // Keep the last good values — a flaky RPC must not reprice the book.
      this.warn({ err: String(err) }, "price feed read failed — holding last prices");
      return;
    }

    order.forEach((sym, i) => {
      const info = infos[i];
      const res = acceptQuote(info ? decodePriceUpdateV2(info.data) : null, {
        headSlot,
        maxStaleSlots: this.opts.maxStaleSlots ?? 150,
        maxConfidenceRatio: this.opts.maxConfidenceRatio ?? 0.02,
        bounds: BOUNDS[sym],
        expectedFeedId: PYTH_FEED_IDS[sym],
        owner: info?.owner.toBase58(),
      });
      if (res.ok) {
        this.px[sym] = res.price;
        this.live[sym] = true;
        return;
      }
      // Rejected: hold the last accepted price rather than snapping to the
      // fallback, but stop claiming it is live.
      this.live[sym] = false;
      this.warn(
        { symbol: sym, reason: res.reason, holding: this.px[sym] },
        "price quote rejected — holding last price",
      );
    });
  }

  /** Prime once, then poll. Returns after the first refresh so callers start warm. */
  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.opts.pollMs ?? 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** De-duplicated warning — a persistently bad feed shouldn't flood the log. */
  private warn(obj: Record<string, unknown>, msg: string): void {
    const key = msg + JSON.stringify(obj);
    if (key === this.lastWarn) return;
    this.lastWarn = key;
    this.opts.log?.(obj, msg);
  }
}
