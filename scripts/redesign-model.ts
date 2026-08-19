/**
 * The owner's proposed redesign, priced against live data.
 *
 * PROPOSAL (as described)
 *   1. The USDC leg is returned regardless of the winning tile — 80% back,
 *      always. The tile only decides Sat Strike.
 *   2. Concentration therefore becomes a bet on Strike alone.
 *   3. The Epoch Vault splits 60% pro-rata by hashrate accrued over the epoch,
 *      40% in EQUAL shares to 21 unique wallets.
 *   4. Raise the BTC share above 12%, "taking the difference out of the fee
 *      layer".
 *
 * WHAT THIS MODELS
 *   - three archetypes taken from the real hashrate leaderboard rather than
 *     invented: a whale, the median listed wallet, and a minimum-deploy minnow;
 *   - their per-epoch economics under today's rules and under the proposal,
 *     with the epoch draw SIMULATED against iteration 4's actual per-wallet
 *     ticket distribution;
 *   - the sybil-gain curve for the 40% equal-shares leg against the same curve
 *     for today's rank-weighted draw.
 *
 * The headline result is that the proposal is EV-neutral by construction: it
 * changes who receives the money and how lumpy it is, not how much there is.
 * That is a real improvement — variance is what keeps size out — but it should
 * not be sold as extra yield, because the first person to check will find it
 * is not.
 *
 *   pnpm redesign-model
 */
import { EPOCH_REWARD_CURVE_BPS } from "../src/strategy/vault.js";
import { TILES } from "../src/strategy/facts.js";

const BASE = process.env["SATRUSH_API"] ?? "https://api.satrush.io/api/v1";
const USD = 1e6;
const ROUNDS_PER_EPOCH = 4320;
const HASHRATE_PER_TICKET = 100;

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}/${path}`);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return ((await r.json()) as { data: T }).data;
}
const num = (v: unknown): number => Number(v as string);
const usd = (x: number): string => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`;

interface ApiConfig {
  strike_fee_bps: number; epoch_fee_bps: number; one_btc_fee_bps: number;
  protocol_fee_bps: number; sats_vault_round_fee_bps: number;
  sats_vault_claim_fee_bps: number; min_deploy_usd_amount: string;
}
interface LbRow {
  authority: string; total_usd_deployed: string; total_hashrate_earned: string;
  total_rounds_played: number; max_streak: number;
}
interface Participant { authority: string; tickets: string }
interface Iter {
  id: number; total_participants: number; total_tickets: string;
  pool_combined_usd_amount: number | null;
}

const [conf, lb, hist] = await Promise.all([
  get<ApiConfig>("config"),
  get<LbRow[]>("leaderboard/hashrate-earned?limit=50"),
  get<Iter[]>("epoch/history?limit=8"),
]);
const closed = hist.filter((h) => h.pool_combined_usd_amount !== null);
const ref = closed[0]!;
const field = (await get<Participant[]>(`epoch/iterations/${ref.id}/participants?limit=500`))
  .map((p) => num(p.tickets)).filter((t) => t > 0).sort((a, b) => b - a);
const FIELD_TOTAL = field.reduce((a, b) => a + b, 0);
const POOL = ref.pool_combined_usd_amount!;

// ── fee split, from live config ─────────────────────────────────────────────
const B = (bps: number): number => bps / 1e4;
const FEE = B(conf.strike_fee_bps + conf.epoch_fee_bps + conf.one_btc_fee_bps
  + conf.protocol_fee_bps);
const SATS = B(conf.sats_vault_round_fee_bps);
const POT = 1 - FEE - SATS;
const CLAIM_NET = 1 - B(conf.sats_vault_claim_fee_bps);
const STRIKE_PAYOUT = 0.70; // operator-stated

console.log("══ FEE SPLIT (live) ══");
console.log(`  pot ${(100 * POT).toFixed(2)}%  ·  sats ${(100 * SATS).toFixed(2)}%  ·  ` +
  `fees ${(100 * FEE).toFixed(2)}%  (strike ${conf.strike_fee_bps} / epoch ` +
  `${conf.epoch_fee_bps} / one_btc ${conf.one_btc_fee_bps} / protocol ${conf.protocol_fee_bps} bps)`);
