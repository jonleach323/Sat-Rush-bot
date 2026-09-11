/**
 * Every live claim, recomputed from first-party sources, with error bars.
 *
 * This supersedes the ad-hoc numbers produced across this branch. Those were
 * wrong in three recurring ways — stale constants, our own config used as an
 * economic input, and point estimates from samples that could not support them
 * — so this recomputes all of them from:
 *
 *   @satrush/client   program constants and formulas (REWARD_MAX_STREAK,
 *                     hashrateReward, satsToBtc) rather than reverse-engineering
 *   @satrush/api      live config, board, full deployment history, epoch
 *                     iterations, hashrate leaderboard
 *
 * Uncertainty is EMPIRICAL, not modelled. Realized edge is a ratio estimator
 * Sum(y)/Sum(x) and its standard error comes from the residuals of this actual
 * sample — no assumption about the payoff distribution, which is what the
 * earlier analytic "4.06x the stake" version needed. Anything that does not
 * clear two standard errors is reported as unresolved, because a -25.45% draw
 * from a distribution that wide was already written up once as a finding.
 *
 *   pnpm recompute
 */
import {
  HASHRATE_PER_TICKET, REWARD_MAX_STREAK, TILE_COUNT, hashrateReward,
} from "@satrush/client";
import { blanketReturn, blanketToll, type FeeModel } from "../src/strategy/ev.js";
import { EPOCH_REWARD_CURVE_BPS } from "../src/strategy/vault.js";
import { resampleField } from "../src/ingest/epoch-field.js";
import { formatEstimate, samplesNeeded, significant, type Estimate } from "../src/strategy/facts.js";

const BASE = process.env["SATRUSH_API"] ?? "https://api.satrush.io/api/v1";
const WALLET = process.env["OPERATOR_WALLET"]
  ?? "8EHb675bVwz3nrAUssQfdKx8665WjkU5wZcykvqtii5J";
