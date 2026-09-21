/**
 * pnpm ev-map [stake-per-round=5]
 *
 * THE MAP. Every action a Sat Rush player can take, priced from live data and
 * the facts, on one page: where each basis point of a deploy goes and who can
 * get it back, the EV of every deploy configuration per round and per day,
 * what holding / claiming / staking / buying yield, what a unit of hashrate
 * is worth in each vault, and what grubstake and affiliate points are worth.
 * Standard errors where the input has one. Read SAT-RUSH-MODEL.md for the
 * mechanics behind every line.
 */
import { REWARD_MAX_STREAK } from "@satrush/client";
import { evOfAllocationV2, v2EconomicsFromConfig } from "../src/strategy/ev-v2.js";
import { TILES_COUNT } from "../src/strategy/ev.js";
import { AFFILIATE_RATE_BPS, BUYBACKS_TO_STAKING_BPS, EPOCH_DEDUP_UPLIFT, RUSH_MINT_PER_USD, RUSH_MINT_USD_CAP, SATS_VAULT_CARRY_DAILY, STREAK_GRACE_ROUNDS, STRIKE_BOOST_WINDOW_ROUNDS, STRIKE_HASHRATE_MULTIPLIER, STRIKE_PAYOUT_FRACTION, STRIKE_TRIGGER_MODULUS, TOKEN_VAULT_CARRY_DAILY, V2_DEPLOY_FEE_LAYER_BPS, V2_LOSING_TILE_REFUND_BPS, V2_VAULT_EXIT_FEE_BPS, VAULT_HASHRATE_PER_TICKET } from "../src/strategy/facts.js";
import { EPOCH_EQUAL_CURVE_BPS, expectedWinningsUsd } from "../src/strategy/vault.js";
import { usdToBase } from "../src/units.js";
import { readOneBtcState, readSatrushConfig } from "./lib/onchain.js";

