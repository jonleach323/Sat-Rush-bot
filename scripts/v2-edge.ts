/**
 * Where is the edge under v2, and is any of it enough to be absolutely +EV?
 *
 * THE STRUCTURAL CHANGE NOBODY HAS PRICED YET
 *
 * Today, concentrating costs you. Covering one tile means owning a big share of
 * it, so each marginal dollar buys a smaller slice of the pot, and you take huge
 * variance for it. That is why the whole field blankets — measured, the board is
 * 99.4% uniform at fire time.
 *
 * Under v2 the USDC and BTC legs come back pro-rata REGARDLESS of the winning
 * tile. So the cost of concentrating on the base layer goes to zero. But the
 * hashrate formula still pays `m + N/n` — one tile earns 21 skill points, a
 * blanket earns 1. The field currently runs at 107.3 raw/$ because everyone
 * blankets; a single-tile miner at the streak cap earns 121.
 *
 * That is a free ~12.8% uplift on hashrate per dollar, which flows straight
 * into the 60% pro-rata Epoch Rebate. It costs nothing on the base layer and
 * carries no variance there. It is the cleanest edge v2 creates.
 *
 * It is also TEMPORARY: it exists only while the rest of the field keeps
 * blanketing out of habit. As they adopt, rho decays to 1 and it is gone. This
 * script sizes it and shows the decay.
 *
 * The harder question this also answers: no combination of legs makes v2
 * absolutely +EV. The toll is deterministic and every pool is a redistribution,
 * so an edge here means losing less than the field, not making money.
 *
 *   pnpm v2-edge
 */
import { hashrateReward, REWARD_MAX_STREAK, TILE_COUNT } from "@satrush/client";

