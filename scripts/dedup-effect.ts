/**
 * What per-wallet dedup does to epoch EV — simulated against the REAL field.
 *
 * The naive model says expected winnings are linear in ticket share:
 * E = 0.9 · (mine / total) · pool. That is right only in the limit of a tiny
 * holding. The program draws 21 winners WITHOUT replacement and removes a
 * drawn wallet's ENTIRE block, so:
 *
 *   - a wallet can win at most once, which makes our own payoff CONCAVE and
 *     costs us relative to linear as our share grows;
 *   - every rival whale drawn early vanishes from the pool, which LIFTS our
 *     odds on the remaining draws and pays us more than linear when we are small.
 *
 * The two effects point in opposite directions, so dedup is not a penalty — it
 * is a transfer from large holders to small ones, with a crossover somewhere in
 * between. Anyone sizing off the linear model is wrong on both sides of it, and
 * wrong in the expensive direction if they are farming at size.
 *
 * This does not model that; it simulates the actual draw against the actual
 * ticket distribution on chain and reports where the crossover falls and what
 * mis-sizing costs.
 *
 *   pnpm dedup-effect
 */
import { createRequire } from "node:module";
import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { EPOCH_REWARD_CURVE_BPS, EPOCH_PAYOUT_FRACTION } from "../src/strategy/vault.js";

