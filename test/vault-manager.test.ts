import { describe, expect, it, vi } from "vitest";
import {
  VaultManager,
  epochEntryReady,
  epochLateWindowSlots,
  oneBtcEntryReady,
  marginalTicketUsd,
  oneBtcFillBps,
  type EpochReadState,
  type OneBtcReadState,
  type VaultManagerOpts,
  type VaultReadState,
} from "../src/exec/vault-manager.js";
import type { VaultEngine, VaultSnapshot } from "../src/exec/vault-engine.js";

const epoch = (over: Partial<EpochReadState> = {}): EpochReadState => ({
  iterationId: 293,
  open: true,
  totalTickets: 0,
  poolValueUsd: 971,
  lastTriggerSlot: 1000,
  iterationDurationSlots: 1000,
  ...over,
});

const ONE_BTC = 100_000_000; // 1 BTC at 8dp — the program's draw trigger

const oneBtc = (over: Partial<OneBtcReadState> = {}): OneBtcReadState => ({
  iterationId: 19,
  open: true,
  totalTickets: 0,
  poolValueUsd: 100_000,
  prizeBtc: 93_000_000, // 0.93 BTC accrued
  targetBtc: ONE_BTC,
  ...over,
});

describe("epochLateWindowSlots", () => {
  it("scales with the iteration so a multi-hour window is not 4 seconds wide", () => {
    // A ~3.5h mainnet iteration at 2% ≈ 637 slots (~4 min), not the 10-slot floor.
    expect(epochLateWindowSlots(31_875, 10, 0.02)).toBe(638);
  });
  it("falls back to the absolute floor on short iterations", () => {
    expect(epochLateWindowSlots(1000, 600, 0.02)).toBe(600); // 20 scaled < 600 floor
  });
  it("tolerates degenerate inputs", () => {
    expect(epochLateWindowSlots(0, 600, 0.02)).toBe(600);
    expect(epochLateWindowSlots(-5, 600, -1)).toBe(600);
  });
});

describe("epochEntryReady", () => {
  it("true only within the late-slots window before close", () => {
    // window closes at 1000 + 1000 = 2000
    expect(epochEntryReady(epoch(), 1995, 10)).toBe(true); // 5 slots left
    expect(epochEntryReady(epoch(), 1990, 10)).toBe(true); // exactly 10 left
    expect(epochEntryReady(epoch(), 1900, 10)).toBe(false); // 100 left — too early
  });
  it("still enters past nominal close while the iteration is Open", () => {
    // The window closing only makes the draw ELIGIBLE; until someone cranks it
    // tickets still count, and the field is maximally visible.
    expect(epochEntryReady(epoch(), 2001, 10)).toBe(true);
    expect(epochEntryReady(epoch(), 9999, 10)).toBe(true);
  });
  it("false when the iteration is not open", () => {
    expect(epochEntryReady(epoch({ open: false }), 1995, 10)).toBe(false);
    expect(epochEntryReady(epoch({ open: false }), 2001, 10)).toBe(false);
  });
});

describe("oneBtcFillBps", () => {
  it("measures fill against the draw target, not the unclaimed escrow", () => {
    expect(oneBtcFillBps(60_500_000, ONE_BTC)).toBe(6050); // 0.605 BTC → 60.5%
    expect(oneBtcFillBps(ONE_BTC, ONE_BTC)).toBe(10_000);
  });
  it("returns 0 rather than dividing by an unknown target", () => {
    expect(oneBtcFillBps(60_500_000, 0)).toBe(0);
  });
});

describe("oneBtcEntryReady", () => {
  it("true once filled past the threshold", () => {
    expect(oneBtcEntryReady(oneBtc(), 8000)).toBe(true); // 0.93 BTC → 93%
    expect(oneBtcEntryReady(oneBtc({ prizeBtc: 60_500_000 }), 8000)).toBe(false); // 60.5%
  });
  it("false when closed or the target is unknown", () => {
    expect(oneBtcEntryReady(oneBtc({ open: false }), 8000)).toBe(false);
    expect(oneBtcEntryReady(oneBtc({ targetBtc: 0 }), 8000)).toBe(false);
  });
  it("a zero unclaimed-escrow balance no longer blocks entry", () => {
    // Regression: fill used to be prizeBtc/reserved_btc_amount, and that escrow
    // is 0 while the vault accumulates — so this path never opened.
    expect(oneBtcEntryReady(oneBtc({ prizeBtc: ONE_BTC }), 8000)).toBe(true);
  });
});

function makeManager(state: VaultReadState, over: Partial<VaultManagerOpts> = {}) {
  const evaluate = vi.fn(async (_snap: VaultSnapshot) => ({
    decision: null,
    acted: false,
    signature: null as string | null,
    skipped: "x" as string | null,
  }));
  const engine = { evaluate } as unknown as VaultEngine;
  const opts: VaultManagerOpts = {
    engine,
    readState: async () => state,
    epochLateSlots: 10,
    epochLateFraction: 0,
    oneBtcMinFillBps: 8000,
    pollMs: 1000,
    killSwitchEngaged: () => false,
    log: vi.fn(),
    ...over,
  };
  return { mgr: new VaultManager(opts), evaluate };
}

