import { describe, expect, it } from "vitest";
import { EventLoopMonitor, JobTimer } from "../src/ops/loop-lag.js";

describe("EventLoopMonitor — a blocked loop has a number", () => {
  it("heartbeat drift records the worst block and counts blocks over the threshold", () => {
    let t = 0;
    const m = new EventLoopMonitor({ heartbeatMs: 1_000, blockThresholdMs: 1_000, now: () => t });
    m.start();
    for (const at of [1_000, 2_005, 3_010]) m.tick((t = at)); // healthy: ≤ 10 ms drift
    m.tick((t = 104_010)); // one 100 s block
    m.tick((t = 105_010));
    const s = m.snapshot();
    expect(s.worstBlockMs).toBe(100_000);
    expect(s.blocks).toBe(1);
    expect(m.worstEverMs).toBe(100_000);
    const again = m.snapshot(); // window reset, lifetime kept
    expect(again.worstBlockMs).toBe(0);
    expect(m.worstEverMs).toBe(100_000);
    m.stop();
  });
});

describe("JobTimer — a block has a name", () => {
  it("keeps last/max/mean per job, names the slowest job in the window, and flags a budget overrun", async () => {
    let t = 0;
    const slow: string[] = [];
    const j = new JobTimer({ now: () => t, onSlow: (name, ms) => slow.push(`${name}:${ms}`) });
    await j.timed("treasury", async () => { t += 40; }, 1_000);
    j.timedSync("refresh", () => { t += 3_000; }, 1_000);
    await j.timed("treasury", async () => { t += 60; }, 1_000);
    const s = j.stats();
    expect(s["treasury"]).toMatchObject({ count: 2, lastMs: 60, maxMs: 60, meanMs: 50 });
    expect(s["refresh"]).toMatchObject({ count: 1, maxMs: 3_000 });
    expect(slow).toEqual(["refresh:3000"]);
    expect(j.window()).toEqual({ name: "refresh", ms: 3_000 });
    expect(j.window()).toBeNull(); // window reset
  });
});
