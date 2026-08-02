/**
 * Restart-recovery: after a mid-round restart the in-memory latch is empty,
 * but re-arming it from the DB must prevent a duplicate deploy into a round
 * already played. This test reproduces the boot-time recovery step.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateDb } from "../src/state/db.js";
import { Bankroll } from "../src/strategy/bankroll.js";
import { usdToBase } from "../src/units.js";

function dbPath() {
  return join(mkdtempSync(join(tmpdir(), "satrush-rec-")), "t.db");
}

function makeBankroll() {
  return new Bankroll(
    { ladder: [usdToBase(1)], maxPerRound: usdToBase(5), dailyLossCap: usdToBase(50), minDeploy: usdToBase(1) },
    { realizedLossToday: () => 0n },
  );
}

// Mirror the boot() recovery step.
function rearmLatch(db: StateDb, bankroll: Bankroll) {
  for (const r of db.query<{ round_id: number }>(
    "SELECT DISTINCT round_id FROM my_deploys WHERE status IN ('fired','landed')",
  )) {
    bankroll.commit(r.round_id);
  }
}

describe("restart recovery", () => {
  it("re-arms the latch from the DB so a played round cannot be re-deployed", () => {
    const path = dbPath();
    // ── session 1: deploy round 800, then "crash" ──
    const db1 = new StateDb(path);
    db1.recordMyDeploy({
      roundId: 800,
      mask: 1,
      amount: usdToBase(5),
      evExpected: 0.1,
      firedSlot: 10,
      sig: "sig-800",
      status: "landed",
    });
    db1.close();

    // ── session 2: fresh process, empty in-memory latch ──
    const db2 = new StateDb(path);
    const bankroll = makeBankroll();
    expect(bankroll.hasDeployed(800)).toBe(false); // latch is empty on boot
    rearmLatch(db2, bankroll);
    expect(bankroll.hasDeployed(800)).toBe(true); // recovered from DB

    // a re-fire attempt into round 800 is now refused
    expect(bankroll.tryCommit(800)).toBe(false);
    expect(bankroll.authorize(800, usdToBase(5))).toMatchObject({
      ok: false,
      reason: "already_deployed_this_round",
    });
    // a fresh round is still allowed
    expect(bankroll.authorize(801, usdToBase(5)).ok).toBe(true);
    db2.close();
  });
});
