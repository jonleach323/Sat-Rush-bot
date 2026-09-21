import { describe, expect, it } from "vitest";
import {
  compareEconomics,
  ECONOMICS_TOLERANCE,
  MEASURED_ECONOMICS,
} from "../src/ops/preflight.js";

const baseline = { ...MEASURED_ECONOMICS };

describe("economics tolerance gate", () => {
  it("passes when on-chain values match the measured baseline", () => {
    expect(compareEconomics(baseline)).toEqual({ ok: true, deviations: [] });
  });

  it("tolerates small drift", () => {
    const drifted = { ...baseline, protocol_fee_bps: Math.round(baseline.protocol_fee_bps * 1.1) };
    expect(compareEconomics(drifted).ok).toBe(true);
  });

  it("trips loudly when a fee leg changes beyond tolerance", () => {
    const changed = { ...baseline, sats_vault_round_fee_bps: 2400 }; // doubled
    const result = compareEconomics(changed);
    expect(result.ok).toBe(false);
    expect(result.deviations[0]).toContain("sats_vault_round_fee_bps");
    expect(result.deviations[0]).toContain("2400");
  });

  it("trips on multiple deviations and reports each", () => {
    const changed = {
      ...baseline,
      strike_fee_bps: 0,
      epoch_fee_bps: 1000,
    };
    const result = compareEconomics(changed);
    expect(result.ok).toBe(false);
    expect(result.deviations).toHaveLength(2);
  });

  it("respects a custom tolerance", () => {
    const drifted = { ...baseline, protocol_fee_bps: Math.round(baseline.protocol_fee_bps * 1.2) };
    expect(compareEconomics(drifted, 0.1).ok).toBe(false);
    expect(compareEconomics(drifted, ECONOMICS_TOLERANCE).ok).toBe(true);
  });
});
