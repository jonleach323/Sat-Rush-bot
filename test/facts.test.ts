import { describe, expect, it } from "vitest";
import {
  ALL_FACTS,
  EPOCH_DEDUP_UPLIFT,
  EPOCH_LAST_CLOSE_POOL_USD,
  EPOCH_LAST_CLOSE_TICKETS,
  REWARD_MAX_STREAK,
  assumedFacts,
  describe as describeFact,
  formatEstimate,
  samplesNeeded,
  significant,
  staleFacts,
  type Estimate,
} from "../src/strategy/facts.js";

/**
 * These tests are the mechanism, not decoration. Each one pins a property that
 * a specific wrong number in this project's history violated.
 */
describe("every fact declares where it came from", () => {
  it("has a value, a unit and a provenance", () => {
    for (const [name, f] of Object.entries(ALL_FACTS)) {
      expect(Number.isFinite(f.value), name).toBe(true);
      expect(f.unit.length, name).toBeGreaterThan(0);
      expect(f.provenance.kind, name).toBeTruthy();
    }
  });

  it("measured facts carry a sample size and a recheck command", () => {
    // A measurement without a sample size is an anecdote. `1.246` was quoted as
    // "measured mean 0.246" with no n and could never be reproduced.
    for (const [name, f] of Object.entries(ALL_FACTS)) {
      if (f.provenance.kind !== "measured") continue;
      expect(f.provenance.n, name).toBeGreaterThan(0);
      expect(f.provenance.recheck.length, name).toBeGreaterThan(0);
      expect(Number.isNaN(new Date(f.provenance.at).getTime()), name).toBe(false);
    }
  });

  it("assumed facts name the risk, not just the reason", () => {
    for (const { name, fact: f } of assumedFacts()) {
      if (f.provenance.kind !== "assumed") continue;
      expect(f.provenance.why.length, name).toBeGreaterThan(10);
      expect(f.provenance.risk.length, name).toBeGreaterThan(10);
    }
  });

  it("pins the complete list of unsourced facts", () => {
    // Failing here means an assumption was added or removed. Both are fine —
    // but they have to be deliberate, because an assumption that arrives
    // quietly is exactly how 0.9333, 0.65 and 1.246 got into the EV path.
    // REWARD_MAX_STREAK left this list once @satrush/client was installed and
    // exported it. One assumption remains.
    expect(assumedFacts().map((x) => x.name).sort()).toEqual([
      "EPOCH_FIELD_BANKED_SHARE",
    ]);
  });

  it("the streak cap is SDK-sourced now, not asserted", () => {
    // It scaled every farming estimate linearly while being an assumption.
    expect(REWARD_MAX_STREAK.provenance.kind).toBe("sdk");
  });

  it("prefers the SDK wherever the program exports the constant", () => {
    // Anything the official client ships should not be measured or assumed
    // here — sdk-parity.test.ts is what keeps the two honest.
    const sdkBacked = Object.entries(ALL_FACTS)
      .filter(([, f]) => f.provenance.kind === "sdk").map(([n]) => n).sort();
    expect(sdkBacked).toEqual([
      "REWARD_MAX_STREAK",
      "STRIKE_BOOST_WINDOW_ROUNDS",
      "STRIKE_HASHRATE_MULTIPLIER",
      "TILES",
      "VAULT_HASHRATE_PER_TICKET",
    ]);
  });
});

