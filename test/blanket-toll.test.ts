import { describe, expect, it } from "vitest";
import {
  STRIKE_PAYOUT_FRACTION,
  blanketReturn,
  blanketToll,
  type FeeModel,
} from "../src/strategy/ev.js";
import { resampleField } from "../src/ingest/epoch-field.js";

/** Mainnet schedule: 294 strike / 232 epoch / 132 one_btc / 142 protocol = 800. */
const MAINNET: FeeModel = {
  deployFeeBps: 800,
  satsVaultRoundBps: 1200,
  satsVaultClaimBps: 1000,
};
const STRIKE_BPS = 294;

describe("blanket economics", () => {
  it("returns 0.909 of gross before the strike leg", () => {
    // 0.92 (deploy legs) x 0.988 (sats claim on the 1200 bps round leg).
    const noStrike = blanketReturn(MAINNET, 0);
    expect(noStrike).toBeCloseTo(0.909, 3);
  });

  it("the toll is 6.356% once the strike leg pays back", () => {
    // 910 bps of leakage less 294 x 0.9333 = 274.4 bps recovered. (Under the
    // owner's stated 0.70 this read 7.046%; the V2 tape measures 14/15.)
    expect(blanketToll(MAINNET, STRIKE_BPS)).toBeCloseTo(0.06356, 4);
  });

  it("pins the measured 14/15 strike split", () => {
    // 12 V2 strikes, every leg, zero variance (pnpm strike-payout). Both the
    // value and the resulting toll are asserted so a silent edit fails loudly.
    expect(STRIKE_PAYOUT_FRACTION).toBe(0.9333);
    expect(blanketToll(MAINNET, STRIKE_BPS)).toBeGreaterThan(0.06);
  });

  it("presence never pays for itself", () => {
    expect(blanketReturn(MAINNET, STRIKE_BPS)).toBeLessThan(1);
  });

  it("a zero-fee schedule is a perfect round trip", () => {
    expect(blanketReturn({ deployFeeBps: 0, satsVaultRoundBps: 0, satsVaultClaimBps: 0 }, 0))
      .toBeCloseTo(1, 9);
  });

  it("only the CLAIM fee on the sats leg is a real cost", () => {
    // 1200 bps routed to the vault but claimed for free loses nothing.
    const freeClaim = blanketReturn({ ...MAINNET, satsVaultClaimBps: 0 }, 0);
    expect(freeClaim).toBeCloseTo(0.92, 6);
  });
});

describe("resampleField", () => {
  const observed = [100, 50, 30, 20];

  it("preserves the total it is given", () => {
    const out = resampleField(observed, 10, 1_000);
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(1_000, 6);
  });

  it("produces exactly the requested entrant count", () => {
    expect(resampleField(observed, 157, 500_000)).toHaveLength(157);
    expect(resampleField(observed, 1, 500_000)).toHaveLength(1);
  });

  it("keeps the shape — concentration survives a resample", () => {
    const out = resampleField(observed, 4, 200);
    // Input top-1 share is 100/200 = 50%; resampling to the same count must
    // reproduce it, which is what the midpoint-quantile sampling buys.
    expect((out[0] as number) / 200).toBeCloseTo(0.5, 2);
    expect(out[0] as number).toBeGreaterThan(out[3] as number);
  });

  it("spreading the same total over more wallets shrinks every block", () => {
    const few = resampleField(observed, 4, 1_000);
    const many = resampleField(observed, 40, 1_000);
    expect(many[0] as number).toBeLessThan(few[0] as number);
  });

  it("is empty rather than fabricated when there is nothing to resample", () => {
    expect(resampleField([], 100, 1_000)).toEqual([]);
    expect(resampleField(observed, 0, 1_000)).toEqual([]);
    expect(resampleField(observed, 10, 0)).toEqual([]);
  });
});
