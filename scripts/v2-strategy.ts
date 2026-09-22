/**
 * The V2 strategy, in numbers — what the program pays per dollar now, where
 * the edge moved, how big the bets can be, and the one input that decides
 * whether presence pays at all: the RUSH minted per dollar of round volume.
 *
 * Runs in three regimes and says which one it is in:
 *
 *   OFFLINE  the stated economics only (facts.ts). Every table is a scenario
 *            sweep over the unknowns, labelled as such.
 *   V1 API   the API still serves the V1 program (before the cutover). Adds
 *            today's live board — volume per round, how much of the field
 *            blankets — so the V2 pools can be sized at real volume.
 *   V2 API   `minted_token_amount` and a token price are being served. Adds
 *            the measured token yield with its error bar, the fee layer read
 *            from the live config, and the break-even verdict.
 *
 * Nothing here is a point estimate without a range: the yield is an
 * `Estimate`, the unknowns are bracketed, and the RUSH price is never
 * assumed — if the oracle has not loaded, the token is credited at zero.
 *
 *   pnpm v2-strategy [rounds]
 */
import { REWARD_MAX_STREAK, TILE_COUNT, hashrateReward } from "@satrush/client";
import {
  blanketReturnV2,
  breakEvenTokenPriceUsd,
  breakEvenTokenYield,
  evOfAllocationV2,
  outcomeReturnsV2,
  satsLegBps,
  statedTokenYield,
  statedV2Economics,
  tokenYield,
  tollAtRiskFraction,
  v2EconomicsFromConfig,
  type V2EvContext,
  type V2Economics,
} from "../src/strategy/ev-v2.js";
import { TILES_COUNT, outcomeReturns, type EvContext } from "../src/strategy/ev.js";
import {
  RUSH_LAUNCH_PRICE_USD,
  RUSH_MINT_PER_USD_VOLUME,
  STREAK_GRACE_ROUNDS,
  V2_BUYBACKS_FEE_BPS,
  TOKEN_SPLIT_EPOCH_BPS,
  TOKEN_SPLIT_LOSERS_BPS,
  TOKEN_SPLIT_STRIKE_BPS,
  TOKEN_SPLIT_WINNERS_BPS,
  V2_DEPLOY_FEE_LAYER_BPS,
  V2_LOSING_TILE_REFUND_BPS,
  V2_VAULT_EXIT_FEE_BPS,
  describe as describeFact,
  formatEstimate,
  type Estimate,
} from "../src/strategy/facts.js";
import { kellyFraction } from "../src/strategy/kelly.js";
import { streakBreakRawLoss } from "../src/strategy/streak.js";
import { EPOCH_EQUAL_CURVE_BPS, epochWinFraction } from "../src/strategy/vault.js";
import { usdToBase } from "../src/units.js";

const BASE = process.env["SATRUSH_API"] ?? "https://api.satrush.io/api/v1";
const SAMPLE = Number(process.argv[2] ?? 200);
/**
 * RUSH mint decimals. The API's staking DTO documents the staked token at 9
 * decimals; override with RUSH_DECIMALS if the mint says otherwise. Flagged
 * in the output because a wrong value scales the yield by powers of ten.
 */
