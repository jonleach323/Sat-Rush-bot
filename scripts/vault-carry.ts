/**
 * pnpm vault-carry [rounds-back=1300] [step=30]
 *
 * The vault carry, measured — not read off the app. Both vaults keep the 10%
 * exit fee of every redemption, so holders' BTC-per-share (RUSH-per-share)
 * ratchets up whenever someone else claims. A settlement's
 * `btc_earned / sats_shares_earned` IS the vault ratio at that settle, so the
 * public API's per-round settlements give the share price per round without
 * touching RPC — a ratio measurement, which converges fast (CLAUDE.md).
 *
 * Prints: the price series, the daily drift with jumps (single-round steps —
 * whale exits) separated from the base rate, the implied fraction of the
 * vault that exited, what the carry adds per $ of gross deployed, and the
 * holding horizon at which it covers the board toll. Also the app's own
 * `apr` field, for comparison only.
 */
import { V2_LOSING_TILE_REFUND_BPS, V2_VAULT_EXIT_FEE_BPS } from "../src/strategy/facts.js";

const BASE = process.env["SATRUSH_API"] ?? "https://api.satrush.io/api/v1";
const BACK = Number(process.argv[2] ?? 1300);
const STEP = Number(process.argv[3] ?? 30);
const get = async <T>(p: string): Promise<T> => {
  const res = await fetch(`${BASE}/${p}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${p}`);
  return ((await res.json()) as { data: T }).data;
};
const num = (v: unknown): number => Number(v as string);
const pct = (x: number, d = 3): string => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(d)}%`;

interface Board { round_id: number; round_duration: number; prices: { btc: number; token: number }; sats_vault: { btc_amount: string; btc_shares: string; apr: number | null }; token_vault: { token_amount: string; token_shares: string; apr: number | null } }
interface Dep { btc_earned: string; sats_shares_earned: string; token_earned: string; token_shares_earned: string; settled_at: string | null; deployed_at: string }
interface Sample { id: number; at: number; sats: number | null; tok: number | null; n: number }

const board = await get<Board>("board");
const samples: Sample[] = [];
for (let id = board.round_id - 2; id > board.round_id - BACK; id -= STEP) {
  let r: { deployments?: Dep[] };
  try { r = await get(`rounds/${id}`); } catch { continue; }
  const ds = (r.deployments ?? []).filter((d) => d.settled_at);
  if (ds.length === 0) continue;
  const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  samples.push({
    id,
    at: Date.parse(ds[0]!.settled_at!),
    sats: mean(ds.filter((d) => num(d.sats_shares_earned) > 0).map((d) => num(d.btc_earned) / num(d.sats_shares_earned))),
    tok: mean(ds.filter((d) => num(d.token_shares_earned) > 0).map((d) => num(d.token_earned) / num(d.token_shares_earned))),
    n: ds.length,
  });
}
samples.reverse(); // oldest first

function series(name: string, pick: (s: Sample) => number | null, live: number, apr: number | null): { baseDaily: number; totalDaily: number } | null {
  const pts = samples.filter((s) => pick(s) !== null).map((s) => ({ id: s.id, at: s.at, p: pick(s) as number }));
  if (pts.length < 3) { console.log(`\n══ ${name}: too few samples (${pts.length}) ══`); return null; }
  const first = pts[0]!, last = pts[pts.length - 1]!;
  const days = (last.at - first.at) / 86400e3;
  console.log(`\n══ ${name} share price, ${pts.length} samples over ${days.toFixed(2)} d (rounds ${first.id}…${last.id}) ══`);
  // Split step changes (a single sampling interval moving > 0.5%) from drift.
  let jumpGrowth = 0; const jumps: string[] = [];
  let driftLog = 0; let driftMs = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const g = b.p / a.p - 1;
    if (g > 0.005) { jumpGrowth += Math.log1p(g); jumps.push(`${a.id}→${b.id} ${pct(g, 2)}`); }
    else { driftLog += Math.log1p(g); driftMs += b.at - a.at; }
  }
  const total = last.p / first.p - 1;
  const baseDaily = driftMs > 0 ? Math.expm1((driftLog / driftMs) * 86400e3) : 0;
  const totalDaily = days > 0 ? Math.expm1(Math.log1p(total) / days) : 0;
  const fee = V2_VAULT_EXIT_FEE_BPS.value / 1e4;
  // A fraction x of shares exiting at fee f lifts the survivors by f·x/(1−x).
  const exited = total / (fee + total);
  console.log(`  first ${first.p.toExponential(5)} → last ${last.p.toExponential(5)} · live ratio ${live.toExponential(5)}`);
  console.log(`  total ${pct(total, 3)} = drift ${pct(Math.expm1(driftLog), 3)} + steps ${pct(Math.expm1(jumpGrowth), 3)}${jumps.length ? ` (${jumps.join(", ")})` : ""}`);
  console.log(`  base drift ${pct(baseDaily, 3)}/day (${pct(baseDaily * 365, 0)} simple APR) · all-in ${pct(totalDaily, 3)}/day (${pct(totalDaily * 365, 0)})`);
  console.log(`  implies ${pct(exited, 1)} of the vault's shares exited in the window (10% fee retained) — a transfer from leavers, it shrinks as they run out`);
  // Per-6h buckets: the rate is lumpy (claims are discrete) and launch-day
  // exits dwarf the steady state; the reader needs the profile, not one number.
  const bucketMs = 6 * 3600e3;
  const rows: string[] = [];
  for (let t = first.at; t < last.at; t += bucketMs) {
    const inb = pts.filter((q) => q.at >= t && q.at < t + bucketMs);
    if (inb.length < 2) continue;
    const a = inb[0]!, b = inb[inb.length - 1]!;
    const dDays = (b.at - a.at) / 86400e3;
    if (dDays <= 0) continue;
    const daily = Math.expm1(Math.log(b.p / a.p) / dDays);
    rows.push(`    ${new Date(t).toISOString().slice(5, 16)}  ${pct(daily, 3).padStart(9)}/day  (rounds ${a.id}…${b.id})`);
  }
  if (rows.length) console.log(`  rate by 6h bucket:\n${rows.join("\n")}`);
  console.log(`  app's apr field: ${apr === null ? "n/a" : pct(apr / 100, 0)} (its window and method are not published)`);
  return { baseDaily, totalDaily };
}

