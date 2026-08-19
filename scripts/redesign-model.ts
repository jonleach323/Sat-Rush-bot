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

// ── does less variance actually buy more game cycles? ───────────────────────
//
// The owner's core claim, and the one worth testing hardest: today "98.6% of
// player facing value is tied to variance" and that exhausts balances too fast.
//
// The first half is right, and understated. EVERY leg is tile- or draw-keyed
// today: the pot, the sats leg (paid to the winning tile's stakers), Strike,
// the epoch draw, the 1-BTC draw. Nothing is returned unconditionally. Under
// the proposal 80% + BTC comes back regardless and only Strike is a lottery.
//
// The second half needs splitting in two, because they are different things:
//   - the MEAN burn rate is set by the toll, and the proposal does not touch it;
//   - the TAIL — going broke fast — is set by variance, and the proposal
//     removes almost all of it.
// If the goal is "more cycles on average" the lever is the toll. If the goal is
// "players do not get wiped out in an afternoon" the proposal nails it.
function simulateRuin(
  mode: "concentrated" | "blanket" | "proposed",
  deployFraction: number, rounds: number, paths = 4000,
): { medianHalfLife: number; pBelow10: number; medianEnd: number } {
  const toll = 1 - (POT + SATS * CLAIM_NET + B(conf.strike_fee_bps) * STRIKE_PAYOUT);
  // A single tile pays about 21x the blanket multiple when it hits.
  const hit = (POT + SATS * CLAIM_NET) * TILES.value;
  const halfLives: number[] = [];
  const ends: number[] = [];
  let below10 = 0;
  for (let p = 0; p < paths; p++) {
    let bal = 1;
    let half = rounds;
    let recorded = false;
    for (let r = 0; r < rounds && bal > 1e-6; r++) {
      const stake = bal * deployFraction;
      bal -= stake;
      if (mode === "concentrated") {
        // 1-in-21 for the full multiple, nothing otherwise. Strike expectation
        // is folded in so the MEAN matches the other modes exactly.
        bal += (Math.random() < 1 / TILES.value ? hit * stake : 0)
          + B(conf.strike_fee_bps) * STRIKE_PAYOUT * stake;
      } else {
        bal += (1 - toll) * stake;
      }
      if (!recorded && bal < 0.5) { half = r + 1; recorded = true; }
    }
    halfLives.push(half);
    ends.push(bal);
    if (bal < 0.1) below10++;
  }
  const med = (xs: number[]): number => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  return { medianHalfLife: med(halfLives), pBelow10: below10 / paths, medianEnd: med(ends) };
}

console.log(`\n══ BALANCE DECAY — does removing variance buy more cycles? ══`);
console.log(`  redeploying 20% of the running balance each round, 100 rounds (~100 min)\n`);
console.log("  design                    median rounds to half   P(below 10% @100)   median end");
for (const [label, mode] of [
  ["today, single tile", "concentrated"],
  ["today, blanket", "blanket"],
  ["proposed (any mask)", "proposed"],
] as [string, "concentrated" | "blanket" | "proposed"][]) {
  const r = simulateRuin(mode, 0.20, 100);
  console.log(`  ${label.padEnd(24)}  ${String(r.medianHalfLife).padStart(21)}   ` +
    `${(100 * r.pBelow10).toFixed(1).padStart(15)}%   ${(100 * r.medianEnd).toFixed(1).padStart(9)}%`);
}
console.log(`\n  Blanket and proposed are the SAME row — identical mean, identical`);
console.log(`  variance, because a blanket already holds the winning tile every`);
console.log(`  round. The proposal gives every player what blanket players`);
console.log(`  already have, and takes the ruin tail away from everyone else.`);
console.log(`\n  But note the median half-life does not improve. The toll sets that,`);
console.log(`  and the proposal does not change the toll. For MORE CYCLES rather`);
console.log(`  than SAFER cycles the levers are the claim fee and the protocol leg:`);
for (const [label, t] of [
  ["today", 1 - (POT + SATS * CLAIM_NET + B(conf.strike_fee_bps) * STRIKE_PAYOUT)],
  ["claim fee → 0", 1 - (POT + SATS + B(conf.strike_fee_bps) * STRIKE_PAYOUT)],
  ["claim fee → 0, protocol → 71 bps",
    1 - (POT + B(conf.protocol_fee_bps) / 2 + SATS + B(conf.strike_fee_bps) * STRIKE_PAYOUT)],
] as [string, number][]) {
  // Rounds for a fully-recycled balance to halve at this toll.
  const n = Math.log(0.5) / Math.log(1 - t);
  console.log(`    ${label.padEnd(34)} toll ${(100 * t).toFixed(2)}% → ` +
    `${n.toFixed(0)} full-recycle rounds to halve`);
}

