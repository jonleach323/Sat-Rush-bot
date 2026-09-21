/**
 * pnpm ev-grid
 *
 * The blanket-at-cap EV as a FUNCTION of the two things that change round to
 * round — the live strike pot (it empties at a strike and refills at
 * strike_fee × gross per round) and the boost flag (2× hashrate for the 240
 * rounds AFTER a strike, i.e. exactly while the pot is small) — and then the
 * capacity: how the value of a ticket falls with our share of the field, and
 * where the boosted blanket's cost per ticket crosses it.
 */
import { REWARD_MAX_STREAK } from "@satrush/client";
import { evOfAllocationV2, v2EconomicsFromConfig } from "../src/strategy/ev-v2.js";
import { TILES_COUNT } from "../src/strategy/ev.js";
import { EPOCH_DEDUP_UPLIFT, STRIKE_BOOST_WINDOW_ROUNDS, STRIKE_HASHRATE_MULTIPLIER, STRIKE_PAYOUT_FRACTION, STRIKE_TRIGGER_MODULUS, V2_DEPLOY_FEE_LAYER_BPS, V2_LOSING_TILE_REFUND_BPS, VAULT_HASHRATE_PER_TICKET } from "../src/strategy/facts.js";
import { EPOCH_EQUAL_CURVE_BPS, expectedWinningsUsd } from "../src/strategy/vault.js";
import { usdToBase } from "../src/units.js";
import { readSatrushConfig } from "./lib/onchain.js";