const sats = series("SATS VAULT", (s) => s.sats, num(board.sats_vault.btc_amount) / num(board.sats_vault.btc_shares), board.sats_vault.apr);
const tok = series("TOKEN VAULT", (s) => s.tok, num(board.token_vault.token_amount) / num(board.token_vault.token_shares), board.token_vault.apr);

// What it is worth to a deploy. Per $ of gross at a uniform board, the sats
// leg every deployer expects is (5% + 89%/21)/21·21… = (1.05 + 0.89)/21 of gross
// whatever the mask (linear in stake), i.e. ≈ 9.2%; the RUSH legs are the
// token yield × 80%. Those are the shares the carry compounds on.
const r = V2_LOSING_TILE_REFUND_BPS.value / 1e4;
const satsLegPerUsd = (0.05 * 21 + r) / 21; // 0.05·V + r·W_win, pro rata, uniform board
const toll = { single: 0.041, fleet: 0.010 }; // FINDINGS E-v2-dryrun / v2-ledger (21 wallets)
console.log(`\n══ WHAT THE CARRY ADDS PER $ DEPLOYED ══`);
console.log(`  sats shares acquired per $ of gross (uniform board, any mask): ${pct(satsLegPerUsd, 2)} of gross`);
if (sats) {
  for (const [label, daily] of [["base drift", sats.baseDaily], ["all-in (launch churn incl.)", sats.totalDaily]] as const) {
    const perUsdDay = satsLegPerUsd * daily;
    console.log(`  ${label.padEnd(28)} ${pct(perUsdDay, 4)} of gross per day held → covers the 1-wallet toll (${pct(toll.single, 1)}) in ${(toll.single / perUsdDay).toFixed(0)} d, the 21-wallet toll (${pct(toll.fleet, 1)}) in ${(toll.fleet / perUsdDay).toFixed(0)} d`);
  }
  console.log(`  (BTC-denominated, before the 10% exit fee you would pay to realise it, and the rate decays as claimers run out)`);
}
if (tok) console.log(`  token vault: RUSH shares are ~1% of gross; at ${pct(tok.baseDaily, 2)}/day base drift that is ${pct(0.012 * tok.baseDaily, 4)} of gross per day`);