const RUSH_DECIMALS = Number(process.env["RUSH_DECIMALS"] ?? 9);
const BPS = 10_000;
const N = TILES_COUNT;
const usd = (x: number): string => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`;
const pct = (x: number, d = 2): string => `${(100 * x).toFixed(d)}%`;
const pad = (s: string, w: number): string => s.padStart(w);

// ── live data (optional) ────────────────────────────────────────────────────
interface ApiConfig {
  strike_fee_bps: number; epoch_fee_bps: number; one_btc_fee_bps: number;
  protocol_fee_bps: number; buybacks_fee_bps?: number;
  sats_vault_claim_fee_bps?: number; vault_exit_fee_bps?: number;
  token_mint?: string | null; strike_trigger_modulus?: number;
}
interface ApiBoard {
  round_id: number; round_duration: number;
  previous_round?: { id: number; total_gross_deployed_usd: string; minted_token_amount: string;
    deployed_usd_amount: string; deployed_usd_on_winning_tile_amount: string; miners_count: number; winners_count: number | null } | null;
  prices?: { btc?: number; token?: number | null; token_share?: number | null } | null;
  token_vault?: { apr?: number | null; token_amount?: string; token_shares?: string } | null;
  sats_vault?: { apr?: number | null } | null;
  strike: { pool_combined_usd_amount: number; pool_token_amount?: string };
}
interface ApiRound {
  id: number; state: string; miners_count: number; winners_count: number | null;
  total_deployed_usd?: string; total_gross_deployed_usd?: string;
  minted_token_amount?: string | null;
}

async function get<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${BASE}/${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    return ((await r.json()) as { data: T }).data;
  } catch {
    return null;
  }
}

const [conf, board, rounds] = await Promise.all([
  get<ApiConfig>("config"),
  get<ApiBoard>("board"),
  get<ApiRound[]>(`rounds?limit=${SAMPLE}`),
]);
const finished = (rounds ?? []).filter((r) => r.state === "finished" || r.state === "settled");
const v2Live = conf?.vault_exit_fee_bps !== undefined;
const regime = conf === null ? "OFFLINE" : v2Live ? "V2 API" : "V1 API";

// ── the economics in force ──────────────────────────────────────────────────
let econ: V2Economics = statedV2Economics();
let econSource = "STATED (announcement + SDK docs) — the upgrade has not landed";
if (conf && v2Live) {
  econ = v2EconomicsFromConfig({
    strike_fee_bps: conf.strike_fee_bps, epoch_fee_bps: conf.epoch_fee_bps,
    one_btc_fee_bps: conf.one_btc_fee_bps, protocol_fee_bps: conf.protocol_fee_bps,
    buybacks_fee_bps: conf.buybacks_fee_bps ?? V2_BUYBACKS_FEE_BPS.value, vault_exit_fee_bps: conf.vault_exit_fee_bps,
  });
  econSource = "DERIVED from the live SatrushConfig";
}
const f = econ.feeLayerBps / BPS;
const r = econ.losingRefundBps / BPS;
const s = satsLegBps(econ) / BPS;
const toll = tollAtRiskFraction(econ);

console.log(`══ SAT RUSH V2 STRATEGY  ·  regime: ${regime} ══\n`);
console.log("  provenance of every constant used below:");
for (const [name, fct] of Object.entries({
  V2_DEPLOY_FEE_LAYER_BPS, V2_LOSING_TILE_REFUND_BPS, V2_VAULT_EXIT_FEE_BPS,
  TOKEN_SPLIT_WINNERS_BPS, TOKEN_SPLIT_LOSERS_BPS, TOKEN_SPLIT_STRIKE_BPS,
  TOKEN_SPLIT_EPOCH_BPS, STREAK_GRACE_ROUNDS, RUSH_LAUNCH_PRICE_USD, RUSH_MINT_PER_USD_VOLUME,
})) console.log(`    ${describeFact(name, fct)}`);
console.log(`  economics in force: ${econSource}`);
if (conf && !v2Live) {
  const live = conf.strike_fee_bps + conf.epoch_fee_bps + conf.one_btc_fee_bps + conf.protocol_fee_bps;
  console.log(`  live config is still V1: ${live} bps layer (strike ${conf.strike_fee_bps} / epoch ` +
    `${conf.epoch_fee_bps} / one_btc ${conf.one_btc_fee_bps} / protocol ${conf.protocol_fee_bps})`);
}

// ── 1. the ledger per dollar ────────────────────────────────────────────────
console.log(`\n══ 1. WHAT A DOLLAR DOES NOW ══`);
console.log(`  fee layer         ${pad(pct(f), 8)}   strike / epoch / 1-BTC / protocol / buybacks legs (split read at boot)`);
console.log(`  losing tile       ${pad(pct(r), 8)}   refunded in USD — the parimutuel is gone`);
console.log(`  sats leg          ${pad(pct(s), 8)}   = 1 − fee − refund: swapped to BTC, paid to the WINNING tile pro-rata`);
console.log(`  winning tile      ${pad(pct(r), 8)}   own stake back as BTC, plus the pro-rata slice of the sats pool`);
console.log(`  RUSH per round    ${pad("M", 8)}   64% winning tile · 16% losing tiles · 14% strike pot · 6% epoch (all pro-rata by stake)`);
console.log(`  vault exit fee    ${pad(pct(econ.vaultExitFeeBps / BPS), 8)}   on BTC and RUSH claims; stays in the vault, so holders earn it`);
console.log(`\n  At a uniform board a proportional player gets back exactly ${pct(1 - f)} from the USD/BTC legs`);
console.log(`  whatever the tile draw, plus 80% of the mint pro-rata by volume. The fee layer is the`);
console.log(`  toll; the token yield is the only thing that can beat it. V1's board toll was 7.05%.`);

