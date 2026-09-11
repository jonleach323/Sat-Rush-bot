import { describe, expect, it } from "vitest";
import { parseBoardPayload, TokenFeed } from "../src/ingest/token-feed.js";

// Shape of GET /v1/board as served on 2026-09-11 (amounts in base units:
// USD 6 decimals, RUSH 9 decimals).
const payload = {
  data: {
    round_id: 55511,
    prices: { btc: 76815.37, sat: 1.52e-6, token: 51.107912, token_share: 6.24e-11 },
    previous_round: { id: 55510, total_gross_deployed_usd: "597293451", minted_token_amount: "175264181" },
    previous_rounds: [
      { id: 55510, total_gross_deployed_usd: "597293451", minted_token_amount: "175264181" }, // duplicate
      { id: 55509, total_gross_deployed_usd: "595293451", minted_token_amount: "174000000" },
      { id: 55508, total_gross_deployed_usd: "0", minted_token_amount: "0" }, // idle: skipped
    ],
  },
};

describe("parseBoardPayload", () => {
  it("reads the oracle price and a gross-weighted mint rate, deduping rounds", () => {
    const p = parseBoardPayload(payload);
    expect(p.tokenUsd).toBeCloseTo(51.107912, 6);
    expect(p.samples.map((s) => s.roundId)).toEqual([55510, 55509]);
    const gross = 597.293451 + 595.293451;
    const minted = 0.175264181 + 0.174;
    expect(p.mintRushPerUsd).toBeCloseTo(minted / gross, 12);
    // ≈ 0.293 RUSH per $1,000, the measured order of magnitude (FINDINGS E-v2-live)
    expect((p.mintRushPerUsd ?? 0) * 1000).toBeGreaterThan(0.25);
    expect((p.mintRushPerUsd ?? 0) * 1000).toBeLessThan(0.35);
  });

  it("reports nulls, not zeros, for what it cannot read", () => {
    expect(parseBoardPayload({ data: {} })).toEqual({ tokenUsd: null, mintRushPerUsd: null, samples: [] });
    expect(parseBoardPayload(null).tokenUsd).toBeNull();
    expect(parseBoardPayload({ data: { prices: { token: -1 } } }).tokenUsd).toBeNull();
  });
});

describe("TokenFeed", () => {
  const mk = (fetchJson: () => Promise<unknown>, now: () => number, extra = {}) =>
    new TokenFeed({
      apiUrl: "https://api.example/v1",
      fallback: { tokenUsd: 0, mintRushPerUsd: 0 },
      pollMs: 0,
      maxAgeMs: 1000,
      fetchJson,
      now,
      ...extra,
    });

  it("values the token at nothing until a quote is accepted, then prices the yield", async () => {
    let t = 1_000;
    const feed = mk(async () => payload, () => t);
    expect(feed.yieldPerVolume()).toBe(0);
    expect(feed.status().live).toBe(false);
    await feed.start();
    const s = feed.status();
    expect(s.live).toBe(true);
    expect(s.mintSampleRounds).toBe(2);
    expect(s.tokenUsd).toBeCloseTo(51.107912, 6);
    // y = price × RUSH/$ ≈ 1.5% — the live figure the ledger runs on
    expect(s.yieldPerVolume).toBeGreaterThan(0.012);
    expect(s.yieldPerVolume).toBeLessThan(0.02);
    t += 1_500;
    expect(feed.status().live).toBe(false); // stale, but the value is held
    expect(feed.yieldPerVolume()).toBe(s.yieldPerVolume);
  });

  it("holds the last accepted value on read failure or an out-of-bounds quote", async () => {
    let reply: () => Promise<unknown> = async () => payload;
    const warnings: string[] = [];
    const feed = mk(() => reply(), () => 5, { log: (_o: unknown, m: string) => warnings.push(m) });
    await feed.refresh();
    const good = feed.yieldPerVolume();
    reply = async () => { throw new Error("boom"); };
    await feed.refresh();
    expect(feed.yieldPerVolume()).toBe(good);
    expect(feed.status().live).toBe(false);
    reply = async () => ({ data: { prices: { token: 1e9 }, previous_round: payload.data.previous_round } });
    await feed.refresh();
    expect(feed.tokenUsd()).toBeCloseTo(51.107912, 6);
    expect(feed.status().live).toBe(false);
    expect(warnings.length).toBe(2);
  });
});
