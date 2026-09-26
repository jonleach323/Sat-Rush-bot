/**
 * The /pnl cards: four tabs (today · position · 30-day hold · hold vs
 * claim) rendered as Telegram HTML — a bold title, one aligned monospace
 * table per card, one footnote — switched with an inline keyboard instead
 * of one long message. Pure: the orchestrator's reports in, HTML out.
 */
import { InlineKeyboard } from "grammy";
import type { PnlSummary, PositionReport } from "./telegram.js";

export type PnlTab = "today" | "position" | "hold" | "verdict";
export const PNL_TABS: readonly PnlTab[] = ["today", "position", "hold", "verdict"];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const money = (n: number, d = 2) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const num = (n: number, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (n: number, d = 2) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const pctd = (x: number) => `${(x * 100).toFixed(2)}%/d`;
const base = (v: bigint) => Number(v) / 1e6;
/** Share counts run to 14 digits; show them compactly so the table keeps its width. */
const compact = (n: number) => {
  const a = Math.abs(n);
  for (const [d, s] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "k"]] as const) if (a >= d) return `${(n / d).toFixed(2)}${s}`;
  return num(n);
};

/** Two-column table: labels left, values right, padded to one width. */
function table(rows: (readonly [string, string])[], width = 30): string {
  const lines = rows.map(([l, v]) => {
    const pad = Math.max(1, width - l.length - v.length);
    return `${l}${" ".repeat(pad)}${v}`;
  });
  return `<pre>${esc(lines.join("\n"))}</pre>`;
}

/** Three-column table for now/later comparisons. */
function table3(head: readonly [string, string, string], rows: (readonly [string, string, string])[], w: readonly [number, number, number] = [10, 10, 10]): string {
  const row = (r: readonly [string, string, string]) => r[0].padEnd(w[0]) + r[1].padStart(w[1]) + r[2].padStart(w[2]);
  return `<pre>${esc([row(head), ...rows.map(row)].join("\n"))}</pre>`;
}