const USD = 1e6;

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}/${path}`);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return ((await r.json()) as { data: T }).data;
}
const n = (v: unknown): number => Number(v as string);
const money = (x: number): string => `${x < 0 ? "-" : "+"}$${Math.abs(x).toFixed(2)}`;

/**
 * Ratio estimator Sum(y)/Sum(x) with a standard error from the sample's own
 * residuals. Makes no claim about the shape of the payoff distribution — which
 * matters here because a 1-in-21 payout is wildly non-normal per trial but the
 * residual sum still behaves.
 */
function ratioEstimate(pairs: readonly { y: number; x: number }[]): Estimate {
  const sx = pairs.reduce((a, p) => a + p.x, 0);
  const sy = pairs.reduce((a, p) => a + p.y, 0);
  if (!(sx > 0) || pairs.length < 2) return { value: 0, stderr: Infinity, n: pairs.length };
  const r = sy / sx;
  const ss = pairs.reduce((a, p) => a + (p.y - r * p.x) ** 2, 0);
  return { value: 100 * r, stderr: (100 * Math.sqrt(ss)) / sx, n: pairs.length };
}

// ── 1. fees, straight from live config ──────────────────────────────────────
interface ApiConfig {
  strike_fee_bps: number; epoch_fee_bps: number; one_btc_fee_bps: number;
  protocol_fee_bps: number; sats_vault_round_fee_bps: number;
  vault_exit_fee_bps: number; unclaimed_hashrate_bps: number;
  epoch_vault_iteration_duration: number; min_deploy_usd_amount: string;
}
const conf = await get<ApiConfig>("config");
const fees: FeeModel = {
  deployFeeBps: conf.strike_fee_bps + conf.epoch_fee_bps + conf.one_btc_fee_bps
    + conf.protocol_fee_bps,
  satsVaultRoundBps: conf.sats_vault_round_fee_bps,
  satsVaultClaimBps: conf.vault_exit_fee_bps,
};
const TOLL = blanketToll(fees, conf.strike_fee_bps);
const CLAIM_NET = 1 - conf.vault_exit_fee_bps / 1e4;

console.log("══ 1. THE TOLL ─ arithmetic on live config, no error bar needed ══");
console.log(`  deploy legs ${fees.deployFeeBps} bps · sats round ${fees.satsVaultRoundBps} ` +
  `· sats claim ${fees.satsVaultClaimBps} · strike ${conf.strike_fee_bps}`);
console.log(`  blanket return ${blanketReturn(fees, 0).toFixed(4)} before strike, ` +
  `${blanketReturn(fees, conf.strike_fee_bps).toFixed(4)} after`);
console.log(`  BLANKET TOLL = ${(100 * TOLL).toFixed(3)}% of gross`);
console.log(`  (earlier quoted as 6.36% on an invented strike fraction, then 7.04%)`);

// ── 2. the wallet, from its full deployment history ─────────────────────────
interface Deployment {
  round_id: number; selected_tiles: number; deployed_usd_amount: string;
  is_won: boolean | null; is_automation: boolean;
  hashrate_earned: string; usd_earned: string;
  sats_shares_earned: string; btc_earned_usd: number;
}
const deploys: Deployment[] = [];
let before: number | undefined;
for (let page = 0; page < 40; page++) {
  const q = `users/${WALLET}/deployments?limit=100${before ? `&before=${before}` : ""}`;
  const batch = await get<Deployment[]>(q);
  if (batch.length === 0) break;
  deploys.push(...batch);
  const last = batch[batch.length - 1]!.round_id;
  if (last === before) break;
  before = last;
  if (batch.length < 100) break;
}
const seen = new Set<number>();
const rows = deploys.filter((d) => !seen.has(d.round_id) && seen.add(d.round_id));

console.log(`\n══ 2. THE WALLET ─ ${rows.length} deploys from the public API ══`);
const tilesOf = (mask: number): number => {
  let c = 0;
  for (let t = 0; t < TILE_COUNT; t++) if (mask & (1 << t)) c++;
  return c;
};
/** Realized value of one deploy: USD won + BTC won, less what we staked. */
const pairFor = (d: Deployment) => {
  const x = n(d.deployed_usd_amount) / USD;
  const y = n(d.usd_earned) / USD + d.btc_earned_usd * CLAIM_NET - x;
  return { x, y, tiles: tilesOf(d.selected_tiles), won: d.is_won === true };
};
const all = rows.map(pairFor);
const deployed = all.reduce((a, p) => a + p.x, 0);
const wonUsd = rows.reduce((a, d) => a + n(d.usd_earned) / USD, 0);
const wonBtc = rows.reduce((a, d) => a + d.btc_earned_usd, 0);
const net = wonUsd + wonBtc * CLAIM_NET - deployed;

console.log(`  deployed        $${deployed.toFixed(2)}`);
console.log(`  USD won         $${wonUsd.toFixed(2)}`);
console.log(`  BTC won         $${wonBtc.toFixed(2)} gross → $${(wonBtc * CLAIM_NET).toFixed(2)} ` +
  `net of the ${conf.vault_exit_fee_bps / 100}% claim fee`);
console.log(`  NET             ${money(net)}`);
const roi = ratioEstimate(all);
console.log(`  ROI             ${formatEstimate(roi, "%")}`);
console.log(`  vs a blanket    ${significant(roi, -100 * TOLL)
  ? "beats the toll at 2 sigma" : `NOT resolved against ${(-100 * TOLL).toFixed(2)}% — ` +
    `need ~${samplesNeeded({ ...roi, value: roi.value + 100 * TOLL }).toLocaleString()} deploys`}`);

// ── 3. by mask width ────────────────────────────────────────────────────────
console.log(`\n══ 3. BY MASK WIDTH ─ where the edge is, if anywhere ══`);
console.log("  tiles    deploys   volume       net       ROI ± se            verdict");
for (const [lo, hi, label] of [[1, 1, "1"], [2, 12, "2-12"], [13, 20, "13-20"],
  [21, 21, "21"]] as [number, number, string][]) {
  const g = all.filter((p) => p.tiles >= lo && p.tiles <= hi);
  if (g.length === 0) continue;
  const e = ratioEstimate(g);
  const vol = g.reduce((a, p) => a + p.x, 0);
  const nt = g.reduce((a, p) => a + p.y, 0);
  console.log(`  ${label.padStart(5)}    ${String(g.length).padStart(7)}   ` +
    `$${vol.toFixed(0).padStart(6)}   ${money(nt).padStart(9)}   ` +
    `${formatEstimate(e, "%").padEnd(34)} ` +
    `${significant(e, -100 * TOLL) ? (e.value > -100 * TOLL ? "beats blanket" : "worse than blanket") : "unresolved"}`);
}
const winners = all.filter((p) => p.won).length;
console.log(`\n  held the winning tile ${winners}/${all.length} ` +
  `(${(100 * winners / all.length).toFixed(1)}%)`);

// ── 4. rho, the farming question, from the leaderboard ──────────────────────
interface LbRow {
  authority: string; total_usd_deployed: string; total_hashrate_earned: string;
  total_rounds_played: number; max_streak: number;
}
const lb = await get<LbRow[]>("leaderboard/hashrate-earned?limit=50");
const fieldRaw = lb.reduce((a, r) => a + n(r.total_hashrate_earned), 0);
const fieldUsd = lb.reduce((a, r) => a + n(r.total_usd_deployed) / USD, 0);
const fieldRate = fieldRaw / fieldUsd;

// Our best achievable rate, from the SDK's own formula.
const rateAt = (streak: number, covered: number): number =>
  Number(hashrateReward(BigInt(USD), Math.min(streak, REWARD_MAX_STREAK), covered,
    TILE_COUNT, BigInt(USD)).total);
const ourBlanket = rateAt(REWARD_MAX_STREAK, TILE_COUNT);
const ourSingle = rateAt(REWARD_MAX_STREAK, 1);

console.log(`\n══ 4. RHO ─ our hashrate per dollar vs the field's ══`);
console.log(`  top ${lb.length} wallets: $${(fieldUsd / 1e6).toFixed(2)}M deployed, ` +
  `${(fieldRaw / 1e6).toFixed(1)}M raw hashrate`);
