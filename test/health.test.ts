import { describe, expect, it } from "vitest";
import { HealthMonitor, type HealthDeps } from "../src/ops/health.js";

function makeDeps(overrides: Partial<HealthDeps> = {}) {
  const alerts: string[] = [];
  const deps: HealthDeps = {
    ingestStale: () => false,
    ingestSlotAgeMs: () => 100,
    snapshotSlot: () => 1000,
    rpcSlot: async () => 1005,
    solBalanceLamports: async () => 50_000_000,
    dbLastWriteError: () => null,
    alert: (m) => void alerts.push(m),
    ...overrides,
  };
  return { deps, alerts };
}

describe("HealthMonitor", () => {
  it("healthy system produces no issues", async () => {
    const { deps, alerts } = makeDeps();
    const monitor = new HealthMonitor(deps, { solFloorLamports: 20_000_000 });
    expect(await monitor.check()).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it("flags ingest staleness", async () => {
    const { deps, alerts } = makeDeps({
      ingestStale: () => true,
      ingestSlotAgeMs: () => 4200,
    });
    const monitor = new HealthMonitor(deps, { solFloorLamports: 0 });
    const issues = await monitor.check();
    expect(issues.map((i) => i.key)).toEqual(["ingest_stale"]);
    expect(alerts[0]).toContain("4200ms");
  });

  it("flags slot lag beyond threshold", async () => {
    const { deps, alerts } = makeDeps({ rpcSlot: async () => 1100 });
    const monitor = new HealthMonitor(deps, {
      solFloorLamports: 0,
      slotLagThreshold: 50,
    });
    const issues = await monitor.check();
    expect(issues.map((i) => i.key)).toEqual(["slot_lag"]);
    expect(alerts[0]).toContain("100 slots");
  });

  it("flags low SOL and DB write failures", async () => {
    const { deps, alerts } = makeDeps({
      solBalanceLamports: async () => 5_000_000,
      dbLastWriteError: () => "SQLITE_FULL",
    });
    const monitor = new HealthMonitor(deps, { solFloorLamports: 20_000_000 });
    const issues = await monitor.check();
    expect(issues.map((i) => i.key).sort()).toEqual(["db_write_error", "sol_low"]);
    expect(alerts).toHaveLength(2);
  });

  it("flags low USDC against the funding floor when wired", async () => {
    const { deps, alerts } = makeDeps({
      usdcBalanceBaseUnits: async () => 3_000_000n, // $3
    });
    const monitor = new HealthMonitor(deps, {
      solFloorLamports: 0,
      usdcFloorBaseUnits: 5_000_000n, // $5 = MAX_PER_ROUND
    });
    const issues = await monitor.check();
    expect(issues.map((i) => i.key)).toEqual(["usdc_low"]);
    expect(alerts[0]).toContain("top up the float");
    // not wired → no check
    const { deps: bare } = makeDeps();
    const bareMonitor = new HealthMonitor(bare, {
      solFloorLamports: 0,
      usdcFloorBaseUnits: 5_000_000n,
    });
    expect(await bareMonitor.check()).toEqual([]);
  });

  it("debounces repeat alerts per key, re-alerts after the window", async () => {
    let t = 0;
    const { deps, alerts } = makeDeps({ ingestStale: () => true });
    const monitor = new HealthMonitor(deps, {
      solFloorLamports: 0,
      debounceMs: 60_000,
      now: () => t,
    });
    await monitor.check();
    t += 10_000;
    await monitor.check(); // inside window → no new alert
    expect(alerts).toHaveLength(1);
    t += 61_000;
    await monitor.check(); // window passed → alert again
    expect(alerts).toHaveLength(2);
  });

  it("survives RPC failures without alert storms", async () => {
    const { deps, alerts } = makeDeps({
      rpcSlot: async () => {
        throw new Error("rpc down");
      },
      solBalanceLamports: async () => {
        throw new Error("rpc down");
      },
    });
    const monitor = new HealthMonitor(deps, { solFloorLamports: 20_000_000 });
    expect(await monitor.check()).toEqual([]);
    expect(alerts).toEqual([]);
  });
});
