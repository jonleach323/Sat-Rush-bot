import { describe, expect, it, vi } from "vitest";
import {
  VaultManager,
  epochEntryReady,
  oneBtcEntryReady,
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

const oneBtc = (over: Partial<OneBtcReadState> = {}): OneBtcReadState => ({
  iterationId: 19,
  open: true,
  totalTickets: 0,
  poolValueUsd: 100_000,
  btcAmount: 1_400_000,
  reservedBtc: 1_500_000,
  ...over,
});

describe("epochEntryReady", () => {
  it("true only within the late-slots window before close", () => {
    // window closes at 1000 + 1000 = 2000
    expect(epochEntryReady(epoch(), 1995, 10)).toBe(true); // 5 slots left
    expect(epochEntryReady(epoch(), 1990, 10)).toBe(true); // exactly 10 left
    expect(epochEntryReady(epoch(), 1900, 10)).toBe(false); // 100 left — too early
    expect(epochEntryReady(epoch(), 2001, 10)).toBe(false); // past close
  });
  it("false when the iteration is not open", () => {
    expect(epochEntryReady(epoch({ open: false }), 1995, 10)).toBe(false);
  });
});

describe("oneBtcEntryReady", () => {
  it("true once filled past the threshold", () => {
    expect(oneBtcEntryReady(oneBtc(), 8000)).toBe(true); // 1.4M/1.5M ≈ 93%
    expect(oneBtcEntryReady(oneBtc({ btcAmount: 100_000 }), 8000)).toBe(false); // ~7%
  });
  it("false when closed or trigger unknown", () => {
    expect(oneBtcEntryReady(oneBtc({ open: false }), 8000)).toBe(false);
    expect(oneBtcEntryReady(oneBtc({ reservedBtc: 0 }), 8000)).toBe(false);
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