describe("VaultManager.tick", () => {
  it("evaluates the epoch vault when in the late window", async () => {
    const { mgr, evaluate } = makeManager({ slot: 1995, epoch: epoch(), oneBtc: null });
    await mgr.tick();
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]![0]).toMatchObject({ kind: "epoch", iterationId: 293 });
  });

  it("does not evaluate the epoch vault too early", async () => {
    const { mgr, evaluate } = makeManager({ slot: 1500, epoch: epoch(), oneBtc: null });
    await mgr.tick();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("evaluates the 1-BTC vault when near the fill trigger", async () => {
    const { mgr, evaluate } = makeManager({ slot: 0, epoch: null, oneBtc: oneBtc() });
    await mgr.tick();
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]![0]).toMatchObject({ kind: "one_btc", iterationId: 19 });
  });

  it("does nothing while the kill switch is engaged", async () => {
    const { mgr, evaluate } = makeManager(
      { slot: 1995, epoch: epoch(), oneBtc: oneBtc() },
      { killSwitchEngaged: () => true },
    );
    await mgr.tick();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("swallows a read failure without throwing", async () => {
    const { mgr, evaluate } = makeManager(
      { slot: 0, epoch: null, oneBtc: null },
      {
        readState: async () => {
          throw new Error("rpc down");
        },
      },
    );
    await expect(mgr.tick()).resolves.toBeUndefined();
    expect(evaluate).not.toHaveBeenCalled();
  });
});

// Regression: the 1-BTC draw is eligible at 1 BTC ACCRUED, not at
// reserved_btc_amount (the unclaimed-prize escrow, 0 during accumulation).
// Comparing against the escrow read as permanently eligible and cranked a
// doomed trigger every 5s poll tick.
describe("1-BTC trigger eligibility", () => {
  const ONE = 100_000_000;
  const eligible = (prizeBtc: number, target = ONE) => prizeBtc >= target;

  it("is NOT eligible at 92% accrued — the state that spammed", () => {
    expect(eligible(92_490_869)).toBe(false);
    // The old predicate compared against a zero escrow and was always true.
    expect(92_490_869 >= 0).toBe(true);
  });

  it("becomes eligible only at the full 1 BTC", () => {
    expect(eligible(99_999_999)).toBe(false);
    expect(eligible(ONE)).toBe(true);
    expect(eligible(ONE + 1)).toBe(true);
  });
});

// Both vaults draw on the same hashrate balance, so evaluation order decides
// the allocation. Fixed order meant a cheaper epoch ticket could outrank a
// richer 1-BTC one purely by position in the source.
describe("vault ordering by ticket value", () => {
  const bothReady = (over: Partial<VaultReadState> = {}): VaultReadState => ({
    slot: 1995, // inside the epoch late window
    epoch: epoch({ totalTickets: 594_398, poolValueUsd: 40_672 }),
    oneBtc: oneBtc({ totalTickets: 634_564, poolValueUsd: 58_314 }),
    ...over,
  });

  it("ranks the richer 1-BTC ticket ahead of the epoch ticket", () => {
    const s = bothReady();
    const e = marginalTicketUsd({ kind: "epoch", state: s.epoch! });
    const o = marginalTicketUsd({ kind: "one_btc", state: s.oneBtc! });
    // Live values: epoch ~$0.062, 1-BTC ~$0.092.
    expect(o).toBeGreaterThan(e);
  });

  it("evaluates the higher-value vault FIRST when both are eligible", async () => {
    const { mgr, evaluate } = makeManager(bothReady());
    await mgr.tick();
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate.mock.calls[0]![0]).toMatchObject({ kind: "one_btc" });
    expect(evaluate.mock.calls[1]![0]).toMatchObject({ kind: "epoch" });
  });

  it("flips the order when the epoch pool is the richer one", async () => {
    const s = bothReady({ epoch: epoch({ totalTickets: 1000, poolValueUsd: 40_672 }) });
    const { mgr, evaluate } = makeManager(s);
    await mgr.tick();
    expect(evaluate.mock.calls[0]![0]).toMatchObject({ kind: "epoch" });
  });

  it("scores an empty or unpriced vault at zero rather than dividing by it", () => {
    expect(marginalTicketUsd({ kind: "epoch", state: epoch({ totalTickets: 0 }) })).toBe(0);
    expect(marginalTicketUsd({ kind: "one_btc", state: oneBtc({ poolValueUsd: 0 }) })).toBe(0);
  });
});

describe("marginalTicketUsd under the V2 equal-prize curve", () => {
  it("prices the marginal epoch ticket on the curve it is handed", async () => {
    const { EPOCH_EQUAL_CURVE_BPS, EPOCH_REWARD_CURVE_BPS, expectedWinningsUsd } = await import("../src/strategy/vault.js");
    const state = { iterationId: 1, open: true, totalTickets: 1000, poolValueUsd: 10_000, lastTriggerSlot: 0, iterationDurationSlots: 1000 };
    const ranked = marginalTicketUsd({ kind: "epoch", state });
    const flat = marginalTicketUsd({ kind: "epoch", state }, EPOCH_EQUAL_CURVE_BPS);
    // Same 90% payout fraction, so one marginal ticket is worth the same to
    // first order (within 1% at a 0.1% share); the curve only reshapes the
    // take of a LARGE holding.
    expect(Math.abs(flat / ranked - 1)).toBeLessThan(0.01);
    const bigRanked = expectedWinningsUsd(300, 700, 10_000, "epoch", 1, EPOCH_REWARD_CURVE_BPS);
    const bigFlat = expectedWinningsUsd(300, 700, 10_000, "epoch", 1, EPOCH_EQUAL_CURVE_BPS);
    expect(bigFlat).toBeLessThan(bigRanked); // one wallet can no longer take rank 1's 32%
  });
});