const cfg = loadConfig();
const conn = new Connection(cfg.RPC_HTTP_URL, "confirmed");
const pid = new PublicKey(cfg.PROGRAM_ID);
const usd = (n: number): string =>
  `${n < 0 ? "-" : "+"}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

// ── the live field ───────────────────────────────────────────────────────────
const disc = createHash("sha256").update("account:EpochVaultEntry").digest().subarray(0, 8);
const accounts = await conn.getProgramAccounts(pid, {
  commitment: "confirmed",
  filters: [
    { memcmp: { offset: 0, bytes: Buffer.from(disc).toString("base64"), encoding: "base64" } },
  ],
});
// 8 disc | version u16 | bump u8 | iteration_id u32 | authority 32 | page u16 | tickets u64
const byIteration = new Map<number, number[]>();
for (const { account } of accounts) {
  const iteration = account.data.readUInt32LE(11);
  const tickets = Number(account.data.readBigUInt64LE(49));
  if (tickets > 0) byIteration.set(iteration, [...(byIteration.get(iteration) ?? []), tickets]);
}
const iteration = Math.max(...byIteration.keys());
const observed = (byIteration.get(iteration) ?? []).sort((a, b) => b - a);
const observedTotal = observed.reduce((a, b) => a + b, 0);

// Project the field to the iteration's close, preserving its CONCENTRATION —
// the shape is what drives dedup, so scaling every entry by the same factor is
// the right way to extrapolate it.
// MEASURED, from EpochDrawTriggered on the last completed iteration (4) — no
// projection. Earlier revisions of this script extrapolated the live iteration
// from ~7% elapsed and got 475,872 tickets against a $63,898 pool; the actual
// close was 806,582 tickets against a $46,553 pool. Both errors flattered us.
const PROJECTED_FIELD = 806_582;
const POOL_USD = 46_553;

// Prefer the MEASURED distribution of a completed iteration over the live
// iteration's partial shape. Early in an iteration only the big buyers have
// entered, so scaling that shape to a full total badly overstates
// concentration — measured, iteration 4 had 157 wallets and a 46.8% top-5,
// against the 37 wallets and 77.4% top-5 the scaled live shape implied.
function loadMeasuredField(): number[] | null {
  try {
    const readFileSync = createRequire(import.meta.url)("node:fs").readFileSync as (p: string, e: string) => string;
    const raw = JSON.parse(readFileSync("data/epoch-iteration-4.json", "utf8")) as {
      blocks: number[];
    };
    return raw.blocks?.length ? raw.blocks : null;
  } catch {
    return null;
  }
}
const measured = loadMeasuredField();
const field = measured ?? observed.map((t) => t * (PROJECTED_FIELD / observedTotal));
if (measured) console.log("using MEASURED iteration-4 distribution (157 wallets)");
const fieldTotal = field.reduce((a, b) => a + b, 0);

// Cost of a ticket in board toll: 6.36% of gross, and gross converts to raw
// hashrate at 101/$ with 65% liquid → 0.6565 tickets per dollar deployed.
// hashrate_earned is the FULL s(m + 21/n) output (operator-confirmed), and
// unclaimed_hashrate_earned is an ADDITIONAL bonus on top — measured mean
// 0.246 of it. The old 0.65 haircut treated a bonus as a deduction.
const TOLL_PER_TICKET = 0.0636 / ((101 * 1.246) / 100);

console.log(`iteration ${iteration}: ${observed.length} wallets, ${observedTotal.toLocaleString()} tickets observed`);
console.log(`projected to close: ${Math.round(fieldTotal).toLocaleString()} tickets, pool $${POOL_USD.toLocaleString()}`);
console.log(`concentration: top1 ${(100 * (field[0] ?? 0) / fieldTotal).toFixed(1)}%  ` +
  `top5 ${(100 * field.slice(0, 5).reduce((a, b) => a + b, 0) / fieldTotal).toFixed(1)}%`);
console.log(`toll per ticket: $${TOLL_PER_TICKET.toFixed(4)}\n`);

// ── simulate the actual draw ─────────────────────────────────────────────────
/** Expected fraction of the pool we capture, holding `mine` tickets. */
function simulate(mine: number, trials = 30_000): number {
  const pool = [...field, mine];
  const me = pool.length - 1;
  const total = fieldTotal + mine;
  let captured = 0;
  for (let t = 0; t < trials; t++) {
    const dead = new Uint8Array(pool.length);
    let remaining = total;
    for (let rank = 0; rank < EPOCH_REWARD_CURVE_BPS.length && remaining > 0; rank++) {
      let r = Math.random() * remaining;
      let picked = -1;
      for (let i = 0; i < pool.length; i++) {
        if (dead[i]) continue;
        r -= pool[i] as number;
        if (r < 0) { picked = i; break; }
      }
      if (picked < 0) break;
      dead[picked] = 1;
      remaining -= pool[picked] as number;
      if (picked === me) {
        captured += (EPOCH_REWARD_CURVE_BPS[rank] ?? 0) / 10_000;
        break; // a wallet wins at most once
      }
    }
  }
  return captured / trials;
}

/** The naive model: linear in ticket share. */
const linearFraction = (mine: number): number =>
  EPOCH_PAYOUT_FRACTION * (mine / (mine + fieldTotal));

console.log("  tickets     share   linear $   dedup $    ratio   linear net   dedup net");
const grid = [500, 1_000, 1_418, 2_000, 2_836, 4_000, 5_672, 8_000, 14_180, 28_361, 50_000];
const rows = grid.map((mine) => {
  const share = mine / (mine + fieldTotal);
  const lin = linearFraction(mine) * POOL_USD;
  const ded = simulate(mine) * POOL_USD;
  const toll = mine * TOLL_PER_TICKET;
  return { mine, share, lin, ded, ratio: ded / lin, linNet: lin - toll, dedNet: ded - toll };
});
for (const r of rows) {
  const flag = r.ratio >= 1 ? "  ⬆ beats linear" : "";
  console.log(
    `  ${r.mine.toLocaleString().padStart(8)}  ${(100 * r.share).toFixed(2).padStart(6)}%  ` +
      `${("$" + Math.round(r.lin).toLocaleString()).padStart(8)}  ` +
      `${("$" + Math.round(r.ded).toLocaleString()).padStart(8)}  ` +
      `${r.ratio.toFixed(2).padStart(6)}x  ` +
      `${usd(r.linNet).padStart(10)}  ${usd(r.dedNet).padStart(10)}${flag}`,
  );
}

// ── crossover, optima, and the cost of using the wrong model ─────────────────
let crossover: number | null = null;
for (let i = 1; i < rows.length; i++) {
  const a = rows[i - 1]!, b = rows[i]!;
  if (a.ratio >= 1 && b.ratio < 1) {
    const f = (a.ratio - 1) / (a.ratio - b.ratio);
    crossover = a.share + f * (b.share - a.share);
    break;
  }
}
console.log(
  crossover !== null
    ? `\n  crossover: dedup beats linear below ~${(100 * crossover).toFixed(1)}% ticket share, loses above it`
    : `\n  crossover: outside the sampled range`,
);

const bestLinear = rows.reduce((a, b) => (b.linNet > a.linNet ? b : a));
const bestDedup = rows.reduce((a, b) => (b.dedNet > a.dedNet ? b : a));
console.log(`\n  sizing off the LINEAR model → ${bestLinear.mine.toLocaleString()} tickets`);
console.log(`    expected: ${usd(bestLinear.linNet)}     actual: ${usd(bestLinear.dedNet)}` +
  `     error: ${usd(bestLinear.dedNet - bestLinear.linNet)}`);
console.log(`  sizing off the DEDUP model  → ${bestDedup.mine.toLocaleString()} tickets`);
console.log(`    actual: ${usd(bestDedup.dedNet)}`);
console.log(`\n  cost of ignoring dedup: ${usd(bestDedup.dedNet - bestLinear.dedNet)} per iteration`);
