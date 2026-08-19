/**
 * Under v2, is choosing how many tiles to cover actually a DECISION?
 *
 * The owner's design puts the whole strategic layer on Sat Strike: "do you want
 * a diluted share and cover all 21, or increase your share by deploying on half
 * the board — risk missing it but potentially double the EV."
 *
 * That last clause is the claim worth testing, because the arithmetic says
 * otherwise. Strike pays the winning tile's stakers pro-rata and the tile is
 * uniform, so for a player staking `s` against a board of `O` spread evenly:
 *
 *   cover n tiles, s/n each:
 *     E = (1/21) · n · (s/n) / (O/21 + s/n) · S
 *
 *   n = 21  →  E = S · s / (O + s)
 *   n = 1   →  E = S · s / (O + 21s)
 *
 * The blanket is ALWAYS greater than or equal to the single tile. They converge
 * as s → 0 and diverge as s grows, because concentrating means owning a larger
 * share of one tile and every marginal dollar buys less of it. Concentration is
 * a VARIANCE dial, not an EV dial — and for size it is strictly EV-negative.
 *
 * That does not make the design wrong. Players like variance dials, and a
 * variance dial that is EV-neutral for small players is an honest one. But it
 * cannot be sold as "double the EV", because the first analyst to check will
 * find it is not, and this project has already learned what that costs.
 *
 * Also modelled: what a real EV lever would look like if he wants one, and what
 * the 8% → 6% fee cut is actually worth.
 *
 *   pnpm strike-concentration
 */
import { TILES } from "../src/strategy/facts.js";

const BASE = process.env["SATRUSH_API"] ?? "https://api.satrush.io/api/v1";
const N = TILES.value;

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}/${path}`);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return ((await r.json()) as { data: T }).data;
}
const num = (v: unknown): number => Number(v as string);

interface ApiConfig {
  strike_fee_bps: number; epoch_fee_bps: number; one_btc_fee_bps: number;
  protocol_fee_bps: number; sats_vault_round_fee_bps: number;
  sats_vault_claim_fee_bps: number;
}
interface Board {
  round_id: number;
  strike: { pool_combined_usd_amount: number; last_trigger_round_id: number };
}
const [conf, board] = await Promise.all([get<ApiConfig>("config"), get<Board>("board")]);
const B = (bps: number): number => bps / 1e4;
const STRIKE_POOL = board.strike.pool_combined_usd_amount;
const STRIKE_PAYOUT = 0.70;

// Board size: use the observed live gross per round. Boards have been thin.
const BOARD_GROSS = Number(process.env["BOARD_GROSS"] ?? 110);
const OTHERS_NET = BOARD_GROSS * (1 - B(conf.strike_fee_bps + conf.epoch_fee_bps
  + conf.one_btc_fee_bps + conf.protocol_fee_bps));

console.log(`live strike pool $${STRIKE_POOL.toFixed(0)} · last fired round ` +
  `${board.strike.last_trigger_round_id} (now ${board.round_id})`);
console.log(`board assumed $${BOARD_GROSS.toFixed(0)} gross/round → ` +
  `$${OTHERS_NET.toFixed(2)} net across ${N} tiles\n`);

/** Expected strike take and its standard deviation, staking `s` over `n` tiles. */
function strike(s: number, n: number, others = OTHERS_NET, pool = STRIKE_POOL): {
  ev: number; sd: number; pHit: number;
} {
  const perTile = s / n;
  const otherPerTile = others / N;
  const shareIfHit = perTile / (otherPerTile + perTile);
  const payoutIfHit = shareIfHit * pool * STRIKE_PAYOUT;
  const pHit = n / N;
  const ev = pHit * payoutIfHit;
  // Bernoulli on the tile landing inside your mask.
  const sd = Math.sqrt(pHit * (1 - pHit)) * payoutIfHit;
  return { ev, sd, pHit };
}

console.log("══ IS CONCENTRATION AN EV DECISION? ══");
console.log("  (conditional on a Strike firing this round)\n");
for (const s of [1, 10, 100, 1000]) {
  console.log(`  staking $${s} against a $${OTHERS_NET.toFixed(0)} board:`);
  console.log("    tiles   P(hit)    EV if strike fires    sd        EV vs blanket");
  const blanket = strike(s, N).ev;
  for (const n of [21, 11, 5, 3, 1]) {
    const r = strike(s, n);
    console.log(`    ${String(n).padStart(5)}   ${(100 * r.pHit).toFixed(1).padStart(5)}%   ` +
      `$${r.ev.toFixed(4).padStart(18)}   $${r.sd.toFixed(2).padStart(7)}   ` +
      `${((r.ev / blanket - 1) * 100).toFixed(2).padStart(6)}%`);
  }
  console.log();
}
console.log("  Concentration NEVER raises the EV. It is flat for a small player and");
console.log("  strictly negative for a large one, because owning more of one tile");
console.log("  means each marginal dollar buys a smaller slice of it. What it does");
console.log("  raise is the standard deviation — which is a real product feature,");
console.log("  just not the one being described.");

// ── what a real EV lever would look like ────────────────────────────────────
// The program already has a concentration term: hashrate pays m + N/n, so a
// single tile earns 21x the "skill" component of a blanket. Applying the same
// shape to the Strike leg would make coverage a genuine trade-off rather than a
// variance dial, and players already understand the mechanic.
console.log(`\n══ IF HE WANTS IT TO BE A REAL DECISION ══`);
console.log(`  The program already has a concentration reward: hashrate pays m + ${N}/n,`);
console.log(`  so one tile earns ${N}x the skill term of a blanket. Reusing that shape on`);
console.log(`  the Strike leg makes coverage an actual EV/variance trade-off:\n`);
console.log("    tiles   weight (N/n)   EV if strike fires   vs blanket   sd");
for (const n of [21, 11, 5, 3, 1]) {
  const r = strike(100, n);
  const w = N / n;
  const blanket = strike(100, N).ev * (N / N);
  console.log(`    ${String(n).padStart(5)}   ${w.toFixed(2).padStart(12)}   ` +
    `$${(r.ev * w).toFixed(4).padStart(17)}   ${((r.ev * w / blanket - 1) * 100).toFixed(1).padStart(9)}%   ` +
    `$${(r.sd * w).toFixed(2).padStart(7)}`);
}
console.log(`\n  Now covering one tile really is worth more in expectation, the`);
console.log(`  marketing line is true, and it stays whale-neutral because the`);
console.log(`  weight depends on COVERAGE, not on size. It also re-creates a real`);
console.log(`  board game — uneven coverage means under-covered tiles are genuinely`);
console.log(`  cheap — but only over the ${(100 * B(conf.strike_fee_bps)).toFixed(2)}% strike leg rather than the whole pot,`);
console.log(`  so the strategy layer is ~${(1 / B(conf.strike_fee_bps) / (1 / 0.80)).toFixed(0)}x smaller than today's.`);

