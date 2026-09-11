/**
 * Is holding sats-vault shares actually +EV, measured across the field?
 *
 * The claim being tested: the 10% claim fee stays in the vault, so wallets that
 * never claim collect from wallets that do, and that carry might exceed the
 * rake. A single-wallet reading suggested +35.31% appreciation, which would
 * have made the whole game +EV.
 *
 * It does not survive the field. Current BTC-per-share is ONE GLOBAL RATIO —
 * verified identical across every wallet checked — so a wallet's appreciation
 * is exactly `current ratio / average ratio when it received its shares - 1`.
 * Measured across the top wallets by deployed volume, the median is about 5%,
 * not 35%, and the single-wallet reading is several standard deviations out
 * with no explanation for it.
 *
 * Which settles the EV question. The sats leg is 12% of volume, so break-even
 * against the rake needs appreciation of roughly 28%. The field gets 5%.
 *
 * This script exists because the outlier was reported as a finding before being
 * checked against the field — the same mistake, in the same session, as the
 * -25.45% that had a +/-28.6 point error bar.
 *
 *   pnpm carry-check
 */
import { formatEstimate, significant, type Estimate } from "../../src/strategy/facts.js";

const BASE = process.env["SATRUSH_API"] ?? "https://api.satrush.io/api/v1";
const OURS = process.env["OPERATOR_WALLET"]
  ?? "8EHb675bVwz3nrAUssQfdKx8665WjkU5wZcykvqtii5J";

interface Lb { authority: string }
interface ApiConfig {
  strike_fee_bps: number; epoch_fee_bps: number; one_btc_fee_bps: number;
  protocol_fee_bps: number; sats_vault_round_fee_bps: number;
  vault_exit_fee_bps: number;
}
interface Stats {
  deployedUsd: number; satsShares: string; satsBtc: number;
  costBasisBtc: number; rounds: number;
}

const conf = await (await fetch(`${BASE}/config`)).json()
  .then((j) => (j as { data: ApiConfig }).data);
const lb = await (await fetch(`${BASE}/leaderboard/hashrate-earned?limit=50`)).json()
  .then((j) => (j as { data: Lb[] }).data);

const wallets = [...new Set([...lb.map((r) => r.authority), OURS])];
const results = await Promise.all(wallets.map(async (w) => {
  try {
    const s = await (await fetch(`https://satstats.app/api/user/${w}`)).json() as Stats;
    const shares = Number(s.satsShares);
    if (!(shares > 0) || !(s.costBasisBtc > 0)) return null;
    return {
      w, shares, deployed: s.deployedUsd, rounds: s.rounds,
      nowRatio: s.satsBtc / shares,
      basisRatio: s.costBasisBtc / shares,
      appr: s.satsBtc / s.costBasisBtc - 1,
    };
  } catch { return null; }
}));
const rows = results.filter((r): r is NonNullable<typeof r> => r !== null);
const mine = rows.find((r) => r.w === OURS);
const field = rows.filter((r) => r.w !== OURS);

// ── the ratio is global, so appreciation is purely a timing effect ──────────
const ratios = rows.map((r) => r.nowRatio);
console.log(`══ IS BTC-PER-SHARE A SINGLE GLOBAL RATIO? ══`);
console.log(`  across ${rows.length} wallets: ${Math.min(...ratios).toExponential(6)} … ` +
  `${Math.max(...ratios).toExponential(6)}`);
console.log(`  ${Math.max(...ratios) / Math.min(...ratios) < 1.0001
  ? "YES — one vault ratio, so appreciation is only about WHEN you received shares"
  : "NO — something else is going on"}\n`);

// ── the field's appreciation, with an error bar ─────────────────────────────
const a = field.map((r) => 100 * r.appr).sort((x, y) => x - y);
const mean = a.reduce((s, x) => s + x, 0) / a.length;
const sd = Math.sqrt(a.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, a.length - 1));
const apprEst: Estimate = { value: mean, stderr: sd / Math.sqrt(a.length), n: a.length };

