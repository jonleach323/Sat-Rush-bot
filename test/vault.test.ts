import { describe, expect, it } from "vitest";
import {
  btcBaseToUsd,
  buildVaultContext,
  EPOCH_PAYOUT_FRACTION,
  EPOCH_REWARD_CURVE_BPS,
  epochWinFraction,
  expectedWinningsUsd,
  selectVaultTickets,
  type VaultTicketContext,
} from "../src/strategy/vault.js";

function ctx(over: Partial<VaultTicketContext> = {}): VaultTicketContext {
  return {
    kind: "one_btc",
    poolValueUsd: 1000,
    othersTickets: 100,
    myTickets: 0,
    hashrateAvailable: 10_000,
    hashrateValueUsd: 0.01,
    maxTickets: 100_000,
    ...over,
  };
}

describe("btcBaseToUsd", () => {
  it("values cbBTC (8 decimals) at the estimate", () => {
    // 0.5 BTC at $100k = $50k
    expect(btcBaseToUsd(50_000_000, 8, 100_000)).toBeCloseTo(50_000);
  });
  it("rejects bad decimals", () => {
    expect(() => btcBaseToUsd(1, -1, 100_000)).toThrow(RangeError);
  });
});

describe("epoch reward curve", () => {
  it("has 21 ranks and sums to 9000 bps — only 90% of the pool is paid out", () => {
    expect(EPOCH_REWARD_CURVE_BPS).toHaveLength(21);
    expect(EPOCH_REWARD_CURVE_BPS.reduce((a, b) => a + b, 0)).toBe(9000);
    expect(EPOCH_PAYOUT_FRACTION).toBeCloseTo(0.9, 10);
  });

  it("passes the RAW pool through — the 90% lives in the curve sum", () => {
    const common = {
      poolValueUsd: 1000,
      totalTickets: 100,
      myTickets: 0,
      hashratePointsAvailable: 1000,
      ticketPriceHashrate: 100,
      hashrateValueUsdPerPoint: 0,
      maxTickets: 100,
    };
    // Discounting here would double-count against epochWinFraction().
    expect(buildVaultContext({ ...common, kind: "epoch" }).poolValueUsd).toBeCloseTo(1000);
    expect(buildVaultContext({ ...common, kind: "one_btc" }).poolValueUsd).toBeCloseTo(1000);
  });
});

describe("epochWinFraction — per-wallet dedup makes payoff concave", () => {
  it("matches the linear model for a tiny share", () => {
    // Small p: E ≈ p · Σw = 0.9p
    expect(epochWinFraction(0.005)).toBeCloseTo(0.9 * 0.005, 3);
  });

  it("falls increasingly short of linear as share grows", () => {
    for (const [p, expected] of [
      [0.10, 0.0659],
      [0.20, 0.1110],
      [0.30, 0.1484],
    ] as const) {
      expect(epochWinFraction(p)).toBeCloseTo(expected, 3);
      expect(epochWinFraction(p)).toBeLessThan(0.9 * p); // strictly below linear
    }
  });

  it("caps at rank-1 only when we hold every ticket (win once, not 21×)", () => {
    expect(epochWinFraction(1)).toBeCloseTo(0.32, 10);
  });

  it("is monotonic and bounded", () => {
    expect(epochWinFraction(0)).toBe(0);
    let prev = 0;
    for (let p = 0.05; p <= 1.0001; p += 0.05) {
      const v = epochWinFraction(p);
      expect(v).toBeGreaterThan(prev);
      expect(v).toBeLessThanOrEqual(EPOCH_PAYOUT_FRACTION);
      prev = v;
    }
  });

  it("1-BTC stays linear (single winner, dedup irrelevant)", () => {
    expect(expectedWinningsUsd(30, 70, 1000, "one_btc")).toBeCloseTo(300);
    // epoch on the same holding is materially lower
    expect(expectedWinningsUsd(30, 70, 1000, "epoch")).toBeLessThan(200);
  });
});