// ── the fee cut is the part that genuinely adds EV ──────────────────────────
console.log(`\n══ THE 8% → 6% FEE CUT ══`);
const SATS = B(conf.sats_vault_round_fee_bps);
const claim = B(conf.sats_vault_claim_fee_bps);
console.log("  reading                                  player keeps   vs today");
const today = (1 - 0.08 - SATS) + SATS * (1 - claim) + B(conf.strike_fee_bps) * STRIKE_PAYOUT;
const rows: [string, number][] = [
  ["today (8% layer, 10% claim fee)", today],
  ["whole fee layer 8% → 6%", (1 - 0.06 - SATS) + SATS * (1 - claim)
    + B(conf.strike_fee_bps * 0.75) * STRIKE_PAYOUT],
  ["…and claim fee → 0", (1 - 0.06 - SATS) + SATS
    + B(conf.strike_fee_bps * 0.75) * STRIKE_PAYOUT],
  ["only the protocol leg 142 → 0 bps", (1 - 0.08 + B(conf.protocol_fee_bps) - SATS)
    + SATS * (1 - claim) + B(conf.strike_fee_bps) * STRIKE_PAYOUT],
];
for (const [label, v] of rows) {
  console.log(`  ${label.padEnd(40)} ${(100 * v).toFixed(2).padStart(11)}%   ` +
    `${v >= today ? "+" : ""}${(100 * (v - today)).toFixed(2)} pts`);
}
console.log(`\n  This is the part of v2 that is genuinely EV-positive, and it is worth`);
console.log(`  more than everything else in the proposal combined. Note the ambiguity:`);
console.log(`  if "8% → 6%" means the WHOLE fee layer, the strike and epoch pools`);
console.log(`  shrink with it, because ${(100 * B(conf.strike_fee_bps + conf.epoch_fee_bps + conf.one_btc_fee_bps)).toFixed(2)} of those 8 points fund player-facing`);
console.log(`  prizes. Cutting the ${(100 * B(conf.protocol_fee_bps)).toFixed(2)}% protocol leg alone is cleaner and costs`);
console.log(`  the prize pools nothing.`);

// ── how much decay does the fee cut actually buy? ───────────────────────────
console.log(`\n══ WHAT THAT BUYS IN GAME CYCLES ══`);
console.log("  toll     full-recycle rounds to halve a balance");
for (const [label, keep] of rows) {
  const toll = 1 - keep;
  console.log(`  ${(100 * toll).toFixed(2)}%   ${(Math.log(0.5) / Math.log(1 - toll)).toFixed(0).padStart(3)}   ${label}`);
}