console.log(`  of the ${(100 * FEE).toFixed(2)}% fee layer, only the ` +
  `${(100 * B(conf.protocol_fee_bps)).toFixed(2)}% protocol leg is the house's —`);
console.log(`  the other ${(100 * B(conf.strike_fee_bps + conf.epoch_fee_bps + conf.one_btc_fee_bps)).toFixed(2)}% already returns to players.\n`);

// ── point 4: where can extra BTC actually come from? ────────────────────────
console.log("══ POINT 4 — raising the BTC share ══");
console.log("  target   USDC back   BTC back (net of claim)   total   vs today");
const todayBase = POT + SATS * CLAIM_NET;
for (const btc of [SATS, 0.15, 0.20, 0.25]) {
  const usdcLeg = POT + SATS - btc; // the split must still sum to 1 − fees
  const total = usdcLeg + btc * CLAIM_NET;
  console.log(`  ${(100 * btc).toFixed(0).padStart(4)}%   ${(100 * usdcLeg).toFixed(2).padStart(9)}%   ` +
    `${(100 * btc * CLAIM_NET).toFixed(2).padStart(22)}%   ${(100 * total).toFixed(2)}%   ` +
    `${total >= todayBase ? "+" : ""}${(100 * (total - todayBase)).toFixed(2)} pts`);
}
console.log(`\n  Every point moved from USDC to BTC is taxed by the ` +
  `${(100 * B(conf.sats_vault_claim_fee_bps)).toFixed(0)}% claim fee.`);
console.log(`  "More BTC per round" is a directional BTC bet, not extra EV. The lever`);
console.log(`  that genuinely adds value is cutting sats_vault_claim_fee_bps:`);
for (const fee of [1000, 500, 250, 0]) {
  const t = POT + SATS * (1 - B(fee));
  console.log(`    claim fee ${String(fee).padStart(4)} bps → player keeps ${(100 * t).toFixed(2)}% ` +
    `(${t >= todayBase ? "+" : ""}${(100 * (t - todayBase)).toFixed(2)} pts)`);
}

// ── the epoch draw, today ───────────────────────────────────────────────────
/** 21 winners, ticket-weighted, without replacement, deduped by wallet. */
function drawTake(mine: number[], others: readonly number[], pool: number, trials = 30_000): number {
  const arr = [...others, ...mine];
  const mineFrom = others.length;
  const total = arr.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let cap = 0;
  for (let t = 0; t < trials; t++) {
    const dead = new Uint8Array(arr.length);
    let rem = total;
    let won = 0;
    for (let rank = 0; rank < EPOCH_REWARD_CURVE_BPS.length && rem > 0; rank++) {
      let x = Math.random() * rem, pick = -1;
      for (let i = 0; i < arr.length; i++) {
        if (dead[i]) continue;
        x -= arr[i] as number;
        if (x < 0) { pick = i; break; }
      }
      if (pick < 0) break;
      dead[pick] = 1; rem -= arr[pick] as number;
      if (pick >= mineFrom) won += (EPOCH_REWARD_CURVE_BPS[rank] ?? 0) / 1e4;
    }
    cap += won;
  }
  return (cap / trials) * pool;
}

/**
 * Proposed epoch: 60% pro-rata by hashrate, 40% in equal shares to 21 wallets.
 * The 21 are modelled as drawn uniformly at random among participants, which is
 * the natural reading of "21 unique wallets" and the one that creates the hole.
 */
function proposedTake(myTickets: number[], participants: number, pool: number): {
  prorata: number; equal: number; total: number;
} {
  const mine = myTickets.reduce((a, b) => a + b, 0);
  const prorata = (mine / (FIELD_TOTAL + mine)) * 0.60 * pool;
  const slots = Math.min(TILES.value, participants);
  // P(a given wallet of mine is drawn) = slots/participants; each slot pays an
  // equal 1/21 of the leg.
  const equal = myTickets.length * (slots / participants) * (0.40 * pool) / slots;
  return { prorata, equal, total: prorata + equal };
}

