import { describe, expect, it, vi } from "vitest";
import {
  VaultEngine,
  type VaultEngineOpts,
  type VaultSnapshot,
} from "../src/exec/vault-engine.js";

function makeEngine(over: Partial<VaultEngineOpts> = {}) {
  const buy = vi.fn(
    async (_kind: string, _iterationId: number, _tickets: number): Promise<string> =>
      "sig-abc",
  );
  const log = vi.fn();
  const opts: VaultEngineOpts = {
    enabled: true,
    dry: false,
    hashrateValueUsd: 0.01,
    ticketPriceHashrate: 100,
    maxTickets: 1000,
    hashrateFraction: 1,
    hashrateAvailable: () => 100_000, // points; 100/ticket → 1000 affordable
    myTickets: () => 0,
    buy,
    log,
    ...over,
  };
  return { engine: new VaultEngine(opts), buy, log };
}

const thin: VaultSnapshot = {
  kind: "one_btc",
  iterationId: 5,
  open: true,
  totalTickets: 50,
  poolValueUsd: 100_000,
};

describe("VaultEngine gating", () => {
  it("does nothing when disabled", async () => {
    const { engine, buy } = makeEngine({ enabled: false });
    const r = await engine.evaluate(thin);
    expect(r.acted).toBe(false);
    expect(r.skipped).toBe("disabled");
    expect(buy).not.toHaveBeenCalled();
  });

  it("skips a closed iteration", async () => {
    const { engine, buy } = makeEngine();
    const r = await engine.evaluate({ ...thin, open: false });
    expect(r.skipped).toBe("iteration_not_open");
    expect(buy).not.toHaveBeenCalled();
  });

  it("dry mode decides but never sends", async () => {
    const { engine, buy, log } = makeEngine({ dry: true });
    const r = await engine.evaluate(thin);
    expect(r.decision!.tickets).toBeGreaterThan(0);
    expect(r.acted).toBe(false);
    expect(r.skipped).toBe("dry");
    expect(buy).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  it("sits out a crowded field without sending", async () => {
    const { engine, buy } = makeEngine();
    const r = await engine.evaluate({
      ...thin,
      totalTickets: 10_000_000,
      poolValueUsd: 10,
    });
    expect(r.acted).toBe(false);
    expect(r.skipped).toBe("field_too_crowded");
    expect(buy).not.toHaveBeenCalled();
  });
});

describe("VaultEngine live buy", () => {
  it("buys once and latches the iteration", async () => {
    const { engine, buy } = makeEngine();
    const r1 = await engine.evaluate(thin);
    expect(r1.acted).toBe(true);
    expect(r1.signature).toBe("sig-abc");
    expect(buy).toHaveBeenCalledTimes(1);
    const [kind, iter, tickets] = buy.mock.calls[0]!;
    expect(kind).toBe("one_btc");
    expect(iter).toBe(5);
    expect(tickets).toBeGreaterThan(0);

    // second evaluation of the same iteration is latched out
    const r2 = await engine.evaluate(thin);
    expect(r2.acted).toBe(false);
    expect(r2.skipped).toBe("already_played");
    expect(buy).toHaveBeenCalledTimes(1);
  });

  it("respects the hashrate fraction budget (points ÷ ticket price)", async () => {
    const { engine, buy } = makeEngine({
      hashrateAvailable: () => 100_000,
      hashrateFraction: 0.1, // 10,000 points spendable → 100 tickets at 100/ticket
      hashrateValueUsd: 0,
      maxTickets: 10_000,
    });
    await engine.evaluate({ ...thin, totalTickets: 1000 });
    const tickets = (buy.mock.calls[0]!)[2];
    expect(tickets).toBeLessThanOrEqual(100);
    expect(tickets).toBeGreaterThan(0);
  });

  it("markPlayed re-arms the latch (boot recovery)", async () => {
    const { engine, buy } = makeEngine();
    engine.markPlayed("one_btc", 5);
    const r = await engine.evaluate(thin);
    expect(r.skipped).toBe("already_played");
    expect(buy).not.toHaveBeenCalled();
  });

  it("latches before awaiting the send (no double-fire on slow confirm)", async () => {
    let release: (v: string) => void = () => {};
    const slowBuy = vi.fn(
      () => new Promise<string>((res) => { release = res; }),
    );
    const { engine } = makeEngine({ buy: slowBuy });
    const p1 = engine.evaluate(thin); // starts the buy, latches
    const r2 = await engine.evaluate(thin); // while first is in flight
    expect(r2.skipped).toBe("already_played");
    release("sig-1");
    const r1 = await p1;
    expect(r1.acted).toBe(true);
    expect(slowBuy).toHaveBeenCalledTimes(1);
  });
});
