/**
 * pnpm measure-remaining
 *
 * The four "still uncertain" items of SAT-RUSH-MODEL.md § 7, measured:
 *   1. staking split — buybacks fee collected since the stream opened vs BTC
 *      rewards deposited to the staking treasury (app text says 29%)
 *   2. epoch pool under the halved fee — conservation of iteration 16's pool
 *      against the epoch fee collected since it opened, and the projected
 *      close (pool, tickets, ticket value) from the post-09-17 pace
 *   3. 1-BTC tickets at the draw — the two finished iterations' actual counts
 *      and iteration 3's pace, giving a bracket on the ticket value
 *   4. the mint TWAP — the mint program's observation ring buffer, read raw
 * Pages the rounds list back to the V2 cutover once (~130 requests).
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { EPOCH_EQUAL_CURVE_BPS, expectedWinningsUsd } from "../src/strategy/vault.js";
import { EPOCH_DEDUP_UPLIFT, RUSH_MINT_USD_CAP } from "../src/strategy/facts.js";
import { readOneBtcState } from "./lib/onchain.js";

const BASE = process.env["SATRUSH_API"] ?? "https://api.satrush.io/api/v1";
const get = async <T>(p: string): Promise<T> => ((await (await fetch(`${BASE}/${p}`, { signal: AbortSignal.timeout(30_000) })).json()) as { data: T }).data;
const pct = (x: number, d = 2) => `${(100 * x).toFixed(d)}%`;
const usd = (x: number, d = 0) => `$${x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
interface Row { id: number; state: string; total_gross_deployed_usd: string; minted_token: string; started_at: string | null; ended_at: string | null }
interface Board { round_id: number; round_duration: number; prices: { token: number; btc: number } }
interface Treasury { total_staked: string; total_reward_deposited: string }
interface Iter { id: number; total_tickets: string; total_participants: number; pool_usd_amount: string; pool_btc_amount: string; pool_token_amount: string; pool_combined_usd_amount: number | null; started_at: string | null; ended_at: string | null }
interface OneBtcIter { id: number; total_tickets: string; started_at: string; ended_at: string | null; usd_amount: number }

const [board, treasury, iter16, iter15, ob1, ob2, ob3, oneBtc] = await Promise.all([
  get<Board>("board"), get<Treasury>("staking/treasury"), get<Iter>("epoch/iterations/16"), get<Iter>("epoch/iterations/15"),
  get<OneBtcIter>("one-btc/iterations/1"), get<OneBtcIter>("one-btc/iterations/2"), get<OneBtcIter>("one-btc/iterations/3"), readOneBtcState(),
]);
const FEE_SWITCH_ROUND = 64176; // strike 208→240, epoch 194→104, buybacks 50→108 (FINDINGS § E-v2-strike)
const V2_FIRST_ROUND = 55394;
const rows: Row[] = [];
let before = board.round_id + 1;
while (before > V2_FIRST_ROUND) {
  const page = await get<Row[]>(`rounds?limit=100&before=${before}`);
  if (page.length === 0) break;
  rows.push(...page.filter((r) => r.state === "finished"));
  before = page[page.length - 1]!.id;
}
const g = (r: Row) => Number(r.total_gross_deployed_usd) / 1e6;
const buybacksBps = (r: Row) => (r.id >= FEE_SWITCH_ROUND ? 108 : 50);
const epochBps = (r: Row) => (r.id >= FEE_SWITCH_ROUND ? 104 : 194);
const btcUsd = board.prices.btc, roundS = board.round_duration * 0.4;

// ── 1. staking split ────────────────────────────────────────────────────────
const STREAM_OPENED = Date.parse("2026-09-10T17:02:00Z");
const sinceOpen = rows.filter((r) => r.started_at && Date.parse(r.started_at) >= STREAM_OPENED);
const buybacksUsd = sinceOpen.reduce((a, r) => a + g(r) * buybacksBps(r) / 1e4, 0);
const rewardsUsd = (Number(treasury.total_reward_deposited) / 1e8) * btcUsd;
console.log(`══ 1. STAKING SPLIT (app text: 29% of the buybacks leg) ══`);
console.log(`  rounds since the stream opened: ${sinceOpen.length} · gross ${usd(sinceOpen.reduce((a, r) => a + g(r), 0))} · buybacks fee collected ${usd(buybacksUsd)} (50 bps to round ${FEE_SWITCH_ROUND - 1}, 108 after)`);
console.log(`  BTC deposited to the staking treasury: ${(Number(treasury.total_reward_deposited) / 1e8).toFixed(5)} BTC = ${usd(rewardsUsd)} at today's price`);
console.log(`  → staking share = ${pct(rewardsUsd / buybacksUsd, 1)} of the leg (stated 29%; BTC priced today, deposits stream over 24 h, so ±3 pts)`);

// ── 2. epoch pool under the halved fee ─────────────────────────────────────
const it16Start = Date.parse(iter16.started_at!);
const in16 = rows.filter((r) => r.started_at && Date.parse(r.started_at) >= it16Start);
const epochFee16 = in16.reduce((a, r) => a + g(r) * epochBps(r) / 1e4, 0);
const pool16 = iter16.pool_combined_usd_amount ?? (Number(iter16.pool_usd_amount) / 1e6 + (Number(iter16.pool_btc_amount) / 1e8) * btcUsd + (Number(iter16.pool_token_amount) / 1e9) * board.prices.token);
const days16 = (Date.now() - it16Start) / 86400e3, iterDays = 2_318_400 * 0.4 / 86400;
const post = in16.filter((r) => r.id >= FEE_SWITCH_ROUND);
const postDays = post.length ? (Date.now() - Date.parse(post[post.length - 1]!.started_at!)) / 86400e3 : 0;
const feePerDayPost = post.reduce((a, r) => a + g(r) * 104 / 1e4, 0) / postDays;
const tickets16 = Number(iter16.total_tickets), ticketsPerDay = tickets16 / days16;
const daysLeft = Math.max(0, iterDays - days16);
const poolClose = pool16 + feePerDayPost * daysLeft, ticketsClose = tickets16 + ticketsPerDay * daysLeft;
const tv = (pool: number, field: number) => { const b = Math.round(0.05 * field); return expectedWinningsUsd(b, field, pool, "epoch", EPOCH_DEDUP_UPLIFT.value, EPOCH_EQUAL_CURVE_BPS) / b; };
const pool15 = iter15.pool_combined_usd_amount as number, field15 = Number(iter15.total_tickets);
console.log(`\n══ 2. EPOCH POOL UNDER THE 104 bps FEE ══`);
console.log(`  iteration 16: ${days16.toFixed(1)} of ${iterDays.toFixed(1)} days · pool ${usd(pool16)} vs epoch fee collected since it opened ${usd(epochFee16)} (${pct(pool16 / epochFee16, 0)} — the rest is the BTC/RUSH legs' price moves and pending sweeps)`);
console.log(`  post-09-17 pace: ${usd(feePerDayPost)}/day of epoch fee (${post.length} rounds over ${postDays.toFixed(1)} d) · tickets ${tickets16.toLocaleString()} → ${ticketsPerDay.toFixed(0)}/day`);
console.log(`  projected close: pool ${usd(poolClose)} · tickets ${ticketsClose.toFixed(0)} · ${iter16.total_participants} wallets so far → ticket value $${tv(poolClose, ticketsClose).toFixed(4)} (equal curve × ${EPOCH_DEDUP_UPLIFT.value} uplift, 5%-of-field block)`);
console.log(`  compare: iteration 15 closed $${tv(pool15, field15).toFixed(4)} (pool ${usd(pool15)}, ${field15.toLocaleString()} tickets) · the fee-only scaling used as the low case was $${(tv(pool15, field15) * 104 / 194).toFixed(4)}`);
console.log(`  bracket for the close: pace ${usd(poolClose)} … if volume keeps falling at the last-3-day rate the pool lands lower and the field with it; the ticket VALUE moves less than the pool because both shrink.`);

// ── 3. 1-BTC tickets at the draw ───────────────────────────────────────────
console.log(`\n══ 3. 1-BTC TICKETS AT THE DRAW ══`);
for (const it of [ob1, ob2]) console.log(`  iteration ${it.id}: ${Number(it.total_tickets).toLocaleString()} tickets at the draw, ${((Date.parse(it.ended_at!) - Date.parse(it.started_at)) / 86400e3).toFixed(1)} days (V1 fee 132 bps)`);
const fill = oneBtc?.btcAmount ?? NaN, t3 = oneBtc?.totalTickets ?? Number(ob3.total_tickets);
const days3 = (Date.now() - Date.parse(ob3.started_at)) / 86400e3;
const last3 = rows.slice(0, Math.round(3 * 86400 / roundS));
const dailyVol = last3.reduce((a, r) => a + g(r), 0) / 3;
const fillPerDay = fill / days3, fillPerDayNow = dailyVol * 48 / 1e4 / btcUsd;
const daysLeftA = (1 - fill) / fillPerDay, daysLeftB = (1 - fill) / fillPerDayNow;
const tPerDay = t3 / days3;
for (const [label, d] of [["at the iteration's average fill", daysLeftA], ["at the last-3-day volume", daysLeftB]] as [string, number][]) {
  const total = t3 + tPerDay * d;
  console.log(`  iteration 3 ${label}: ${d.toFixed(0)} more days → ${(total / 1e6).toFixed(2)}M tickets → $${(btcUsd / total).toFixed(4)}/ticket = ${(btcUsd / total / 100).toExponential(2)} $/raw`);
}
console.log(`  (iteration 3 so far: ${t3.toLocaleString()} tickets, ${pct(fill, 1)} filled in ${days3.toFixed(1)} d; ${tPerDay.toFixed(0)} tickets/day)`);

// ── 4. the mint TWAP ───────────────────────────────────────────────────────
console.log(`\n══ 4. THE MINT'S TWAP (mint program ring buffer, raw) ══`);
try {
  const c = new Connection(process.env["RPC_URL"] ?? "https://api.mainnet-beta.solana.com", "confirmed");
  const info = await c.getAccountInfo(new PublicKey("FT7AjGeSS1ecbsiR4zivFtVJ2KqF2aJ3fQ2m9f1Atsf7"));
  if (info) {
    const d = info.data;
    const obs: number[] = [];
    // Inferred layout (dump of 2026-09-21): from offset 72, 24-byte records
    // [u64 slot-ish counter, u64 price × 1e15, u64 pad]; counters step ~600
    // slots (≈ 4 min), so ~270 records ≈ 18 h — this is the 1-day side.
    for (let off = 80; off + 8 <= d.length; off += 24) {
      const v = Number(d.readBigUInt64LE(off));
      if (v > 1e15 && v < 1e18) obs.push(v / 1e15);
    }
    const mintRate = rows.slice(0, 100).reduce((a, r) => a + Number(r.minted_token) / 1e9, 0) / rows.slice(0, 100).reduce((a, r) => a + g(r), 0);
    const implied = RUSH_MINT_USD_CAP.value / mintRate;
    console.log(`  ${obs.length} observations read (24-byte stride, value/1e15): min $${Math.min(...obs).toFixed(2)} · mean $${(obs.reduce((a, b) => a + b, 0) / obs.length).toFixed(2)} · max $${Math.max(...obs).toFixed(2)}`);
    console.log(`  implied cap price from the live mint rate: $${RUSH_MINT_USD_CAP.value}/$1k ÷ ${(1000 * mintRate).toFixed(4)} RUSH/$1k = $${implied.toFixed(2)}; spot $${board.prices.token.toFixed(2)}`);
    console.log(`  → the binding average is the higher (30-day) TWAP at ~$${implied.toFixed(0)}; the ring's recent observations (~$${(obs.reduce((a, b) => a + b, 0) / obs.length).toFixed(0)}) are the 1-day side. Layout is inferred, not documented.`);
  } else console.log("  ring buffer account absent");
} catch (e) { console.log(`  ring buffer unreadable: ${(e as Error).message}`); }