describe("buildVaultContext", () => {
  it("subtracts our sunk tickets from the on-chain total to get others'", () => {
    const c = buildVaultContext({
      kind: "epoch",
      poolValueUsd: 1000,
      totalTickets: 500,
      myTickets: 120,
      hashratePointsAvailable: 20_000,
      ticketPriceHashrate: 100,
      hashrateValueUsdPerPoint: 0.005,
      maxTickets: 1000,
    });
    expect(c.othersTickets).toBe(380);
    expect(c.myTickets).toBe(120);
  });
  it("converts hashrate points to affordable tickets at the ticket price", () => {
    const c = buildVaultContext({
      kind: "one_btc",
      poolValueUsd: 1000,
      totalTickets: 0,
      myTickets: 0,
      hashratePointsAvailable: 950, // 100/ticket → 9 affordable (floor)
      ticketPriceHashrate: 100,
      hashrateValueUsdPerPoint: 0.01,
      maxTickets: 1000,
    });
    expect(c.hashrateAvailable).toBe(9);
    // per-ticket cost = per-point value × price
    expect(c.hashrateValueUsd).toBeCloseTo(1);
  });
  it("clamps others at zero on a read race", () => {
    const c = buildVaultContext({
      kind: "one_btc",
      poolValueUsd: 1,
      totalTickets: 5,
      myTickets: 9,
      hashratePointsAvailable: 0,
      ticketPriceHashrate: 100,
      hashrateValueUsdPerPoint: 0,
      maxTickets: 1,
    });
    expect(c.othersTickets).toBe(0);
  });
  it("rejects a non-positive ticket price", () => {
    expect(() =>
      buildVaultContext({
        kind: "epoch",
        poolValueUsd: 1,
        totalTickets: 0,
        myTickets: 0,
        hashratePointsAvailable: 100,
        ticketPriceHashrate: 0,
        hashrateValueUsdPerPoint: 0,
        maxTickets: 1,
      }),
    ).toThrow(RangeError);
  });
});

describe("expectedWinningsUsd", () => {
  it("1-BTC is ticket-fraction times prize (linear — single winner)", () => {
    expect(expectedWinningsUsd(9, 1, 1000, "one_btc")).toBeCloseTo(900);
    expect(expectedWinningsUsd(1, 9, 1000, "one_btc")).toBeCloseTo(100);
  });
  it("epoch is concave — owning the field can't win 21 prizes", () => {
    // 90% share: the naive linear model claims 810; per-wallet dedup caps it far
    // lower because we can only be drawn once.
    expect(expectedWinningsUsd(9, 1, 1000, "epoch")).toBeCloseTo(301.4, 0);
    // A tiny share still tracks the linear approximation (0.9·p·pool).
    expect(expectedWinningsUsd(1, 999, 1000, "epoch")).toBeCloseTo(0.9, 1);
  });
  it("is zero when no tickets exist", () => {
    expect(expectedWinningsUsd(0, 0, 1000)).toBe(0);
  });
});

