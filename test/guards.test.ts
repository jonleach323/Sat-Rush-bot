import { describe, expect, it } from "vitest";
import {
  assertDeployInvariants,
  assertFeeBearingInvariants,
  type DeploySendInvariants,
} from "../src/exec/guards.js";
import { HaltError } from "../src/ingest/decode.js";
import { usdToBase } from "../src/units.js";

function valid(): DeploySendInvariants {
  return {
    roundId: 1,
    amountBaseUnits: usdToBase(5),
    mask: 0b101, // tiles 0,2
    quantumBase: usdToBase(1),
    minDeployBase: usdToBase(1),
    maxPerRoundBase: usdToBase(1000),
    dailyLossCapBase: usdToBase(1000),
    realizedLossTodayBase: 0n,
    priorityFeeMicroLamports: 1000,
    maxPriorityFeeMicroLamports: 1_000_000,
    tipLamports: 0,
    maxTipLamports: 10_000,
    latchHeld: true,
    killSwitchEngaged: false,
  };
}

describe("assertDeployInvariants — the pre-send chokepoint", () => {
  it("passes a valid deploy", () => {
    expect(() => assertDeployInvariants(valid())).not.toThrow();
  });

  it.each<[string, Partial<DeploySendInvariants>]>([
    ["kill switch engaged", { killSwitchEngaged: true }],
    ["latch not held", { latchHeld: false }],
    ["amount zero", { amountBaseUnits: 0n }],
    ["amount negative", { amountBaseUnits: -1n }],
    ["amount not quantum multiple", { amountBaseUnits: usdToBase(5) + 1n }],
    ["amount below min deploy", { amountBaseUnits: usdToBase(1), minDeployBase: usdToBase(2) }],
    ["amount exceeds max per round", { amountBaseUnits: usdToBase(2000) }],
    ["amount exceeds u64", { amountBaseUnits: 2n ** 64n, maxPerRoundBase: 2n ** 65n, dailyLossCapBase: 2n ** 65n }],
    ["mask empty (0 tiles)", { mask: 0 }],
    ["mask beyond 21 bits", { mask: 1 << 21 }],
    ["priority fee over clamp", { priorityFeeMicroLamports: 2_000_000 }],
    ["priority fee negative", { priorityFeeMicroLamports: -1 }],
    ["tip over clamp", { tipLamports: 50_000 }],
  ])("HALTS on: %s", (_label, patch) => {
    expect(() => assertDeployInvariants({ ...valid(), ...patch })).toThrow(HaltError);
  });

  it("HALTS when the deploy would breach the daily loss cap (re-checked on actual amount)", () => {
    expect(() =>
      assertDeployInvariants({
        ...valid(),
        amountBaseUnits: usdToBase(600),
        realizedLossTodayBase: usdToBase(500),
        dailyLossCapBase: usdToBase(1000),
      }),
    ).toThrow(/daily loss cap/);
  });

  it("strike-boost divergence: a $15 send against a $5 authorized cap HALTS (F1 regression)", () => {
    // Reproduces AUDIT F1: selector produced $15 (boosted), bankroll cap $5.
    // With the effective (boosted) cap the amount is valid, but the
    // authorized-amount equality check in the orchestrator is the definitive
    // catch; here we prove the cap guard itself halts a $15 send at a $5 cap.
    expect(() =>
      assertDeployInvariants({
        ...valid(),
        amountBaseUnits: usdToBase(15),
        maxPerRoundBase: usdToBase(5),
      }),
    ).toThrow(/exceeds MAX_PER_ROUND/);
  });
});

describe("assertFeeBearingInvariants — settle/claim", () => {
  it("passes a clamped fee", () => {
    expect(() =>
      assertFeeBearingInvariants({
        kind: "settle",
        priorityFeeMicroLamports: 1000,
        maxPriorityFeeMicroLamports: 1_000_000,
        killSwitchEngaged: false,
      }),
    ).not.toThrow();
  });

  it("HALTS on kill switch or fee over clamp", () => {
    expect(() =>
      assertFeeBearingInvariants({
        kind: "claim",
        priorityFeeMicroLamports: 1000,
        maxPriorityFeeMicroLamports: 1_000_000,
        killSwitchEngaged: true,
      }),
    ).toThrow(HaltError);
    expect(() =>
      assertFeeBearingInvariants({
        kind: "claim",
        priorityFeeMicroLamports: 9_999_999,
        maxPriorityFeeMicroLamports: 1_000_000,
        killSwitchEngaged: false,
      }),
    ).toThrow(HaltError);
  });
});