// ── 2. toll at risk and sizing ──────────────────────────────────────────────
console.log(`\n══ 2. THE MOST A DOLLAR CAN LOSE IS ${pct(toll)} — SIZE ON THAT ══`);
console.log(`  V1: a single-tile dollar lost the whole dollar 20 times in 21. V2: it loses ${pct(toll)}`);
console.log(`  when its tile misses, and the RUSH and hashrate it earned come back regardless.`);
console.log(`\n  $ at risk per round    V1 single-tile stake    V2 stake (same risk)`);
for (const risk of [1, 5, 20, 110]) {
  console.log(`  ${pad(usd(risk), 18)}    ${pad(usd(risk), 20)}    ${pad(usd(risk / toll), 20)}`);
}
console.log(`\n  Caps written as "stake" (MAX_PER_ROUND, DAILY_LOSS_CAP treating the full stake as`);
console.log(`  the loss) are ${(1 / toll).toFixed(1)}x too tight under V2. bankroll.authorize() must charge the`);
console.log(`  daily cap ${pct(toll)} of the stake, and pnl must mark BTC and RUSH legs to USD, or a`);
console.log(`  winning day reads as a losing one and the cap trips on phantom losses.`);

// ── 3. is presence +EV? the token yield decides ─────────────────────────────
const beLayer = breakEvenTokenYield(econ.feeLayerBps);
// The protocol leg alone is what leaves the player pool (E-accounting: 1.42%
// of the 8% layer). Scaled to the announced 6% layer if the split is unknown.
const protocolBps = conf && v2Live ? conf.protocol_fee_bps : Math.round(142 * (econ.feeLayerBps / 800));
const beLeak = breakEvenTokenYield(protocolBps);
console.log(`\n══ 3. IS PRESENCE +EV? ONLY THE RUSH YIELD CAN MAKE IT SO ══`);
console.log(`  yield y = (RUSH minted this round × price) / gross round volume. 80% of it comes back`);
console.log(`  to a proportional player this round; the strike and epoch legs (20%) later.`);
console.log(`\n  break-even yield, board-only view (whole ${pct(f)} layer is toll):     y* = ${pct(beLayer, 3)}`);
console.log(`  break-even yield, all-in view (only the protocol leg leaves):      y* = ${pct(beLeak, 3)}` +
  `   (protocol ${protocolBps} bps${conf && v2Live ? "" : ", scaled from V1's 142 of 800"})`);
const yStated = statedTokenYield();
console.log(`\n  OWNER'S LAUNCH NUMBERS: 1 RUSH per $${(1 / RUSH_MINT_PER_USD_VOLUME.value).toFixed(0)} of volume, ` +
  `listing at $${RUSH_LAUNCH_PRICE_USD.value}  →  y = ${pct(yStated)} of volume`);
console.log(`  The mint is PROPORTIONAL to volume. So the yield per dollar is the same in a thin`);
console.log(`  round and a fat one — there is NO timing edge on the token leg — and only the price`);
console.log(`  and the mint rate move it. "A very complex algo" replaces the rate later; with a`);
console.log(`  2.1M cap it can only fall, so the launch window is the richest the leg will ever be.`);
console.log(`\n  break-even RUSH price at the launch rate:  $${breakEvenTokenPriceUsd(econ.feeLayerBps).toFixed(2)} (whole layer as toll)` +
  `  …  $${breakEvenTokenPriceUsd(protocolBps).toFixed(2)} (protocol leg only)`);