describe("staleness is an error, not a note", () => {
  it("reports volume-tracking facts as stale once past their half-life", () => {
    // The iteration-4 pool and field were four days old across a 4.7x volume
    // collapse and inverted the farming verdict. Three-day half-lives exist so
    // that cannot pass silently again.
    const later = new Date(Date.parse(EPOCH_LAST_CLOSE_TICKETS.provenance.kind === "measured"
      ? EPOCH_LAST_CLOSE_TICKETS.provenance.at : "2026-08-15") + 10 * 86_400_000);
    const names = staleFacts(later).map((s) => s.name);
    expect(names).toContain("EPOCH_LAST_CLOSE_TICKETS");
    expect(names).toContain("EPOCH_LAST_CLOSE_POOL_USD");
    expect(names).toContain("EPOCH_DEDUP_UPLIFT");
  });

  it("does not flag structural facts that cannot drift", () => {
    const far = new Date("2027-01-01");
    expect(staleFacts(far).map((s) => s.name)).not.toContain("SLOT_SECONDS");
    expect(staleFacts(far).map((s) => s.name)).not.toContain("TILES");
  });

  it("nothing is stale on the day it was measured", () => {
    expect(staleFacts(new Date("2026-08-15"))).toEqual([]);
  });

  it("orders by how far past the half-life, not by raw age", () => {
    const s = staleFacts(new Date("2027-01-01"));
    for (let i = 1; i < s.length; i++) {
      const prev = s[i - 1]!, cur = s[i]!;
      expect(prev.ageDays / prev.halfLifeDays).toBeGreaterThanOrEqual(
        cur.ageDays / cur.halfLifeDays,
      );
    }
  });
});

describe("estimates cannot be quoted without an error bar", () => {
  /** The actual reconcile-ev sample that produced a withdrawn finding. */
  const reconcile: Estimate = { value: -25.45, stderr: 28.6, n: 188 };

  it("calls the -25.45% sample what it was", () => {
    expect(significant(reconcile)).toBe(false);
    expect(formatEstimate(reconcile, "%")).toContain("NOT SIGNIFICANT");
  });

  it("says how many observations would have settled it", () => {
    // 188 * (2*28.6 / 25.45)^2 — a bit over a thousand, not a couple hundred.
    expect(samplesNeeded(reconcile)).toBeGreaterThan(900);
    expect(samplesNeeded(reconcile)).toBeLessThan(1200);
  });

  it("passes a genuinely resolved estimate", () => {
    const solid: Estimate = { value: -11.03, stderr: 1.2, n: 4000 };
    expect(significant(solid)).toBe(true);
    expect(formatEstimate(solid, "%")).not.toContain("NOT SIGNIFICANT");
  });

  it("tests against a baseline, not just zero", () => {
    // Beating a blanket is the bar. -11% is clearly worse than -7%...
    const edge: Estimate = { value: -11.03, stderr: 0.5, n: 4000 };
    expect(significant(edge, -7.05)).toBe(true);
    // ...but the same value with a wide error bar is not.
    expect(significant({ ...edge, stderr: 8 }, -7.05)).toBe(false);
  });

  it("treats a zero-error estimate as unresolved rather than certain", () => {
    expect(significant({ value: 5, stderr: 0, n: 1 })).toBe(false);
    expect(samplesNeeded({ value: 5, stderr: 0, n: 1 })).toBe(Infinity);
  });

  it("needs infinite samples to resolve a zero effect", () => {
    expect(samplesNeeded({ value: 0, stderr: 1, n: 10 })).toBe(Infinity);
  });
});

describe("describe() surfaces provenance in one line", () => {
  it("names the SDK symbol a fact came from", () => {
    expect(describeFact("REWARD_MAX_STREAK", REWARD_MAX_STREAK))
      .toContain("REWARD_MAX_STREAK from @satrush/client");
  });
  it("marks remaining assumptions loudly", () => {
    const [first] = assumedFacts();
    expect(describeFact(first!.name, first!.fact)).toContain("ASSUMED");
  });
  it("dates measurements", () => {
    expect(describeFact("EPOCH_DEDUP_UPLIFT", EPOCH_DEDUP_UPLIFT)).toContain("n=127");
  });
  it("names the pool constant's units", () => {
    expect(describeFact("EPOCH_LAST_CLOSE_POOL_USD", EPOCH_LAST_CLOSE_POOL_USD))
      .toContain("USD");
  });
});
