import { describe, expect, it } from "vitest";
import { PNL_TABS, pnlKeyboard, renderPnlCard } from "../src/ops/pnl-cards.js";
import type { PnlSummary, PositionReport } from "../src/ops/telegram.js";
import { usdToBase } from "../src/units.js";

const pnl: PnlSummary = {
  date: "2026-09-22", deployed: usdToBase(1_234), returned: usdToBase(1_098.1), net: usdToBase(-135.9), feesPaid: usdToBase(7.4),
  unsettled: { legs: 21, grossUsd: 21, rounds: 1 }, sharesMarkedUsd: 12.3, markedNet: usdToBase(-123.6),
};
const pos: PositionReport = {
  wallets: 21, fleetUsdc: 35_120, fleetSol: 1.049, usdcUnclaimed: 12.3,
  satsShares: "1234567", btc: 0.01234, btcUsd: 1_055, tokenShares: "98765", rush: 24.5, rushUsd: 1_062,
  hashrateLiquid: 12_345, hashrateDeferred: 3_210, tickets: 155.55, totalUnclaimedUsd: 2_129.3, btcPrice: 85_500, rushPrice: 43.34,
  rate: { sampleHours: 22.3, settlements: 480, btcPerDay: 0.00041, rushPerDay: 0.82, hashratePerDay: 410, usdNetPerDay: -0.9, grossPerDay: 640 },
  carry: { sats: 0.003, token: 0.0024 }, carrySource: "live",
  apr: { sats: 1.095, token: 0.876, satsCompounded: 1.99, tokenCompounded: 1.4 },
  breakeven: { costBasisUsd: 2_600, holdingsUsd: 2_129.3, shortfallUsd: 470.7, blendedCarryDaily: 0.0027, days: 75, alreadyAhead: false, lifetimeDeployedUsd: 4_100, lifetimeReturnedUsd: 1_500 },
  vaults: { epoch: { iterationId: 16, myTickets: 1_234, totalTickets: 900_000, shareBps: 13.7, poolUsd: 9_583, slotsToClose: 120_000 }, oneBtc: { iterationId: 3, totalTickets: 231_393, prizeUsd: 85_500, fillBps: 1274 } },
  verdict: { days: 30, btc: { heldUsd: 1_154, claimedUsd: 949.5, holdEdgeUsd: 204.5, breakevenCarryDaily: -0.0035 }, rush: { heldUsd: 1_141, claimedUsd: 1_022, holdEdgeUsd: 119, breakevenCarryDaily: -0.0013 }, breakevenCarryDailyYear: { btc: -0.0003, rush: 0.002 }, holdWins: true, stakingYieldDaily: 0.00224 },
  projection: { days: 30, btc: 0.0257, rush: 52.1, tickets: 12_455, btcUsd: 2_197, rushUsd: 2_258, usdNet: -27, gainUsd: 2_311, carryUsd: 95 },
};

describe("/pnl cards", () => {
  it("every tab renders as HTML with one aligned table and no unescaped angle brackets", () => {
    for (const tab of PNL_TABS) {
      const html = renderPnlCard(tab, pnl, pos);
      expect(html.startsWith("<b>")).toBe(true);
      expect(html).toContain("<pre>");
      const inner = html.replace(/<\/?(b|i|pre)>/g, "");
      expect(inner).not.toMatch(/[<>]/);
    }
  });
  it("aligns values to the right of a fixed width", () => {
    const today = renderPnlCard("today", pnl, pos);
    expect(today).toMatch(/deployed\s+\$1,234\.00\n/);
    expect(today).toMatch(/net cash\s+-\$135\.90\n/);
    expect(today).toMatch(/unsettled legs\s+21 · \$21\.00/);
  });
  it("position shows shares, their conversions, hashrate as tickets and the live draws", () => {
    const p = renderPnlCard("position", pnl, pos);
    expect(p).toMatch(/BTC shares\s+1,234,567/);
    expect(p).toMatch(/= BTC\s+0\.012340/);
    expect(p).toMatch(/≈ tickets\s+155\.6/);
    expect(p).toMatch(/epoch #16\s+1,234 \/ 900,000 \(0\.14%\)/);
    expect(p).toMatch(/1-BTC #3\s+231,393 tix · 12\.7% full/);
    expect(p).toMatch(/unclaimed ≈\s+\$2,129\.30/);
  });
  it("hold and verdict tabs carry the projection and the break-even carry", () => {
    const h = renderPnlCard("hold", pnl, pos);
    expect(h).toContain("bot stopped");
    expect(h).toContain("+30d");
    expect(h).toMatch(/BTC\s+0\.012340\s+0\.025700/);
    expect(h).toMatch(/APR on BTC shares\s+109\.5% \(199\.0% comp\.\)/);
    expect(h).toMatch(/gain in 30d\s+\+\$2,311\.00/);
    expect(h).toMatch(/cost basis \(net\)\s+\$2,600\.00/);
    expect(h).toMatch(/break-even\s+75 d \(\d{4}-\d{2}-\d{2}\) at 0\.27%\/d/);
    const v = renderPnlCard("verdict", pnl, pos);
    expect(v).toContain("HOLD wins");
    expect(v).toMatch(/RUSH\s+HOLD \$119\.00/);
    expect(v).toContain("0.20%/d");
  });
  it("without a position the position tabs say so instead of throwing", () => {
    expect(renderPnlCard("position", pnl, null)).toContain("not available yet");
    expect(renderPnlCard("verdict", pnl, null)).toContain("not available yet");
  });
  it("the keyboard marks the active tab and covers all four", () => {
    const kb = pnlKeyboard("hold").inline_keyboard.flat();
    expect(kb).toHaveLength(4);
    expect(kb.map((b) => b.text)).toEqual(["Today", "Position", "• Bot stopped", "Hold vs claim"]);
    expect(kb.map((b) => (b as { callback_data: string }).callback_data)).toEqual(["pnl:today", "pnl:position", "pnl:hold", "pnl:verdict"]);
  });
});