console.log(`\n  scenario yield     blanket return    net per $     $/round on a $${(100 / toll).toFixed(0)} deploy`);
for (const [label, y] of [
  ["0 (oracle unloaded)", 0], ["$5", statedTokenYield(5)], ["$10 launch", yStated],
  ["$10, claimed (−10%)", yStated * (1 - econ.vaultExitFeeBps / BPS)], ["$20", statedTokenYield(20)],
  ["board break-even", beLayer], ["$50", statedTokenYield(50)],
] as [string, number][]) {
  const ret = blanketReturnV2(econ, y);
  console.log(`  ${pad(label, 20)} ${pad(pct(y, 2), 7)}   ${pad(pct(ret), 14)}    ${pad(pct(ret - 1), 9)}     ${pad(usd((ret - 1) * (100 / toll)), 10)}`);
}
console.log(`\n  At $10 the board-only view is ${pct(blanketReturnV2(econ, yStated) - 1)} per dollar; the all-in view (fee`);
console.log(`  legs recycling through strike, epoch and 1-BTC vaults to a full participant) is`);
console.log(`  about ${pct(yStated - protocolBps / BPS, 2)}. Positive only if the price HOLDS while every dollar of volume`);
console.log(`  mints sell-side supply, and only realisable at −${pct(econ.vaultExitFeeBps / BPS, 0)} through the exit fee or by`);
console.log(`  holding for the vault APR. The price is the whole trade; the mint rate is measured below.`);

// ── 4. the board edge that survives ─────────────────────────────────────────
const boardGross = finished.length > 0
  ? finished.reduce((a, rd) => a + Number(rd.total_gross_deployed_usd ?? rd.total_deployed_usd ?? 0) / 1e6, 0)
    / finished.length / (v2Live ? 1 : 1 - 0.08) // V1 total_deployed_usd is net of the 8% layer
  : 500;
const boardLabel = finished.length > 0
  ? `live mean of the last ${finished.length} rounds${v2Live ? "" : " (V1 net grossed up by 8%)"}`
  : "assumed — no API";
console.log(`\n══ 4. THE BOARD EDGE UNDER V2 (board ${usd(boardGross)} gross/round, ${boardLabel}) ══`);
console.log(`  The contested pool keyed to the winning tile is C = ${pct(s)}·V + 64%·M·P + E_strike.`);
console.log(`  It is shared exactly as V1's pot was, so an under-stocked tile is still worth`);
console.log(`  (1/21)·C·a/(W + a). Only the size changed: ${pct(s)} of volume where V1 put ~88% up.`);
const stakesFor = (ratio: number, tile: number): bigint[] => {
  const perTileNet = usdToBase((boardGross / N) * (1 - f));
  const st = new Array<bigint>(N).fill(perTileNet);
  st[tile] = usdToBase((boardGross / N) * ratio * (1 - f));
  return st;
};
console.log(`\n  single tile at ratio ρ of the average tile, token at nothing:`);
console.log(`  stake    ρ=0 (empty)   ρ=0.5    ρ=0.8    ρ=0.9    ρ=1.0    ← EV as % of stake`);
for (const stake of [1, 10, 100]) {
  const row = [0, 0.5, 0.8, 0.9, 1.0].map((ratio) => {
    const ctx: V2EvContext = { predictedStakes: stakesFor(ratio, 0), econ, mintedTokenValueBase: 0 };
    const a = new Array<bigint>(N).fill(0n);
    a[0] = usdToBase(stake);
    return evOfAllocationV2(ctx, a) / Number(usdToBase(stake));
  });
  console.log(`  ${pad(usd(stake), 5)}   ${row.map((v) => pad(pct(v, 1), 9)).join("   ")}`);
}
console.log(`\n  V1's break-even for a $1 snipe was ρ < 0.909 and the field sat at 0.994 at fire time.`);
console.log(`  V2 still pays for thin tiles — but the field will disperse now that concentrating`);
console.log(`  costs nothing on the USD leg, and everyone can afford a snipe at an 11¢ toll. Expect`);
console.log(`  the ratio to move; \`pnpm fire-timing\` measures it. Water-filling handles it either way.`);

