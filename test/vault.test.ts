import { describe, expect, it } from "vitest";
import {
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

describe("expectedWinningsUsd", () => {
  it("is ticket-fraction times pool", () => {
    expect(expectedWinningsUsd(9, 1, 1000)).toBeCloseTo(900);
    expect(expectedWinningsUsd(1, 9, 1000)).toBeCloseTo(100);
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

  it("epoch and one_btc use the same math", () => {
    const a = selectVaultTickets(ctx({ kind: "one_btc" }));
    const b = selectVaultTickets(ctx({ kind: "epoch" }));
    expect(a.tickets).toBe(b.tickets);
  });

  it("rejects invalid inputs", () => {
    expect(() => selectVaultTickets(ctx({ poolValueUsd: -1 }))).toThrow(RangeError);
    expect(() => selectVaultTickets(ctx({ othersTickets: -5 }))).toThrow(RangeError);
    expect(() => selectVaultTickets(ctx({ hashrateValueUsd: NaN }))).toThrow(RangeError);
  });
});
