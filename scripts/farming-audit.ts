/**
 * Where does the farming number actually come from, and does it survive live data?
 *
 * `strategy-compare` reports farm-21 as the best strategy. Its BOARD leg is
 * replayed from real rounds and is trustworthy. Its EPOCH leg is not measured
 * at all — it is three constants multiplied together:
 *
 *   POOL   = 46_553           hardcoded off epoch iteration 4
 *   field  = iteration-4.json 157 wallets, 806,582 tickets, same iteration
 *   x1.246 unsourced          commented only "full output + measured bonus"
 *
 * Iteration 4 predates roughly a 4.7x collapse in volume, and the two stale
 * inputs do NOT move together: the pool scales with volume, while field tickets
 * scale with volume TIMES streak, and streaks only grow while wallets keep
 * playing. So the staleness does not cancel — it compounds in the one direction
 * that flatters farming.
 *
 * This prices the identical strategy off live accounts (EpochVault for the
 * pool, EpochVaultPage for the real per-wallet field, sampled Round accounts
 * for volume), then re-prices it under strategy-compare's constants so the
 * difference can be attributed to a specific input rather than argued about.
 *
 *   pnpm farming-audit [deployUsdPerRound] [streak]
 */
import { createRequire } from "node:module";
import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../src/config.js";
import { decodeAccount, type Board, type Round, type SatrushConfig } from "../src/adapter/idl.js";
import { boardPda, roundPda, satrushConfigPda } from "../src/adapter/pdas.js";
import { PriceFeed } from "../src/ingest/prices.js";
import { readEpochField, resampleField } from "../src/ingest/epoch-field.js";
import { EPOCH_REWARD_CURVE_BPS } from "../src/strategy/vault.js";
import { hashrateRawPerUsd, REWARD_MAX_STREAK } from "../src/strategy/hashrate.js";
import { blanketToll, feeModelFromConfig, TILES_COUNT } from "../src/strategy/ev.js";

const cfg = loadConfig();
const conn = new Connection(cfg.RPC_HTTP_URL, "confirmed");
const pid = new PublicKey(cfg.PROGRAM_ID);
const num = (v: unknown): number => Number((v as { toString(): string }).toString());
const DEPLOY_USD = Number(process.argv[2] ?? 1);
const STREAK = Number(process.argv[3] ?? REWARD_MAX_STREAK);
const TICKET_PRICE_RAW = 100;

const [confInfo, boardInfo, slot] = await Promise.all([
  conn.getAccountInfo(satrushConfigPda(pid), "confirmed"),
  conn.getAccountInfo(boardPda(pid), "confirmed"),
  conn.getSlot("confirmed"),
]);
if (!confInfo || !boardInfo) throw new Error("core accounts unavailable");
const conf = decodeAccount<SatrushConfig>("SatrushConfig", confInfo.data);
const board = decodeAccount<Board>("Board", boardInfo.data);
const fees = feeModelFromConfig(conf);

const prices = new PriceFeed({
  connection: conn,
  accounts: {
    btc: cfg.PYTH_BTC_USD_ACCOUNT ? new PublicKey(cfg.PYTH_BTC_USD_ACCOUNT) : undefined,
    sol: cfg.PYTH_SOL_USD_ACCOUNT ? new PublicKey(cfg.PYTH_SOL_USD_ACCOUNT) : undefined,
  },
  fallback: { btc: cfg.BTC_USD_ESTIMATE, sol: cfg.SOL_USD_ESTIMATE },
  log: () => {},
});
await prices.refresh();

const iterSlots = num(conf.epoch_vault_iteration_duration);
const roundsPerIter = Math.round(iterSlots / Math.max(1, board.round_duration));
const daysPerIter = roundsPerIter / 1440;
const field = await readEpochField({
  connection: conn, programId: pid, btcUsd: prices.btcUsd(), iterationSlots: iterSlots, slot,
});