const BASE = process.env["SATRUSH_API"] ?? "https://api.satrush.io/api/v1";
const get = async <T>(p: string): Promise<T> => ((await (await fetch(`${BASE}/${p}`, { signal: AbortSignal.timeout(30_000) })).json()) as { data: T }).data;
const pct = (x: number, d = 2) => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(d)}%`;
interface Board { round_id: number; round_duration: number; prices: { token: number; btc: number }; strike: { pool_combined_usd_amount: number } }
interface Conf { strike_fee_bps: number; epoch_fee_bps: number; one_btc_fee_bps: number; protocol_fee_bps: number; vault_exit_fee_bps: number }
interface Row { state: string; total_gross_deployed_usd: string; minted_token: string }
const [board, conf, rows, chain] = await Promise.all([get<Board>("board"), get<Conf>("config"), get<Row[]>("rounds?limit=100"), readSatrushConfig()]);
const fin = rows.filter((r) => r.state === "finished");
const gross = fin.reduce((a, r) => a + Number(r.total_gross_deployed_usd) / 1e6, 0) / fin.length;
const mintRate = fin.reduce((a, r) => a + Number(r.minted_token) / 1e9, 0) / fin.reduce((a, r) => a + Number(r.total_gross_deployed_usd) / 1e6, 0);
const spot = board.prices.token, yieldNow = mintRate * spot;
const modulus = chain?.strike_trigger_modulus ?? STRIKE_TRIGGER_MODULUS.value;
const buybacks = chain?.buybacks_fee_bps ?? (V2_DEPLOY_FEE_LAYER_BPS.value - conf.strike_fee_bps - conf.epoch_fee_bps - conf.one_btc_fee_bps - conf.protocol_fee_bps);
const econ = v2EconomicsFromConfig({ ...conf, buybacks_fee_bps: buybacks }, { losingRefundBps: V2_LOSING_TILE_REFUND_BPS.value });
const others = new Array<bigint>(TILES_COUNT).fill(usdToBase((gross * (1 - econ.feeLayerBps / 1e4)) / TILES_COUNT));
const POOL = 28_200, FIELD = 900_000, PRIZE = 0.9 * POOL / 21; // iteration 16 projected close (pnpm measure-remaining)
const ticketSmall = expectedWinningsUsd(Math.round(0.05 * FIELD), FIELD, POOL, "epoch", EPOCH_DEDUP_UPLIFT.value, EPOCH_EQUAL_CURVE_BPS) / Math.round(0.05 * FIELD);
const STAKE = 5;
const ev = (pot: number, mult: number, ticketUsd = ticketSmall, stake = STAKE, tokenYield = yieldNow): number => {
  const alloc = new Array<bigint>(TILES_COUNT).fill(usdToBase(stake / TILES_COUNT));
  return evOfAllocationV2({ predictedStakes: others, econ, mintedTokenValueBase: 0, tokenYieldPerVolume: tokenYield,
    strikeExpectedPot: (pot * STRIKE_PAYOUT_FRACTION.value / modulus) * 1e6,
    hashrate: { streak: REWARD_MAX_STREAK, valueUsdPerRawUnit: ticketUsd / VAULT_HASHRATE_PER_TICKET.value, multiplier: mult } }, alloc) / 1e6 / stake;
};
const refill = gross * conf.strike_fee_bps / 1e4; // $ added to the pot per round
const seed = 300; // reserve seed after a trigger (measured $229–$374, pnpm strike-payout)
console.log(`board $${gross.toFixed(0)} · pot refill $${refill.toFixed(2)}/round · pot now $${board.strike.pool_combined_usd_amount.toFixed(0)} · steady-state mean pot ≈ $${(seed + refill * modulus / 2).toFixed(0)} · ticket (5% block) $${ticketSmall.toFixed(4)} · RUSH leg ${pct(yieldNow)}`);
console.log(`\n══ A. BLANKET AT CAP ($${STAKE}) — EV per $ per round by pot size and boost ══`);
console.log(`  pot        rounds since strike   unboosted   boosted (2×)`);
for (const pot of [seed, 500, 1000, 2000, 3000, 5000, 8000]) {
  const since = Math.max(0, (pot - seed) / refill);
  console.log(`  $${String(pot).padEnd(6)}   ${since.toFixed(0).padStart(8)}              ${pct(ev(pot, 1)).padStart(7)}     ${pct(ev(pot, STRIKE_HASHRATE_MULTIPLIER.value)).padStart(7)}${since <= STRIKE_BOOST_WINDOW_ROUNDS.value ? "  ← inside the boost window" : ""}`);
}
const W = STRIKE_BOOST_WINDOW_ROUNDS.value;
const potAt = (r: number) => seed + refill * r;
let evBoost = 0; for (let r = 0; r < W; r++) evBoost += ev(potAt(r), STRIKE_HASHRATE_MULTIPLIER.value); evBoost /= W;
// unboosted rounds: memoryless trigger — pot distribution ~ geometric in rounds since strike beyond the window
let evUnb = 0, n = 0; for (let r = W; r < 6 * modulus; r++) { const w = Math.pow(1 - 1 / modulus, r); evUnb += w * ev(potAt(r), 1); n += w; } evUnb /= n;
console.log(`\n  average over a boost window (pot refilling from the seed): ${pct(evBoost)} per $ per round`);
console.log(`  average unboosted round (pot weighted by the memoryless trigger): ${pct(evUnb)} per $ per round`);
console.log(`  blended full-time: ${pct((W / modulus) * evBoost + (1 - W / modulus) * evUnb)}   · pot-gated unboosted (deploy only when pot > $2,000): ${pct(ev(2000, 1))}…${pct(ev(5000, 1))}`);

console.log(`\n══ B. CAPACITY — ticket value vs our share of the field, and the cost of a ticket ══`);
const nonHashrateToll = (mult: number) => -ev(seed + refill * modulus / 2, mult, 0) ; // EV with tickets worth 0 → the toll the tickets must cover
const rawPerUsd = (mult: number) => (REWARD_MAX_STREAK + 1) * mult;
for (const mult of [1, STRIKE_HASHRATE_MULTIPLIER.value]) console.log(`  ${mult === 1 ? "unboosted" : "boosted  "} blanket at cap: non-hashrate toll ${pct(nonHashrateToll(mult))} of gross ÷ ${(rawPerUsd(mult) / 100).toFixed(2)} tickets per $ → cost $${(nonHashrateToll(mult) / (rawPerUsd(mult) / 100)).toFixed(4)} per ticket (steady pot)`);
console.log(`\n  our share s of epoch tickets (21 wallets, one prize each, ${FIELD.toLocaleString()} others)   tickets   expected prizes   $/ticket     1-BTC $/ticket at same T (1.8M…3.5M others)`);
for (const s of [0.02, 0.05, 0.10, 0.20, 0.30, 0.50]) {
  const T = s / (1 - s) * FIELD, t = T / 21;
  const p = 1 - Math.pow(1 - t / (FIELD + T), 21), prizes = 21 * p;
  const btcUsd = board.prices.btc;
  console.log(`  ${pct(s, 0).padStart(5)}   ${Math.round(T).toLocaleString().padStart(9)}   ${prizes.toFixed(2).padStart(8)}   $${(prizes * PRIZE / T).toFixed(4)}      $${(btcUsd / (3.5e6 + T)).toFixed(4)}…$${(btcUsd / (1.8e6 + T)).toFixed(4)}`);
}
const cB = nonHashrateToll(STRIKE_HASHRATE_MULTIPLIER.value) / (rawPerUsd(STRIKE_HASHRATE_MULTIPLIER.value) / 100), cU = nonHashrateToll(1) / (rawPerUsd(1) / 100);
console.log(`\n  read: a boosted ticket costs $${cB.toFixed(4)} at the steady pot — epoch tickets beat that up to ~30% of the field, 1-BTC tickets until the draw holds ~${(board.prices.btc / cB / 1e6).toFixed(1)}M tickets.`);
console.log(`  An unboosted ticket costs $${cU.toFixed(4)}: it pays only at a tiny share of a fat field, or when the pot is fat enough to carry it (table A). The pot, not the ticket, is what makes an unboosted round positive.`);
console.log(`  Fraction of rounds with the pot above $2k / $3k / $5k / $8k (memoryless trigger, refill $${refill.toFixed(2)}/round): ${[2000, 3000, 5000, 8000].map((p) => pct(Math.exp(-((p - seed) / refill) / modulus), 0)).join(" / ")}.`);

// ── C. fleet shape: one tile per wallet (fleet covers the board) vs each wallet blanketing ──
console.log(`\n══ C. FLEET SHAPE — k wallets × $${STAKE}: one DISTINCT tile each vs each wallet blanketing (per $ of fleet gross per round, steady pot, 5%-block ticket) ══`);
const potMean = seed + refill * modulus / 2;
const evAlloc = (alloc: bigint[], othersNet: bigint[], tiles: number, mult: number, stake: number): number =>
  evOfAllocationV2({ predictedStakes: othersNet, econ, mintedTokenValueBase: 0, tokenYieldPerVolume: yieldNow,
    strikeExpectedPot: (potMean * STRIKE_PAYOUT_FRACTION.value / modulus) * 1e6,
    hashrate: { streak: REWARD_MAX_STREAK, valueUsdPerRawUnit: ticketSmall / VAULT_HASHRATE_PER_TICKET.value, multiplier: mult } }, alloc) / 1e6 / stake;
const netOf = (g: number) => usdToBase(g * (1 - econ.feeLayerBps / 1e4));
console.log(`  k     one tile each (unboosted)   blanket each (unboosted)   one tile each (boosted)   blanket each (boosted)   hashrate raw/$: single 121 vs blanket 101`);
for (const k of [1, 5, 10, 21]) {
  const res: number[] = [];
  for (const mult of [1, STRIKE_HASHRATE_MULTIPLIER.value]) {
    // one tile each: wallet i on tile i; the other k-1 fleet stakes sit on other tiles (as others' NET stake)
    let evSingle = 0;
    for (let i = 0; i < k; i++) {
      const o = others.map((s, j) => (j !== i && j < k ? s + netOf(STAKE) : s));
      const a = new Array<bigint>(TILES_COUNT).fill(0n); a[i] = usdToBase(STAKE);
      evSingle += evAlloc(a, o, 1, mult, STAKE);
    }
    evSingle /= k;
    // blanket each: every fleet-mate spreads $STAKE/21 on every tile
    const oB = others.map((s) => s + BigInt(k - 1) * netOf(STAKE / TILES_COUNT));
    const aB = new Array<bigint>(TILES_COUNT).fill(usdToBase(STAKE / TILES_COUNT));
    const evBlanket = evAlloc(aB, oB, TILES_COUNT, mult, STAKE);
    res.push(evSingle, evBlanket);
  }
  console.log(`  ${String(k).padEnd(3)}   ${pct(res[0]!).padStart(22)}   ${pct(res[1]!).padStart(22)}   ${pct(res[2]!).padStart(21)}   ${pct(res[3]!).padStart(20)}`);
}
console.log(`  (k = 21 one-tile-each is a blanket at the FLEET level: identical refund/sats/pot flows, +20% hashrate; below 21 the uncovered tiles are simply not played)`);