console.log(`  field rate     ${fieldRate.toFixed(1)} raw/$`);
console.log(`  ours, blanket  ${ourBlanket} raw/$ at streak ${REWARD_MAX_STREAK} → ` +
  `rho ${(ourBlanket / fieldRate).toFixed(2)}`);
console.log(`  ours, 1 tile   ${ourSingle} raw/$ at streak ${REWARD_MAX_STREAK} → ` +
  `rho ${(ourSingle / fieldRate).toFixed(2)}`);
console.log(`  max streak in the field: ${Math.max(...lb.map((r) => r.max_streak))} ` +
  `— the COUNTER runs past ${REWARD_MAX_STREAK}, the reward multiplier does not`);
const breakEvenRho = TOLL / (conf.epoch_fee_bps / 1e4);
console.log(`\n  farming break-even needs rho >= ${breakEvenRho.toFixed(2)} ` +
  `(toll ${(100 * TOLL).toFixed(2)}% / epoch leg ${conf.epoch_fee_bps} bps)`);
console.log(`  → blanket farming is ${ourBlanket / fieldRate >= breakEvenRho ? "VIABLE" : "NOT VIABLE"}` +
  `, single-tile farming is ${ourSingle / fieldRate >= breakEvenRho ? "VIABLE" : "NOT VIABLE"}`);

// ── 5. the epoch draw, priced against the live field ────────────────────────
interface Iter {
  id: number; total_participants: number; total_tickets: string;
  pool_combined_usd_amount: number | null;
}
const hist = await get<Iter[]>("epoch/history?limit=8");
console.log(`\n══ 5. EPOCH ITERATIONS ─ measured, not projected ══`);
console.log("   iter   participants    tickets        pool      raw/$ implied");
for (const it of hist) {
  const pool = it.pool_combined_usd_amount;
  console.log(`  ${String(it.id).padStart(5)}   ${String(it.total_participants).padStart(12)}   ` +
    `${n(it.total_tickets).toLocaleString().padStart(9)}   ` +
    `${pool ? "$" + pool.toFixed(0).padStart(8) : "    (open)"}`);
}

