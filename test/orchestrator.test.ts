/**
 * Orchestrator-level tests on fakes: the layer where every 2026-09-21 bug
 * lived (ARM-edge ordering, kill-switch reach, refresh bursts, the fire
 * path). Real Bankroll / CandidateSet / RaceSender(dry) / GameState; fake
 * RPC, fake ingest, in-memory DB. See test/harness/.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Orchestrator } from "../src/index.js";
import { chaseStakes } from "./harness/fixtures.js";
import { bootHarness, primeRound, writeKill, type Harness } from "./harness/orchestrator.js";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
  vi.restoreAllMocks();
});

describe("round lifecycle on fakes", () => {
  it("opens the round on the first slot, arms at the fire offset, and fires exactly the authorized amount (dry)", async () => {
    h = await bootHarness();
    const fire = vi.spyOn(h.sender, "fire");
    h.slotsTo(1_001);
    await h.settle();
    expect(h.internals()).toEqual({ botState: "ROUND_OPEN", roundId: 100 });

    // Walk to the cutoff. FIRE_OFFSET_SLOTS=4 → ARMED at end_slot − 4 = 1226.
    h.slotsTo(1_225);
    await h.settle();
    expect(h.internals().botState).toBe("ROUND_OPEN");
    h.slotsTo(1_226);
    await h.settle(80);
    // ARMED → fire → the post-fire states; never still ROUND_OPEN.
    expect(["ARMED", "SETTLING", "LOGGED"]).toContain(h.internals().botState);
    // One send per leg (tile mode: one wallet per covered tile), all for this
    // round, each from a distinct wallet — and never a second fire in the round.
    const metas = fire.mock.calls.map((c) => c[0].meta as { roundId: number; wallet: string; mask: number });
    expect(metas.length).toBeGreaterThan(0);
    expect(metas.every((m) => m.roundId === 100)).toBe(true);
    expect(new Set(metas.map((m) => m.wallet)).size).toBe(metas.length);
    h.slotsTo(1_229); // more slots inside the round must not re-fire
    await h.settle(40);
    expect(fire).toHaveBeenCalledTimes(metas.length);

    // The ledger carries every leg as dry, for the exact gross the selector chose.
    const rows = h.db.query<{ round_id: number; amount: string; status: string; mask: number }>("SELECT round_id, amount, status, mask FROM my_deploys");
    expect(rows.length).toBe(metas.length);
    expect(rows.every((r) => r.round_id === 100 && r.status === "dry")).toBe(true);
    expect(rows.map((r) => r.mask).sort()).toEqual(metas.map((m) => m.mask).sort());
    const total = rows.reduce((a, r) => a + BigInt(r.amount), 0n);
    expect(total).toBeGreaterThan(0n);
    expect(total <= 1_000_000_000n).toBe(true);
  });

  it("re-prices on the final board PRE_ARM_SLOTS before the fire offset, and the ARM tick only sends", async () => {
    h = await bootHarness();
    type WithRefresh = { refreshCandidates: (t: string) => Promise<void> };
    const proto = Orchestrator.prototype as unknown as WithRefresh;
    const original = proto.refreshCandidates;
    const refresh = vi.spyOn(proto, "refreshCandidates");
    const fire = vi.spyOn(h.sender, "fire");
    const order: string[] = [];
    refresh.mockImplementation(async function (this: unknown, trigger: string) {
      order.push(`refresh:${trigger}`);
      return original.call(this, trigger);
    });
    fire.mockImplementation(async function (this: unknown, ...args: unknown[]) {
      order.push("fire");
      return { outcome: "dry", signature: "x", meta: (args[0] as { meta: unknown }).meta } as never;
    });
    // Offset 4 → pre-arm at cutoff 7 (slot 1223), ARM at cutoff 4 (slot 1226).
    h.slotsTo(1_223);
    await h.settle(60);
    expect(order).toContain("refresh:pre_arm");
    expect(order).not.toContain("fire"); // priced, signed, not yet sent
    h.slotsTo(1_225);
    await h.settle(20);
    expect(order).not.toContain("fire");
    h.slotsTo(1_226);
    await h.settle(60);
    const preArmAt = order.indexOf("refresh:pre_arm");
    expect(order.indexOf("fire")).toBeGreaterThan(preArmAt);
    // Nothing was re-priced inside the fire window.
    expect(order.slice(order.indexOf("fire") - 1)[0]).not.toMatch(/^refresh:armed/);
    expect(order.filter((o) => o === "refresh:armed")).toHaveLength(0);
  });
});

describe("kill switch reaches everything", () => {
  it("a KILL file blocks the fire and the fleet treasury, and the skip is recorded", async () => {
    h = await bootHarness();
    const fire = vi.spyOn(h.sender, "fire");
    h.slotsTo(1_001);
    await h.settle();
    writeKill(h);
    h.slotsTo(1_226);
    await h.settle(80);
    expect(fire).not.toHaveBeenCalled();
    const skips = h.db.query<{ reason: string }>("SELECT reason FROM skips WHERE round_id = 100");
    expect(skips.map((s) => s.reason)).toContain("kill_switch_engaged");
    // Treasury: stands down under the file (RUNBOOK §2 — /pause is the trading-only hold).
    await (h.orch as unknown as { fleetTreasuryCycle: () => Promise<void> }).fleetTreasuryCycle();
    expect((h.orch as unknown as { lastFleetPlan: unknown }).lastFleetPlan).toBeNull();
  });
});

describe("occupancy bursts", () => {
  it("40 Round writes in a burst collapse into a handful of candidate refreshes", async () => {
    h = await bootHarness();
    const refresh = vi.spyOn(h.orch["candidates" as never] as { refresh: () => unknown }, "refresh");
    h.slotsTo(1_001);
    await h.settle();
    const before = refresh.mock.calls.length;
    const stakes = chaseStakes();
    for (let i = 0; i < 40; i++) {
      stakes[2 + (i % 19)]! += 1_000_000;
      await primeRound(100, stakes);
      h.roundUpdate([...stakes], 1_002 + i);
    }
    await h.settle(50);
    const during = refresh.mock.calls.length - before;
    expect(during).toBeLessThanOrEqual(2); // one immediate, the rest coalesced
    await h.settle(900);
    const after = refresh.mock.calls.length - before;
    expect(after).toBeLessThanOrEqual(3); // plus one trailing refresh with the final board
    expect(after).toBeGreaterThanOrEqual(1);
  });
});

describe("ingest reconnect", () => {
  it("re-seeds the snapshot from RPC on the first connect after a drop, then re-prices", async () => {
    h = await bootHarness();
    const reads = vi.spyOn(h.conn, "getMultipleAccountsInfo");
    const refresh = vi.spyOn(h.orch["candidates" as never] as { refresh: () => unknown }, "refresh");
    h.slotsTo(1_001);
    await h.settle();
    const readsBefore = reads.mock.calls.length;
    const refreshBefore = refresh.mock.calls.length;
    h.source.disconnect("slot stream silent");
    h.source.reconnect();
    await h.settle(60);
    expect(reads.mock.calls.length).toBeGreaterThan(readsBefore); // config/board/vaults/Miners re-read
    expect(refresh.mock.calls.length).toBeGreaterThan(refreshBefore); // and the selector re-run
    // A connect without a preceding drop does not re-seed.
    const readsAfter = reads.mock.calls.length;
    h.source.reconnect();
    await h.settle(40);
    expect(reads.mock.calls.length).toBe(readsAfter);
  });
});

describe("ramp signal sizing (V2)", () => {
  it("prices the ramp on the minimum blanket, not on the bankroll-sized cap", async () => {
    // $35k on the primary → the auto cap is the bankroll; the ramp deploys $1 × 21 tiles.
    h = await bootHarness({ env: { GAME_VERSION: "v2" }, primaryUsdc: 35_000_000_000n });
    h.slotsTo(1_001);
    await h.settle();
    const diag = (h.orch as unknown as { evDiagnostics: () => Record<string, unknown> }).evDiagnostics();
    expect(diag["rampBlanketUsd"]).toBe(21);
    expect(diag["capBlanketUsd"] as number).toBeGreaterThan(30_000);
    expect(typeof diag["blanketEvBpsAtStreakCap"]).toBe("number");
    expect(typeof diag["capBlanketEvBpsAtStreakCap"]).toBe("number");
    // The two are different questions: a $21 ramp and a $35k blanket do not price alike.
    expect(diag["blanketEvBpsAtStreakCap"]).not.toBe(diag["capBlanketEvBpsAtStreakCap"]);
    // The boost cycle is priced: p = window / modulus, and a cycle-weighted signal drives the ramp.
    expect(diag["pBoosted"]).toBeCloseTo(240 / 1097, 3);
    expect(typeof diag["cycleEvBpsAtStreakCap"]).toBe("number");
    expect(diag["unboostedDeployUsd"] as number).toBeGreaterThan(0);
  });
});

describe("on-chain config retune", () => {
  it("a rewritten SatrushConfig is priced live: the state updates, the change is named, candidates re-price", async () => {
    h = await bootHarness({ env: { GAME_VERSION: "v2" } });
    const { encode, makeConfig } = await import("./harness/fixtures.js");
    const { satrushConfigPda } = await import("../src/adapter/pdas.js");
    const refresh = vi.spyOn(h.orch["candidates" as never] as { refresh: () => unknown }, "refresh");
    const alerts: string[] = [];
    vi.spyOn(h.orch, "alert").mockImplementation((m: string) => void alerts.push(m));
    h.slotsTo(1_001);
    await h.settle();
    const before = refresh.mock.calls.length;
    // The announced retune: a bigger strike cut, funded from the epoch leg, layer unchanged.
    const retuned = await encode.config(makeConfig({ strike_fee_bps: 276, epoch_fee_bps: 68 }));
    h.source.account(satrushConfigPda(h.programId), retuned, 1_002, h.programId, "wallet");
    await h.settle(60);
    expect(h.state.satrushConfig?.strike_fee_bps).toBe(276);
    expect(alerts.some((a) => /strike_fee_bps 240→276/.test(a) && /epoch_fee_bps 104→68/.test(a))).toBe(true);
    expect(refresh.mock.calls.length).toBeGreaterThan(before);
    // The same values again: nothing to say.
    h.source.account(satrushConfigPda(h.programId), retuned, 1_003, h.programId, "wallet");
    await h.settle(30);
    expect(alerts.filter((a) => /config changed/.test(a))).toHaveLength(1);
  });
});