export function renderPnlCard(tab: PnlTab, pnl: PnlSummary, pos: PositionReport | null): string {
  switch (tab) {
    case "today": {
      const rows: (readonly [string, string])[] = [
        ["deployed", money(base(pnl.deployed))],
        ["returned (settled)", money(base(pnl.returned))],
        ["net cash", money(base(pnl.net))],
        ["fees", money(base(pnl.feesPaid))],
      ];
      if (pnl.unsettled && pnl.unsettled.legs > 0) rows.push(["unsettled legs", `${pnl.unsettled.legs} · ${money(pnl.unsettled.grossUsd)}`]);
      if (pnl.sharesMarkedUsd !== undefined) rows.push(["shares won", signed(pnl.sharesMarkedUsd)]);
      if (pnl.markedNet !== undefined) rows.push(["marked net", money(base(pnl.markedNet))]);
      return `<b>📊 Today</b> · ${esc(pnl.date)} UTC\n${table(rows)}\n` +
        (pnl.unsettled && pnl.unsettled.legs > 0 ? `<i>unsettled legs sit in their deployment accounts until settled; 89% comes back</i>` : "");
    }
    case "position": {
      if (!pos) return "<b>💰 Position</b>\n<i>not available yet</i>";
      const rows: (readonly [string, string])[] = [
        ...(pos.totalUsd !== undefined
          ? [
              ["TOTAL", money(pos.totalUsd)] as const,
              ...(pos.hashrateUsd !== undefined && pos.hashrateUsd > 0 ? [["  + hashrate ≈", money(pos.hashrateUsd)] as const, ["  = with hashrate", money(pos.totalUsd + pos.hashrateUsd)] as const] : []),
              ["", ""] as const,
            ]
          : []),
        ["USDC in wallets", money(pos.fleetUsdc)],
        ["USDC unclaimed", money(pos.usdcUnclaimed)],
        ["SOL", pos.fleetSolUsd !== undefined ? `${num(pos.fleetSol, 3)} · ${money(pos.fleetSolUsd)}` : num(pos.fleetSol, 3)],
        ["", ""],
        ["BTC shares", compact(Number(pos.satsShares))],
        ["  = BTC", num(pos.btc, 6)],
        ["  ≈ USD", money(pos.btcUsd)],
        ["RUSH shares", compact(Number(pos.tokenShares))],
        ["  = RUSH", num(pos.rush, 3)],
        ["  ≈ USD", money(pos.rushUsd)],
        ["", ""],
        ["hashrate", compact(pos.hashrateLiquid)],
        ["  deferred", compact(pos.hashrateDeferred)],
        ["  ≈ tickets", num(pos.tickets, 1)],
      ];
      if (pos.vaults?.epoch) {
        const e = pos.vaults.epoch;
        rows.push([`epoch #${e.iterationId}`, `${num(e.myTickets)} / ${num(e.totalTickets)} (${(e.shareBps / 100).toFixed(2)}%)`]);
        rows.push(["  pool · closes", `${money(e.poolUsd, 0)} · ${num(e.slotsToClose)} slots`]);
      }
      if (pos.vaults?.oneBtc) {
        const o = pos.vaults.oneBtc;
        rows.push([`1-BTC #${o.iterationId}`, `${num(o.totalTickets)} tix · ${(o.fillBps / 100).toFixed(1)}% full`]);
      }
      rows.push(["", ""], ["unclaimed ≈", money(pos.totalUnclaimedUsd)]);
      return `<b>💰 Position</b> · ${pos.wallets} wallets · BTC ${money(pos.btcPrice, 0)} · RUSH ${money(pos.rushPrice)}\n${table(rows)}\n` +
        `<i>TOTAL is wallets + SOL + everything unclaimed. Hashrate is marked at a ticket carried to next week's draw; the deferred part is released by a BTC claim.</i>`;
    }
    case "hold": {
      if (!pos) return "<b>📈 Unclaimed, bot stopped</b>\n<i>not available yet</i>";
      const p = pos.projection, r = pos.rate, a = pos.apr;
      const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
      const t = table3(["", "now", `+${p.days}d`], [
        ["BTC", num(pos.btc, 6), num(p.btc, 6)],
        ["RUSH", num(pos.rush, 3), num(p.rush, 3)],
        ["BTC $", money(pos.btcUsd, 0), money(p.btcUsd, 0)],
        ["RUSH $", money(pos.rushUsd, 0), money(p.rushUsd, 0)],
      ], [8, 11, 11]);
      const rows: (readonly [string, string])[] = [
        ["APR on BTC shares", `${pct(a.sats)} (${pct(a.satsCompounded)} comp.)`],
        ["APR on RUSH shares", `${pct(a.token)} (${pct(a.tokenCompounded)} comp.)`],
        ["", ""],
        [`gain in ${p.days}d`, signed(p.gainUsd)],
        ["  BTC", `+${num(p.btc - pos.btc, 6)}`],
        ["  RUSH", `+${num(p.rush - pos.rush, 3)}`],
        ["", ""],
        ["cash in, all time", money(pos.breakeven.lifetimeDeployedUsd, 0)],
        ["cash back, all time", money(pos.breakeven.lifetimeReturnedUsd, 0)],
        ["cost basis (net)", money(pos.breakeven.costBasisUsd)],
        ["holdings now", money(pos.breakeven.holdingsUsd)],
        ["break-even", breakevenText(pos.breakeven)],
      ];
      return `<b>📈 Unclaimed, bot stopped</b> · what the holdings earn on their own\n${t}${table(rows)}\n` +
        `<i>vault carry ${pctd(pos.carry.sats)} BTC · ${pctd(pos.carry.token)} RUSH (${pos.carrySource}): the exit fees of those who claim, paid to those who stay; prices held. While the bot runs it adds +${num(r.btcPerDay, 6)} BTC · +${num(r.rushPerDay, 3)} RUSH a day at the last ${r.sampleHours.toFixed(0)} h rate.</i>`;
    }
    case "verdict": {
      if (!pos) return "<b>⚖️ Hold vs claim</b>\n<i>not available yet</i>";
      const v = pos.verdict;
      const t = table3(["", "hold", "claim"], [
        ["BTC", money(v.btc.heldUsd, 0), money(v.btc.claimedUsd, 0)],
        ["RUSH", money(v.rush.heldUsd, 0), money(v.rush.claimedUsd, 0)],
      ], [8, 11, 11]);
      const rows: (readonly [string, string])[] = [
        ["BTC", `${v.btc.holdEdgeUsd >= 0 ? "HOLD" : "CLAIM"} ${signed(Math.abs(v.btc.holdEdgeUsd)).replace("+", "")}`],
        ["RUSH", `${v.rush.holdEdgeUsd >= 0 ? "HOLD" : "CLAIM+STAKE"} ${signed(Math.abs(v.rush.holdEdgeUsd)).replace("+", "")}`],
        ["", ""],
        ...(v.deferredHashrate && v.deferredHashrate > 0
          ? [["BTC claim releases", `${num(v.deferredHashrate)} hashrate ≈ ${money(v.deferredReleaseUsd ?? 0)}`] as const]
          : []),
        ["carry now", `${pctd(pos.carry.sats)} · ${pctd(pos.carry.token)}`],
        [`claim wins if <  (${v.days}d)`, `${pctd(v.btc.breakevenCarryDaily)} · ${pctd(v.rush.breakevenCarryDaily)}`],
        ["claim wins if <  (1y)", `${pctd(v.breakevenCarryDailyYear.btc)} · ${pctd(v.breakevenCarryDailyYear.rush)}`],
      ];
      return `<b>⚖️ Hold vs claim</b> · ${v.days} days · ${v.holdWins ? "HOLD wins" : "CLAIMING wins"}\n${t}${table(rows)}\n` +
        `<i>claim pays the 10% exit fee once and a BTC claim releases the deferred hashrate (counted in "claim"); RUSH then stakes at ${pctd(v.stakingYieldDaily)}; the bot never claims by itself</i>`;
    }
    default:
      return "";
  }
}

function breakevenText(b: PositionReport["breakeven"]): string {
  if (b.alreadyAhead) return `ahead by ${money(-b.shortfallUsd)}`;
  if (b.days === null) return "never on carry alone";
  const when = new Date(Date.now() + b.days * 86_400_000).toISOString().slice(0, 10);
  return `${b.days} d (${when}) at ${(b.blendedCarryDaily * 100).toFixed(2)}%/d`;
}

export function pnlKeyboard(active: PnlTab): InlineKeyboard {
  const label = (t: PnlTab, text: string) => (t === active ? `• ${text}` : text);
  return new InlineKeyboard()
    .text(label("today", "Today"), "pnl:today")
    .text(label("position", "Position"), "pnl:position")
    .row()
    .text(label("hold", "Bot stopped"), "pnl:hold")
    .text(label("verdict", "Hold vs claim"), "pnl:verdict");
}
