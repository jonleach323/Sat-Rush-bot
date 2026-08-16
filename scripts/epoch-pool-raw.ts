/**
 * Raw EpochVault + iteration fields, unaggregated.
 *
 * The audit's pool projection and the measured banked pool disagree by roughly
 * an order of magnitude, which means one of the two is wrong about what these
 * fields MEAN. Print them separately rather than guessing.
 *
 *   pnpm epoch-pool-raw
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../src/config.js";
import {
  decodeAccount, type Board, type EpochVault, type EpochVaultIteration, type Round,
  type SatrushConfig,
} from "../src/adapter/idl.js";
import {
  boardPda, epochVaultIterationPda, epochVaultPda, roundPda, satrushConfigPda,
} from "../src/adapter/pdas.js";
import { PriceFeed } from "../src/ingest/prices.js";

const cfg = loadConfig();
const conn = new Connection(cfg.RPC_HTTP_URL, "confirmed");
const pid = new PublicKey(cfg.PROGRAM_ID);
const n = (v: unknown): number => Number((v as { toString(): string }).toString());

const [confI, boardI, vaultI, slot] = await Promise.all([
  conn.getAccountInfo(satrushConfigPda(pid), "confirmed"),
  conn.getAccountInfo(boardPda(pid), "confirmed"),
  conn.getAccountInfo(epochVaultPda(pid), "confirmed"),
  conn.getSlot("confirmed"),
]);
const conf = decodeAccount<SatrushConfig>("SatrushConfig", confI!.data);
const board = decodeAccount<Board>("Board", boardI!.data);
const v = decodeAccount<EpochVault>("EpochVault", vaultI!.data);

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
const BTC = prices.btcUsd();

const iterSlots = n(conf.epoch_vault_iteration_duration);
const elapsedSlots = slot - n(v.last_trigger_slot);
const progress = elapsedSlots / iterSlots;

console.log(`BTC $${BTC.toFixed(0)}   epoch_fee_bps ${conf.epoch_fee_bps}`);
console.log(`iteration ${v.iteration_id}   last_trigger_slot ${n(v.last_trigger_slot).toLocaleString()}`);
console.log(`now slot ${slot.toLocaleString()}   elapsed ${elapsedSlots.toLocaleString()} / ` +
  `${iterSlots.toLocaleString()} = ${(100 * progress).toFixed(2)}%\n`);

console.log("EpochVault fields:");
console.log(`  pool_usd_amount      ${(n(v.pool_usd_amount) / 1e6).toFixed(2)} USD`);
console.log(`  pending_usd_amount   ${(n(v.pending_usd_amount) / 1e6).toFixed(2)} USD`);
console.log(`  reserved_usd_amount  ${(n(v.reserved_usd_amount) / 1e6).toFixed(2)} USD   ` +
  `← owed to prior winners, NOT ours to win`);
console.log(`  pool_btc_amount      ${(n(v.pool_btc_amount) / 1e8).toFixed(8)} BTC ` +
  `= $${((n(v.pool_btc_amount) / 1e8) * BTC).toFixed(2)}`);
console.log(`  reserved_btc_amount  ${(n(v.reserved_btc_amount) / 1e8).toFixed(8)} BTC ` +
  `= $${((n(v.reserved_btc_amount) / 1e8) * BTC).toFixed(2)}`);

const contestable = n(v.pool_usd_amount) / 1e6 + (n(v.pool_btc_amount) / 1e8) * BTC;
console.log(`\n  contestable pool (pool legs only)  $${contestable.toFixed(2)}`);
console.log(`  + pending                          $${(n(v.pending_usd_amount) / 1e6).toFixed(2)}`);

const itI = await conn.getAccountInfo(epochVaultIterationPda(v.iteration_id, pid), "confirmed");
if (itI) {
  const it = decodeAccount<EpochVaultIteration>("EpochVaultIteration", itI.data);
  console.log(`\nIteration ${it.iteration_id}: state ${JSON.stringify(it.state)}  ` +
    `tickets ${n(it.total_tickets).toLocaleString()}  participants ${it.participants_count}  ` +
    `pages ${it.page_count}`);
  console.log(`  claimable_usd ${(n(it.claimable_usd) / 1e6).toFixed(2)}   ` +
    `claimable_btc ${(n(it.claimable_btc) / 1e8).toFixed(8)}`);
}

// Does the banked pool square with observed volume at epoch_fee_bps?
const infos = await conn.getMultipleAccountsInfo(
  Array.from({ length: 60 }, (_, i) => roundPda(board.round_id - i - 1, pid)), "confirmed",
);
const gross = infos
  .filter((x): x is NonNullable<typeof x> => x !== null)
  .map((x) => n(decodeAccount<Round>("Round", x.data).deployed_usd_amount) / 1e6 / 0.8)
  .filter((x) => x > 0);
const perRound = gross.reduce((a, b) => a + b, 0) / Math.max(1, gross.length);
const roundsPerIter = Math.round(iterSlots / board.round_duration);
const roundsElapsed = Math.round(elapsedSlots / board.round_duration);

console.log(`\nreconciliation`);
console.log(`  measured volume        $${perRound.toFixed(2)} gross/round (${gross.length} rounds sampled)`);
console.log(`  rounds elapsed         ${roundsElapsed.toLocaleString()} of ${roundsPerIter.toLocaleString()}`);
console.log(`  epoch inflow implied   $${(perRound * roundsElapsed * conf.epoch_fee_bps / 1e4).toFixed(2)}` +
  ` at ${conf.epoch_fee_bps} bps`);
console.log(`  pool actually banked   $${contestable.toFixed(2)}`);
console.log(`  → gap                  $${(contestable - perRound * roundsElapsed * conf.epoch_fee_bps / 1e4).toFixed(2)}`);
console.log(`\n  A large positive gap means the pool is mostly CARRY from previous`);
console.log(`  iterations, not inflow from current volume. That inverts the usual`);
console.log(`  reasoning: a banked stock against a shrunken field is the one regime`);
console.log(`  where farming genuinely pays — but it is a stock, so it drains.`);
