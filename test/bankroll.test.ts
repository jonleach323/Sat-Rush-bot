import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Bankroll,
  strikeSizeMultiplier,
  type BankrollConfig,
} from "../src/strategy/bankroll.js";
import { usdToBase } from "../src/units.js";

function bankroll(
  overrides: Partial<BankrollConfig> = {},
  lossToday: bigint = 0n,
): Bankroll {
  return new Bankroll(
    {
      ladder: [usdToBase(1), usdToBase(2), usdToBase(5)],
      maxPerRound: usdToBase(5),
      dailyLossCap: usdToBase(20),
      minDeploy: usdToBase(1),
      ...overrides,
    },
    { realizedLossToday: () => lossToday },
  );
}

describe("ladder quantization", () => {
  it("floors to the smallest ladder unit and clamps to MAX_PER_ROUND", () => {
    const b = bankroll();
    expect(b.quantize(usdToBase(3.7))).toBe(usdToBase(3));
    expect(b.quantize(usdToBase(0.5))).toBe(0n); // below quantum
    expect(b.quantize(usdToBase(50))).toBe(usdToBase(5)); // clamped
    expect(b.quantize(0n)).toBe(0n);
  });

  it("quantization respects min deploy via authorize", () => {
    const b = bankroll({ minDeploy: usdToBase(2) });
    // $1.9 quantizes to $1 < min $2 → blocked.
    expect(b.authorize(1, usdToBase(1.9))).toMatchObject({
      ok: false,
      reason: "below_min_deploy",
    });
    // $2.4 quantizes to $2 = min → allowed.
    expect(b.authorize(1, usdToBase(2.4))).toMatchObject({
      ok: true,
      amountGross: usdToBase(2),
    });
  });
});

describe("caps and latches", () => {
  it("allows a normal deployment and never exceeds MAX_PER_ROUND", () => {
    const auth = bankroll().authorize(10, usdToBase(100));
    expect(auth).toMatchObject({ ok: true, amountGross: usdToBase(5) });
  });

  it("one-deployment-per-round latch", () => {
    const b = bankroll();
    expect(b.authorize(7, usdToBase(2)).ok).toBe(true);
    b.commit(7);
    expect(b.authorize(7, usdToBase(2))).toMatchObject({
      ok: false,
      reason: "already_deployed_this_round",
    });
    expect(b.authorize(8, usdToBase(2)).ok).toBe(true); // next round fine
    b.release(7); // verifiably-never-sent path
    expect(b.authorize(7, usdToBase(2)).ok).toBe(true);
  });

  it("daily loss cap blocks conservatively (stake counted as potential loss)", () => {
    const b = bankroll({}, usdToBase(18)); // $18 lost today, cap $20
    expect(b.authorize(1, usdToBase(2)).ok).toBe(true); // 18+2 = 20 ≤ cap
    expect(b.authorize(2, usdToBase(3))).toMatchObject({
      ok: false,
      reason: "daily_loss_cap_reached",
    });
  });

  it("rejects zero/negative amounts", () => {
    expect(bankroll().authorize(1, 0n)).toMatchObject({
      ok: false,
      reason: "amount_not_positive",
    });
  });
});

describe("kill switch", () => {
  it("in-memory trip blocks everything", () => {
    const b = bankroll();
    b.tripKillSwitch("HaltError: tile stake decreased");
    expect(b.killSwitchEngaged()).toBe(true);
    expect(b.authorize(1, usdToBase(2))).toMatchObject({
      ok: false,
      reason: "kill_switch_engaged",
    });
    expect(b.killSwitchReason()).toContain("HaltError");
  });

  it("kill file on disk blocks everything, and lifts when removed", () => {
    const dir = mkdtempSync(join(tmpdir(), "satrush-kill-"));
    const killFile = join(dir, "KILL");
    const b = bankroll({ killSwitchFile: killFile });
    expect(b.authorize(1, usdToBase(2)).ok).toBe(true);
    writeFileSync(killFile, "stop");
    expect(b.killSwitchEngaged()).toBe(true);
    expect(b.authorize(2, usdToBase(2))).toMatchObject({
      ok: false,
      reason: "kill_switch_engaged",
    });
    rmSync(killFile);
    expect(b.killSwitchEngaged()).toBe(false);
    expect(b.authorize(3, usdToBase(2)).ok).toBe(true);
  });
});

describe("strike conditioning hook", () => {
  const opts = { thresholdBaseUnits: usdToBase(100), boost: 1.5 };

  it("is inert below the threshold and boost=1", () => {
    expect(strikeSizeMultiplier(usdToBase(50), opts)).toBe(1);
    expect(
      strikeSizeMultiplier(usdToBase(500), { ...opts, boost: 1 }),
    ).toBe(1);
  });

  it("scales above the threshold", () => {
    expect(strikeSizeMultiplier(usdToBase(500), opts)).toBe(1.5);
  });

  it("rejects invalid boost", () => {
    expect(() => strikeSizeMultiplier(0n, { ...opts, boost: 0 })).toThrow(RangeError);
  });
});