const BASE = process.env["SATRUSH_API"] ?? "https://api.satrush.io/api/v1";
const JUP = process.env["JUPITER_QUOTE_URL"] ?? "https://lite-api.jup.ag/swap/v1/quote";
const STAKE = Number(process.argv[2] ?? 5);
const get = async <T>(p: string): Promise<T> => ((await (await fetch(`${BASE}/${p}`, { signal: AbortSignal.timeout(30_000) })).json()) as { data: T }).data;
const pct = (x: number, d = 2) => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(d)}%`;
const usd = (x: number, d = 2) => `$${x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const se = (a: number[]) => Math.sqrt(a.reduce((x, y) => x + (y - mean(a)) ** 2, 0) / Math.max(1, a.length - 1) / a.length);

interface Board { round_id: number; round_duration: number; prices: { token: number; btc: number; sat: number; token_share: number }; strike: { pool_combined_usd_amount: number }; sats_vault: { apr: number | null }; token_vault: { apr: number | null } }
interface Conf { usd_mint: string; token_mint: string; strike_fee_bps: number; epoch_fee_bps: number; one_btc_fee_bps: number; protocol_fee_bps: number; vault_exit_fee_bps: number; unclaimed_hashrate_bps: number; min_deploy_usd_amount: string; epoch_vault_iteration_duration: number }
interface Iter { id: number; pool_combined_usd_amount: number | null; total_tickets: string; total_participants: number; started_at: string | null; ended_at: string | null }
interface OneBtc { id: number; total_tickets: string; total_participants: number; usd_amount?: number; started_at: string }
interface Treasury { total_staked: string; total_reward_deposited: string; apr: number | null }
interface RoundRow { id: number; state: string; total_gross_deployed_usd: string; minted_token: string; started_at: string | null }

// ── live inputs ─────────────────────────────────────────────────────────────
const [board, conf, hist, live16, oneBtcHist, treasury, chain] = await Promise.all([
  get<Board>("board"), get<Conf>("config"), get<Iter[]>("epoch/history?limit=3"), get<Iter>("epoch/iterations/16").catch(() => null),
  get<OneBtc[]>("one-btc/history?limit=1"), get<Treasury>("staking/treasury"), readSatrushConfig(),
]);
const oneBtc = await readOneBtcState();
// three days of rounds for the volume (the staking stream is volume)
const rows: RoundRow[] = [];
let before = board.round_id + 1;
const roundS = board.round_duration * 0.4, roundsPerDay = 86400 / roundS;
while (rows.length < 3 * roundsPerDay) {
  const page = await get<RoundRow[]>(`rounds?limit=100&before=${before}`);
  if (page.length === 0) break;
  rows.push(...page.filter((r) => r.state === "finished"));
  before = page[page.length - 1]!.id;
}
const grossAll = rows.map((r) => Number(r.total_gross_deployed_usd) / 1e6);
const gross = mean(grossAll.slice(0, 100)), grossSe = se(grossAll.slice(0, 100));
const dailyVolume = mean(grossAll) * roundsPerDay, dailyVolumeSe = se(grossAll) * roundsPerDay;
const mintRate = rows.reduce((a, r) => a + Number(r.minted_token) / 1e9, 0) / rows.reduce((a, r) => a + Number(r.total_gross_deployed_usd) / 1e6, 0);
const spot = board.prices.token, btcUsd = board.prices.btc;
const modulus = chain?.strike_trigger_modulus ?? STRIKE_TRIGGER_MODULUS.value;
const buybacks = chain?.buybacks_fee_bps ?? (V2_DEPLOY_FEE_LAYER_BPS.value - conf.strike_fee_bps - conf.epoch_fee_bps - conf.one_btc_fee_bps - conf.protocol_fee_bps);
const econ = v2EconomicsFromConfig({ ...conf, buybacks_fee_bps: buybacks }, { losingRefundBps: V2_LOSING_TILE_REFUND_BPS.value });
const fee = V2_VAULT_EXIT_FEE_BPS.value / 1e4;
const closed = hist.find((h) => h.ended_at && h.pool_combined_usd_amount !== null)!;
const yieldNow = mintRate * spot;

console.log(`SAT RUSH — EV MAP  ${new Date().toISOString().slice(0, 16)}Z   round ${board.round_id} · ${roundS.toFixed(0)} s rounds (${roundsPerDay.toFixed(0)}/day) · RUSH ${usd(spot)} · BTC ${usd(btcUsd, 0)}`);
console.log(`board ${usd(gross, 0)} ± ${usd(grossSe, 0)} gross/round (last 100) · volume ${usd(dailyVolume, 0)} ± ${usd(dailyVolumeSe, 0)}/day (last ${rows.length} rounds) · mint ${(1000 * mintRate).toFixed(4)} RUSH/$1k = ${pct(yieldNow)} of gross (cap ${pct(RUSH_MINT_USD_CAP.value, 0)} at TWAP; fact ${(1000 * RUSH_MINT_PER_USD.value).toFixed(4)})`);
console.log(`on-chain: strike modulus ${modulus} · buybacks ${buybacks} bps · ${chain ? "read live" : "NOT read — facts snapshot"}`);

// ── 1. where a deployed dollar goes ─────────────────────────────────────────
console.log(`\n══ 1. ONE DOLLAR OF GROSS DEPLOY — where every basis point goes, and who can get it back ══`);
const legs: [string, number, string][] = [
  ["losing tiles refunded (USD, claim_usd, no fee)", V2_LOSING_TILE_REFUND_BPS.value / 1e4, "yours, on every losing tile you covered"],
  ["swap to BTC → sats-vault shares of the WINNING tile", 0.05, "parimutuel among the winning tile's stakers (plus 89% of their own stake)"],
  [`strike fee (${conf.strike_fee_bps} bps) → jackpot pot`, conf.strike_fee_bps / 1e4, `pays ${pct(STRIKE_PAYOUT_FRACTION.value, 1)} at trigger (1/${modulus}), reserve re-seeds: ~100% back to winning-tile stakers over time`],
  [`epoch fee (${conf.epoch_fee_bps} bps) → epoch vault`, conf.epoch_fee_bps / 1e4, "21 equal prizes per ~10.7 d iteration, drawn by tickets bought with hashrate"],
  [`1-BTC fee (${conf.one_btc_fee_bps} bps) → 1-BTC vault`, conf.one_btc_fee_bps / 1e4, "one winner per 1 BTC accumulated, drawn by tickets bought with hashrate"],
  [`protocol fee (${conf.protocol_fee_bps} bps) → treasury`, conf.protocol_fee_bps / 1e4, `${AFFILIATE_RATE_BPS.value / 100}% of it (${(conf.protocol_fee_bps * AFFILIATE_RATE_BPS.value / 1e4).toFixed(0)} bps) to the referrer as points → bonus USDC; the rest leaves`],
  [`buybacks (${buybacks} bps) → ${BUYBACKS_TO_STAKING_BPS.value / 100}% BTC to stakers, ${100 - BUYBACKS_TO_STAKING_BPS.value / 100}% RUSH burn`, buybacks / 1e4, `${(buybacks * BUYBACKS_TO_STAKING_BPS.value / 1e4).toFixed(1)} bps to RUSH stakers pro rata; ${(buybacks * (1 - BUYBACKS_TO_STAKING_BPS.value / 1e4)).toFixed(1)} bps buys and burns RUSH`],
  [`+ RUSH minted (≤ ${pct(RUSH_MINT_USD_CAP.value, 0)} at TWAP; live ${pct(yieldNow)})`, yieldNow, "64% winners' stake pro rata · 16% losers' · 14% strike pot · 6% epoch pool — as token-vault shares"],
  [`+ hashrate: (streak + 21/tiles) raw per $ gross, ×${STRIKE_HASHRATE_MULTIPLIER.value} in boost`, 0, `${conf.unclaimed_hashrate_bps / 100}% deferred until a sats claim; 100 raw = 1 vault ticket`],
];
for (const [name, v, who] of legs) console.log(`  ${name.padEnd(58)} ${(v ? pct(v) : "").padStart(8)}   ${who}`);
console.log(`  ${"= layer".padEnd(58)} ${pct(econ.feeLayerBps / 1e4).padStart(8)}   sum of the five fee legs; the tape shows net = 94.00% of gross on every V2 round`);

// ── 2. deploy configurations ────────────────────────────────────────────────
console.log(`\n══ 2. DEPLOY CONFIGURATIONS — EV per $ of gross per round, RUSH at spot, on the mean board ($${STAKE}/round) ══`);
const pool = closed.pool_combined_usd_amount as number, field = Number(closed.total_tickets);
const block = Math.round(0.05 * field);
const ticketOld = expectedWinningsUsd(block, field, pool, "epoch", EPOCH_DEDUP_UPLIFT.value, EPOCH_EQUAL_CURVE_BPS) / block;
const livePool = live16?.pool_combined_usd_amount ?? null, liveTickets = live16 ? Number(live16.total_tickets) : null;
const closedEpochBps = 194; // iteration 15 ran at the pre-09-17 fee (pnpm buy-vs-mine reads it off a mid-iteration round)
const ticketNewFee = ticketOld * (conf.epoch_fee_bps / closedEpochBps);
const ticketLivePace = livePool !== null && liveTickets ? expectedWinningsUsd(Math.round(0.05 * liveTickets), liveTickets, livePool, "epoch", EPOCH_DEDUP_UPLIFT.value, EPOCH_EQUAL_CURVE_BPS) / Math.round(0.05 * liveTickets) : null;
const others = new Array<bigint>(TILES_COUNT).fill(usdToBase((gross * (1 - econ.feeLayerBps / 1e4)) / TILES_COUNT));
const strikeSteady = (conf.strike_fee_bps / 1e4) * STRIKE_PAYOUT_FRACTION.value;
const ev = (tiles: number, streak: number, mult: number, ticketUsd: number, tokenYield = yieldNow, stake = STAKE): number => {
  const alloc = new Array<bigint>(TILES_COUNT).fill(0n);
  for (let i = 0; i < tiles; i++) alloc[i] = usdToBase(stake / tiles);
  return evOfAllocationV2({ predictedStakes: others, econ, mintedTokenValueBase: 0, tokenYieldPerVolume: tokenYield,
    strikeExpectedPot: strikeSteady * (stake + gross) * 1e6, hashrate: { streak, valueUsdPerRawUnit: ticketUsd / VAULT_HASHRATE_PER_TICKET.value, multiplier: mult } }, alloc) / 1e6 / stake;
};
const boostShare = STRIKE_BOOST_WINDOW_ROUNDS.value / modulus;
console.log(`  epoch ticket value: iteration ${closed.id} closed $${ticketOld.toFixed(4)} (pool $${pool.toFixed(0)} at 194 bps) · scaled to the live ${conf.epoch_fee_bps} bps fee $${ticketNewFee.toFixed(4)} · iteration 16 live pace ${ticketLivePace === null ? "n/a" : "$" + ticketLivePace.toFixed(4)} (pool $${(livePool ?? 0).toFixed(0)} / ${liveTickets ?? 0} tickets, mid-iteration)`);
console.log(`  strike: ${pct(strikeSteady)} of gross in steady state · boost: ${STRIKE_HASHRATE_MULTIPLIER.value}× hashrate for ${STRIKE_BOOST_WINDOW_ROUNDS.value} of every ~${modulus} rounds (${pct(boostShare, 0)} of rounds)`);
console.log(`\n  configuration                                 EV/$ (ticket: 15 closed)   (live fee, low)   (16 pace)   $/day at $${STAKE}/round every round [low … 16 pace]`);
const cfgs: [string, number, number, number][] = [
  ["fresh wallet, single emptiest tile (streak 1)", 1, 1, 1], ["single tile at streak cap (100)", 1, REWARD_MAX_STREAK, 1],
  ["21-tile blanket, streak 1", TILES_COUNT, 1, 1], ["21-tile blanket at streak cap", TILES_COUNT, REWARD_MAX_STREAK, 1],
  [`21-tile blanket at cap, BOOSTED round (${STRIKE_HASHRATE_MULTIPLIER.value}×)`, TILES_COUNT, REWARD_MAX_STREAK, STRIKE_HASHRATE_MULTIPLIER.value],
];
const table: Record<string, [number, number]> = {}; // [16-pace central, live-fee low]
for (const [name, tiles, streak, mult] of cfgs) {
  const a = ev(tiles, streak, mult, ticketOld), b = ev(tiles, streak, mult, ticketNewFee), c = ev(tiles, streak, mult, ticketLivePace ?? ticketOld);
  table[name] = [c, b];
  console.log(`  ${name.padEnd(46)} ${pct(a).padStart(14)}   ${pct(b).padStart(15)}   ${pct(c).padStart(9)}   ${usd(b * STAKE * roundsPerDay).padStart(10)} … ${usd(c * STAKE * roundsPerDay)}`);
}
const capBlanket = table["21-tile blanket at streak cap"]!, boosted = table[`21-tile blanket at cap, BOOSTED round (${STRIKE_HASHRATE_MULTIPLIER.value}×)`]!;
const minDeploy = Number(conf.min_deploy_usd_amount) / 1e6;
const keepStreakCost = -Math.min(0, capBlanket[1]) * minDeploy;
console.log(`\n  policy "presence": $${minDeploy} blanket every round outside boosts (keeps the streak; ${STREAK_GRACE_ROUNDS.value}-round grace) costs ${usd(keepStreakCost * roundsPerDay * (1 - boostShare), 2)}/day worst case;`);
console.log(`  MAX blanket inside boost windows earns ${pct(boosted[1])}…${pct(boosted[0])} per $ × ${pct(boostShare, 0)} of rounds. Blended per $ of a full-time blanket at cap: ${pct((1 - boostShare) * capBlanket[1] + boostShare * boosted[1])} … ${pct((1 - boostShare) * capBlanket[0] + boostShare * boosted[0])}.`);
console.log(`  own weight: at $${STAKE}/round our block is ${pct(STAKE / (STAKE + gross), 1)} of the board; a bigger stake raises the share of the sats/strike pools we split with ourselves and thins the ticket value — re-run with the stake you mean.`);
console.log(`  ramp: ${REWARD_MAX_STREAK - 1} rounds (${((REWARD_MAX_STREAK - 1) * roundS / 3600).toFixed(1)} h) to the cap; at $${minDeploy} blanket the ramp's negative EV is ${usd(-Math.min(0, table["21-tile blanket, streak 1"]![1]) * minDeploy * (REWARD_MAX_STREAK - 1), 2)} at most.`);

// ── 3. hashrate ─────────────────────────────────────────────────────────────
console.log(`\n══ 3. WHAT A UNIT OF HASHRATE IS WORTH (100 raw = 1 ticket) ══`);
const ob = oneBtcHist[0]!;
const obUsd = btcUsd; // the prize is one whole BTC
const fill = oneBtc ? oneBtc.btcAmount : NaN, obTickets = oneBtc ? oneBtc.totalTickets : Number(ob.total_tickets);
const projTickets = fill > 0 ? obTickets / fill : NaN;
console.log(`  epoch ticket: $${ticketOld.toFixed(4)} (closed 15) · $${ticketNewFee.toFixed(4)} (live fee, same field) · $${ticketLivePace?.toFixed(4) ?? "n/a"} (16 live pace: smaller field)   → per raw ${(ticketNewFee / 100).toExponential(2)}…${((ticketLivePace ?? ticketOld) / 100).toExponential(2)} $`);
console.log(`  1-BTC ticket: prize ${usd(obUsd, 0)} · iteration ${oneBtc?.iterationId ?? ob.id}: ${obTickets.toLocaleString()} tickets, ${pct(fill, 1)} filled (on-chain) → if tickets keep pace with fill, ~${(projTickets / 1e6).toFixed(2)}M at the draw → $${(obUsd / projTickets).toFixed(4)}/ticket = ${(obUsd / projTickets / 100).toExponential(2)} $/raw`);
console.log(`  fill: ${conf.one_btc_fee_bps} bps × ${usd(dailyVolume, 0)}/day = ${usd(dailyVolume * conf.one_btc_fee_bps / 1e4, 0)}/day → ${((1 - fill) * btcUsd / (dailyVolume * conf.one_btc_fee_bps / 1e4)).toFixed(0)} days to the draw at today's volume. Winner-take-all: one ticket in ~${(projTickets / 1e6).toFixed(1)}M.`);
console.log(`  → the 1-BTC vault pays ~${(obUsd / projTickets / ticketNewFee).toFixed(1)}× (vs live-fee epoch) / ~${(obUsd / projTickets / (ticketLivePace ?? ticketOld)).toFixed(1)}× (vs 16 pace) the epoch vault per unit of hashrate IF purchases keep pace with fill — pnpm measure-remaining brackets the draw at 1.8–3.5M tickets ($0.023–$0.045); the vault engine ranks by marginal ticket value each tick.`);
console.log(`  deferred ${conf.unclaimed_hashrate_bps / 100}% of every play's hashrate is released only by claim_sats, pro rata to the fraction claimed (a ${pct(fee, 0)} exit fee on that fraction).`);

// ── 4. holding, claiming, staking, buying ───────────────────────────────────
console.log(`\n══ 4. HOLD · CLAIM · STAKE · BUY ══`);
const stakedUsd = (Number(treasury.total_staked) / 1e9) * spot;
const stakingStreamPerDay = dailyVolume * (buybacks / 1e4) * (BUYBACKS_TO_STAKING_BPS.value / 1e4);
const stakingForward = stakingStreamPerDay / stakedUsd;
const streamOpened = Date.parse("2026-09-10T17:02:00Z"), streamDays = (Date.now() - streamOpened) / 86400e3;
const stakingLifetime = ((Number(treasury.total_reward_deposited) / 1e8) * btcUsd / streamDays) / stakedUsd;
console.log(`  sats-vault shares (unclaimed BTC winnings): carry ${pct(SATS_VAULT_CARRY_DAILY.value, 2)}/day (BTC-denominated; leavers' ${pct(fee, 0)} exit fee; decays) — hold; claiming costs ${pct(fee, 0)} and there is no BTC yield to move to`);
console.log(`  token-vault shares (unclaimed RUSH):        carry ${pct(TOKEN_VAULT_CARRY_DAILY.value, 2)}/day (RUSH-denominated) — hold; claim-to-stake never repays the fee at these rates (pnpm hold-vs-stake)`);
console.log(`  staking (bought RUSH):  forward ${pct(stakingForward, 3)}/day = ${(BUYBACKS_TO_STAKING_BPS.value / 1e4 * buybacks).toFixed(1)} bps × ${usd(dailyVolume, 0)}/day ÷ ${usd(stakedUsd, 0)} staked (±${pct(stakingForward * dailyVolumeSe / dailyVolume, 3)} from volume) · lifetime ${pct(stakingLifetime, 3)}/day (app apr ${treasury.apr?.toFixed(0) ?? "n/a"}%) — a VOLUME yield: falls with the board; no lock, no fee`);
console.log(`  unclaimed USD: claim_usd is fee-free — always claim; redeploy or withdraw.`);
try {
  const q = (await (await fetch(`${JUP}?inputMint=${conf.usd_mint}&outputMint=${conf.token_mint}&amount=1000000000&slippageBps=100`, { signal: AbortSignal.timeout(20_000) })).json()) as { outAmount: string };
  const avg = 1000 / (Number(q.outAmount) / 1e9);
  console.log(`  buy RUSH ($1k, Jupiter): ${usd(avg)} avg = ${pct(avg / spot - 1)} over spot; then stake at the forward yield above. Both hold the RUSH price risk.`);
} catch { console.log("  buy RUSH: Jupiter unreachable"); }

// ── 5. grubstake / affiliate / automation ───────────────────────────────────
console.log(`\n══ 5. GRUBSTAKE · AFFILIATE · AUTOMATION ══`);
const noHashrateBlanket = ev(TILES_COUNT, REWARD_MAX_STREAK, 0, 0);
console.log(`  affiliate: ${AFFILIATE_RATE_BPS.value / 100}% of the ${conf.protocol_fee_bps} bps protocol leg on referred volume = ${(conf.protocol_fee_bps * AFFILIATE_RATE_BPS.value / 1e4).toFixed(0)} bps as points, 1:1 to bonus USDC (grubstake). A fleet under the primary's tag rebates ${(conf.protocol_fee_bps * AFFILIATE_RATE_BPS.value / 1e4).toFixed(0)} bps of its own volume.`);
console.log(`  grubstake (bonus USDC): can only be deployed, earns SATS+RUSH but NO hashrate, USD winnings return to the grubstake, expires. A blanket at cap is worth ${pct(1 + noHashrateBlanket)} of face on the board (no hashrate leg) — spend it, never let it expire.`);
console.log(`  public automation: the owner's crank deploys for you (Static/Random/Discretionary masks); same fees, no information timing, deployment rent fronted by the crank. Only useful to hold a streak without running a bot.`);

// ── 6. verdict ──────────────────────────────────────────────────────────────
console.log(`\n══ 6. RANKING — per dollar committed, today ══`);
const rank: [string, string][] = [
  [`blanket at streak cap in BOOST rounds`, `${pct(boosted[1])}…${pct(boosted[0])} per round; ${pct(boostShare, 0)} of rounds; needs the cap held between boosts`],
  [`blanket at streak cap, unboosted`, `${pct(capBlanket[1])}…${pct(capBlanket[0])} per round (sign depends on the epoch ticket value under the 104 bps fee)`],
  [`hold unclaimed shares`, `sats ${pct(SATS_VAULT_CARRY_DAILY.value, 2)}/day, token ${pct(TOKEN_VAULT_CARRY_DAILY.value, 2)}/day, decaying`],
  [`buy RUSH and stake`, `${pct(stakingForward, 3)}/day forward at today's volume (${pct(stakingLifetime, 3)} lifetime); RUSH price risk`],
  [`single-tile deploys, any streak`, `${pct(table["single tile at streak cap (100)"]![1])}…${pct(table["fresh wallet, single emptiest tile (streak 1)"]![0])} per round — never`],
];
for (const [a, b] of rank) console.log(`  ${a.padEnd(42)} ${b}`);
