/**
 * pnpm ev-size [max-stake=200]
 *
 * Where the EV-maximizing stake sits: the fleet blanket at the streak cap on
 * today's board, EV in DOLLARS per round as a function of gross stake, with
 * the hashrate valued two ways — linear at the small-block ticket value (what
 * the selector's marginal loop sees between 0 and its share cap) and with the
 * dilution curve (our tickets lower the value of every ticket we hold). The
 * argmax of the dilution curve is "not too much"; the selector's stop (first
 * non-positive marginal at the linear value, or MAX_PER_ROUND) is what the
 * bot does. Boosted and unboosted, at the LIVE pot.
 */
import { REWARD_MAX_STREAK } from "@satrush/client";
import { evOfAllocationV2, v2EconomicsFromConfig } from "../src/strategy/ev-v2.js";
import { TILES_COUNT } from "../src/strategy/ev.js";
import { EPOCH_DEDUP_UPLIFT, STRIKE_HASHRATE_MULTIPLIER, STRIKE_PAYOUT_FRACTION, STRIKE_TRIGGER_MODULUS, V2_DEPLOY_FEE_LAYER_BPS, V2_LOSING_TILE_REFUND_BPS, VAULT_HASHRATE_PER_TICKET } from "../src/strategy/facts.js";
import { EPOCH_EQUAL_CURVE_BPS, expectedWinningsUsd } from "../src/strategy/vault.js";
import { usdToBase } from "../src/units.js";
import { readSatrushConfig } from "./lib/onchain.js";

const BASE = process.env["SATRUSH_API"] ?? "https://api.satrush.io/api/v1";
const MAX = Number(process.argv[2] ?? 200);
const get = async <T>(p: string): Promise<T> => ((await (await fetch(`${BASE}/${p}`, { signal: AbortSignal.timeout(30_000) })).json()) as { data: T }).data;
interface Board { round_id: number; round_duration: number; prices: { token: number }; strike: { pool_combined_usd_amount: number } }
interface Conf { strike_fee_bps: number; epoch_fee_bps: number; one_btc_fee_bps: number; protocol_fee_bps: number; vault_exit_fee_bps: number }
interface Row { state: string; total_gross_deployed_usd: string; minted_token: string }
const [board, conf, rows, chain] = await Promise.all([get<Board>("board"), get<Conf>("config"), get<Row[]>("rounds?limit=100"), readSatrushConfig()]);
const fin = rows.filter((r) => r.state === "finished");
const gross = fin.reduce((a, r) => a + Number(r.total_gross_deployed_usd) / 1e6, 0) / fin.length;
const mintRate = fin.reduce((a, r) => a + Number(r.minted_token) / 1e9, 0) / fin.reduce((a, r) => a + Number(r.total_gross_deployed_usd) / 1e6, 0);
const yieldNow = mintRate * board.prices.token;
const modulus = chain?.strike_trigger_modulus ?? STRIKE_TRIGGER_MODULUS.value;
const buybacks = chain?.buybacks_fee_bps ?? (V2_DEPLOY_FEE_LAYER_BPS.value - conf.strike_fee_bps - conf.epoch_fee_bps - conf.one_btc_fee_bps - conf.protocol_fee_bps);
const econ = v2EconomicsFromConfig({ ...conf, buybacks_fee_bps: buybacks }, { losingRefundBps: V2_LOSING_TILE_REFUND_BPS.value });
const others = new Array<bigint>(TILES_COUNT).fill(usdToBase((gross * (1 - econ.feeLayerBps / 1e4)) / TILES_COUNT));
const pot = board.strike.pool_combined_usd_amount;
// Epoch: iteration 16 projected close (pnpm measure-remaining); rounds per iteration ≈ 10.7 d × 939.
const POOL = 28_200, FIELD = 900_000, PRIZE = 0.9 * POOL / 21, ROUNDS_PER_ITER = 2_318_400 / (board.round_duration);
const ticketSmall = expectedWinningsUsd(Math.round(0.05 * FIELD), FIELD, POOL, "epoch", EPOCH_DEDUP_UPLIFT.value, EPOCH_EQUAL_CURVE_BPS) / Math.round(0.05 * FIELD);
// Dilution: value per ticket when the fleet (21 wallets) holds T tickets over the iteration.
const ticketAtShare = (T: number): number => {
  if (T <= 0) return ticketSmall;
  const t = T / 21, p = 1 - Math.pow(1 - t / (FIELD + T), 21);
  return (21 * p * PRIZE) / T;
};
const ev = (stake: number, mult: number, ticketUsd: number): number => {
  const alloc = new Array<bigint>(TILES_COUNT).fill(usdToBase(stake / TILES_COUNT));
  return evOfAllocationV2({ predictedStakes: others, econ, mintedTokenValueBase: 0, tokenYieldPerVolume: yieldNow,
    strikeExpectedPot: (pot * STRIKE_PAYOUT_FRACTION.value / modulus) * 1e6,
    hashrate: { streak: REWARD_MAX_STREAK, valueUsdPerRawUnit: ticketUsd / VAULT_HASHRATE_PER_TICKET.value, multiplier: mult, coveredOverride: 1 } }, alloc) / 1e6;
};
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(2)}%`;
console.log(`board $${gross.toFixed(0)} · pot $${pot.toFixed(0)} · RUSH leg ${pct(yieldNow)} · ticket (small block) $${ticketSmall.toFixed(4)} · tile mode (121 raw/$ at cap)`);
for (const mult of [1, STRIKE_HASHRATE_MULTIPLIER.value]) {
  console.log(`\n══ ${mult === 1 ? "UNBOOSTED" : "BOOSTED (2×)"} fleet blanket at the cap — EV $ per round vs stake ══`);
  console.log(`  stake    EV linear ticket   EV with dilution   marginal (dilution)   our share of field if played every round`);
  let best = { stake: 0, ev: -Infinity }, prev = 0, stopLinear: number | null = null, prevLin = 0;
  for (let stake = 1; stake <= MAX; stake += stake < 20 ? 1 : stake < 100 ? 5 : 20) {
    const rawPerRound = stake * (REWARD_MAX_STREAK + TILES_COUNT) * mult;
    const T = (rawPerRound / 100) * ROUNDS_PER_ITER * (mult === 1 ? 1 : 240 / modulus);
    const share = T / (FIELD + T);
    const lin = ev(stake, mult, ticketSmall), dil = ev(stake, mult, ticketAtShare(T));
    if (stopLinear === null && lin < prevLin) stopLinear = stake - 1;
    if (dil > best.ev) best = { stake, ev: dil };
    console.log(`  $${String(stake).padEnd(5)}   ${("$" + lin.toFixed(3)).padStart(12)}   ${("$" + dil.toFixed(3)).padStart(14)}   ${("$" + (dil - prev).toFixed(3)).padStart(15)}   ${pct(share).padStart(10)}`);
    prev = dil; prevLin = lin;
  }
  console.log(`  → EV-maximizing stake with dilution: $${best.stake} (EV $${best.ev.toFixed(3)}/round); the selector's linear marginal stays positive until ${stopLinear === null ? `beyond $${MAX}` : "$" + stopLinear} — it stops at MAX_PER_ROUND or its hashrate share cap (VAULT_MAX_SHARE), not at the true optimum.`);
}