describe("selectVaultTickets", () => {
  it("sits out a crowded field where a ticket can't beat the hashrate cost", () => {
    const d = selectVaultTickets(ctx({ poolValueUsd: 10, othersTickets: 1_000_000 }));
    expect(d.tickets).toBe(0);
    expect(d.reason).toBe("field_too_crowded");
  });

  it("enters a thin field", () => {
    const d = selectVaultTickets(ctx({ poolValueUsd: 1000, othersTickets: 50 }));
    expect(d.tickets).toBeGreaterThan(0);
    expect(d.evUsd).toBeGreaterThan(0);
    expect(d.winShareAfter).toBeGreaterThan(0);
  });

  it("the edge: for the same hashrate spent, a thinner field pays more", () => {
    // Cap both to the same ticket spend; a thinner field converts it into more
    // win-share and more EV per point — the reason to save hashrate for thin draws.
    const spend = { maxTickets: 100, hashrateAvailable: 100, hashrateValueUsd: 0 };
    const thin = selectVaultTickets(ctx({ ...spend, othersTickets: 50 }));
    const crowded = selectVaultTickets(ctx({ ...spend, othersTickets: 5000 }));
    expect(thin.tickets).toBe(crowded.tickets); // same points spent
    expect(thin.winShareAfter).toBeGreaterThan(crowded.winShareAfter);
    expect(thin.evUsd).toBeGreaterThan(crowded.evUsd);
  });

  it("at a calibrated opportunity cost, a crowded field is sat out but a thin one is played", () => {
    // Set the per-point floor near the thin field's per-ticket value: the thin
    // field still clears it, the crowded field no longer does.
    const floor = { poolValueUsd: 1000, hashrateValueUsd: 2 };
    const thin = selectVaultTickets(ctx({ ...floor, othersTickets: 20 }));
    const crowded = selectVaultTickets(ctx({ ...floor, othersTickets: 20_000 }));
    expect(thin.tickets).toBeGreaterThan(0);
    expect(crowded.tickets).toBe(0);
  });

  it("only one ticket is needed to own an empty field", () => {
    // others = 0 → a single ticket already wins the whole pool; more add nothing.
    const d = selectVaultTickets(ctx({ othersTickets: 0 }));
    expect(d.tickets).toBe(1);
    expect(d.winShareAfter).toBe(1);
  });

  it("a higher hashrate opportunity cost makes it pickier", () => {
    const cheap = selectVaultTickets(ctx({ hashrateValueUsd: 0.001 }));
    const dear = selectVaultTickets(ctx({ hashrateValueUsd: 1 }));
    expect(dear.tickets).toBeLessThan(cheap.tickets);
  });

  it("respects the hashrate budget", () => {
    const d = selectVaultTickets(ctx({ hashrateAvailable: 5, othersTickets: 50 }));
    expect(d.tickets).toBeLessThanOrEqual(5);
  });

  it("reports no_hashrate when the wallet has none", () => {
    const d = selectVaultTickets(ctx({ hashrateAvailable: 0 }));
    expect(d.tickets).toBe(0);
    expect(d.reason).toBe("no_hashrate");
  });

  it("respects the per-iteration ticket cap", () => {
    const d = selectVaultTickets(ctx({ maxTickets: 7, othersTickets: 50 }));
    expect(d.tickets).toBeLessThanOrEqual(7);
    expect(d.reason).toBe("cap_reached");
  });

  it("does not re-charge tickets already held (sunk)", () => {
    const d = selectVaultTickets(ctx({ myTickets: 20, othersTickets: 50 }));
    // win share reflects total holdings including the sunk 20
    expect(d.winShareAfter).toBeGreaterThan(20 / 70);
  });

  it("reports no_pool when there is nothing to win", () => {
    const d = selectVaultTickets(ctx({ poolValueUsd: 0 }));
    expect(d.tickets).toBe(0);
    expect(d.reason).toBe("no_pool");
  });

  it("the marginal buy is EV-positive and win-share increases", () => {
    const before = ctx({ othersTickets: 200, poolValueUsd: 5000 });
    const d = selectVaultTickets(before);
    expect(d.evUsd).toBeGreaterThan(0);
    const shareBefore = before.myTickets / (before.myTickets + before.othersTickets || 1);
    expect(d.winShareAfter).toBeGreaterThan(shareBefore);
  });

  it("buys more into a bigger pool", () => {
    const small = selectVaultTickets(ctx({ poolValueUsd: 100 }));
    const big = selectVaultTickets(ctx({ poolValueUsd: 100_000 }));
    expect(big.tickets).toBeGreaterThan(small.tickets);
  });

  it("buys fewer epoch tickets than 1-BTC — dedup saturates the epoch payoff", () => {
    // Same pool and field: 1-BTC is linear in share so the marginal ticket keeps
    // paying; epoch is concave (a wallet can only win once) so the marginal
    // ticket decays faster and the selector stops earlier.
    const oneBtc = selectVaultTickets(ctx({ kind: "one_btc" }));
    const epoch = selectVaultTickets(ctx({ kind: "epoch" }));
    expect(epoch.tickets).toBeGreaterThan(0);
    expect(epoch.tickets).toBeLessThan(oneBtc.tickets);
  });

  it("rejects invalid inputs", () => {
    expect(() => selectVaultTickets(ctx({ poolValueUsd: -1 }))).toThrow(RangeError);
    expect(() => selectVaultTickets(ctx({ othersTickets: -5 }))).toThrow(RangeError);
    expect(() => selectVaultTickets(ctx({ hashrateValueUsd: NaN }))).toThrow(RangeError);
  });
});