const live = hist.find((h) => h.pool_combined_usd_amount === null) ?? hist[0]!;
const closed = hist.filter((h) => h.pool_combined_usd_amount !== null);
const lastClosed = closed[0];
if (lastClosed) {
  const parts = await get<{ authority: string; tickets: string }[]>(
    `epoch/iterations/${live.id}/participants?limit=500`,
  ).catch(() => []);
  const blocks = parts.map((p) => n(p.tickets)).filter((x) => x > 0).sort((a, b) => b - a);
  console.log(`\n  live iteration ${live.id}: ${live.total_participants} participants, ` +
    `${n(live.total_tickets).toLocaleString()} tickets` +
    `${blocks.length ? ` (${blocks.length} read)` : ""}`);
  console.log(`  last CLOSED (${lastClosed.id}): ${lastClosed.total_participants} participants, ` +
    `${n(lastClosed.total_tickets).toLocaleString()} tickets, ` +
    `$${lastClosed.pool_combined_usd_amount!.toFixed(0)} pool`);

  if (blocks.length > 1) {
    /** 21 winners, without replacement, deduped by wallet. */
    const draw = (mine: number, field: number[], pool: number, trials = 20_000): number => {
      const arr = [...field, mine];
      const me = arr.length - 1;
      const total = arr.reduce((a, b) => a + b, 0);
      let cap = 0;
      for (let t = 0; t < trials; t++) {
        const dead = new Uint8Array(arr.length);
        let rem = total;
        for (let r = 0; r < EPOCH_REWARD_CURVE_BPS.length && rem > 0; r++) {
          let x = Math.random() * rem, pick = -1;
          for (let i = 0; i < arr.length; i++) {
            if (dead[i]) continue;
            x -= arr[i]!;
            if (x < 0) { pick = i; break; }
          }
          if (pick < 0) break;
          dead[pick] = 1; rem -= arr[pick]!;
          if (pick === me) { cap += (EPOCH_REWARD_CURVE_BPS[r] ?? 0) / 1e4; break; }
        }
      }
      return (cap / trials) * pool;
    };
    // Price a $1/round blanket farm over one whole iteration, bracketing the
    // one thing that actually decides it: how many wallets turn up.
    const roundsPerIter = Math.round(conf.epoch_vault_iteration_duration / 150);
    const tickets = Math.floor((ourBlanket * roundsPerIter) / Number(HASHRATE_PER_TICKET));
    const boardCost = TOLL * 1 * roundsPerIter;
    const totalFull = n(live.total_tickets) *
      (n(lastClosed.total_tickets) / Math.max(1, n(live.total_tickets)));
    console.log(`\n  farm-21 at $1/round over ${roundsPerIter} rounds → ` +
      `${tickets.toLocaleString()} tickets, board cost $${boardCost.toFixed(2)}`);
    console.log("   entrants   epoch take    NET/iter");
    for (const p of [live.total_participants, 100, lastClosed.total_participants]) {
      const f = resampleField(blocks, p, Math.max(totalFull, n(live.total_tickets)));
      const take = draw(tickets, f, lastClosed.pool_combined_usd_amount!);
      console.log(`  ${String(p).padStart(9)}   $${take.toFixed(2).padStart(9)}   ` +
        `${money(take - boardCost).padStart(9)}`);
    }
    console.log(`  (pool held at the last CLOSED iteration's $${lastClosed.pool_combined_usd_amount!.toFixed(0)};`);
    console.log(`   the live pool is smaller, so these are upper bounds)`);
  }
}

console.log(`\n══ WHAT SURVIVES ══`);
console.log(`  The toll is exact. Everything else is a sample, and the ROI above`);
console.log(`  is the only wallet-level number that matters — read its error bar`);
console.log(`  before quoting it.`);