// Kelly at the empty-tile case, to show the sizing regime — against the SAME
// board under both programs, so the comparison is not a quoted number.
{
  const a = new Array<bigint>(N).fill(0n);
  a[0] = usdToBase(10);
  const v2ctx: V2EvContext = { predictedStakes: stakesFor(0, 0), econ, mintedTokenValueBase: 0 };
  const fV2 = kellyFraction(outcomeReturnsV2(v2ctx, a));
  // V1 fee legs: the live config while it is still V1, else E6's measurement.
  const v1Fees = conf && !v2Live
    ? { deployFeeBps: conf.strike_fee_bps + conf.epoch_fee_bps + conf.one_btc_fee_bps + conf.protocol_fee_bps,
        satsVaultRoundBps: 1200, satsVaultClaimBps: conf.sats_vault_claim_fee_bps ?? 1000 }
    : { deployFeeBps: 800, satsVaultRoundBps: 1200, satsVaultClaimBps: 1000 };
  const v1Stakes = stakesFor(0, 0).map((st) => (st * BigInt(Math.round((1 - v1Fees.deployFeeBps / BPS) * 1e6)))
    / BigInt(Math.round((1 - f) * 1e6)));
  const v1ctx: EvContext = { predictedStakes: v1Stakes, fees: v1Fees, multiplier: 1, semantics: "raw" };
  const fV1 = kellyFraction(outcomeReturns(v1ctx, a));
  console.log(`  Kelly on a $10 empty-tile snipe against this board: ${pct(fV2, 1)} of bankroll under V2,`);
  console.log(`  ${pct(fV1, 1)} under V1 — V2's edge per round is smaller in dollars and its downside is`);
  console.log(`  bounded, so the two pull in opposite directions. Use a fraction: the model is new.`);
}

// ── 5. concentration is free, and it pays hashrate ──────────────────────────
const rate = (n: number): number =>
  Number(hashrateReward(1_000_000n, REWARD_MAX_STREAK, n, TILE_COUNT, 1_000_000n).total);
console.log(`\n══ 5. CONCENTRATE: THE USD LEG NO LONGER PUNISHES IT, HASHRATE STILL REWARDS IT ══`);
console.log(`  tiles   raw hashrate / $ at the streak cap   vs blanket`);
for (const n of [21, 11, 5, 3, 1]) {
  console.log(`  ${pad(String(n), 5)}   ${pad(String(rate(n)), 34)}   ${pad(`${((rate(n) / rate(21) - 1) * 100).toFixed(1)}%`, 8)}`);
}
console.log(`  Under V1 a single tile bought a 21x variance bet on the whole stake. Under V2 the`);
console.log(`  variance is on the ${pct(s)} sats slice and the 64% RUSH leg only; the 89% comes back.`);
console.log(`  One tile per deploy is the V2 default (k_emptiest / water-filling both do this);`);
console.log(`  spread only when the model finds several thin tiles.`);

// ── 6. streak under grace ───────────────────────────────────────────────────
const cap = REWARD_MAX_STREAK;
console.log(`\n══ 6. THE STREAK SURVIVES ${STREAK_GRACE_ROUNDS.value} SKIPS ══`);
console.log(`  SDK: a play ${STREAK_GRACE_ROUNDS.value + 1} rounds after the last one still continues the streak; ${STREAK_GRACE_ROUNDS.value + 2} resets it.`);
console.log(`  consecutive skips   cost in raw hashrate per $/round (streak ${cap})`);
for (const k of [1, 2, 3]) {
  const cost = k <= STREAK_GRACE_ROUNDS.value ? 0 : streakBreakRawLoss(cap);
  console.log(`  ${pad(String(k), 17)}   ${cost === 0 ? "0 — free" : `${cost.toLocaleString()} (the reset)`}`);
}
console.log(`  Keeping the counter alive costs one minimum deploy every third round: $1 × ${pct(toll)}`);
console.log(`  = ${usd(toll)} per three rounds. Under V1 it cost a full toll every round. The presence`);
console.log(`  credit (streak.ts) is now zero while the grace absorbs a skip.`);

// ── 7. epoch: equal shares ──────────────────────────────────────────────────
console.log(`\n══ 7. EPOCH VAULT: 21 EQUAL SHARES ══`);
console.log(`  share p    V1 take / pool    V2 take / pool    V2 / V1`);
for (const p of [0.001, 0.01, 0.05, 0.10, 0.30]) {
  const v1 = epochWinFraction(p);
  const v2 = epochWinFraction(p, 1, EPOCH_EQUAL_CURVE_BPS);
  console.log(`  ${pad(pct(p, 1), 7)}    ${pad(pct(v1, 2), 14)}    ${pad(pct(v2, 2), 14)}    ${pad(`${(v2 / v1).toFixed(2)}x`, 7)}`);
}
console.log(`  Same value at the margin, a hard cap of one flat slot per wallet: past a few percent`);
console.log(`  of the tickets the marginal ticket is worth less than under V1. VAULT_MAX_SHARE`);
console.log(`  should come down accordingly, and the vault engine must be handed EPOCH_EQUAL_CURVE_BPS.`);
console.log(`  The pool now carries a RUSH leg (6% of every mint plus strike skims) on top of USD+BTC.`);