// ── how the 21 are SELECTED decides the sybil answer ────────────────────────
//
// The owner's objection is correct and my first cut was sloppy: "equal shares
// to 21 unique wallets" does not say HOW the 21 are chosen, and the sybil
// answer depends entirely on that. Two readings:
//
//   UNIFORM  drawn at random among participants. Every wallet is one lottery
//            ticket regardless of size, so k wallets buy k entries. Linear.
//   WEIGHTED drawn ticket-weighted with the existing wallet dedup — the
//            mechanism that already runs — but PAID a flat 1/21 each. A tiny
//            wallet is then unlikely to be drawn at all, so splitting buys
//            little until you already hold a large ticket share.
//
// He is also right that the hole is not new: today's dedup already rewards
// splitting, measured below at ~1.6x. The only question is whether the change
// makes it bigger, and that turns on this choice alone.
function equalLegWeighted(
  mine: number[], others: readonly number[], pool: number, trials = 30_000,
): number {
  const arr = [...others, ...mine];
  const mineFrom = others.length;
  const total = arr.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  const slots = TILES.value;
  let won = 0;
  for (let t = 0; t < trials; t++) {
    const dead = new Uint8Array(arr.length);
    let rem = total;
    for (let r = 0; r < slots && rem > 0; r++) {
      let x = Math.random() * rem, pick = -1;
      for (let i = 0; i < arr.length; i++) {
        if (dead[i]) continue;
        x -= arr[i] as number;
        if (x < 0) { pick = i; break; }
      }
      if (pick < 0) break;
      dead[pick] = 1; rem -= arr[pick] as number;
      if (pick >= mineFrom) won += 1 / slots;
    }
  }
  return (won / trials) * 0.40 * pool;
}

// ── sybil curve ─────────────────────────────────────────────────────────────
console.log(`\n══ SYBIL GAIN — same total volume, split across k wallets ══`);
const sybilOf = types.find((t) => t.name === "mid")!;
const volS = sybilOf.perRoundUsd * ROUNDS_PER_EPOCH;
const tixS = Math.floor((volS * sybilOf.rate) / HASHRATE_PER_TICKET);
const base = { today: drawTake([tixS], field, POOL), prop: proposedTake([tixS], ref.total_participants, POOL) };
console.log(`  a ${usd(volS)}/epoch wallet holding ${tixS.toLocaleString()} tickets\n`);
const baseW = equalLegWeighted([tixS], field, POOL);
console.log("     k    TODAY rank curve   40% leg UNIFORM      40% leg TICKET-WEIGHTED");
for (const k of [1, 2, 4, 8, 21, 50, 500]) {
  const split = new Array<number>(k).fill(tixS / k);
  const today = drawTake(split, field, POOL);
  const uni = proposedTake(split, ref.total_participants + k - 1, POOL).equal;
  const wtd = equalLegWeighted(split, field, POOL);
  console.log(`  ${String(k).padStart(4)}    ${usd(today).padStart(9)} ` +
    `${("(" + (today / base.today).toFixed(2) + "x)").padStart(8)}   ` +
    `${usd(uni).padStart(9)} ${("(" + (uni / Math.max(1e-9, base.prop.equal)).toFixed(2) + "x)").padStart(9)}   ` +
    `${usd(wtd).padStart(9)} ${("(" + (wtd / Math.max(1e-9, baseW)).toFixed(2) + "x)").padStart(9)}`);
}
console.log(`\n  The 60% pro-rata leg is sybil-proof, and the owner is right about why:`);
console.log(`  splitting creates no new hashrate. With the field pinned at the streak`);
console.log(`  cap (${fieldRate.toFixed(1)} raw/$ against a theoretical max of 121) hashrate per dollar`);
console.log(`  is flat, so pro-rata by hashrate IS pro-rata by volume. 500 wallets at`);
console.log(`  1/500 the size each earn 1/500 the hashrate. Nothing is gained.`);
console.log(`\n  He is also right that the hole is not new: today's dedup already pays`);
console.log(`  ~1.6x for splitting, and it SATURATES — one win per wallet caps it.`);
console.log(`\n  The whole question is how the 21 are SELECTED, which the proposal does`);
console.log(`  not specify:`);
console.log(`    UNIFORM at random   one entry per wallet regardless of size, so the`);
console.log(`                        gain is LINEAR and unbounded — 113x at k=500.`);
console.log(`    TICKET-WEIGHTED     reuse the dedup draw that already exists and only`);
console.log(`                        flatten the PAYOUT — saturates at 2.75x.`);
console.log(`\n  So: reuse the existing selection and the objection is answered. Only`);
console.log(`  the uniform-random reading opens anything new, and 2.75x against`);
console.log(`  today's 1.6x is the honest cost of flattening the curve.`);
