/**
 * Dump the LIVE epoch field: pool, per-wallet ticket blocks, concentration.
 *
 *   pnpm epoch-field
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../src/config.js";
import { decodeAccount, type Board, type SatrushConfig } from "../src/adapter/idl.js";
import { boardPda, satrushConfigPda } from "../src/adapter/pdas.js";
import { PriceFeed } from "../src/ingest/prices.js";
import { readEpochField } from "../src/ingest/epoch-field.js";

const cfg = loadConfig();
const conn = new Connection(cfg.RPC_HTTP_URL, "confirmed");
const pid = new PublicKey(cfg.PROGRAM_ID);
const n = (v: unknown): number => Number((v as { toString(): string }).toString());

const [confInfo, boardInfo, slot] = await Promise.all([
  conn.getAccountInfo(satrushConfigPda(pid), "confirmed"),
  conn.getAccountInfo(boardPda(pid), "confirmed"),
  conn.getSlot("confirmed"),
]);
const conf = decodeAccount<SatrushConfig>("SatrushConfig", confInfo!.data);
const board = decodeAccount<Board>("Board", boardInfo!.data);

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

const field = await readEpochField({
  connection: conn, programId: pid, btcUsd: prices.btcUsd(),
  iterationSlots: n(conf.epoch_vault_iteration_duration), slot,
});

const summed = field.blocks.reduce((a, b) => a + b, 0);
console.log(`iteration ${field.iterationId} · ${(100 * field.progress).toFixed(1)}% elapsed`);
console.log(`pool          $${field.poolUsd.toFixed(2)}`);
console.log(`total_tickets ${field.totalTickets.toLocaleString()} across ${field.participants} wallets`);
console.log(`pages read    ${field.blocks.length} entries summing ${summed.toLocaleString()}` +
  `  → ${field.complete ? "COMPLETE" : "INCOMPLETE (share estimates will be optimistic)"}`);
if (field.blocks.length === 0) process.exit(0);

const top = (k: number): string => {
  const s = field.blocks.slice(0, k).reduce((a, b) => a + b, 0);
  return `${((100 * s) / Math.max(1, summed)).toFixed(1)}%`;
};
console.log(`\nconcentration  top1 ${top(1)}  top5 ${top(5)}  top10 ${top(10)}  top20 ${top(20)}`);
console.log(`median block   ${field.blocks[Math.floor(field.blocks.length / 2)]?.toLocaleString()}`);
console.log(`largest 8      ${field.blocks.slice(0, 8).map((b) => b.toLocaleString()).join("  ")}`);
console.log(`\nboard round ${board.round_id}; round_duration ${board.round_duration} slots`);