// ── archetypes, from the real leaderboard ───────────────────────────────────
const perRound = (r: LbRow): number =>
  num(r.total_usd_deployed) / USD / Math.max(1, r.total_rounds_played);
const rateOf = (r: LbRow): number =>
  num(r.total_hashrate_earned) / (num(r.total_usd_deployed) / USD);
const sortedByVol = [...lb].sort((a, b) => perRound(b) - perRound(a));
const whale = sortedByVol[0]!;
const mid = sortedByVol[Math.floor(sortedByVol.length / 2)]!;
const MIN_DEPLOY = num(conf.min_deploy_usd_amount) / USD;
const fieldRate = lb.reduce((a, r) => a + num(r.total_hashrate_earned), 0)
  / lb.reduce((a, r) => a + num(r.total_usd_deployed) / USD, 0);

interface Archetype { name: string; perRoundUsd: number; rate: number }
const types: Archetype[] = [
  { name: "whale", perRoundUsd: perRound(whale), rate: rateOf(whale) },
  { name: "mid", perRoundUsd: perRound(mid), rate: rateOf(mid) },
  { name: "minnow", perRoundUsd: MIN_DEPLOY, rate: fieldRate },
];

console.log(`\n══ ARCHETYPES (from the live hashrate leaderboard) ══`);
console.log(`  field hashrate rate ${fieldRate.toFixed(1)} raw/$ · ` +
  `reference epoch ${ref.id}: ${ref.total_participants} participants, ` +
  `${FIELD_TOTAL.toLocaleString()} tickets, ${usd(POOL)} pool\n`);
console.log("  type      $/round   volume/epoch    tickets/epoch");
for (const t of types) {
  const vol = t.perRoundUsd * ROUNDS_PER_EPOCH;
  const tix = Math.floor((vol * t.rate) / HASHRATE_PER_TICKET);
  console.log(`  ${t.name.padEnd(8)}  ${("$" + t.perRoundUsd.toFixed(2)).padStart(8)}   ` +
    `${usd(vol).padStart(12)}   ${tix.toLocaleString().padStart(13)}`);
}

// ── head to head ────────────────────────────────────────────────────────────
console.log(`\n══ PER EPOCH (${ROUNDS_PER_EPOCH} rounds ≈ 3 days), net of everything ══`);
// Absolute figures use each archetype's LIFETIME average deploy size, which
// predates a ~4.7x collapse in volume — so read the % columns, which are
// scale-free, and treat the dollars as illustrative of relative position.
console.log("  type      volume       TODAY              PROPOSED           delta      epoch back as % of volume");
for (const t of types) {
  const vol = t.perRoundUsd * ROUNDS_PER_EPOCH;
  const tix = Math.floor((vol * t.rate) / HASHRATE_PER_TICKET);

  // Legs common to both designs. Expected pot return is proportional for any
  // strategy: the winning tile is uniform and payouts are pro-rata, so
  // E[return] = share of total stake, whatever mask you use.
  const sats = SATS * CLAIM_NET * vol;
  const strike = B(conf.strike_fee_bps) * STRIKE_PAYOUT * vol;
  const oneBtc = B(conf.one_btc_fee_bps) * vol; // untouched by the proposal

  const todayPot = POT * vol;
  const todayEpoch = drawTake([tix], field, POOL);
  const todayNet = todayPot + sats + strike + oneBtc + todayEpoch - vol;

  const propPot = POT * vol; // returned regardless of tile
  const p = proposedTake([tix], ref.total_participants, POOL);
  const propNet = propPot + sats + strike + oneBtc + p.total - vol;

  // Today the pot leg is a 1-in-21 lottery per round; a blanket removes that,
  // but the epoch draw stays lumpy. Report the epoch leg's hit rate as the
  // clearest proxy for how often this player sees anything.
  const pHit = 1 - Math.pow(1 - tix / (FIELD_TOTAL + tix), TILES.value);
  const pct = (x: number): string =>
    `${x >= 0 ? "+" : ""}${(100 * x / vol).toFixed(2)}%`;
  console.log(`  ${t.name.padEnd(8)}  ${usd(vol).padStart(9)}   ` +
    `${usd(todayNet).padStart(10)} ${pct(todayNet).padStart(7)}   ` +
    `${usd(propNet).padStart(10)} ${pct(propNet).padStart(7)}   ` +
    `${pct(propNet - todayNet).padStart(7)}    today ${(100 * todayEpoch / vol).toFixed(2)}% → ` +
    `prop ${(100 * p.total / vol).toFixed(2)}%   (hit ${(100 * pHit).toFixed(0)}%)`);
}
console.log(`\n  THE ANTI-WHALE MECHANISM IS THE EPOCH DRAW, and the last column measures`);
console.log(`  it: per-wallet dedup lifts a small holder's odds every time a whale is`);
console.log(`  drawn and its whole block leaves the pool. That is why a minnow gets`);
console.log(`  several times more epoch back per dollar than a whale does. Everything`);
console.log(`  else in the fee schedule is strictly proportional.`);
console.log(`\n  The pot leg is identical in both columns — that is the point. Expected`);
console.log(`  return from a uniform tile draw with pro-rata payout IS your stake`);
console.log(`  share, so removing the lottery changes variance, not EV. The delta`);
console.log(`  above is entirely the epoch redistribution.`);

