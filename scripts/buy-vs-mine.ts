/**
 * pnpm buy-vs-mine [usd-of-rush=1000] [stake-per-round=5]
 *
 * Two ways to end up holding RUSH: buy it on the open market and stake it
 * (cbBTC yield from the buybacks leg), or mine it on the board (the mint,
 * paid for by the non-token toll) and hold it as token-vault shares (the
 * exit-fee carry). Which acquires a dollar of RUSH cheaper, and what does
 * each dollar earn afterwards?
 *
 *   BUY   cost = the live Jupiter route (price impact at $1k/$10k/$50k);
 *         yield = staking treasury reward stream ÷ (staked + ours) — the
 *         stream is a fixed $/day from volume, so our stake dilutes it.
 *         Stake/unstake/claim carry no lock, cooldown or fee (app Stake
 *         page + treasury account, 2026-09-21).
 *   MINE  cost = (−EV of the round with the RUSH leg priced at ZERO) per RUSH
 *         minted pro rata, through the V2 model on today's board; three
 *         configurations (fresh single tile, single tile at the streak cap,
 *         21-tile blanket at the cap). Spot-independent: the mint is
 *         proportional to volume, so the $ cost of a RUSH does not move with
 *         its price — the crossover is a spot price.
 *         yield = token-vault carry on the shares (no exit fee paid).
 *
 * Both sides carry the same RUSH price risk; it cancels in the comparison.
 */
import { REWARD_MAX_STREAK } from "@satrush/client";
import { evOfAllocationV2, v2EconomicsFromConfig } from "../src/strategy/ev-v2.js";
import { TILES_COUNT } from "../src/strategy/ev.js";
import { EPOCH_DEDUP_UPLIFT, RUSH_MINT_PER_USD, SATS_VAULT_CARRY_DAILY, STAKING_YIELD_DAILY, STRIKE_PAYOUT_FRACTION, TOKEN_VAULT_CARRY_DAILY, V2_DEPLOY_FEE_LAYER_BPS, V2_LOSING_TILE_REFUND_BPS, VAULT_HASHRATE_PER_TICKET } from "../src/strategy/facts.js";
import { EPOCH_EQUAL_CURVE_BPS, expectedWinningsUsd } from "../src/strategy/vault.js";
import { usdToBase } from "../src/units.js";

const BASE = process.env["SATRUSH_API"] ?? "https://api.satrush.io/api/v1";
const JUP = process.env["JUPITER_QUOTE_URL"] ?? "https://lite-api.jup.ag/swap/v1/quote";
const TARGET_USD = Number(process.argv[2] ?? 1000);
const STAKE_USD = Number(process.argv[3] ?? 5);
const get = async <T>(p: string): Promise<T> =>
  ((await (await fetch(`${BASE}/${p}`, { signal: AbortSignal.timeout(20_000) })).json()) as { data: T }).data;
interface Board { round_duration: number; prices: { token: number; btc: number }; strike: { pool_combined_usd_amount: number } }
interface RoundRow { id: number; state: string; total_gross_deployed_usd: string; minted_token: string }
interface Conf { usd_mint: string; token_mint: string; strike_fee_bps: number; epoch_fee_bps: number; one_btc_fee_bps: number; protocol_fee_bps: number; vault_exit_fee_bps: number }
interface Iter { id: number; pool_combined_usd_amount: number | null; total_tickets: string; ended_at: string | null }
interface Treasury { total_staked: string; total_reward_deposited: string; apr: number | null }
interface Quote { inAmount: string; outAmount: string; priceImpactPct: string; routePlan: { swapInfo: { label: string }; percent: number }[] }