// Epoch winners are deduped BY WALLET: a drawn holder's entire block leaves the
// pool. With tickets concentrated (top 10 held 71.5% live), whales are drawn
// early and vanish, so a small holder's odds on later draws exceed its raw
// share. epochWinFraction models our own once-only limit but treats the rest of
// the pool as static — measured at 1.42-1.49x too low.
describe("epoch dedup uplift", () => {
  it("defaults to the old conservative behaviour at uplift 1", () => {
    expect(epochWinFraction(0.001, 1)).toBeCloseTo(epochWinFraction(0.001), 12);
  });

  it("scales a small holder's expectation by the uplift", () => {
    const base = epochWinFraction(0.0002);
    expect(epochWinFraction(0.0002, 1.45)).toBeCloseTo(base * 1.45, 12);
  });

  it("never scales past the pool's actual payout fraction", () => {
    // The uplift redistributes odds between holders; it cannot mint pool.
    expect(epochWinFraction(0.95, 3)).toBeLessThanOrEqual(EPOCH_PAYOUT_FRACTION);
    expect(epochWinFraction(1, 5)).toBeCloseTo(EPOCH_PAYOUT_FRACTION, 12);
  });

  it("treats an uplift below 1 as no uplift", () => {
    expect(epochWinFraction(0.001, 0.5)).toBeCloseTo(epochWinFraction(0.001), 12);
  });

  it("leaves the 1-BTC vault alone — it is winner-take-all, not deduped", () => {
    const withUplift = expectedWinningsUsd(100, 600_000, 50_000, "one_btc", 1.45);
    const without = expectedWinningsUsd(100, 600_000, 50_000, "one_btc", 1);
    expect(withUplift).toBeCloseTo(without, 12);
  });

  it("does raise the epoch vault's expectation", () => {
    const withUplift = expectedWinningsUsd(144, 668_088, 40_672, "epoch", 1.45);
    const without = expectedWinningsUsd(144, 668_088, 40_672, "epoch", 1);
    expect(withUplift / without).toBeCloseTo(1.45, 6);
    expect(withUplift).toBeGreaterThan(11); // ~$11.4, matching the simulation
  });
});

describe("vault engine: uncapped by default, reserves for a better filling 1-BTC draw", () => {
  it("spends the whole balance when uncapped, and holds back what a reserved vault would take", async () => {
    const { VaultEngine } = await import("../src/exec/vault-engine.js");
    const bought: number[] = [];
    const engine = new VaultEngine({
      enabled: true, dry: false, hashrateValueUsd: 0, epochDedupUplift: 1, epochCurve: undefined,
      ticketPriceHashrate: 100, maxTickets: 0, hashrateFraction: 1,
      hashrateAvailable: () => 50_000, // 500 tickets' worth
      myTickets: () => 0,
      buy: async (_k: string, _i: number, t: number) => { bought.push(t); return "sig"; },
      log: () => undefined,
    } as never);
    const epoch = { kind: "epoch" as const, iterationId: 1, open: true, totalTickets: 900_000, poolValueUsd: 10_000 };
    const oneBtc = { kind: "one_btc" as const, iterationId: 3, open: true, totalTickets: 230_000, poolValueUsd: 85_000 };
    const planned = engine.plannedPoints(oneBtc);
    expect(planned).toBe(50_000); // at zero opportunity cost the 1-BTC optimum is the whole balance
    await engine.evaluate(epoch, 20_000);
    expect(bought[0]).toBe(300); // 50k − 20k reserved = 30k points = 300 tickets, not the old cap of 250
  });
});

describe("epochCarryValuePerTicket — the opportunity cost that spreads a backlog over draws", () => {
  it("falls as the fleet's own steady spend grows the field, and a big backlog stops before swamping one draw", async () => {
    const { epochCarryValuePerTicket, expectedWinningsUsd, EPOCH_EQUAL_CURVE_BPS } = await import("../src/strategy/vault.js");
    const base = { poolUsd: 40_000, othersField: 900_000, wallets: 21, uplift: 1.37 };
    const light = epochCarryValuePerTicket({ ...base, perWalletSteadyTickets: 100 });
    const heavy = epochCarryValuePerTicket({ ...base, perWalletSteadyTickets: 10_000 });
    expect(light).toBeGreaterThan(heavy);
    expect(light).toBeCloseTo((0.9 * 40_000 / (900_000 + 2_100)) * Math.pow(1 - 100 / 902_100, 20) * 1.37, 9);
    // A wallet holding 10,000 tickets' worth (the 2026-09-26 backlog per wallet) against a
    // 347k field: the marginal ticket in THIS draw sinks below the carried value before the
    // backlog is spent, so the greedy leaves hashrate for next week.
    const carry = epochCarryValuePerTicket({ poolUsd: 40_000, othersField: 900_000, wallets: 21, perWalletSteadyTickets: 3_000, uplift: 1.37 });
    const marginalAt = (mine: number) =>
      expectedWinningsUsd(mine + 1, 347_000, 15_475, "epoch", 1.37, EPOCH_EQUAL_CURVE_BPS) - expectedWinningsUsd(mine, 347_000, 15_475, "epoch", 1.37, EPOCH_EQUAL_CURVE_BPS);
    expect(marginalAt(0)).toBeGreaterThan(carry);
    expect(marginalAt(10_000)).toBeLessThan(marginalAt(0));
  });
});
