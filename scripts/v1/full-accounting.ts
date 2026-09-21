/**
 * Every leg, classified as LEAK or REDISTRIBUTION. The full accounting.
 *
 * WHY THIS EXISTS
 *
 * Every previous pass over-counted the rake by treating buffers and transfers
 * as losses. Three separate corrections:
 *
 *   1. The strike's 30% is NOT lost. `strike.pool_usd_amount / usd_amount` is
 *      exactly 0.700000, and `epoch.active_pool / pool` is exactly 0.900000 —
 *      the same structure, and the epoch's 10% is owner-confirmed as a ROLLOVER
 *      buffer rather than a rake. At steady state a buffer distributes its
 *      entire inflow; it only means the pool runs larger than one cycle's
 *      inflow. Counting it as a leak cost 0.88% of volume.
 *
 *   2. The sats claim fee is NOT lost either. It stays IN the vault, which is
 *      the entire reason share value appreciates — measured, +6.61% ± 0.89%
 *      across 41 wallets. It is a transfer from claimers to holders, so for the
 *      player pool as a whole it nets to zero. Counting it as a leak cost
 *      another 1.20%.
 *
 *   3. The epoch and 1-BTC legs return through the vaults, so writing them off
 *      is the 7.046% "toll" figure, which is a BOARD round-trip and not an
 *      all-in number.
 *
 * What actually leaves the player pool is the protocol fee. That is it.
 *
 *   pnpm full-accounting
 */
import { formatEstimate, type Estimate } from "../../src/strategy/facts.js";
import { hashrateReward, REWARD_MAX_STREAK, TILE_COUNT } from "@satrush/client";

const BASE = process.env["SATRUSH_API"] ?? "https://api.satrush.io/api/v1";
const USD = 1e6;
const B = (bps: number): number => bps / 1e4;

interface ApiConfig {
  strike_fee_bps: number; epoch_fee_bps: number; one_btc_fee_bps: number;
  protocol_fee_bps: number; sats_vault_round_fee_bps: number;
  vault_exit_fee_bps: number;
}
interface BoardT {
  strike: { usd_amount: string; pool_usd_amount: string };
  epoch_vault: { pool_usd_amount: string; active_pool_usd_amount: string };
}
interface LbRow { authority: string; total_usd_deployed: string; total_hashrate_earned: string }

const get = async <T>(p: string): Promise<T> =>
  ((await (await fetch(`${BASE}/${p}`)).json()) as { data: T }).data;
const [conf, board, lb] = await Promise.all([
  get<ApiConfig>("config"), get<BoardT>("board"),
  get<LbRow[]>("leaderboard/hashrate-earned?limit=50"),
]);

// ── 1. confirm the buffer structure from live state ─────────────────────────
const strikeRatio = Number(board.strike.pool_usd_amount) / Number(board.strike.usd_amount);
const epochRatio = Number(board.epoch_vault.active_pool_usd_amount)
  / Number(board.epoch_vault.pool_usd_amount);
console.log("══ ARE THE HOLDBACKS BUFFERS OR RAKE? ══");
console.log(`  strike payable / total   ${strikeRatio.toFixed(6)}`);
console.log(`  epoch  payable / total   ${epochRatio.toFixed(6)}`);
console.log(`  The epoch's ${((1 - epochRatio) * 100).toFixed(0)}% is owner-confirmed as a rollover buffer. The strike`);
console.log(`  exposes the identical structure, so its ${((1 - strikeRatio) * 100).toFixed(0)}% is read the same way:`);
console.log(`  a buffer distributes its whole inflow at steady state and leaks nothing.`);
console.log(`  INFERRED BY ANALOGY, not separately confirmed — worth asking the owner.\n`);

// ── 2. the ledger ───────────────────────────────────────────────────────────
type Kind = "returned" | "redistributed" | "LEAK";
const legs: { name: string; frac: number; kind: Kind; note: string }[] = [
  { name: "pot → USDC returned", frac: 1 - B(conf.strike_fee_bps + conf.epoch_fee_bps
      + conf.one_btc_fee_bps + conf.protocol_fee_bps) - B(conf.sats_vault_round_fee_bps),
    kind: "returned", note: "v2: paid back pro-rata regardless of tile" },
  { name: "sats vault round leg", frac: B(conf.sats_vault_round_fee_bps),
    kind: "returned", note: "paid as BTC shares" },
  { name: "sat strike", frac: B(conf.strike_fee_bps),
    kind: "redistributed", note: `${((1 - strikeRatio) * 100).toFixed(0)}% buffered, not lost` },
  { name: "epoch vault", frac: B(conf.epoch_fee_bps),
    kind: "redistributed", note: `${((1 - epochRatio) * 100).toFixed(0)}% rolls over` },
  { name: "1-BTC vault", frac: B(conf.one_btc_fee_bps),
    kind: "redistributed", note: "accumulates to a 1 BTC prize" },
  { name: "protocol fee", frac: B(conf.protocol_fee_bps),
    kind: "LEAK", note: "the only money that leaves" },
];
console.log("══ THE LEDGER, per $1 deployed ══");
console.log("  leg                       share    class            note");
for (const l of legs) {
  console.log(`  ${l.name.padEnd(24)} ${(100 * l.frac).toFixed(2).padStart(6)}%   ` +
    `${l.kind.padEnd(15)}  ${l.note}`);
}
const leak = legs.filter((l) => l.kind === "LEAK").reduce((a, l) => a + l.frac, 0);
const sum = legs.reduce((a, l) => a + l.frac, 0);
console.log(`  ${"".padEnd(24)} ${(100 * sum).toFixed(2).padStart(6)}%   (sums to 100%)`);
console.log(`\n  TRUE AGGREGATE RAKE = ${(100 * leak).toFixed(2)}%. Players collectively get ` +
  `back ${(100 * (1 - leak)).toFixed(2)}%.`);