const [board, conf, hist, treasury, roundRows] = await Promise.all([get<Board>("board"), get<Conf>("config"), get<Iter[]>("epoch/history?limit=3"), get<Treasury>("staking/treasury"), get<RoundRow[]>("rounds?limit=100")]);
// The board: the MEAN of the last finished rounds, not one round — gross has a
// 70% CV round to round and a single tile's own weight swings the toll with it.
const finished = roundRows.filter((r) => r.state === "finished" && Number(r.total_gross_deployed_usd) > 0);
const grossRows = finished.map((r) => Number(r.total_gross_deployed_usd) / 1e6);
const gross = grossRows.reduce((a, b) => a + b, 0) / grossRows.length;
const grossSe = Math.sqrt(grossRows.reduce((a, g) => a + (g - gross) ** 2, 0) / (grossRows.length - 1) / grossRows.length);
const mintLive = finished.reduce((a, r) => a + Number(r.minted_token) / 1e9, 0) / finished.reduce((a, r) => a + Number(r.total_gross_deployed_usd) / 1e6, 0);
const spot = board.prices.token;
const pct = (x: number, d = 2) => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(d)}%`;
const usd = (x: number, d = 2) => `$${x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;

// ── BUY: live routes ───────────────────────────────────────────────────────
const quote = async (usdIn: number): Promise<{ usdIn: number; rush: number; avg: number; premium: number; impact: number; route: string } | null> => {
  try {
    const q = (await (await fetch(`${JUP}?inputMint=${conf.usd_mint}&outputMint=${conf.token_mint}&amount=${Math.round(usdIn * 1e6)}&slippageBps=100`, { signal: AbortSignal.timeout(20_000) })).json()) as Quote;
    if (!q.outAmount) return null;
    const rush = Number(q.outAmount) / 1e9;
    const avg = usdIn / rush;
    return { usdIn, rush, avg, premium: avg / spot - 1, impact: Number(q.priceImpactPct), route: q.routePlan.map((r) => `${r.swapInfo.label} ${r.percent}%`).join(" + ") };
  } catch { return null; }
};
const sizes = Array.from(new Set([1000, 10_000, 50_000, TARGET_USD])).sort((a, b) => a - b);
const quotes = (await Promise.all(sizes.map(quote))).filter((q): q is NonNullable<typeof q> => q !== null);

// ── staking stream and its dilution ────────────────────────────────────────
const STREAM_OPENED = Date.parse(process.env["STAKING_STREAM_OPENED"] ?? "2026-09-10T17:02:00Z");
const streamDays = (Date.now() - STREAM_OPENED) / 86400e3;
const stakedUsd = (Number(treasury.total_staked) / 1e9) * spot;
const streamUsdPerDay = ((Number(treasury.total_reward_deposited) / 1e8) * board.prices.btc) / streamDays;
const stakeYield = (ours: number) => streamUsdPerDay / (stakedUsd + ours);

// ── MINE: the model on today's board, RUSH leg priced at zero ──────────────
const closed = hist.find((h) => h.ended_at && h.pool_combined_usd_amount !== null)!;
// The API config omits the buybacks leg; the layer is a fixed 600 bps on the
// tape (every V2 round: net = 94% of gross), so the leg is the remainder. It
// was 50 bps until round 64175 and 108 bps from 64176 (2026-09-17 21:04 UTC,
// with strike 208→240 and epoch 194→104) — pnpm strike-payout / FINDINGS.
const buybacksBps = V2_DEPLOY_FEE_LAYER_BPS.value - (conf.strike_fee_bps + conf.epoch_fee_bps + conf.one_btc_fee_bps + conf.protocol_fee_bps);
if (buybacksBps < 0) throw new Error(`fee legs exceed the ${V2_DEPLOY_FEE_LAYER_BPS.value} bps layer: re-measure V2_DEPLOY_FEE_LAYER_BPS`);
const econ = v2EconomicsFromConfig({ ...conf, buybacks_fee_bps: buybacksBps }, { losingRefundBps: V2_LOSING_TILE_REFUND_BPS.value });
const pool = closed.pool_combined_usd_amount as number;
const field = Number(closed.total_tickets);
const block = Math.round(0.05 * field);
const ticketUsd = expectedWinningsUsd(block, field, pool, "epoch", EPOCH_DEDUP_UPLIFT.value, EPOCH_EQUAL_CURVE_BPS) / block;
const rawUsd = ticketUsd / VAULT_HASHRATE_PER_TICKET.value;
const others = new Array<bigint>(TILES_COUNT).fill(usdToBase((gross * (1 - econ.feeLayerBps / 1e4)) / TILES_COUNT));
const mintRate = Number.isFinite(mintLive) && mintLive > 0 ? mintLive : RUSH_MINT_PER_USD.value;
// The strike jackpot leg, pro rata on the winning tile: the strike fee of every
// round's gross accumulates and pays STRIKE_PAYOUT_FRACTION of the pot on a
// ~1-in-1440 draw, so in steady-state expectation it returns strike_fee ×
// payout fraction of each round's gross. (The orchestrator prices the LIVE
// pot ÷ modulus per round; today's pot gives the second figure printed.)
const strikeSteadyPerRound = (conf.strike_fee_bps / 1e4) * STRIKE_PAYOUT_FRACTION.value; // × volume
const strikeLivePerRound = (board.strike.pool_combined_usd_amount * STRIKE_PAYOUT_FRACTION.value) / 1440;
const netNonToken = (tiles: number, streak: number, withStrike = true): number => {
  const alloc = new Array<bigint>(TILES_COUNT).fill(0n);
  const per = usdToBase(STAKE_USD / tiles);
  for (let i = 0; i < tiles; i++) alloc[i] = per;
  const volume = STAKE_USD + gross;
  return evOfAllocationV2({ predictedStakes: others, econ, mintedTokenValueBase: 0, tokenYieldPerVolume: 0,
    strikeExpectedPot: withStrike ? strikeSteadyPerRound * volume * 1e6 : 0,
    hashrate: { streak, valueUsdPerRawUnit: rawUsd, multiplier: 1 } }, alloc) / 1e6 / STAKE_USD;
};
const roundsPerDay = 86400 / (board.round_duration * 0.4);
const configs: [string, number, number][] = [["fresh wallet, 1 tile", 1, 1], ["1 tile at streak cap", 1, REWARD_MAX_STREAK], ["21-tile blanket at cap", TILES_COUNT, REWARD_MAX_STREAK]];

console.log(`RUSH spot ${usd(spot)} (API oracle) · board ${usd(gross, 0)} ± ${usd(grossSe, 0)} gross (mean of the last ${finished.length} finished rounds) · mint ${(1000 * mintRate).toFixed(4)} RUSH/$1k over them (fact ${(1000 * RUSH_MINT_PER_USD.value).toFixed(4)}) · yield at spot ${pct(mintRate * spot)} of gross`);
console.log(`staking treasury: ${usd(stakedUsd, 0)} staked · stream ${usd(streamUsdPerDay, 0)}/day lifetime (${streamDays.toFixed(1)} d) · ${pct(stakeYield(0), 3)}/day undiluted (fact ${pct(STAKING_YIELD_DAILY.value, 3)}, app apr ${treasury.apr === null ? "n/a" : (treasury.apr).toFixed(0) + "%"})`);
console.log(`token-vault carry on unclaimed shares: ${pct(TOKEN_VAULT_CARRY_DAILY.value, 3)}/day (fact, measured ${TOKEN_VAULT_CARRY_DAILY.provenance.kind === "measured" ? TOKEN_VAULT_CARRY_DAILY.provenance.at : "?"})\n`);

console.log(`══ COST OF ${usd(TARGET_USD, 0)} OF RUSH ══`);
console.log(`  BUY (Jupiter route, live)`);
console.log(`  size        RUSH out     avg price   premium over spot   impact    route`);
for (const q of quotes) console.log(`  ${usd(q.usdIn, 0).padStart(8)}   ${q.rush.toFixed(3).padStart(10)}   ${usd(q.avg).padStart(9)}   ${pct(q.premium).padStart(17)}   ${pct(q.impact).padStart(7)}   ${q.route}`);
const buyAt = quotes.find((q) => q.usdIn === TARGET_USD) ?? quotes[0];
if (!buyAt) { console.log("  (no route quoted — Jupiter unreachable)"); }

console.log(`\n  MINE (V2 model, $${STAKE_USD}/round on the mean board, RUSH leg at $0 → the non-token toll)`);
console.log(`  credited: 89% losing-tile refund · own stake + the 5% sats leg back as BTC shares on a win · the strike jackpot pro rata`);
console.log(`  (steady state ${pct(strikeSteadyPerRound)} of gross; today's $${board.strike.pool_combined_usd_amount.toFixed(0)} pot ÷ 1440 × ${STRIKE_PAYOUT_FRACTION.value} = $${strikeLivePerRound.toFixed(2)}/round = ${pct(strikeLivePerRound / (STAKE_USD + gross))})`);
console.log(`  · hashrate → epoch tickets at the equal-prize curve × ${EPOCH_DEDUP_UPLIFT.value}x uplift. Shares at full vault ratio (held, no exit fee).`);
console.log(`  NOT credited (each can only add): the 1-BTC lottery (≤ ${(conf.one_btc_fee_bps / 100).toFixed(2)}% of gross, ticket-engine dependent), the affiliate rebate`);
console.log(`  (10% of the protocol leg as grubstake), and the ${pct(SATS_VAULT_CARRY_DAILY.value, 2)}/day carry the mined BTC shares earn while held.`);
console.log(`  configuration              toll per $ gross (no strike)   RUSH per $ gross   cost per RUSH   vs spot   gross volume for ${usd(TARGET_USD, 0)}   rounds (1 wallet)`);
const mineCosts: { name: string; costPerRush: number; toll: number }[] = [];
for (const [name, tiles, streak] of configs) {
  const toll = -netNonToken(tiles, streak);
  const tollNoStrike = -netNonToken(tiles, streak, false);
  const costPerRush = toll / mintRate;
  const volume = TARGET_USD / (mintRate * spot);
  mineCosts.push({ name, costPerRush, toll });
  console.log(`  ${name.padEnd(26)} ${pct(toll).padStart(8)} (${pct(tollNoStrike)})   ${(mintRate).toExponential(3).padStart(10)}   ${usd(costPerRush).padStart(13)}   ${(costPerRush / spot).toFixed(2).padStart(5)}×   ${usd(volume, 0).padStart(22)}   ${(volume / STAKE_USD).toFixed(0).padStart(6)} ≈ ${(volume / STAKE_USD / roundsPerDay).toFixed(1)} d`);
}

console.log(`\n══ WHAT EACH DOLLAR OF RUSH EARNS AFTERWARDS ══`);
console.log(`  bought, staked:   ${pct(stakeYield(TARGET_USD), 3)}/day with ${usd(TARGET_USD, 0)} added to the stake (${pct(stakeYield(0), 3)} undiluted; ${pct(stakeYield(50_000), 3)} if $50k joined) — paid in cbBTC, no lock, no fee`);
console.log(`  mined, as shares: ${pct(TOKEN_VAULT_CARRY_DAILY.value, 3)}/day carry — RUSH-denominated, decays as claimers thin out; claiming to stake costs the ${(conf.vault_exit_fee_bps / 100).toFixed(0)}% exit fee (never pays back at these rates)`);

console.log(`\n══ VERDICT over 30 / 90 days per ${usd(TARGET_USD, 0)} committed (RUSH price held; it is the same risk on both sides) ══`);
const carry = TOKEN_VAULT_CARRY_DAILY.value;
for (const days of [30, 90]) {
  const buyVal = buyAt ? (TARGET_USD / (1 + buyAt.premium)) * (1 + stakeYield(TARGET_USD) * days) : NaN;
  const line = mineCosts.map((m) => `${m.name}: ${usd((TARGET_USD / (m.costPerRush / spot)) * (1 + carry * days), 0)}`).join(" · ");
  console.log(`  ${String(days).padStart(3)} d   buy+stake → ${usd(buyVal, 0)}   |   mine+hold → ${line}`);
}
console.log(`\n  crossover: mining beats buying only when spot exceeds the cost per RUSH above (the mint is volume-proportional, so that`);
console.log(`  cost is a $ figure independent of price): ${mineCosts.map((m) => `${m.name} ${usd(m.costPerRush)}`).join(" · ")}.`);
console.log(`  Bracket: if the mint instead targets a $ yield at a lagging price, cost per RUSH scales WITH spot and there is no crossover;`);
console.log(`  the mint rate has been rising (pnpm mint-rule prints the drift; +1.74%/day over 09-12→21 per RUSH_MINT_PER_USD's note), which lowers the mine cost by the same fraction per day while it persists.`);
console.log(`  Throughput: buying is one transaction; mining ${usd(TARGET_USD, 0)} of RUSH needs the volume above through one wallet, or /21 with the fleet.`);