const BASE = process.env["SATRUSH_API"] ?? "https://api.satrush.io/api/v1";
const USD = 1e6;
const N = TILE_COUNT;

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}/${path}`);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return ((await r.json()) as { data: T }).data;
}
const num = (v: unknown): number => Number(v as string);
const B = (bps: number): number => bps / 1e4;

interface ApiConfig {
  strike_fee_bps: number; epoch_fee_bps: number; one_btc_fee_bps: number;
  protocol_fee_bps: number; sats_vault_round_fee_bps: number;
  sats_vault_claim_fee_bps: number;
}
interface LbRow { total_usd_deployed: string; total_hashrate_earned: string }

const [conf, lb] = await Promise.all([
  get<ApiConfig>("config"),
  get<LbRow[]>("leaderboard/hashrate-earned?limit=50"),
]);

const fieldRate = lb.reduce((a, r) => a + num(r.total_hashrate_earned), 0)
  / lb.reduce((a, r) => a + num(r.total_usd_deployed) / USD, 0);
/** Raw hashrate per dollar at the streak cap, covering n tiles. */
const rate = (n: number): number =>
  Number(hashrateReward(BigInt(USD), REWARD_MAX_STREAK, n, N, BigInt(USD)).total);

console.log("══ THE FREE LUNCH v2 CREATES ══");
console.log(`  field today: ${fieldRate.toFixed(1)} raw/$ — everyone blankets, because today`);
console.log(`  concentrating costs pot share. Under v2 the pot comes back regardless.\n`);
console.log("  tiles   raw/$ at streak 100   vs the field   base-layer cost of concentrating");
for (const n of [21, 11, 5, 3, 1]) {
  console.log(`  ${String(n).padStart(5)}   ${String(rate(n)).padStart(18)}   ` +
    `${((rate(n) / fieldRate - 1) * 100).toFixed(1).padStart(11)}%   ` +
    `${n === N ? "—" : "ZERO under v2 (was a pot-share loss)"}`);
}

// ── what that uplift is actually worth ──────────────────────────────────────
// The rebate leg is 60% of the epoch fee, distributed by hashrate share. An
// uplift of u in hashrate per dollar buys u more of that leg, and nothing else.
const REBATE_SHARE = 0.60;
const rebateBpsOfVolume = B(conf.epoch_fee_bps) * REBATE_SHARE;
console.log(`\n══ WHAT IT IS WORTH ══`);
console.log(`  epoch leg ${conf.epoch_fee_bps} bps of volume × ${100 * REBATE_SHARE}% rebate = ` +
  `${(1e4 * rebateBpsOfVolume).toFixed(0)} bps distributed by hashrate share\n`);
console.log("  tiles   hashrate uplift   excess rebate captured   as % of volume");
for (const n of [21, 5, 1]) {
  const u = rate(n) / fieldRate - 1;
  console.log(`  ${String(n).padStart(5)}   ${(100 * u).toFixed(1).padStart(14)}%   ` +
    `${(1e4 * rebateBpsOfVolume * u).toFixed(1).padStart(21)} bps   ` +
    `${(100 * rebateBpsOfVolume * u).toFixed(3).padStart(13)}%`);
}

// ── it decays as the field adopts ───────────────────────────────────────────
console.log(`\n══ AND IT DECAYS ══`);
console.log("  share of field also concentrating   field rate   our uplift");
for (const adopt of [0, 0.1, 0.25, 0.5, 0.75, 1.0]) {
  const fr = fieldRate * (1 - adopt) + rate(1) * adopt;
  console.log(`  ${(100 * adopt).toFixed(0).padStart(33)}%   ${fr.toFixed(1).padStart(10)}   ` +
    `${((rate(1) / fr - 1) * 100).toFixed(1).padStart(9)}%`);
}
console.log(`\n  This is transition alpha, not a moat. It pays while the field keeps`);
console.log(`  blanketing out of habit and goes to zero when they notice.`);

// ── the absolute question ───────────────────────────────────────────────────
const SATS = B(conf.sats_vault_round_fee_bps);
const CLAIM = B(conf.sats_vault_claim_fee_bps);
const POT = 1 - B(conf.strike_fee_bps + conf.epoch_fee_bps + conf.one_btc_fee_bps
  + conf.protocol_fee_bps) - SATS;

/** v2 return per $1, given our hashrate uplift and the fee scenario. */
function v2Return(uplift: number, feeLayer: number, claimFee: number): number {
  const scale = feeLayer / 0.08; // prize legs shrink with the layer
  const pot = 1 - feeLayer - SATS;
  return pot
    + SATS * (1 - claimFee)                                  // BTC leg
    + B(conf.strike_fee_bps) * scale * 0.70                  // strike, EV
    + B(conf.epoch_fee_bps) * scale * REBATE_SHARE * (1 + uplift) // rebate + our edge
    + B(conf.epoch_fee_bps) * scale * (1 - REBATE_SHARE)     // draw, proportional
    + B(conf.one_btc_fee_bps) * scale;                       // 1-BTC vault, proportional
}

console.log(`\n══ CAN ANY OF THIS BE ABSOLUTELY +EV? ══`);
console.log("  scenario                                    blanket    1-tile    best case");
const uplift1 = rate(1) / fieldRate - 1;
const rows: [string, number, number][] = [
  ["v2 as described (8% layer, 10% claim)", 0.08, CLAIM],
  ["fee layer → 6%", 0.06, CLAIM],
  ["fee layer → 6%, claim fee → 0", 0.06, 0],
  ["protocol leg → 0 only, claim fee → 0", 0.08 - B(conf.protocol_fee_bps), 0],
];
for (const [label, layer, claim] of rows) {
  const blanket = v2Return(0, layer, claim) - 1;
  const one = v2Return(uplift1, layer, claim) - 1;
  console.log(`  ${label.padEnd(42)} ${(100 * blanket).toFixed(2).padStart(7)}%  ` +
    `${(100 * one).toFixed(2).padStart(7)}%  ${one > 0 ? "POSITIVE" : "still negative"}`);
}
console.log(`\n  Every row is negative. The toll is deterministic and every pool is a`);
console.log(`  redistribution of money players themselves put in, so "edge" here means`);
console.log(`  LOSING LESS THAN THE FIELD, not making money from the game.`);
console.log(`\n  Absolute profit has to come from outside the loop:`);
console.log(`    - BTC beta. You accumulate BTC at roughly a ${(100 * (1 - v2Return(uplift1, 0.06, 0))).toFixed(1)}% premium to spot.`);
console.log(`      Profitable only if BTC outruns that over your holding period.`);
console.log(`    - Sat Strike. Genuine upside, ~1/1440 per round, pure variance.`);
console.log(`    - Any points or token program. If one exists, the toll is the`);
console.log(`      entry fee and the token decides the answer — not the game math.`);
// ── the biggest edge in the game, measured ──────────────────────────────────
//
// The sats vault charges a claim fee and that fee STAYS IN THE VAULT, so every
// wallet that claims pays the wallets that do not. Holding shares is therefore
// a carry trade funded by other players' impatience, and it needs no
// prediction, no latency and no tile selection.
const WALLET = process.env["OPERATOR_WALLET"]
  ?? "8EHb675bVwz3nrAUssQfdKx8665WjkU5wZcykvqtii5J";
try {
  const r = await fetch(`https://satstats.app/api/user/${WALLET}`);
  const w = await r.json() as {
    deployedUsd: number; usdPaidForSats: number; satsBtcUsd: number;
    costBasisBtc: number; satsBtc: number; unrealizedBtc: number;
  };
  const appreciation = w.unrealizedBtc / w.costBasisBtc;
  console.log(`\n══ THE CARRY NOBODY IS PRICING ══`);
  console.log(`  The ${(100 * CLAIM).toFixed(0)}% claim fee stays IN the vault, so every wallet that claims`);
  console.log(`  pays the wallets that do not. Measured on ${WALLET.slice(0, 8)}…:\n`);
  console.log(`    paid into the sats leg      $${w.usdPaidForSats.toFixed(2)}`);
  console.log(`    BTC credited at settle       ${w.costBasisBtc.toFixed(8)}`);
  console.log(`    those same shares now worth  ${w.satsBtc.toFixed(8)} BTC = $${w.satsBtcUsd.toFixed(2)}`);
  console.log(`    share appreciation          ${(100 * appreciation).toFixed(2)}%  ← structural, not price`);
  console.log(`    total return on the leg     ${(100 * (w.satsBtcUsd / w.usdPaidForSats - 1)).toFixed(2)}%`);
  console.log(`\n  Sized against volume: the leg is ${(100 * SATS).toFixed(0)}% of every deploy, so ` +
    `${(100 * appreciation).toFixed(1)}% appreciation`);
  console.log(`  on it is worth ${(100 * SATS * appreciation).toFixed(2)}% OF VOLUME — larger than the ` +
    `${(100 * (1 - v2Return(uplift1, 0.08, CLAIM))).toFixed(2)}% all-in rake.`);
  console.log(`\n  Caveats, and they matter: this is a transfer from claimers, so it`);
  console.log(`  decays if the field stops claiming; it is BTC-denominated, so you`);
  console.log(`  carry the price; and it is one wallet over a few weeks, not a`);
  console.log(`  measured rate. Re-check before sizing off it.`);
} catch {
  console.log(`\n  (satstats unreachable — skipping the carry measurement)`);
}