// ── 8. live V2 measurements ─────────────────────────────────────────────────
console.log(`\n══ 8. LIVE ══`);
if (!conf || !board) {
  console.log(`  API unreachable — everything above is the stated economics. Re-run with the network.`);
} else if (!v2Live) {
  const blanketShare = finished.length > 0
    ? finished.reduce((a, rd) => a + (rd.winners_count ?? 0) / Math.max(1, rd.miners_count), 0) / finished.length
    : NaN;
  const miners = finished.length > 0
    ? finished.reduce((a, rd) => a + rd.miners_count, 0) / finished.length : NaN;
  console.log(`  V1 program still live (round ${board.round_id}, ${board.round_duration}-slot rounds).`);
  console.log(`  last ${finished.length} rounds: ${usd(boardGross)} gross/round · ${miners.toFixed(1)} miners · ` +
    `${pct(blanketShare, 1)} of miners paid each round (≈ the blanket share of the field)`);
  console.log(`  At this volume the V2 contested pool is ${usd(s * boardGross)}/round of BTC plus 64% of the`);
  console.log(`  mint; the toll on a full blanket of the board's average deploy is ${usd(toll * boardGross / Math.max(1, miners))}.`);
  const roundsPerDay = 86_400 / (board.round_duration * 0.4);
  const mintPerRound = boardGross * RUSH_MINT_PER_USD_VOLUME.value;
  console.log(`  At the launch rate this volume mints ${mintPerRound.toFixed(2)} RUSH/round ≈ ` +
    `${(mintPerRound * roundsPerDay).toFixed(0)} RUSH/day ≈ ${usd(mintPerRound * roundsPerDay * RUSH_LAUNCH_PRICE_USD.value)}/day`);
  console.log(`  of new supply at $${RUSH_LAUNCH_PRICE_USD.value} (${board.round_duration}-slot rounds, ${roundsPerDay.toFixed(0)}/day). ` +
    `Every dollar we add mints $${(RUSH_MINT_PER_USD_VOLUME.value * RUSH_LAUNCH_PRICE_USD.value).toFixed(3)} more.`);
  console.log(`  strike pool ${usd(board.strike.pool_combined_usd_amount)} · sats vault APR ` +
    `${board.sats_vault?.apr == null ? "n/a" : `${board.sats_vault.apr.toFixed(1)}%`}`);
  console.log(`\n  Nothing V2 to measure yet. After the cutover this section prints the token yield.`);
} else {
  const price = board.prices?.token ?? null;
  const priced = finished.filter((rd) => rd.minted_token_amount != null && Number(rd.total_gross_deployed_usd ?? 0) > 0);
  const pr = board.previous_round;
  if (pr && Number(pr.total_gross_deployed_usd) > 0) {
    const g = Number(pr.total_gross_deployed_usd) / 1e6;
    const minted = Number(pr.minted_token_amount) / 10 ** RUSH_DECIMALS;
    const wNet = Number(pr.deployed_usd_on_winning_tile_amount) / 1e6;
    const post = Number(pr.deployed_usd_amount) / 1e6;
    const swapPred = s * g + r * (wNet / (1 - f));
    const swapAct = g * (1 - f) - post;
    console.log(`  previous round ${pr.id}: ${usd(g)} gross · ${pr.miners_count} miners, ${pr.winners_count ?? "?"} paid · minted ${minted.toFixed(6)} RUSH ` +
      `= ${(1000 * minted / g).toFixed(4)} per $1,000 (stated ${(1000 * RUSH_MINT_PER_USD_VOLUME.value).toFixed(4)})` +
      (price == null ? "" : ` · at $${price.toFixed(2)} = ${pct(minted * price / g, 3)} of gross`));
    console.log(`  swap check: actual ${usd(swapAct)} vs 0.05·V + 0.89·W_win ${usd(swapPred)} (Δ ${(swapAct - swapPred).toFixed(4)}) — ` +
      `${Math.abs(swapAct - swapPred) < 0.01 ? "READING A HOLDS" : "MISMATCH — stop and re-derive"}`);
  }
  console.log(`  V2 live (round ${board.round_id}). RUSH oracle price: ${price == null ? "NOT LOADED — token credited at $0" : `$${price}`}` +
    ` · token vault APR ${board.token_vault?.apr == null ? "n/a" : `${board.token_vault.apr.toFixed(1)}%`}` +
    ` · sats vault APR ${board.sats_vault?.apr == null ? "n/a" : `${board.sats_vault.apr.toFixed(1)}%`}`);
  console.log(`  RUSH decimals assumed ${RUSH_DECIMALS} (RUSH_DECIMALS to override)`);
  if (priced.length === 0) {
    console.log(`  no finished round carries minted_token_amount and gross volume yet.`);
  } else {
    const yields = priced.map((rd) => {
      const minted = Number(rd.minted_token_amount) / 10 ** RUSH_DECIMALS;
      const gross = Number(rd.total_gross_deployed_usd) / 1e6;
      return { id: rd.id, minted, gross, y: tokenYield(minted * (price ?? 0), gross) };
    });
    const ys = yields.map((x) => x.y);
    const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
    const sd = Math.sqrt(ys.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, ys.length - 1));
    const est: Estimate = { value: 100 * mean, stderr: (100 * sd) / Math.sqrt(ys.length), n: ys.length };
    console.log(`\n  token yield y = M·P/V over the last ${ys.length} rounds: ${formatEstimate(est, "%")}`);
    console.log(`  break-even: ${pct(beLayer, 3)} (board-only) … ${pct(beLeak, 3)} (all-in) · stated launch yield ${pct(yStated)}`);
    const rate = yields.reduce((a, x) => a + x.minted / x.gross, 0) / yields.length;
    console.log(`  measured mint rate ${(rate * 500).toFixed(3)} RUSH per $500 (stated 1.000) — if this drifts the "complex algo" is live`);
    // Fixed-per-round or proportional? Correlate minted with gross.
    const mm = yields.reduce((a, x) => a + x.minted, 0) / yields.length;
    const gm = yields.reduce((a, x) => a + x.gross, 0) / yields.length;
    let cov = 0, vm = 0, vg = 0;
    for (const x of yields) { cov += (x.minted - mm) * (x.gross - gm); vm += (x.minted - mm) ** 2; vg += (x.gross - gm) ** 2; }
    const corr = vm > 0 && vg > 0 ? cov / Math.sqrt(vm * vg) : 0;
    const cvMint = mm > 0 ? Math.sqrt(vm / Math.max(1, yields.length - 1)) / mm : 0;
    console.log(`  mint vs gross volume: corr ${corr.toFixed(2)}, mint CV ${pct(cvMint, 1)} → ` +
      (cvMint < 0.05 ? "FIXED per round: yield falls with volume — deploy into thin rounds"
        : corr > 0.8 ? "PROPORTIONAL to volume: yield is a constant, only the price decides"
        : "unclear — need more rounds"));
    console.log(`  mean mint ${mm.toFixed(2)} RUSH/round · mean gross ${usd(gm)}/round`);
    console.log(`\n  last rounds:  id      minted RUSH     gross      yield`);
    for (const x of yields.slice(0, 8)) {
      console.log(`                ${x.id}   ${pad(x.minted.toFixed(3), 12)}   ${pad(usd(x.gross), 9)}   ${pad(pct(x.y), 8)}`);
    }
  }
}

console.log(`\n══ WHAT TO DO ══`);
console.log(`  1. Hold everything: never claim_sats / claim_token (exit fee funds the holders; both vaults pay APR).`);
console.log(`  2. Size on the ${pct(toll)} toll, not the stake; start at a fraction of Kelly.`);
console.log(`  3. Water-fill the contested pool (sats slice + 64% RUSH + strike); one tile by default.`);
console.log(`  4. No timing edge on the token: y is per-dollar. Deploy every round while price ≥ break-even,`);
console.log(`     front-loaded while the launch rate lasts; else the minimum every third round for the streak.`);
console.log(`  5. Hand the vault engine the flat curve and lower VAULT_MAX_SHARE.`);
console.log(`  6. Measure before trusting: refund %, mint rule, RUSH price, board ratio at cutoff.`);
