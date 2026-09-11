/**
 * Why concentration loses the epoch draw even though whales win rank 1 most —
 * and how far the split incentive actually goes.
 *
 * The owner's intuition is correct as far as it goes: rank 1 is drawn FIRST,
 * weighted by tickets, so the largest holder genuinely does have the best shot
 * at the biggest single prize. What that misses is the cap. A wallet is removed
 * once drawn, so its whole payoff is "best prize I catch, once". A 30% holder
 * takes rank 1 about 30% of the time and then leaves — it can never also take
 * ranks 4, 9 and 17, which is precisely what the same tickets spread across
 * several wallets would do.
 *
 * So both statements hold at once: whales have the best chance at rank 1, and
 * whales have the worst EV per ticket. This measures both against the real
 * on-chain field, and extends the dev's four-way split to the full curve —
 * because the incentive does not stop at four.
 *
 * NOTE ON INTENT: this quantifies an exploit surface for a design conversation.
 * It is analysis, not a plan — this repo trades one wallet and has no
 * multi-wallet path, and the operator's stated position is that the split
 * incentive is a bug to blunt.
 *
 *   pnpm sybil-curve [total-tickets]
 */
import { createRequire } from "node:module";
import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { loadConfig } from "../../src/config.js";
import { EPOCH_REWARD_CURVE_BPS, EPOCH_PAYOUT_FRACTION } from "../../src/strategy/vault.js";
import { EPOCH_LAST_CLOSE_TICKETS } from "../../src/strategy/facts.js";

const cfg = loadConfig();
const conn = new Connection(cfg.RPC_HTTP_URL, "confirmed");
const pid = new PublicKey(cfg.PROGRAM_ID);
const usd = (n: number): string => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

// Measured close of the last COMPLETE iteration (4), from EpochDrawTriggered.
const FIELD_TICKETS = EPOCH_LAST_CLOSE_TICKETS.value;
const POOL_USD = 46_553;
const TOTAL = Number(process.argv[2] ?? 100_000);

// Live concentration shape, scaled to the measured close.
const disc = createHash("sha256").update("account:EpochVaultEntry").digest().subarray(0, 8);
const accounts = await conn.getProgramAccounts(pid, {
  commitment: "confirmed",
  filters: [
    { memcmp: { offset: 0, bytes: Buffer.from(disc).toString("base64"), encoding: "base64" } },
  ],
});
const byIteration = new Map<number, number[]>();
for (const { account } of accounts) {
  const it = account.data.readUInt32LE(11);
  const t = Number(account.data.readBigUInt64LE(49));
  if (t > 0) byIteration.set(it, [...(byIteration.get(it) ?? []), t]);
}
const live = (byIteration.get(Math.max(...byIteration.keys())) ?? []).sort((a, b) => b - a);
const liveTotal = live.reduce((a, b) => a + b, 0);

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
const field = measured ?? live.map((t) => (t * FIELD_TICKETS) / liveTotal);
if (measured) console.log("using MEASURED iteration-4 distribution (157 wallets)");
const fieldTotal = field.reduce((a, b) => a + b, 0);

/**
 * Run the draw. `mine` lists OUR wallets' ticket blocks (one entry per wallet).
 * Returns total pool fraction captured across all of them, plus rank-1 and
 * any-win rates for the FIRST of our wallets.
 */
function simulate(mine: number[], trials = 40_000) {
  const pool = [...field, ...mine];
  const first = field.length;
  const total = fieldTotal + mine.reduce((a, b) => a + b, 0);
  let captured = 0, rank1 = 0, anyWin = 0;
  for (let t = 0; t < trials; t++) {
    const dead = new Uint8Array(pool.length);
    let remaining = total;
    let wonFirst = false;
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
      if (picked >= first) {
        captured += (EPOCH_REWARD_CURVE_BPS[rank] ?? 0) / 10_000;
        if (picked === first) {
          wonFirst = true;
          if (rank === 0) rank1++;
        }
      }
    }
    if (wonFirst) anyWin++;
  }
  return { ev: (captured / trials) * POOL_USD, rank1: rank1 / trials, anyWin: anyWin / trials };
}

console.log(`field ${Math.round(fieldTotal).toLocaleString()} tickets (measured close, iteration 4)`);
console.log(`pool  ${usd(POOL_USD)}   holding under test: ${TOTAL.toLocaleString()} tickets\n`);

// ── the owner's question: don't whales have the best shot? ───────────────────
console.log("═══ yes — and it still loses ═══");
console.log("  wallet size    share   P(rank 1)   P(win anything)   EV        EV/ticket");
for (const size of [5_000, 25_000, 50_000, 100_000, 200_000]) {
  const r = simulate([size]);
  const share = size / (size + fieldTotal);
  console.log(
    `  ${size.toLocaleString().padStart(11)}   ${(100 * share).toFixed(2).padStart(6)}%   ` +
      `${(100 * r.rank1).toFixed(2).padStart(8)}%   ${(100 * r.anyWin).toFixed(2).padStart(14)}%   ` +
      `${usd(r.ev).padStart(7)}   $${(r.ev / size).toFixed(4)}`,
  );
}
console.log("\n  P(rank 1) rises with size — the owner is right about that. EV/ticket falls");
console.log("  anyway, because a wallet is removed once drawn: the whale's ceiling is ONE");
console.log("  prize, however large, while the same tickets in several wallets collect several.");

// ── the split curve ──────────────────────────────────────────────────────────
console.log(`\n═══ splitting ${TOTAL.toLocaleString()} tickets across N wallets ═══`);
console.log("  wallets   per wallet     total EV   vs 1 wallet   EV/ticket");
let base = 0;
for (const n of [1, 2, 4, 8, 16, 32, 64, 128]) {
  const per = Math.floor(TOTAL / n);
  if (per < 1) break;
  const r = simulate(Array.from({ length: n }, () => per));
  if (n === 1) base = r.ev;
  const gain = base > 0 ? (r.ev / base - 1) * 100 : 0;
  console.log(
    `  ${String(n).padStart(7)}   ${per.toLocaleString().padStart(10)}   ${usd(r.ev).padStart(10)}   ` +
      `${(gain >= 0 ? "+" : "") + gain.toFixed(0) + "%"}`.padStart(14) +
      `   $${(r.ev / TOTAL).toFixed(4)}`,
  );
}

// Where the curve asymptotes. Note this lands ABOVE the linear/pro-rata payout,
// not below it: once our wallets are small enough that the once-only cap never
// binds, we still collect the uplift from RIVAL blocks being removed as they are
// drawn. An earlier version of this script called the linear payout a "ceiling",
// which the simulation immediately contradicts — atomised holdings beat linear
// for the same reason a small holder does.
const linearPayout = EPOCH_PAYOUT_FRACTION * (TOTAL / (TOTAL + fieldTotal)) * POOL_USD;
console.log(`\n  linear/pro-rata payout for comparison: ${usd(linearPayout)}`);
console.log("  The dev's 4-way split is not the end of it — the incentive keeps paying until");
console.log("  each wallet is small enough that the once-only cap stops binding, which is");
console.log("  roughly 32 wallets here, not 4.");