// ── sybil curve ─────────────────────────────────────────────────────────────
console.log(`\n══ SYBIL GAIN — same total volume, split across k wallets ══`);
const sybilOf = types.find((t) => t.name === "mid")!;
const volS = sybilOf.perRoundUsd * ROUNDS_PER_EPOCH;
const tixS = Math.floor((volS * sybilOf.rate) / HASHRATE_PER_TICKET);
const base = { today: drawTake([tixS], field, POOL), prop: proposedTake([tixS], ref.total_participants, POOL) };
console.log(`  a ${usd(volS)}/epoch wallet holding ${tixS.toLocaleString()} tickets\n`);
console.log("     k    TODAY (rank curve)    PROPOSED 60/40      prop 40% leg alone");
for (const k of [1, 2, 4, 8, 21, 50]) {
  const split = new Array<number>(k).fill(tixS / k);
  const today = drawTake(split, field, POOL);
  const prop = proposedTake(split, ref.total_participants + k - 1, POOL);
  console.log(`  ${String(k).padStart(4)}    ${usd(today).padStart(9)} ` +
    `${("(" + (today / base.today).toFixed(2) + "x)").padStart(8)}    ` +
    `${usd(prop.total).padStart(9)} ${("(" + (prop.total / base.prop.total).toFixed(2) + "x)").padStart(8)}    ` +
    `${usd(prop.equal).padStart(9)} ${("(" + (prop.equal / Math.max(1e-9, base.prop.equal)).toFixed(2) + "x)").padStart(8)}`);
}
console.log(`\n  The 40% equal-shares leg is LINEAR in wallet count: each wallet you`);
console.log(`  add draws its own slot with the same probability, and each slot pays`);
console.log(`  the same 1/21 regardless of size. Today's rank curve is ticket-`);
console.log(`  weighted with wallet dedup, so splitting buys far less.`);
console.log(`\n  This is the one part of the proposal that works AGAINST the stated`);
console.log(`  goal of attracting whales: equal shares taxes size directly.`);
console.log(`  The 60% pro-rata leg does the opposite and is sybil-proof — with the`);
console.log(`  field pinned at the streak cap (${fieldRate.toFixed(1)} raw/$ against a ` +
  `theoretical max near 121),`);
console.log(`  hashrate per dollar is nearly flat, so pro-rata by hashrate is`);
console.log(`  effectively pro-rata by volume and splitting gains nothing.`);
