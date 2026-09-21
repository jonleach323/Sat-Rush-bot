/**
 * pnpm strike-payout [rounds-back=14000]
 *
 * What fraction of the Sat Strike pot actually pays out when it fires, and
 * what happens to the rest. STRIKE_PAYOUT_FRACTION was a STATED 0.70 (owner,
 * 2026-08-15, V1); the V2 rounds API exposes the split per strike round:
 * `strike_bonus_*` (paid to the winning tile's stakers pro rata),
 * `strike_reserve_*` (retained) and `strike_seed_from_reserve_*` (what the
 * retained reserve seeds into the NEXT pot). Pages the rounds list back with
 * `before`, keeps every `is_sat_strike` round, and prints per-leg payout
 * fractions, the seeding, and the strike interval against the on-chain modulus.
 */
import { readSatrushConfig } from "./lib/onchain.js";
import { STRIKE_TRIGGER_MODULUS } from "../src/strategy/facts.js";
const BASE = process.env["SATRUSH_API"] ?? "https://api.satrush.io/api/v1";
const BACK = Number(process.argv[2] ?? 14000);
const get = async <T>(p: string): Promise<T> =>
  ((await (await fetch(`${BASE}/${p}`, { signal: AbortSignal.timeout(30_000) })).json()) as { data: T }).data;
interface Row { id: number; state: string; is_sat_strike: boolean | null; total_gross_deployed_usd: string; strike_fee_usd: string;
  strike_bonus_usd: string; strike_bonus_btc: string; strike_bonus_token: string; strike_reserve_usd: string; strike_reserve_btc: string; strike_reserve_token: string;
  strike_seed_from_reserve_usd: string; strike_seed_from_reserve_btc: string; strike_seed_from_reserve_token: string; strike_epoch_usd: string; strike_epoch_btc: string; strike_epoch_token: string; strike_bonus_combined_usd: number | null; started_at: string | null }
const [first, conf, chain] = await Promise.all([get<Row[]>("rounds?limit=1"), get<{ strike_fee_bps: number }>("config"), readSatrushConfig()]);
const modulus = chain?.strike_trigger_modulus ?? STRIKE_TRIGGER_MODULUS.value;
if (!chain) console.log(`(on-chain config unreadable — modulus from the ${STRIKE_TRIGGER_MODULUS.value} snapshot)`);
const head = first[0]!.id;
const strikes: Row[] = [];
let feeUsd = 0, rounds = 0, before = head + 1;
const stop = head - BACK;
while (before > stop) {
  const page = await get<Row[]>(`rounds?limit=100&before=${before}`);
  if (page.length === 0) break;
  for (const r of page) {
    if (r.state !== "finished") continue;
    rounds++; feeUsd += (Number(r.total_gross_deployed_usd) / 1e6) * (conf.strike_fee_bps / 1e4);
    if (r.is_sat_strike) strikes.push(r);
  }
  before = page[page.length - 1]!.id;
}
const n = (s: string, d: number) => Number(s) / 10 ** d;
const pct = (x: number, d = 1) => `${(100 * x).toFixed(d)}%`;
console.log(`rounds ${stop + 1}…${head} (${rounds} finished): ${strikes.length} strikes → one per ${(rounds / Math.max(1, strikes.length)).toFixed(0)} rounds (on-chain modulus ${modulus} → expected one per ${modulus}); strike fee collected $${feeUsd.toFixed(0)} (${conf.strike_fee_bps} bps × gross)`);
console.log(`\n  round    gross    bonus USD   reserve   seeded next   payout USD   payout BTC   payout RUSH   epoch leg   date`);
const fr: number[] = [];
let bonusCombinedTotal = 0;
for (const r of strikes) {
  const bU = n(r.strike_bonus_usd, 6), rU = n(r.strike_reserve_usd, 6), sU = n(r.strike_seed_from_reserve_usd, 6), eU = n(r.strike_epoch_usd, 6);
  const bB = n(r.strike_bonus_btc, 8), rB = n(r.strike_reserve_btc, 8);
  const bT = n(r.strike_bonus_token, 9), rT = n(r.strike_reserve_token, 9);
  const fU = bU / (bU + rU + eU), fB = bB + rB > 0 ? bB / (bB + rB + n(r.strike_epoch_btc, 8)) : NaN, fT = bT + rT > 0 ? bT / (bT + rT + n(r.strike_epoch_token, 9)) : NaN;
  fr.push(fU); bonusCombinedTotal += r.strike_bonus_combined_usd ?? bU;
  console.log(`  ${r.id}   $${n(r.total_gross_deployed_usd, 6).toFixed(0).padStart(5)}   ${("$" + bU.toFixed(0)).padStart(9)}   ${("$" + rU.toFixed(0)).padStart(7)}   ${("$" + sU.toFixed(0)).padStart(11)}   ${pct(fU).padStart(10)}   ${(Number.isNaN(fB) ? "—" : pct(fB)).padStart(10)}   ${(Number.isNaN(fT) ? "—" : pct(fT)).padStart(11)}   ${("$" + eU.toFixed(0)).padStart(9)}   ${(r.started_at ?? "").slice(0, 10)}`);
}
if (fr.length > 0) {
  const mean = fr.reduce((a, b) => a + b, 0) / fr.length;
  const sd = Math.sqrt(fr.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, fr.length - 1));
  console.log(`\n  payout fraction at trigger: mean ${pct(mean, 2)} ± ${pct(sd / Math.sqrt(fr.length), 2)} (n = ${fr.length}, sd ${pct(sd, 2)})`);
  console.log(`  the retained reserve is SEEDED into the next pot (seed column), so the long-run payout of the strike fee is ~100% less only the reserve outstanding at any moment.`);
  console.log(`  conservation: bonuses paid (all legs, combined USD) $${bonusCombinedTotal.toFixed(0)} vs strike fee collected $${feeUsd.toFixed(0)} = ${pct(bonusCombinedTotal / feeUsd)}; the rest sits in the pot`);
  console.log(`  (board.strike pool + reserve) awaiting the next trigger. Lumpy: ±1 strike swings it by ~${pct(1 / Math.max(1, strikes.length))}. The fee was 208 bps to round 64175 and 240 from 64176 (2026-09-17).`);
}