console.log(`══ FIELD APPRECIATION ══`);
console.log(`  ${formatEstimate(apprEst, "%")}`);
console.log(`  median ${a[Math.floor(a.length / 2)]!.toFixed(2)}%  ·  ` +
  `range ${a[0]!.toFixed(2)}% … ${a[a.length - 1]!.toFixed(2)}%  ·  sd ${sd.toFixed(2)}%`);
if (mine) {
  const z = (100 * mine.appr - mean) / sd;
  console.log(`\n  our wallet: ${(100 * mine.appr).toFixed(2)}%  →  z = ${z.toFixed(2)}`);
  console.log(`  basis ratio ${mine.basisRatio.toExponential(6)} vs field median ` +
    `${field.map((r) => r.basisRatio).sort((x, y) => x - y)[Math.floor(field.length / 2)]!.toExponential(6)}`);
  if (Math.abs(z) > 2) {
    console.log(`  UNEXPLAINED OUTLIER. Our basis is below wallets with far longer`);
    console.log(`  histories, which a monotonically rising ratio cannot produce.`);
    console.log(`  Do not size off it — use the field figure.`);
  }
}

// ── the EV question ─────────────────────────────────────────────────────────
const B = (bps: number): number => bps / 1e4;
const SATS = B(conf.sats_vault_round_fee_bps);
// v2 all-in rake for a single-tile miner, from scripts/v2-edge.ts.
const RAKE = Number(process.env["V2_RAKE"] ?? 0.0333);
const breakEven = RAKE / SATS;

console.log(`\n══ DOES THE CARRY COVER THE RAKE? ══`);
console.log(`  the sats leg is ${(100 * SATS).toFixed(0)}% of volume, and the v2 rake is ` +
  `${(100 * RAKE).toFixed(2)}% of volume`);
console.log(`  → break-even needs appreciation of ${(100 * breakEven).toFixed(1)}%\n`);
console.log("  appreciation source        value     carry as % of volume   net vs rake");
const cases: [string, number][] = [
  ["field mean", mean / 100],
  ["field median", a[Math.floor(a.length / 2)]! / 100],
  ["field best wallet", a[a.length - 1]! / 100],
  ...(mine ? [["our wallet (outlier)", mine.appr] as [string, number]] : []),
  ["break-even", breakEven],
];
for (const [label, v] of cases) {
  const carry = SATS * v;
  const net = carry - RAKE;
  console.log(`  ${label.padEnd(24)} ${(100 * v).toFixed(2).padStart(6)}%   ` +
    `${(100 * carry).toFixed(3).padStart(19)}%   ` +
    `${(net >= 0 ? "+" : "") + (100 * net).toFixed(2)}%`);
}

const verdict = SATS * (mean / 100) - RAKE;
console.log(`\n══ VERDICT ══`);
console.log(`  Holding shares is worth ${(100 * SATS * mean / 100).toFixed(2)}% of volume at the field rate.`);
console.log(`  The rake is ${(100 * RAKE).toFixed(2)}%. Net ${(100 * verdict).toFixed(2)}% — ` +
  `${verdict > 0 ? "POSITIVE" : "NEGATIVE"}.`);
console.log(`\n  Never claiming is still strictly better than claiming: it is free and`);
console.log(`  the carry is real. It just does not come close to covering the rake,`);
console.log(`  and it CANNOT, because it is funded by other players' claim fees —`);
console.log(`  a pool that shrinks as the field learns the same thing.`);
console.log(`\n  significant against zero? ${significant(apprEst, 0) ? "yes" : "no"} — the carry exists.`);
console.log(`  significant against break-even ${(100 * breakEven).toFixed(0)}%? ` +
  `${significant(apprEst, 100 * breakEven) ? "yes, and it is BELOW it" : "unresolved"}`);