console.log(`  The sats CLAIM fee is not in this list because it stays in the vault —`);
console.log(`  it is a transfer from claimers to holders, and nets to zero for the pool.`);

// ── 3. what an individual can capture above proportional ────────────────────
const SATS = B(conf.sats_vault_round_fee_bps);
const fieldRate = lb.reduce((a, r) => a + Number(r.total_hashrate_earned), 0)
  / lb.reduce((a, r) => a + Number(r.total_usd_deployed) / USD, 0);
const rateAt = (n: number): number =>
  Number(hashrateReward(BigInt(USD), REWARD_MAX_STREAK, n, TILE_COUNT, BigInt(USD)).total);

// Measured across 41 wallets in pnpm carry-check.
const carry: Estimate = { value: 6.61, stderr: 0.89, n: 41 };
const carryOfVolume = SATS * (carry.value / 100);
const carryLo = SATS * ((carry.value - 2 * carry.stderr) / 100);
const carryHi = SATS * ((carry.value + 2 * carry.stderr) / 100);
const hashUplift = rateAt(1) / fieldRate - 1;
const rebateEdge = B(conf.epoch_fee_bps) * 0.60 * hashUplift;

console.log(`\n══ WHAT AN INDIVIDUAL CAN CAPTURE ABOVE PROPORTIONAL ══`);
console.log(`  never claiming — others' claim fees accrue to your shares`);
console.log(`    field appreciation ${formatEstimate(carry, "%")}`);
console.log(`    × the ${(100 * SATS).toFixed(0)}% sats leg = ${(100 * carryOfVolume).toFixed(3)}% of volume ` +
  `(2σ: ${(100 * carryLo).toFixed(3)}%…${(100 * carryHi).toFixed(3)}%)`);
console.log(`  single-tile under v2 — free once the pot returns regardless`);
console.log(`    ${rateAt(1)} raw/$ vs the field's ${fieldRate.toFixed(1)} = +${(100 * hashUplift).toFixed(1)}%`);
console.log(`    × the ${(1e4 * B(conf.epoch_fee_bps) * 0.60).toFixed(0)} bps rebate leg = ` +
  `${(100 * rebateEdge).toFixed(3)}% of volume`);

console.log(`\n══ THE ANSWER ══`);
console.log("  scenario                             rake     capture      NET");
const scenarios: [string, number][] = [
  ["today's protocol fee (142 bps)", B(conf.protocol_fee_bps)],
  ["fee layer 8% → 6%, protocol pro-rata", B(conf.protocol_fee_bps) * 0.75],
  ["protocol fee → 71 bps", B(71)],
  ["protocol fee → 0", 0],
];
for (const [label, r] of scenarios) {
  const cap = carryOfVolume + rebateEdge;
  const net = cap - r;
  console.log(`  ${label.padEnd(36)} ${(100 * r).toFixed(2).padStart(5)}%   ` +
    `${(100 * cap).toFixed(2).padStart(6)}%   ${(net >= 0 ? "+" : "") + (100 * net).toFixed(2)}%` +
    `${net > 0 ? "  ← POSITIVE" : ""}`);
}
console.log(`\n  Range on the capture from the carry's 2σ band: ` +
  `${(100 * (carryLo + rebateEdge)).toFixed(2)}%…${(100 * (carryHi + rebateEdge)).toFixed(2)}%.`);
console.log(`  Against today's ${(100 * B(conf.protocol_fee_bps)).toFixed(2)}% protocol fee that straddles ` +
  `break-even, so the honest`);
console.log(`  verdict is UNRESOLVED at today's fees and POSITIVE if the protocol leg`);
console.log(`  is cut, which is exactly what v2 proposes.`);
console.log(`\n  Two caveats that decide it and are not yet measured:`);
console.log(`   - the carry is a RATE, not a level. ${carry.value.toFixed(2)}% is cumulative over the`);
console.log(`     game's life so far; per-round it depends on how fast others claim.`);
console.log(`   - it is funded by claimers, so it decays as the field learns. Both`);
console.log(`     need a time series before sizing.`);
