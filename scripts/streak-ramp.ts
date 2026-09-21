/**
 * pnpm streak-ramp [usd-per-round=5]
 *
 * The streak is the lever the round-level EV hides. Hashrate per dollar is
 * (streak + 21/n), capped at REWARD_MAX_STREAK, and under V2 it buys epoch
 * tickets worth pool × 0.9 / field per 100 raw (× the dedup uplift). A fresh
 * wallet earns 22 raw per dollar on one tile; at the cap it earns 121 — 5.5×
 * — and rounds are ~92 s, so the cap is ~2.5 h of continuous play away.
 *
 * This prices a single-tile deploy at a uniform board of today's gross for
 * streaks 1…cap through the V2 model itself (evOfAllocationV2 with the
 * hashrate valuation), from live API numbers: the ramp's cost (the
 * negative-EV rounds to the cap) against what presence pays once there.
 */
import { REWARD_MAX_STREAK } from "@satrush/client";
import { evOfAllocationV2, v2EconomicsFromConfig } from "../src/strategy/ev-v2.js";
import { TILES_COUNT } from "../src/strategy/ev.js";
import { EPOCH_DEDUP_UPLIFT, RUSH_MINT_PER_USD, V2_DEPLOY_FEE_LAYER_BPS, V2_LOSING_TILE_REFUND_BPS, VAULT_HASHRATE_PER_TICKET } from "../src/strategy/facts.js";
import { EPOCH_EQUAL_CURVE_BPS, expectedWinningsUsd } from "../src/strategy/vault.js";
import { usdToBase } from "../src/units.js";

const BASE = process.env["SATRUSH_API"] ?? "https://api.satrush.io/api/v1";
const USD = Number(process.argv[2] ?? 5);
const get = async <T>(p: string): Promise<T> =>
  ((await (await fetch(`${BASE}/${p}`, { signal: AbortSignal.timeout(20_000) })).json()) as { data: T }).data;
interface Board { round_id: number; round_duration: number; prices: { token: number; btc: number }; previous_round: { total_gross_deployed_usd: string } }
interface Conf { strike_fee_bps: number; epoch_fee_bps: number; one_btc_fee_bps: number; protocol_fee_bps: number; vault_exit_fee_bps: number }
interface Iter { id: number; pool_combined_usd_amount: number | null; total_tickets: string; ended_at: string | null }
const [board, conf, hist] = await Promise.all([get<Board>("board"), get<Conf>("config"), get<Iter[]>("epoch/history?limit=3")]);
const closed = hist.find((h) => h.ended_at && h.pool_combined_usd_amount !== null)!;
const gross = Number(board.previous_round.total_gross_deployed_usd) / 1e6;
// The API config omits the buybacks leg; the layer is a fixed 600 bps on the
// tape (every V2 round: net = 94% of gross), so the leg is the remainder. It
// was 50 bps until round 64175 and 108 bps from 64176 (2026-09-17 21:04 UTC,
// with strike 208→240 and epoch 194→104) — pnpm strike-payout / FINDINGS.
const buybacksBps = V2_DEPLOY_FEE_LAYER_BPS.value - (conf.strike_fee_bps + conf.epoch_fee_bps + conf.one_btc_fee_bps + conf.protocol_fee_bps);
if (buybacksBps < 0) throw new Error(`fee legs exceed the ${V2_DEPLOY_FEE_LAYER_BPS.value} bps layer: re-measure V2_DEPLOY_FEE_LAYER_BPS`);
const econ = v2EconomicsFromConfig({ ...conf, buybacks_fee_bps: buybacksBps }, { losingRefundBps: V2_LOSING_TILE_REFUND_BPS.value });
const tokenYield = RUSH_MINT_PER_USD.value * board.prices.token;
const pool = closed.pool_combined_usd_amount as number;
const field = Number(closed.total_tickets);
// Price of ONE ticket as the average over a block we could buy (5% of the field), under the equal curve with the uplift.
const block = Math.round(0.05 * field);
const ticketUsd = (expectedWinningsUsd(block, field, pool, "epoch", EPOCH_DEDUP_UPLIFT.value, EPOCH_EQUAL_CURVE_BPS) - 0) / block;
const rawUsd = ticketUsd / VAULT_HASHRATE_PER_TICKET.value;
const others = new Array<bigint>(TILES_COUNT).fill(usdToBase((gross * (1 - econ.feeLayerBps / 1e4)) / TILES_COUNT));
const alloc = new Array<bigint>(TILES_COUNT).fill(0n); alloc[0] = usdToBase(USD);
const evAt = (streak: number): number =>
  evOfAllocationV2({ predictedStakes: others, econ, mintedTokenValueBase: 0, tokenYieldPerVolume: tokenYield,
    hashrate: { streak, valueUsdPerRawUnit: rawUsd, multiplier: 1 } }, alloc) / 1e6;
const cap = REWARD_MAX_STREAK;
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(2)}%`;
console.log(`board $${gross.toFixed(0)} gross (previous round, uniform), token yield ${pct(tokenYield)} at $${board.prices.token.toFixed(2)}, epoch iteration ${closed.id}: pool $${pool.toFixed(0)}, ${field.toLocaleString()} tickets`);
console.log(`ticket value (5%-of-field block, equal prizes, uplift ${EPOCH_DEDUP_UPLIFT.value}x): $${ticketUsd.toFixed(4)} → $${rawUsd.toExponential(3)} per raw hashrate unit`);
console.log(`\n  streak   raw/$ (1 tile)   hashrate credit   EV of $${USD} single tile   per $`);
let rampCost = 0;
for (const s of [1, 10, 25, 50, 75, cap]) {
  const ev = evAt(s);
  console.log(`  ${String(s).padStart(6)}   ${String(s + TILES_COUNT).padStart(13)}   ${pct((s + TILES_COUNT) * rawUsd).padStart(15)}   ${("$" + ev.toFixed(4)).padStart(22)}   ${pct(ev / USD).padStart(8)}`);
}
for (let s = 1; s < cap; s++) rampCost += Math.min(0, evAt(s) * (1 / USD)); // per $1 minimum deploy per round
const evCap = evAt(cap) / USD;
const roundsToCap = cap - 1;
const hours = (roundsToCap * board.round_duration * 0.4) / 3600;
console.log(`\nramp: ${roundsToCap} rounds of a $1 minimum deploy ≈ ${hours.toFixed(1)} h; cost of the negative-EV rounds ${("$" + (-rampCost).toFixed(2))}`);
console.log(`at the cap a $${USD} single tile is ${pct(evCap)} per $ per round → $${(evCap * USD).toFixed(3)}/round, $${(evCap * USD * 86400 / (board.round_duration * 0.4)).toFixed(0)}/day at one deploy every round`);
console.log(evCap > 0
  ? `the ramp pays back in ${Math.ceil(-rampCost / (evCap * USD))} rounds at the cap; a 2-round grace means the streak survives skips of one or two rounds but a third resets it to 1`
  : `presence is negative even at the cap on these numbers — do not ramp; the token yield or the ticket value has to rise first`);
console.log(`caveats: the ticket price is a price-taker figure (our block dilutes it), the field grows with everyone's streaks, and the hashrate is 35% deferred to claim time; BTC/RUSH-denominated legs, carry not included.`);