// ── live volume, from Round accounts ────────────────────────────────────────
// Round.deployed_usd_amount is the 8000 bps pot leg, i.e. 0.8 x gross.
const roundInfos = await conn.getMultipleAccountsInfo(
  Array.from({ length: 40 }, (_, i) => roundPda(board.round_id - i - 1, pid)), "confirmed",
);
const samples = roundInfos
  .filter((x): x is NonNullable<typeof x> => x !== null)
  .map((x) => num(decodeAccount<Round>("Round", x.data).deployed_usd_amount) / 1e6 / 0.8)
  .filter((x) => x > 0);
const grossPerRound = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);

console.log(`live iteration ${field.iterationId} · ${(100 * field.progress).toFixed(1)}% elapsed ` +
  `· ${roundsPerIter} rounds (${daysPerIter.toFixed(1)}d) per iteration`);
console.log(`  pool banked   $${field.poolUsd.toFixed(0)}`);
console.log(`  field         ${field.totalTickets.toLocaleString()} tickets / ` +
  `${field.participants} wallets  ${field.complete ? "(pages complete)" : "(PAGES INCOMPLETE)"}`);
console.log(`  board volume  $${grossPerRound.toFixed(2)} gross/round over ${samples.length} rounds`);
if (field.progress <= 0.02 || field.blocks.length === 0) {
  console.log("\nToo early in the iteration to price the field. Re-run later.");
  process.exit(0);
}

// Both sides must describe a WHOLE iteration: comparing our full-iteration
// tickets against a 23%-elapsed field is the same partial-window error that has
// produced every wrong answer in this project.
//
// Scaling ticket COUNTS by 1/progress is not enough, and getting this wrong is
// what made the first cut of this script swing by $200/day. Payout is deduped
// by wallet across 21 slots, so with 52 entrants a fifth of the field wins
// something and share barely matters; at 157 entrants (what iteration 4 closed
// with) that collapses. Holding the entrant count at its 23%-elapsed value
// while inflating everyone's tickets models a world where no one else ever
// joins — maximally favourable to us, and false.
//
// So project the field as (entrant count P, total tickets T) and resample the
// MEASURED shape to P wallets. P is the dominant uncertainty and is bracketed
// rather than picked.
const totalFull = field.totalTickets / field.progress;
const poolFull = field.poolUsd +
  (1 - field.progress) * grossPerRound * roundsPerIter * (conf.epoch_fee_bps / 1e4);


// ── the draw, simulated against the real distribution ───────────────────────
// 21 winners without replacement, deduped by wallet: once a wallet is drawn all
// of its tickets leave. Rank weights then decide the payout.
function drawTake(mine: number, blocks: readonly number[], pool: number, trials = 20_000): number {
  const arr = [...blocks, mine];
  const me = arr.length - 1;
  const total = arr.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let cap = 0;
  for (let t = 0; t < trials; t++) {
    const dead = new Uint8Array(arr.length);
    let rem = total;
    for (let rank = 0; rank < EPOCH_REWARD_CURVE_BPS.length && rem > 0; rank++) {
      let r = Math.random() * rem;
      let pick = -1;
      for (let i = 0; i < arr.length; i++) {
        if (dead[i]) continue;
        r -= arr[i] as number;
        if (r < 0) { pick = i; break; }
      }
      if (pick < 0) break;
      dead[pick] = 1;
      rem -= arr[pick] as number;
      if (pick === me) { cap += (EPOCH_REWARD_CURVE_BPS[rank] ?? 0) / 10_000; break; }
    }
  }
  return (cap / trials) * pool;
}

const toll = blanketToll(fees, conf.strike_fee_bps);
const boardCost = toll * DEPLOY_USD * roundsPerIter;

const ticketsFor = (bonus: number): number =>
  Math.floor((DEPLOY_USD * hashrateRawPerUsd(STREAK, TILES_COUNT) * bonus * roundsPerIter) /
    TICKET_PRICE_RAW);

console.log(`\nfarm-21, $${DEPLOY_USD}/round at streak ${STREAK}, one full iteration`);
console.log(`  blanket toll ${(100 * toll).toFixed(2)}% of gross → board cost ` +
  `$${boardCost.toFixed(2)} per iteration\n`);

