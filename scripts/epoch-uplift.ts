/**
 * Re-measure EPOCH_DEDUP_UPLIFT against the live ticket distribution.
 *
 * Epoch winners are deduped by wallet: a drawn holder's ENTIRE block leaves the
 * pool. When tickets are concentrated, whales are drawn early and vanish, so a
 * small holder's odds on later draws far exceed its raw ticket share.
 * epochWinFraction() models our own once-only constraint but treats the rest of
 * the pool as static, which understates EV by a factor that depends entirely on
 * how concentrated the field currently is.
 *
 * This reads every EpochVaultEntry for the live iteration and simulates the 21
 * draws to measure that factor. Re-run it when concentration shifts.
 *
 *   pnpm epoch-uplift
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { EPOCH_REWARD_CURVE_BPS, epochWinFraction } from "../src/strategy/vault.js";

const cfg = loadConfig();
const connection = new Connection(cfg.RPC_HTTP_URL, "confirmed");
const programId = new PublicKey(cfg.PROGRAM_ID);
const disc = createHash("sha256").update("account:EpochVaultEntry").digest().subarray(0, 8);

const accounts = await connection.getProgramAccounts(programId, {
  commitment: "confirmed",
  filters: [{ memcmp: { offset: 0, bytes: Buffer.from(disc).toString("base64"), encoding: "base64" } }],
});

// 8 disc | version u16 | bump u8 | iteration_id u32 | authority 32 | page u16 | tickets u64
const byIteration = new Map<number, number[]>();
for (const { account } of accounts) {
  const iteration = account.data.readUInt32LE(11);
  const tickets = Number(account.data.readBigUInt64LE(49));
  if (tickets > 0) byIteration.set(iteration, [...(byIteration.get(iteration) ?? []), tickets]);
}
const iteration = Math.max(...byIteration.keys());
const field = (byIteration.get(iteration) ?? []).sort((a, b) => b - a);
const total = field.reduce((a, b) => a + b, 0);
const share = (n: number) => field.slice(0, n).reduce((a, b) => a + b, 0) / total;

console.log(`iteration ${iteration}: ${field.length} participants, ${total.toLocaleString()} tickets`);
console.log(`concentration: top1 ${(100 * share(1)).toFixed(1)}%  top10 ${(100 * share(10)).toFixed(1)}%`);

/** One draw sequence; returns the reward-curve fraction we captured. */
function simulate(mine: number, trials: number): number {
  const pool = [...field, mine];
  const me = pool.length - 1;
  let captured = 0;
  for (let t = 0; t < trials; t++) {
    const alive = pool.map((_, i) => i);
    let remaining = pool.reduce((a, b) => a + b, 0);
    for (let rank = 0; rank < EPOCH_REWARD_CURVE_BPS.length && remaining > 0; rank++) {
      let r = Math.random() * remaining;
      let picked = -1;
      for (const idx of alive) {
        r -= pool[idx] as number;
        if (r < 0) { picked = idx; break; }
      }
      if (picked < 0) break;
      if (picked === me) { captured += (EPOCH_REWARD_CURVE_BPS[rank] ?? 0) / 10_000; break; }
      remaining -= pool[picked] as number;
      alive.splice(alive.indexOf(picked), 1);
    }
  }
  return captured / trials;
}

console.log("\n  tickets      modelled         true      uplift");
const ratios: number[] = [];
for (const mine of [144, 500, 2000]) {
  const modelled = epochWinFraction(mine / (total + mine));
  const truth = simulate(mine, 120_000);
  const ratio = modelled > 0 ? truth / modelled : 0;
  ratios.push(ratio);
  console.log(
    `  ${String(mine).padStart(7)}   ${modelled.toExponential(3)}   ${truth.toExponential(3)}   ${ratio.toFixed(2)}x`,
  );
}
const mid = ratios.sort((a, b) => a - b)[Math.floor(ratios.length / 2)] as number;
console.log(`\nEPOCH_DEDUP_UPLIFT=${mid.toFixed(2)}`);