// ── the dominant variable: how many wallets show up ─────────────────────────
// 1.179, not the 1.246 strategy-compare used: PublicDeploySettled's
// unclaimed_hashrate_earned / hashrate_earned ratio is 0.179 over 1,875 settles.
// The 0.246 it was built on has no stated sample and cannot be reproduced.
const UNCLAIMED_UPLIFT = 1.179;
const tix = ticketsFor(UNCLAIMED_UPLIFT);
console.log(`  projected pool $${Math.round(poolFull).toLocaleString()}   ` +
  `projected field ${Math.round(totalFull).toLocaleString()} tickets   ` +
  `our tickets ${tix.toLocaleString()}\n`);
console.log("  entrants   our share   dedup uplift   epoch take   NET/iter    NET/day");
for (const p of [field.participants, 80, 120, 157, 230]) {
  const blocks = resampleField(field.blocks, p, totalFull);
  const take = drawTake(tix, blocks, poolFull);
  const share = tix / (tix + totalFull);
  const net = take - boardCost;
  const tag = p === field.participants ? " (now)" : p === 157 ? " (iter 4)" : "";
  console.log(
    `  ${String(p).padStart(8)}   ${(100 * share).toFixed(3).padStart(8)}%   ` +
      `${(take / Math.max(1e-9, share * poolFull)).toFixed(2).padStart(12)}x   ` +
      `$${take.toFixed(2).padStart(8)}   ` +
      `${((net >= 0 ? "+" : "-") + "$" + Math.abs(net).toFixed(2)).padStart(9)}   ` +
      `${((net >= 0 ? "+" : "-") + "$" + Math.abs(net / daysPerIter).toFixed(2)).padStart(8)}${tag}`,
  );
}
console.log(`\n  21 winner slots deduped by wallet. At ${field.participants} entrants a fifth of the`);
console.log(`  field wins something regardless of ticket share; by ~157 that advantage is`);
console.log(`  mostly gone. This — not the pool — is what decides the sign.`);

// ── attribution against strategy-compare's constants ────────────────────────
try {
  const req = createRequire(import.meta.url);
  const stale = JSON.parse(req("node:fs").readFileSync("data/epoch-iteration-4.json", "utf8"));
  const staleBlocks = stale.blocks as number[];
  const mid = resampleField(field.blocks, 157, totalFull);
  console.log("\n  attribution — one input swapped at a time (157-entrant baseline):");
  const rows: [string, number, number[]][] = [
    ["live pool + live field", poolFull, mid],
    ["STALE pool ($46,553)", 46_553, mid],
    ["STALE field (iter 4)", poolFull, staleBlocks],
    ["both stale = the backtest", 46_553, staleBlocks],
  ];
  for (const [label, pool, blocks] of rows) {
    const take = drawTake(tix, blocks, pool);
    const net = (take - boardCost) / daysPerIter;
    console.log(`    ${label.padEnd(26)} take $${take.toFixed(2).padStart(8)}   ` +
      `${((net >= 0 ? "+" : "-") + "$" + Math.abs(net).toFixed(2) + "/day").padStart(11)}`);
  }
} catch { /* the stale file is optional */ }

// ── can we even hold these tickets? ─────────────────────────────────────────
const capped = Math.min(tix, cfg.VAULT_MAX_TICKETS);
console.log(`\n  ticket cap reality check`);
console.log(`    modelled   ${tix.toLocaleString()} tickets/iteration (all earned hashrate converted)`);
console.log(`    configured ${cfg.VAULT_MAX_TICKETS.toLocaleString()} ` +
  `(VAULT_MAX_TICKETS), and only ${cfg.VAULT_HASHRATE_FRACTION} of the balance is spendable`);
if (capped < tix) {
  const takeCapped = drawTake(capped, resampleField(field.blocks, 157, totalFull), poolFull);
  const netCapped = (takeCapped - boardCost) / daysPerIter;
  console.log(`    at the configured cap the epoch take is $${takeCapped.toFixed(2)} ` +
    `→ ${(netCapped >= 0 ? "+" : "-") + "$" + Math.abs(netCapped).toFixed(2)}/day`);
  console.log(`    The backtest credits ${(tix / cfg.VAULT_MAX_TICKETS).toFixed(1)}x the tickets the bot is allowed to buy.`);
}
